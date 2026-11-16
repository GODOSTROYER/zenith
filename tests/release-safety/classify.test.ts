/** PROD-LIFE-10: migration classification, expand/compatible versus data versus contract. Pure. */
import { describe, expect, it } from "vitest";
import { assessMigration, blocksCodeRollback, classifySql, maxClass, migrationBindingDigest, requiresHumanApproval, splitStatements } from "@/lib/release-safety";

describe("splitStatements", () => {
  it("honours comments, quotes and dollar quoting", () => {
    const sql = `-- drop table nope;\ncreate table a (x text default 'a;b'); /* drop table b; */ create function f() returns int as $$ begin drop table c; end $$ language plpgsql;`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^create table a/);
    expect(parts[1]).toMatch(/^create function f/);
  });
});

describe("classifySql", () => {
  it.each([
    ["create table widgets (id int primary key)", "expand"],
    ["create index concurrently idx on widgets (id)", "expand"],
    ["alter table widgets add column note text", "expand"],
    ["alter table widgets add column flag boolean not null default false", "expand"],
    ["alter table widgets add constraint c check (id > 0) not valid", "expand"],
    ["alter type color add value 'teal'", "expand"],
    ["update widgets set note = 'x'", "data"],
    ["delete from widgets where id < 10", "data"],
    ["insert into widgets select * from old_widgets", "data"],
    ["create table copy as select * from widgets", "data"],
    ["do $$ begin perform 1; end $$", "data"],
    ["drop table widgets", "contract"],
    ["alter table widgets drop column note", "contract"],
    ["alter table widgets rename column a to b", "contract"],
    ["alter table widgets alter column id type bigint", "contract"],
    ["alter table widgets alter column note set not null", "contract"],
    ["alter table widgets add column req int not null", "contract"],
    ["alter table widgets add constraint u unique (id)", "contract"],
    ["truncate widgets", "contract"],
    ["revoke select on widgets from reader", "contract"],
    ["cluster widgets using idx", "unclassified"],
    ["frobnicate the schema", "unclassified"],
  ] as const)("%s -> %s", (sql, expected) => {
    expect(classifySql(sql).class).toBe(expected);
  });

  it("takes the most dangerous statement of a script", () => {
    const r = classifySql("create table a (id int); update a set id = 1; alter table a drop column id;");
    expect(r.class).toBe("contract");
    expect(r.statements).toBe(3);
    expect(r.findings.length).toBeGreaterThan(1);
  });

  it("a quoted value cannot imitate a keyword", () => {
    expect(classifySql("insert into notes (body) values ('drop table users')").class).toBe("data");
  });

  it("an empty script is none and oversized input is never expand", () => {
    expect(classifySql("-- nothing\n").class).toBe("none");
    expect(classifySql("create table t (id int);".repeat(40_000)).class).toBe("unclassified");
  });

  it("findings never repeat statement text", () => {
    const r = classifySql("update secrets set token = 'hunter2-canary'");
    expect(JSON.stringify(r)).not.toContain("hunter2-canary");
  });
});

describe("assessMigration", () => {
  it("no migration is none", () => {
    expect(assessMigration(undefined).class).toBe("none");
  });
  it("an unclassified migration is treated as destructive, never as compatible", () => {
    const a = assessMigration({});
    expect(a.class).toBe("unclassified");
    expect(requiresHumanApproval(a.class)).toBe(true);
    expect(blocksCodeRollback(a.class)).toBe(true);
  });
  it("a declared expand needs no separate approval", () => {
    const a = assessMigration({ declared: "expand" });
    expect(a.class).toBe("expand");
    expect(requiresHumanApproval(a.class)).toBe(false);
  });
  it("SQL can raise the declared class but never lower it", () => {
    expect(assessMigration({ declared: "expand", sql: "drop table t" })).toMatchObject({ class: "contract", raisedBySql: true });
    expect(assessMigration({ declared: "contract", sql: "create table t (id int)" }).class).toBe("contract");
    expect(assessMigration({ declared: "expand", sql: "create table t (id int)" })).toMatchObject({ class: "expand", raisedBySql: false });
  });
  it("data migrations need approval but do not block a code rollback by themselves", () => {
    expect(requiresHumanApproval("data")).toBe(true);
    expect(blocksCodeRollback("data")).toBe(false);
    expect(blocksCodeRollback("contract")).toBe(true);
    expect(maxClass("data", "expand")).toBe("data");
  });
});

describe("migrationBindingDigest", () => {
  const base = { workspaceId: "w", environmentId: "e", serviceAddress: "container_service/web", imageDigest: `sha256:${"a".repeat(64)}`, commandDigest: "c".repeat(64), class: "contract" as const };
  it("changes with every part of the approved effect", () => {
    const d = migrationBindingDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [{ workspaceId: "x" }, { environmentId: "x" }, { serviceAddress: "container_service/api" }, { imageDigest: `sha256:${"b".repeat(64)}` }, { commandDigest: "d".repeat(64) }, { class: "data" as const }, { sqlDigest: "e".repeat(64) }]) {
      expect(migrationBindingDigest({ ...base, ...change })).not.toBe(d);
    }
    expect(migrationBindingDigest({ ...base })).toBe(d);
  });
});
