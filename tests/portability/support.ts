/**
 * Real-engine fixtures for the portability tests: PGlite (a real Postgres
 * compiled to WebAssembly), and real directories for artifact and object
 * storage. Nothing here pretends to be a service; it is the smallest honest
 * implementation of each port.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { ArtifactStore, ObjectStorePort, SqlRunner } from "@/lib/portability/types";

export function tempDir(prefix = "zenith-portability-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function pgliteRunner(db: PGlite): SqlRunner {
  return { query: async (text, params) => (await db.query(text, params ? [...params] : [])).rows as Record<string, unknown>[] };
}

/** A new PGlite instance opened from a dump of `db`: a different engine instance reading the same bytes. */
export async function reopened(db: PGlite): Promise<PGlite> {
  const dump = await db.dumpDataDir("none");
  return PGlite.create({ loadDataDir: dump });
}

/** Tenant storage as a directory. */
export function directoryArtifactStore(dir: string, label = `file://${dir}`): ArtifactStore {
  const resolve = (key: string): string => {
    const full = path.resolve(dir, ...key.split("/"));
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error("escape");
    return full;
  };
  return {
    label,
    async put(key, bytes) {
      const file = resolve(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    },
    async get(key) {
      try {
        return fs.readFileSync(resolve(key));
      } catch {
        return null;
      }
    },
    async list(prefix) {
      const out: string[] = [];
      const walk = (abs: string, rel: string): void => {
        if (!fs.existsSync(abs)) return;
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
          const key = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(abs, entry.name), key);
          else if (key.startsWith(prefix)) out.push(key);
        }
      };
      walk(path.resolve(dir), "");
      return out.sort();
    },
  };
}

/** An object store whose objects are files (content type kept in a sidecar). Keys are encoded so any key is representable. */
export function directoryObjectStore(dir: string): ObjectStorePort & { corrupt(key: string): void } {
  fs.mkdirSync(dir, { recursive: true });
  const enc = (key: string): string => Buffer.from(key, "utf8").toString("base64url");
  const dec = (name: string): string => Buffer.from(name, "base64url").toString("utf8");
  return {
    async list(prefix) {
      return fs
        .readdirSync(dir)
        .filter((n) => !n.endsWith(".type"))
        .map((n) => ({ key: dec(n), size: fs.statSync(path.join(dir, n)).size }))
        .filter((o) => o.key.startsWith(prefix))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async get(key) {
      const file = path.join(dir, enc(key));
      if (!fs.existsSync(file)) return null;
      const type = path.join(dir, `${enc(key)}.type`);
      return { bytes: fs.readFileSync(file), ...(fs.existsSync(type) ? { contentType: fs.readFileSync(type, "utf8") } : {}) };
    },
    async put(key, bytes, contentType) {
      fs.writeFileSync(path.join(dir, enc(key)), bytes);
      if (contentType) fs.writeFileSync(path.join(dir, `${enc(key)}.type`), contentType);
    },
    corrupt(key) {
      fs.writeFileSync(path.join(dir, enc(key)), Buffer.from("tampered"));
    },
  };
}

export const SEED_SQL = `
create schema app;
create type app.mood as enum ('sad', 'ok', 'happy');
create table public.accounts (
  id serial primary key,
  email text not null unique,
  balance numeric(12,4) not null default 0,
  created_at timestamptz not null default '2024-01-01 00:00:00+00',
  mood app.mood default 'ok',
  tags text[] not null default '{}',
  meta jsonb,
  blob bytea,
  note text check (length(note) < 1000)
);
create table app.entries (
  id bigint generated always as identity primary key,
  account_id int not null references public.accounts(id) on delete cascade,
  amount numeric(18,2) not null,
  memo text,
  total_cents bigint generated always as ((amount * 100)::bigint) stored
);
create index entries_account_idx on app.entries (account_id, amount desc);
create unique index accounts_lower_email on public.accounts (lower(email));
create sequence public.invoice_numbers start 1000 increment by 5;
select nextval('public.invoice_numbers');
select nextval('public.invoice_numbers');
insert into public.accounts (email, balance, mood, tags, meta, blob, note) values
  ('ada@example.test', 12345678.1234, 'happy', '{a,"b c"}', '{"k": [1, 2, {"z": null}], "s": "x"}', '\\xdeadbeef', E'line one\\nline "two" \\\\ back'),
  ('grace@example.test', 0, null, '{}', null, null, 'héllo ☃ 日本語'),
  ('o''neil@example.test', -5.5, 'sad', '{}', '"just a string"', '\\x', null);
insert into app.entries (account_id, amount, memo) values (1, 10.50, 'first'), (1, 99999999999999.99, null), (2, 0.01, 'tiny, with ''quotes''');
`;

export async function seededPglite(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SEED_SQL);
  return db;
}
