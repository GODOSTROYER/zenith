/**
 * PROD-OPS-09: tamper-evident audit export. Real PGlite SQL for the ledger (migration 47), the real LocalJwkSigner
 * (EdDSA) and the standalone offline verifier script. Contract level: no live Postgres and no product audit store; the
 * reader is a stub that behaves like the paged store reader. Keys are generated at runtime.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { generateSigningJwk } from "@/lib/credentials/signing/keygen";
import { LocalJwkSigner } from "@/lib/credentials/signing/local";
import type { AuditEvent } from "@/lib/domain/types";
import { AUDIT_EXPORT_SCHEMA, chainEvents, entryHash, genesisHash } from "@/lib/audit-export/chain";
import { AuditExportError, MAX_EXPORT_EVENTS, createAuditExport, type AuditReader } from "@/lib/audit-export/service";
import { latestExport, listExports, recordExport } from "@/lib/audit-export/store";
import { main as verifyMain, verifyAuditExport } from "../../scripts/supply-chain/zenith-verify-audit-export.mjs";

const WS = `ws-${randomUUID()}`;
const OTHER = `ws-${randomUUID()}`;
const event = (workspaceId: string, n: number, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  ts: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
  id: `ev-${workspaceId}-${String(n).padStart(4, "0")}`,
  workspaceId,
  actor: { type: "user", id: "u1", name: "Operator" },
  actionId: "deploy.start",
  input: { n },
  result: "ok",
  summary: `event ${n}`,
  ...extra,
});

/** A paged reader over a fixed list, newest first like the product store; honours workspace and range filters. */
function readerOf(all: AuditEvent[]): AuditReader {
  return async (filter) => {
    const rows = all
      .filter((e) => e.workspaceId === filter.workspaceId && (!filter.from || e.ts >= filter.from) && (!filter.to || e.ts <= filter.to))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const start = filter.cursor ? Number(filter.cursor) : 0;
    const page = rows.slice(start, start + filter.limit);
    return { events: page, nextCursor: start + filter.limit < rows.length ? String(start + filter.limit) : undefined };
  };
}

let db: PlatformDbHandle;
let signer: LocalJwkSigner;
let keys: unknown;
beforeEach(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  const generated = await generateSigningJwk("EdDSA");
  signer = LocalJwkSigner.fromJwk("TEST_KEY", generated.privateJwk, { alg: "EdDSA" });
  keys = [signer.publicJwk()];
}, 60_000);
afterEach(async () => { await db.close(); });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-audit-export-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ten = Array.from({ length: 10 }, (_, i) => event(WS, i + 1));

describe("hash chain", () => {
  it("is deterministic, order-independent of input order, and commits to every event and the previous export", () => {
    const a = chainEvents(WS, null, ten);
    const b = chainEvents(WS, null, [...ten].reverse());
    expect(b.head).toBe(a.head);
    expect(a.entries).toHaveLength(10);
    expect(a.genesis).toBe(genesisHash(WS, null));
    expect(a.entries[0].hash).toBe(entryHash(a.genesis, a.entries[0].event));
    expect(chainEvents(WS, "a".repeat(64), ten).head).not.toBe(a.head);
    expect(chainEvents(OTHER, null, ten).head).not.toBe(a.head);
    const edited = clone(ten);
    edited[4].summary = "changed";
    expect(chainEvents(WS, null, edited).head).not.toBe(a.head);
  });
});

