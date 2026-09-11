/**
 * The secret store, as a contract both backends keep.
 *
 * `src/lib/secrets` owns AES-256-GCM and owns it alone; `SecretsBackend` only
 * moves sealed records — a file under `ZENITH_DATA` or a row in
 * `public.secrets`. So the promises are the same on both sides and they are
 * what this suite asserts: a value goes in and comes back out, a rotation
 * counts up without rewriting who created it, a listing is metadata and never
 * a value, a removal is a removal, and **a sealed record lifted into another
 * workspace refuses to open** — which is the property that makes one shared
 * table safe for many tenants.
 *
 * The backend is chosen by `ZENITH_STORE` at call time, so each block sets the
 * variable around itself rather than needing a second process. The Postgres
 * block only appears with `ZENITH_CONTRACT_POSTGRES=1` plus real keys (see
 * `./factories.ts`).
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDataDir } from "../../_support/data-dir";
import { CONTRACT_PREFIX, postgresContractEnabled } from "./factories";

// MUST precede every application import: the file backend pins ZENITH_DATA the
// moment it is loaded. The key likewise — the store reads it from the
// environment and refuses every write without one.
tempDataDir("zenith-secrets-contract-");
process.env.ZENITH_SECRET_KEY ??= crypto.randomBytes(32).toString("base64");

const {
  listSecrets,
  putSecret,
  readSecretValue,
  removeSecret,
  secretsBackend,
  secretStatus,
} = await import("@/lib/secrets");

const WS = `${CONTRACT_PREFIX}-secrets`;
const OTHER = `${CONTRACT_PREFIX}-secrets-other`;
const REF = `vault:${CONTRACT_PREFIX}/svc/STRIPE_KEY`;
const REF_2 = `vault:${CONTRACT_PREFIX}/svc/DATABASE_URL`;
const VALUE = "sk_live_contract_value";
const ROTATED = "sk_live_contract_rotated";

/** The backends under test: the file one always, Postgres when it is armed. */
const backends: { name: string; store: "file" | "postgres" }[] = [
  { name: "FileSecrets", store: "file" },
  ...(postgresContractEnabled()
    ? [{ name: "PostgresSecrets", store: "postgres" as const }]
    : []),
];

afterAll(async () => {
  if (!postgresContractEnabled()) return;
  const { pgClient } = await import("@/lib/db/postgres-store");
  await pgClient().from("secrets").delete().like("workspace_id", `${CONTRACT_PREFIX}%`);
  const { closeRestBridge } = await import("@/lib/db/pg/sync-rest");
  closeRestBridge();
});

