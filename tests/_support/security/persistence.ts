/**
 * Helpers for the persistence leak suite (PROD-OPS-06): runtime-generated canaries, a full database dump and a file
 * tree reader. Nothing here is a real secret and nothing is hard-coded: every canary is built from fresh random
 * bytes on each run, in the shapes the stores recognise (and one shape they cannot).
 *
 * Application code is not imported here (this module is imported statically, before test env assignments).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The leak paths the inventory names (`leakPath`) and the suite exercises. */
export const LEAK_PATHS = ["vault", "api", "broker", "logs", "job-logs", "telemetry", "evidence", "events", "temporal", "model-visible", "connections"] as const;
export type LeakPath = (typeof LEAK_PATHS)[number];

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const pick = (n: number, alphabet: string): string => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
const b64url = (n: number): string => randomBytes(n).toString("base64url");

export interface RuntimeCanaries {
  /** a secret with no recognisable shape: only sealing protects it */
  opaque: string;
  aws: string;
  github: string;
  slack: string;
  jwt: string;
  pem: string;
  /** `postgres://app:<password>@host/db` */
  url: string;
  /** the password inside `url` */
  urlPassword: string;
}

/** Fresh, unrelated values on every call. */
export function runtimeCanaries(): RuntimeCanaries {
  const urlPassword = `Pw${pick(18, ALNUM)}`;
  return {
    opaque: `op_${b64url(24)}`,
    aws: `AKIA${pick(16, B32)}`,
    github: `ghp_${pick(36, ALNUM)}`,
    slack: `xoxb-${pick(11, "0123456789")}-${pick(24, ALNUM)}`,
    jwt: `eyJ${b64url(18)}.eyJ${b64url(30)}.${b64url(40)}`,
    pem: `-----BEGIN PRIVATE KEY-----\n${b64url(48)}\n${b64url(48)}\n-----END PRIVATE KEY-----`,
    url: `postgres://app:${urlPassword}@db.internal/app`,
    urlPassword,
  };
}

/** Values whose appearance, in any listed encoding, is a leak. The PEM contributes each body line too. */
export function recognisedShapes(c: RuntimeCanaries): string[] {
  const body = c.pem.split("\n").filter((line) => !line.startsWith("-----"));
  return [c.aws, c.github, c.slack, c.jwt, c.pem, ...body, c.url, c.urlPassword];
}

export const allShapes = (c: RuntimeCanaries): string[] => [c.opaque, ...recognisedShapes(c)];

interface Queryable { query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]> }

/** Every row of every base table in a schema, as text. Table names come from the catalog and are validated. */
export async function dumpSchema(db: Queryable, schema = "platform"): Promise<string[]> {
  const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name", [schema]);
  const out: string[] = [];
  for (const { table_name: name } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("unexpected table name");
    for (const row of await db.query<{ r: string }>(`select x::text as r from ${schema}."${name}" x`)) out.push(`${schema}.${name}: ${row.r}`);
  }
  return out;
}

/** Every file under a directory as latin1 text (so binary and UTF-8 both contain their ASCII needles). */
export function readTree(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push({ file: path.relative(dir, full), text: fs.readFileSync(full).toString("latin1") });
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return out;
}