describe("signed export and offline verification", () => {
  const exportOnce = async (events = ten, extra: { from?: string; to?: string } = {}) =>
    createAuditExport({ db, signer, read: readerOf(events) }, { workspaceId: WS, createdBy: "admin-1", ...extra });

  it("verifies offline against the pinned key, including through the CLI with a ledger", async () => {
    const { document, record } = await exportOnce();
    expect(document.schema).toBe(AUDIT_EXPORT_SCHEMA);
    expect(record).toMatchObject({ workspaceId: WS, eventCount: 10, previousExportId: null, keyId: signer.kid });
    const result = verifyAuditExport(document, { keys, workspace: WS });
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.claims.head).toBe(record.head);

    const files = { doc: path.join(scratch, "export.json"), keys: path.join(scratch, "keys.json"), ledger: path.join(scratch, "ledger.json") };
    fs.writeFileSync(files.doc, JSON.stringify(document));
    fs.writeFileSync(files.keys, JSON.stringify(keys));
    fs.writeFileSync(files.ledger, JSON.stringify({ exports: await listExports(db, WS) }));
    const out: string[] = [];
    const sink = { write: (s: string) => { out.push(s); return true; } } as unknown as NodeJS.WriteStream;
    expect(verifyMain([files.doc, "--keys", files.keys, "--ledger", files.ledger, "--workspace", WS], sink, sink)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ verified: true, count: 10 });
    expect(verifyMain([files.doc, "--keys", files.keys, "--workspace", "someone-else"], sink, sink)).toBe(1);
    expect(verifyMain([], sink, sink)).toBe(2);
  });

  it("detects an edited event, a removed event, an inserted event, a reorder, and a truncated tail", async () => {
    const { document } = await exportOnce();
    const check = (mutate: (d: typeof document) => void): string[] => {
      const copy = clone(document);
      mutate(copy);
      const r = verifyAuditExport(copy, { keys });
      expect(r.ok).toBe(false);
      return r.errors;
    };
    expect(check((d) => { d.entries[3].event.summary = "tampered"; }).join()).toMatch(/entry 3/);
    expect(check((d) => { d.entries.splice(5, 1); }).join()).toMatch(/holds 9 entries/);
    expect(check((d) => { d.entries.splice(5, 1); const c = chainEvents(WS, null, d.entries.map((e) => e.event)); d.entries = c.entries; }).join()).toMatch(/9 entries|signed head|covers 10/);
    expect(check((d) => { d.entries.splice(2, 0, { event: event(WS, 99), hash: "0".repeat(64) }); }).join()).toBeTruthy();
    expect(check((d) => { [d.entries[1], d.entries[2]] = [d.entries[2], d.entries[1]]; }).join()).toMatch(/out of the signed order|chain hash/);
    expect(check((d) => { d.entries.pop(); }).join()).toMatch(/covers 10/);
    // An attacker who recomputes the whole chain over altered events still cannot reproduce the signed head.
    expect(check((d) => {
      const events = d.entries.map((e) => e.event);
      events[2] = { ...events[2], summary: "forged" };
      d.entries = chainEvents(WS, null, events).entries;
    }).join()).toMatch(/signed head/);
  });

  it("rejects a forged header, a foreign signer, an unpinned kid and malformed input", async () => {
    const { document } = await exportOnce();
    const [h, p, s] = document.jws.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...payload, count: 3 })).toString("base64url");
    expect(verifyAuditExport({ ...document, jws: `${h}.${forged}.${s}` }, { keys }).errors.join()).toMatch(/signature does not verify/);

    const other = await generateSigningJwk("EdDSA");
    const foreign = LocalJwkSigner.fromJwk("OTHER", other.privateJwk, { alg: "EdDSA" });
    const second = await createAuditExport({ db, signer: foreign, read: readerOf(ten) }, { workspaceId: OTHER, createdBy: "admin-1" });
    expect(verifyAuditExport(second.document, { keys }).errors.join()).toMatch(/not in the pinned key file/);
    expect(verifyAuditExport(second.document, { keys: [foreign.publicJwk()] }).ok).toBe(true);

    expect(verifyAuditExport({ schema: "nope" }, { keys }).ok).toBe(false);
    expect(verifyAuditExport(document, { keys: { kty: "OKP", crv: "Ed25519", kid: "x", x: "abc", d: "secret" } }).errors.join()).toMatch(/private member/);
  });

  it("links successive exports and the ledger shows a dropped or substituted one", async () => {
    const first = await exportOnce();
    const more = [...ten, event(WS, 11), event(WS, 12)];
    const second = await exportOnce(more);
    expect(second.record.previousExportId).toBe(first.record.id);
    expect(second.record.previousHead).toBe(first.record.head);
    expect(verifyAuditExport(second.document, { keys, previousHead: first.record.head }).ok).toBe(true);
    expect(verifyAuditExport(second.document, { keys, previousHead: "f".repeat(64) }).errors.join()).toMatch(/not chained onto the expected previous head/);

    const ledger = await listExports(db, WS);
    expect(ledger.map((r) => r.id)).toEqual([second.record.id, first.record.id]);
    expect(verifyAuditExport(second.document, { keys, ledger }).ok).toBe(true);
    expect(verifyAuditExport(second.document, { keys, ledger: ledger.filter((r) => r.id !== first.record.id) }).errors.join()).toMatch(/previous export named by this export is missing/);
    expect(verifyAuditExport(second.document, { keys, ledger: ledger.filter((r) => r.id !== second.record.id) }).errors.join()).toMatch(/not in the ledger/);
    expect(verifyAuditExport(first.document, { keys, ledger: [{ ...ledger[1], head: "e".repeat(64) }] }).errors.join()).toMatch(/different head/);
  });

  it("refuses to export without a signer and records nothing", async () => {
    await expect(createAuditExport({ db, signer: undefined, read: readerOf(ten) }, { workspaceId: WS, createdBy: "a" })).rejects.toMatchObject({ code: "signer_unavailable" });
    expect(await listExports(db, WS)).toEqual([]);
  });

  it("honours the range, validates it, and refuses a range that is too large instead of truncating", async () => {
    const { document, record } = await exportOnce(ten, { from: ten[2].ts, to: ten[5].ts });
    expect(document.entries.map((e) => e.event.id)).toEqual(ten.slice(2, 6).map((e) => e.id));
    expect(record.rangeFrom).not.toBeNull();
    expect(verifyAuditExport(document, { keys }).ok).toBe(true);
    await expect(exportOnce(ten, { from: "not-a-date" })).rejects.toBeInstanceOf(AuditExportError);
    await expect(exportOnce(ten, { from: ten[5].ts, to: ten[2].ts })).rejects.toMatchObject({ code: "range_invalid" });
    const huge = Array.from({ length: MAX_EXPORT_EVENTS + 1 }, (_, i) => ({ ...event(WS, 0), id: `big-${i}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString() }));
    await expect(exportOnce(huge)).rejects.toMatchObject({ code: "range_too_large" });
    expect(await listExports(db, WS)).toHaveLength(1);
  }, 60_000);

  it("never includes another workspace's events, even from a reader that ignores the tenant filter", async () => {
    const leaky: AuditReader = async () => ({ events: [...ten, event(OTHER, 1), event(OTHER, 2)] });
    const { document } = await createAuditExport({ db, signer, read: leaky }, { workspaceId: WS, createdBy: "a" });
    expect(document.entries).toHaveLength(10);
    expect(document.entries.every((e) => e.event.workspaceId === WS)).toBe(true);
    expect(await listExports(db, OTHER)).toEqual([]);
    expect(await latestExport(db, OTHER)).toBeUndefined();
  });
});

describe("export ledger (migration 47)", () => {
  const row = (previous: { id: string; head: string } | null, id = `ae_${randomUUID()}`) => ({
    id, workspaceId: WS, rangeFrom: null, rangeTo: null, eventCount: 1, genesis: "a".repeat(64), head: id.length.toString(16).padStart(64, "b"),
    previous, keyId: "k", signatureDigest: "c".repeat(64), createdBy: "u",
  });

  it("is append-only and never forks", async () => {
    const first = await recordExport(db, row(null));
    await expect(db.query("update platform.audit_exports set event_count = 9 where id = $1", [first.id])).rejects.toThrow();
    await expect(db.query("delete from platform.audit_exports where id = $1", [first.id])).rejects.toThrow();
    // a second root, or a second successor of the same predecessor, is a fork and is refused
    await expect(recordExport(db, row(null))).rejects.toMatchObject({ code: "conflict" });
    const second = await recordExport(db, row({ id: first.id, head: first.head }));
    await expect(recordExport(db, row({ id: first.id, head: first.head }))).rejects.toMatchObject({ code: "conflict" });
    expect((await latestExport(db, WS))?.id).toBe(second.id);
  });

  it("scopes every read to the workspace", async () => {
    await recordExport(db, row(null));
    await recordExport(db, { ...row(null), workspaceId: OTHER });
    expect((await listExports(db, WS)).every((r) => r.workspaceId === WS)).toBe(true);
    expect(await listExports(db, OTHER)).toHaveLength(1);
  });
});