describe.each(backends)("secrets contract — $name", ({ store, name }) => {
  const previous = process.env.ZENITH_STORE;
  beforeAll(() => {
    process.env.ZENITH_STORE = store;
  });
  afterAll(() => {
    // Leave the variable exactly as it was found, or the next block runs on the
    // wrong backend and the failure is nowhere near the cause.
    if (previous === undefined) delete process.env.ZENITH_STORE;
    else process.env.ZENITH_STORE = previous;
  });

  it("is the backend this block asked for", () => {
    expect(secretsBackend().kind).toBe(store);
    expect(name).toContain(store === "file" ? "File" : "Postgres");
  });

  it("stores a value and hands it back, and nothing else does", () => {
    const meta = putSecret(WS, REF, VALUE, "Alice");
    expect(meta).toMatchObject({ ref: REF, version: 1, createdBy: "Alice", updatedBy: "Alice" });
    expect(readSecretValue(WS, REF)).toBe(VALUE);

    // What the backend actually holds is ciphertext. The record is the only
    // thing that ever reaches storage, so it is the thing worth checking.
    const record = secretsBackend().get(WS, REF)!;
    expect(JSON.stringify(record)).not.toContain(VALUE);
    expect(Buffer.from(record.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(record.authTag, "base64")).toHaveLength(16);
    expect(record.keyVersion).toBe(1);
  });

  it("reports existence and metadata, never the value", () => {
    const status = secretStatus(WS, REF);
    expect(status.exists).toBe(true);
    expect(JSON.stringify(status)).not.toContain(VALUE);
    expect(secretStatus(WS, "vault:NOT_THERE")).toEqual({ ref: "vault:NOT_THERE", exists: false });
    expect(readSecretValue(WS, "vault:NOT_THERE")).toBeUndefined();
  });

  it("rotates in place: the version counts up, the creation does not move", () => {
    const first = secretStatus(WS, REF);
    if (!first.exists) throw new Error("the value stored by the previous step is gone");
    const meta = putSecret(WS, REF, ROTATED, "Bob");
    expect(meta.version).toBe(2);
    expect(meta.updatedBy).toBe("Bob");
    // Who created it and when are the audit trail; a rotation must not rewrite
    // them into whoever happened to turn the key last.
    expect(meta.createdBy).toBe("Alice");
    expect(meta.createdAt).toBe(first.createdAt);
    expect(meta.updatedAt >= first.updatedAt).toBe(true);
    expect(readSecretValue(WS, REF)).toBe(ROTATED);
    // The old ciphertext is gone, not shadowed.
    expect(readSecretValue(WS, REF)).not.toBe(VALUE);
  });

  it("lists this workspace's references, oldest first, without values", () => {
    putSecret(WS, REF_2, "postgres://user:pw@host/db", "Alice");
    putSecret(OTHER, REF, "someone-elses-value", "Carol");

    const listed = listSecrets(WS);
    expect([...listed].map((m) => m.ref).sort()).toEqual([REF, REF_2].sort());
    // Oldest first, and said as a property of the list rather than as an index:
    // two writes in one millisecond are a tie, and a tie is not a bug.
    expect([...listed].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))).toEqual(listed);
    expect(JSON.stringify(listed)).not.toContain(ROTATED);
    expect(JSON.stringify(listed)).not.toContain("postgres://");
    // Another workspace's row is not in this workspace's listing, even though
    // both hold the same reference string.
    expect(listSecrets(OTHER).map((m) => m.ref)).toEqual([REF]);
    expect(listSecrets(`${CONTRACT_PREFIX}-nobody`)).toEqual([]);
  });

  it("keeps two workspaces' values for one reference apart", () => {
    expect(readSecretValue(WS, REF)).toBe(ROTATED);
    expect(readSecretValue(OTHER, REF)).toBe("someone-elses-value");
  });

  it("refuses a sealed record lifted into another workspace", () => {
    // The workspace and the reference are authenticated alongside the value, so
    // a row copied across a tenant boundary fails to open rather than quietly
    // decrypting as somebody else's secret. This is the property that lets one
    // `secrets` table hold every workspace.
    const backend = secretsBackend();
    const lifted = backend.get(WS, REF)!;
    const thief = `${CONTRACT_PREFIX}-secrets-thief`;
    backend.put(thief, lifted);
    expect(() => readSecretValue(thief, REF)).toThrow(/cannot be opened/i);

    // …and the same row under a different reference inside its own workspace,
    // which is the other half of the AAD: `${workspaceId} ${ref}`.
    const moved = `${REF}-moved`;
    backend.put(WS, { ...lifted, ref: moved });
    expect(() => readSecretValue(WS, moved)).toThrow(/cannot be opened/i);

    backend.remove(thief, REF);
    backend.remove(WS, moved);
  });

  it("removes a value and says what it removed", () => {
    const removed = removeSecret(WS, REF_2);
    expect(removed).toMatchObject({ ref: REF_2 });
    expect(secretStatus(WS, REF_2)).toEqual({ ref: REF_2, exists: false });
    expect(readSecretValue(WS, REF_2)).toBeUndefined();
    // Removing what is not there is not an error, and reports nothing removed.
    expect(removeSecret(WS, REF_2)).toBeUndefined();
    expect(listSecrets(WS).map((m) => m.ref)).toEqual([REF]);
  });

  it("refuses a value that is a file rather than a credential", () => {
    expect(() => putSecret(WS, "vault:HUGE", "x".repeat(9000), "Alice")).toThrow(/at most/i);
    expect(() => putSecret(WS, "vault:EMPTY", "", "Alice")).toThrow(/needs a value/i);
    expect(() => putSecret(WS, "bad ref", VALUE, "Alice")).toThrow(/not a usable secret reference/i);
  });
});
