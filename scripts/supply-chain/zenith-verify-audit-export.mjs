#!/usr/bin/env node
/**
 * zenith-verify-audit-export: offline verifier for signed, hash-chained audit exports (PROD-OPS-09).
 *
 *   node scripts/supply-chain/zenith-verify-audit-export.mjs EXPORT.json --keys PUBLIC_KEYS.json
 *        [--workspace ID] [--previous-head HEX64] [--ledger LEDGER.json]
 *
 * Needs only node:crypto and the files named above: no network, no Zenith process, no database. It is an independent
 * implementation of src/lib/audit-export/chain.ts (a test checks that both agree on the same bytes).
 *
 * PUBLIC_KEYS.json is a public JWK, a JWKS ({"keys":[...]}) or an array of public JWKs (Ed25519). The keys are
 * pinned by the caller; the export never supplies its own. LEDGER.json is the response of
 * GET /api/platform/v1/audit/exports ({"exports":[...]}) or the bare array: when given, the export must appear in
 * it with the same head, count and signature digest, and its predecessor link must match the ledger.
 *
 * Exit status: 0 verified, 1 not verified (every failed check is listed), 2 usage error.
 * Verified means: the claims are signed by a pinned key, the chain recomputed from the entries reproduces the signed
 * head and count, entries are in the signed order, and (if asked) the links match. It does NOT mean the live log was
 * complete before export; the chain starts at export time.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SCHEMA = "zenith.audit-export/v1";
const JWS_TYP = "zenith-audit-export+jwt";
const ORDER = "ts,id ascending";
const HEX64 = /^[0-9a-f]{64}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_HEADERS = ["jwk", "jku", "x5u", "x5c", "x5t", "x5t#S256", "crit"];
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256 = (v) => createHash("sha256").update(v).digest("hex");

/** Same canonical form as src/lib/controlplane/digest.ts: sorted keys, undefined dropped, arrays in order. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

export const genesisHash = (workspaceId, previousHead) => sha256(`${SCHEMA}\ngenesis\n${workspaceId}\n${previousHead ?? ""}`);
export const entryHash = (previous, event) => sha256(`${SCHEMA}\nentry\n${previous}\n${canonical(event)}`);

function loadKeys(raw) {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.keys) ? raw.keys : [raw];
  const keys = new Map();
  for (const jwk of list) {
    if (!isObject(jwk) || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.kid !== "string") throw new Error("keys must be public Ed25519 JWKs with a kid");
    if (["d", "p", "q", "k"].some((m) => m in jwk)) throw new Error("a private member is present in the key file; pass public keys only");
    keys.set(jwk.kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }));
  }
  if (keys.size === 0) throw new Error("no public keys supplied");
  return keys;
}

const decodeJson = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** Verify an export document. Returns { ok, errors, claims } and never throws on bad input. */
export function verifyAuditExport(doc, options) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  let claims;
  try {
    const keys = loadKeys(options.keys);
    if (!isObject(doc) || doc.schema !== SCHEMA || typeof doc.jws !== "string" || !Array.isArray(doc.entries)) return { ok: false, errors: ["not a zenith.audit-export/v1 document"], claims: undefined };
    const parts = doc.jws.split(".");
    if (parts.length !== 3 || !parts.every((p) => B64U.test(p))) return { ok: false, errors: ["the signed header is not a compact JWS"], claims: undefined };
    const header = decodeJson(parts[0]);
    if (!isObject(header) || header.alg !== "EdDSA" || header.typ !== JWS_TYP || typeof header.kid !== "string") return { ok: false, errors: ["unexpected JWS header (EdDSA and the audit export type are required)"], claims: undefined };
    if (FORBIDDEN_HEADERS.some((h) => h in header)) return { ok: false, errors: ["the JWS header carries a forbidden member"], claims: undefined };
    const key = keys.get(header.kid);
    if (!key) return { ok: false, errors: [`the export is signed by key "${header.kid}", which is not in the pinned key file`], claims: undefined };
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) return { ok: false, errors: ["the signature does not verify"], claims: undefined };
    claims = decodeJson(parts[1]);
    if (!isObject(claims) || claims.schema !== SCHEMA || claims.order !== ORDER) return { ok: false, errors: ["the signed claims are not an audit export header"], claims: undefined };
    if (typeof claims.workspaceId !== "string" || !HEX64.test(claims.genesis) || !HEX64.test(claims.head) || !Number.isSafeInteger(claims.count) || claims.count < 0 || typeof claims.exportId !== "string") return { ok: false, errors: ["the signed claims are malformed"], claims };
    const prev = claims.previousExport;
    if (prev !== null && !(isObject(prev) && typeof prev.id === "string" && HEX64.test(prev.head))) return { ok: false, errors: ["the signed previous-export link is malformed"], claims };

    if (options.workspace !== undefined && options.workspace !== claims.workspaceId) fail(`the export belongs to workspace "${claims.workspaceId}", not "${options.workspace}"`);
    if (options.previousHead !== undefined && (prev?.head ?? null) !== options.previousHead) fail("the export is not chained onto the expected previous head");
    if (genesisHash(claims.workspaceId, prev?.head ?? null) !== claims.genesis) fail("the signed genesis does not match the workspace and previous-export link");
    if (doc.entries.length !== claims.count) fail(`the export holds ${doc.entries.length} entries but the signature covers ${claims.count}`);

    let previous = claims.genesis;
    let lastEvent;
    const seen = new Set();
    const from = claims.range?.from ?? null;
    const to = claims.range?.to ?? null;
    for (let i = 0; i < doc.entries.length; i++) {
      const entry = doc.entries[i];
      if (!isObject(entry) || !isObject(entry.event) || typeof entry.hash !== "string") { fail(`entry ${i} is malformed`); break; }
      const event = entry.event;
      if (event.workspaceId !== claims.workspaceId) fail(`entry ${i} belongs to another workspace`);
      if (typeof event.id !== "string" || typeof event.ts !== "string") { fail(`entry ${i} has no id or timestamp`); break; }
      if (seen.has(event.id)) fail(`entry ${i} repeats event id ${event.id}`);
      seen.add(event.id);
      if (lastEvent && (lastEvent.ts > event.ts || (lastEvent.ts === event.ts && lastEvent.id >= event.id))) fail(`entry ${i} is out of the signed order`);
      if (from !== null && event.ts < from) fail(`entry ${i} is before the signed range`);
      if (to !== null && event.ts > to) fail(`entry ${i} is after the signed range`);
      const expected = entryHash(previous, event);
      if (entry.hash !== expected) { fail(`entry ${i} (${event.id}) does not match its chain hash: the event or its position was altered`); break; }
      previous = expected;
      lastEvent = event;
    }
    if (errors.length === 0 && previous !== claims.head) fail("the recomputed chain head does not match the signed head");
    if (claims.count > 0 && errors.length === 0) {
      const first = doc.entries[0].event, last = doc.entries[doc.entries.length - 1].event;
      if (claims.firstEvent?.id !== first.id || claims.lastEvent?.id !== last.id) fail("the signed first/last event does not match the entries");
    }

    if (options.ledger !== undefined) {
      const rows = Array.isArray(options.ledger) ? options.ledger : options.ledger?.exports;
      if (!Array.isArray(rows)) fail("the ledger file is not a list of exports");
      else {
        const row = rows.find((r) => r?.id === claims.exportId && r?.workspaceId === claims.workspaceId);
        if (!row) fail("this export is not in the ledger (it was never recorded, or the ledger entry was removed)");
        else {
          if (row.head !== claims.head || row.eventCount !== claims.count || row.genesis !== claims.genesis) fail("the ledger records a different head, count or genesis for this export");
          if (row.signatureDigest !== sha256(doc.jws)) fail("the ledger records a different signature for this export");
          if ((row.previousExportId ?? null) !== (prev?.id ?? null) || (row.previousHead ?? null) !== (prev?.head ?? null)) fail("the ledger links a different previous export");
          if (prev && !rows.some((r) => r?.id === prev.id && r?.head === prev.head)) fail("the previous export named by this export is missing from the ledger");
        }
      }
    }
  } catch (e) {
    fail(`could not verify: ${e instanceof Error ? e.message : "unreadable input"}`);
  }
  return { ok: errors.length === 0, errors, claims };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

export function main(argv, stdout = process.stdout, stderr = process.stderr) {
  const a = args(argv);
  if (a._.length !== 1 || !a.keys) {
    stderr.write("usage: zenith-verify-audit-export EXPORT.json --keys PUBLIC_KEYS.json [--workspace ID] [--previous-head HEX64] [--ledger LEDGER.json]\n");
    return 2;
  }
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  let doc, keys, ledger;
  try {
    doc = read(a._[0]);
    keys = read(a.keys);
    ledger = a.ledger ? read(a.ledger) : undefined;
  } catch (e) {
    stderr.write(`zenith-verify-audit-export: cannot read input: ${e instanceof Error ? e.message : "error"}\n`);
    return 2;
  }
  if (a["previous-head"] !== undefined && !HEX64.test(a["previous-head"])) { stderr.write("--previous-head must be 64 hex characters\n"); return 2; }
  const result = verifyAuditExport(doc, { keys, workspace: a.workspace, previousHead: a["previous-head"], ledger });
  stdout.write(`${JSON.stringify({ verified: result.ok, exportId: result.claims?.exportId ?? null, workspaceId: result.claims?.workspaceId ?? null, count: result.claims?.count ?? null, head: result.claims?.head ?? null, errors: result.errors }, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
