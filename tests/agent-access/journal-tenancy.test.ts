/**
 * SEC-F1: foreign and absent operations have identical errors before their
 * documents are loaded. SQLite and PGlite execute real SQL in memory. The
 * Postgres tag below adapts PGlite, not a live server or multi-process pool.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ControlError, Journal, SqliteAgentJournal, type AgentJournal, type Operation, type Principal, type Proposal,
} from "@/lib/agent-access/control/journal";
import { PgAgentJournal, REQUIRED_MIGRATIONS } from "@/lib/agent-access/control/journal-pg";
import type { Sql } from "@/lib/hosted/authority/pg/client";

const now = Date.parse("2026-10-01T00:00:00.000Z");
const who: Principal = {
  subject: "shared-member", integrationId: "integration-a", workspaceId: "workspace-a",
  projectIds: ["project-a"], scopes: ["read", "plan", "write"], expiresAt: "2099-01-01T00:00:00.000Z",
};
const foreignWho: Principal = { ...who, integrationId: "integration-b", workspaceId: "workspace-b", projectIds: ["project-b"] };
const absent = "op_missing";
const proposal = (principal: Principal, key: string): Proposal => ({
  action: "manifest.import", input: {}, target: { workspaceId: principal.workspaceId, projectId: principal.projectIds[0] },
  fingerprint: "reviewed-state", plan: {}, requestKey: key,
});

type Lane = { journal: AgentJournal; own: Operation; foreign: Operation; close: () => Promise<void> };

async function sqliteLane(): Promise<Lane> {
  const inner = new Journal(":memory:", () => now);
  const own = inner.prepare(who, proposal(who, "request_own"));
  const foreign = inner.prepare(foreignWho, proposal(foreignWho, "request_foreign"));
  return { journal: new SqliteAgentJournal(inner), own, foreign, close: async () => { inner.close(); } };
}

async function postgresLane(): Promise<Lane> {
  const db = new PGlite();
  await db.exec(`
    create schema agent;
    create table agent.schema_migrations (version integer, name text);
    create table agent.agent_operations (
      id text primary key, workspace_id text not null, subject text not null,
      phase text not null, digest text not null, expires_at timestamptz not null,
      approved_by text, approval_role text, approved_at timestamptz, finished_at timestamptz,
      fence_token bigint not null default 0, lease_owner text, lease_until timestamptz,
      attempts integer not null default 0, authorization_digest text, application_authorization_digest text,
      document jsonb not null
    );
    create table agent.agent_operation_events (
      seq bigserial primary key, operation_id text not null, kind text not null,
      at timestamptz not null, document jsonb not null
    );
  `);
  for (const migration of REQUIRED_MIGRATIONS)
    await db.query("insert into agent.schema_migrations values ($1, $2)", [migration.version, migration.name]);

  const fixture = new Journal(":memory:", () => now);
  const own = fixture.prepare(who, proposal(who, "request_own"));
  const foreign = fixture.prepare(foreignWho, proposal(foreignWho, "request_foreign"));
  fixture.close();
  for (const operation of [own, foreign]) {
    await db.query("insert into agent.agent_operations (id, workspace_id, subject, phase, digest, expires_at, document) values ($1, $2, $3, $4, $5, $6, $7)",
      [operation.id, operation.target.workspaceId, operation.subject, operation.phase, operation.digest, operation.expiresAt, JSON.stringify(operation)]);
    await db.query("insert into agent.agent_operation_events (operation_id, kind, at, document) values ($1, $2, $3, $4)",
      [operation.id, "prepared", operation.createdAt, JSON.stringify({ operationId: operation.id })]);
  }

  // Every tag executes in PGlite. The driver shape is adapted, while filtering,
  // row locks, updates and transaction rollback are database behavior.
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((sql, part, index) => sql + (index ? `$${index}` : "") + part, "");
    return db.query(text, values).then((result) => result.rows);
  }) as unknown as Sql;
  tag.json = ((value: unknown) => JSON.stringify(value)) as unknown as Sql["json"];
  tag.begin = ((fn: (tx: Sql) => Promise<unknown>) => db.transaction(async (tx) => {
    const transactionTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((sql, part, index) => sql + (index ? `$${index}` : "") + part, "");
      return tx.query(text, values).then((result) => result.rows);
    }) as unknown as Sql;
    transactionTag.json = tag.json;
    return fn(transactionTag);
  })) as Sql["begin"];
  return { journal: new PgAgentJournal({ client: tag, clock: () => now }), own, foreign, close: () => db.close() };
}

async function refusal(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlError);
    const { code, message, status } = error as ControlError;
    return { code, message, status };
  }
  throw new Error("Expected operation access to be refused.");
}

const missing = { code: "operation_not_found", message: "Operation not found in this scope.", status: 404 };
const principalMethods = ["get", "events", "claim"] as const;
type Method = typeof principalMethods[number] | "review" | "unapprove" | "forReview";

function access(journal: AgentJournal, operation: Operation, method: Method, id: string, principal = who): Promise<unknown> {
  switch (method) {
    case "get": return journal.get(principal, id);
    case "events": return journal.events(principal, id);
    case "claim": return journal.claim(principal, id, operation.fingerprint);
    case "review": return journal.review(id, principal.subject, principal.workspaceId, operation.digest, true);
    case "unapprove": return journal.unapprove(id, operation.digest, principal.subject, principal.workspaceId);
    case "forReview": return journal.forReview(id, principal.workspaceId);
  }
}

for (const [label, open] of [["SQLite", sqliteLane], ["Postgres SQL via PGlite", postgresLane]] as const) {
  describe(`${label}: operation tenant boundaries`, () => {
    let lane: Lane;
    beforeAll(async () => { lane = await open(); });
    afterAll(async () => { await lane?.close(); });

    it.each<Method>([...principalMethods, "review", "unapprove", "forReview"])
      ("%s returns the same code, message and status for a foreign and absent id", async (method) => {
        const foreign = await refusal(() => access(lane.journal, lane.foreign, method, lane.foreign.id));
        const phantom = await refusal(() => access(lane.journal, lane.foreign, method, absent));
        expect(foreign).toEqual(missing);
        expect(foreign).toEqual(phantom);
        expect((await lane.journal.get(foreignWho, lane.foreign.id)).phase).toBe("prepared");
      });

    it.each(principalMethods)("%s also hides another subject's operation in the same workspace", async (method) => {
      const stranger = { ...who, subject: "another-member", projectIds: ["different-project"] };
      const other = await refusal(() => access(lane.journal, lane.own, method, lane.own.id, stranger));
      const phantom = await refusal(() => access(lane.journal, lane.own, method, absent, stranger));
      expect(other).toEqual(missing);
      expect(other).toEqual(phantom);
    });

    it("still returns the caller's operation, browser review and event history", async () => {
      expect(await lane.journal.get(who, lane.own.id)).toEqual(lane.own);
      expect(await lane.journal.forReview(lane.own.id, who.workspaceId)).toEqual(lane.own);
      expect(await lane.journal.events(who, lane.own.id)).toHaveLength(1);
      expect(await refusal(() => lane.journal.claim(who, lane.own.id, lane.own.fingerprint)))
        .toMatchObject({ code: "approval_required", status: 409 });
    });

    it("retains scope and credential checks for operations in the caller's scope", async () => {
      expect(await refusal(() => lane.journal.get({ ...who, scopes: [] }, lane.own.id)))
        .toMatchObject({ code: "scope_denied", status: 403 });
      expect(await refusal(() => lane.journal.get({ ...who, projectIds: [] }, lane.own.id)))
        .toMatchObject({ code: "scope_denied", status: 403 });
      expect(await refusal(() => lane.journal.get({ ...who, expiresAt: "2020-01-01T00:00:00.000Z" }, lane.own.id)))
        .toMatchObject({ code: "credential_expired", status: 401 });
    });

    it("requires the reviewer's subject before inspecting the proposal", async () => {
      expect(await refusal(() => lane.journal.review(lane.own.id, "another-member", who.workspaceId, lane.own.digest, true)))
        .toEqual(missing);
    });

    it("preserves review, approval withdrawal, claim and finalization for the owning workspace", async () => {
      const { journal, own } = lane;
      expect((await journal.review(own.id, who.subject, who.workspaceId, own.digest, true)).phase).toBe("approved");
      expect((await journal.unapprove(own.id, own.digest, who.subject, who.workspaceId)).phase).toBe("prepared");
      await journal.review(own.id, who.subject, who.workspaceId, own.digest, true);
      expect(await journal.claim(who, own.id, own.fingerprint)).toMatchObject({ claimed: true, operation: { phase: "running" } });
      expect((await journal.finishIfValid(who, own.id, { ok: true }, true)).phase).toBe("succeeded");
      expect((await journal.get(who, own.id)).phase).toBe("succeeded");
    });
  });
}
