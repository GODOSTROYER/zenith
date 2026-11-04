/**
 * PROD-OPS-07 follow-up: tenant-owned archive destinations and archive verify/restore, on real PGlite SQL (or explicitly gated owned PostgreSQL). The tenant
 * bucket is an in-memory S3 client double behind the real S3 adapter (contract level, no live S3 claim); the operator
 * bucket is a real temp directory. Keys are generated at runtime.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { FilesystemTarget } from "@/lib/hosted/backup/targets";
import type { ArchiveTarget } from "@/lib/retention/archive";
import { connectTenantDestination, createDestination, getActiveDestination, resolveDestination, revokeDestination, type ResolveDeps } from "@/lib/retention/destination";
import { retentionPass, type RetentionOptions } from "@/lib/retention/job";
import { parseRetentionPolicy, type PolicyLoad } from "@/lib/retention/policy";
import { restoreArchive, verifyArchive } from "@/lib/retention/restore";
import { listArchives } from "@/lib/retention/store";
import { retentionArchiveMain } from "../../scripts/retention-archive";
import { newWorkspace, seedApprovedOperation, uid } from "../controlplane/_support/harness";

const PUBKEY = "A".repeat(43);
const KEY = randomBytes(32);
const APPROVAL = { decision: "DEC-RETENTION", approvedBy: "test-operator", approvedAt: "2026-10-01T00:00:00.000Z" } as const;
const GATE = { ZENITH_RETENTION_APPLY: "1" };
const LOAD: PolicyLoad = (() => {
  const policy = parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90 } }, approval: APPROVAL });
  return { ok: true, policy, source: "inline", digest: "0".repeat(64) };
})();

const nativePostgres = process.env.ZENITH_TEST_RETENTION_PG === "1";
let db: PlatformDbHandle;
let dir: string;
let operator: FilesystemTarget;
let operatorPuts = 0;
const operatorTarget: ArchiveTarget = { label: "operator dir", put: async (k, b) => { operatorPuts++; await operator.put(k, b); }, get: (k) => operator.get(k) };
beforeAll(async () => {
  const pgUrl = process.env.ZENITH_TEST_PLATFORM_PG_URL;
  if (nativePostgres && !pgUrl) throw new Error("Explicit retention PostgreSQL gate requires an owned disposable ZENITH_TEST_PLATFORM_PG_URL.");
  db = await openPlatformDb(nativePostgres ? { kind: "postgres", url: pgUrl!, max: 2 } : { kind: "pglite" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-retention-restore-"));
  operator = new FilesystemTarget(dir);
}, 60_000);
afterAll(async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const run = (o: RetentionOptions) => retentionPass(db, { maxBatches: 100, maxPrunes: 100, key: KEY, recheckMs: 0, ...o });
const deps: ResolveDeps = { operator: operatorTarget };

async function runner(ws: string) {
  const { tokenHash } = repos.runners.generateRegistrationToken("runner");
  await repos.runners.createRegistrationToken(db, { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
  return repos.runners.registerRunner(db, { tokenHash, name: "r", publicKey: PUBKEY, capabilities: ["tofu.run"] });
}

async function jobWithLogs(ws: string, runnerId: string, ageDays: number, lines = 3): Promise<string> {
  const { operation } = await seedApprovedOperation(db, ws);
  const jobId = uid("job");
  await repos.jobs.enqueue(db, { id: jobId, workspaceId: ws, runnerId, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
  await repos.jobs.claimNext(db, { workspaceId: ws, runnerId, max: 1 });
  await repos.jobs.settle(db, { workspaceId: ws, runnerId, jobId, status: "succeeded", result: { exitCode: 0 } });
  for (let i = 0; i < lines; i++) {
    await db.query(
      `insert into platform.runner_job_logs (job_id, workspace_id, batch_seq, line_no, ts, stream, line, recorded_at)
       values ($1, $2, 0, $3, clock_timestamp(), 'stdout', $4, clock_timestamp() - ($5::int * interval '1 day'))`,
      [jobId, ws, i, `line-${i}-${randomBytes(6).toString("hex")}`, ageDays]);
  }
  return jobId;
}

const logCount = async (ws: string, jobId?: string): Promise<number> =>
  (await db.query<{ n: number }>("select count(*)::int as n from platform.runner_job_logs where workspace_id = $1 and ($2::text is null or job_id = $2)", [ws, jobId ?? null]))[0].n;

/** An archived-then-pruned workspace: logs gone from the source, present in the archive. */
async function archivedAndPruned(lines = 3) {
  const ws = newWorkspace();
  const { id: runnerId } = await runner(ws);
  const jobId = await jobWithLogs(ws, runnerId, 150, lines);
  await run({ env: GATE, load: LOAD, target: operatorTarget });
  await run({ env: GATE, load: LOAD, target: operatorTarget });
  expect(await logCount(ws, jobId)).toBe(0);
  const archive = (await listArchives(db, { workspaceId: ws })).find((a) => a.dataClass === "runner_job_logs")!;
  return { ws, jobId, archive };
}

describe("verify", () => {
  it("accepts an intact archive and rejects a tampered object, a wrong key and an unknown id", async () => {
    const { archive } = await archivedAndPruned(2);
    expect(await verifyArchive(db, archive.id, { deps, key: KEY })).toMatchObject({ ok: true, rows: 2 });
    expect(await verifyArchive(db, archive.id, { deps, key: randomBytes(32) })).toMatchObject({ ok: false });
    expect(await verifyArchive(db, "arc_missing", { deps, key: KEY })).toMatchObject({ ok: false, archive: null });
    const bytes = (await operator.get(archive.objectKey))!;
    const bad = Buffer.from(bytes);
    bad[bad.length - 3] ^= 0x01;
    await operator.put(archive.objectKey, bad);
    expect((await verifyArchive(db, archive.id, { deps, key: KEY })).ok).toBe(false);
    await operator.put(archive.objectKey, bytes);
    expect((await verifyArchive(db, archive.id, { deps, key: KEY })).ok).toBe(true);
    // another workspace cannot reach it by id
    expect((await verifyArchive(db, archive.id, { deps, key: KEY }, "ws_someone_else")).archive).toBeNull();
  });
});

describe("restore", () => {
  it("restores to a staging schema without touching platform, idempotently, with read-back and an audit row", async () => {
    const { ws, archive } = await archivedAndPruned(3);
    const r1 = await restoreArchive(db, { archiveId: archive.id, mode: "staging", stagingSuffix: "t1", actor: "op" }, { deps, key: KEY });
    expect(r1).toMatchObject({ verdict: "verified", mode: "staging", stagingSchema: "retention_stage_t1", selected: 3, inserted: 3, existingDiffer: 0 });
    expect(r1.auditId).toMatch(/^rrest_/);
    const staged = await db.query<{ n: number }>('select count(*)::int as n from "retention_stage_t1"."runner_job_logs" where workspace_id = $1', [ws]);
    expect(staged[0].n).toBe(3);
    expect(await logCount(ws)).toBe(0);
    const r2 = await restoreArchive(db, { archiveId: archive.id, mode: "staging", stagingSuffix: "t1", actor: "op" }, { deps, key: KEY });
    expect(r2).toMatchObject({ verdict: "verified", inserted: 0, existingIdentical: 3 });
    const audits = await db.query<{ n: number; who: string }>("select count(*)::int as n, min(requested_by) as who from platform.retention_restores where archive_id = $1", [archive.id]);
    expect(audits[0]).toEqual({ n: 2, who: "op" });
  });

  it("restores to the source table, never overwrites an existing row, and is idempotent", async () => {
    const { ws, jobId, archive } = await archivedAndPruned(3);
    const first = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op" }, { deps, key: KEY });
    expect(first).toMatchObject({ verdict: "verified", selected: 3, inserted: 3, skippedNoParent: 0 });
    expect(await logCount(ws, jobId)).toBe(3);
    const again = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op" }, { deps, key: KEY });
    expect(again).toMatchObject({ verdict: "verified", inserted: 0, existingIdentical: 3 });
    expect(await logCount(ws, jobId)).toBe(3);
    // a row changed after restore (newer state) is kept as it is
    await db.query("update platform.runner_job_logs set line = 'edited-after-restore' where job_id = $1 and line_no = 0", [jobId]);
    const third = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op" }, { deps, key: KEY });
    expect(third).toMatchObject({ verdict: "verified", inserted: 0, existingDiffer: 1, existingIdentical: 2 });
    const line = await db.query<{ line: string }>("select line from platform.runner_job_logs where job_id = $1 and line_no = 0", [jobId]);
    expect(line[0].line).toBe("edited-after-restore");
  });

  it("restores only the selected ids, and refuses ids that are not in the archive", async () => {
    const { ws, archive } = await archivedAndPruned(3);
    const refused = await restoreArchive(db, { archiveId: archive.id, mode: "source", rowIds: ["999999999"], actor: "op" }, { deps, key: KEY });
    expect(refused.verdict).toBe("refused");
    expect(await logCount(ws)).toBe(0);
    const staged = await restoreArchive(db, { archiveId: archive.id, mode: "staging", stagingSuffix: "pick", actor: "op" }, { deps, key: KEY });
    const one = await db.query<{ id: string }>('select id::text as id from "retention_stage_pick"."runner_job_logs" where workspace_id = $1 order by id limit 1', [ws]);
    expect(staged.inserted).toBe(3);
    const partial = await restoreArchive(db, { archiveId: archive.id, mode: "source", rowIds: [one[0].id], actor: "op" }, { deps, key: KEY });
    expect(partial).toMatchObject({ verdict: "verified", selected: 1, inserted: 1 });
    expect(await logCount(ws)).toBe(1);
  });

  it("skips rows whose parent no longer exists instead of failing", async () => {
    const { ws, jobId, archive } = await archivedAndPruned(2);
    await db.query("delete from platform.runner_jobs where id = $1 and workspace_id = $2", [jobId, ws]);
    const r = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op" }, { deps, key: KEY });
    expect(r).toMatchObject({ verdict: "verified", inserted: 0, skippedNoParent: 2 });
    expect(await logCount(ws)).toBe(0);
  });

  it("refuses (and audits the refusal) when the archive fails verification or the request is malformed", async () => {
    const { archive } = await archivedAndPruned(1);
    const bytes = (await operator.get(archive.objectKey))!;
    const bad = Buffer.from(bytes);
    bad[bad.length - 2] ^= 0x01;
    await operator.put(archive.objectKey, bad);
    const r = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op" }, { deps, key: KEY });
    expect(r.verdict).toBe("refused");
    expect(r.detail).toMatch(/verification/);
    expect(r.auditId).not.toBeNull();
    await operator.put(archive.objectKey, bytes);
    for (const suffix of ["Bad-Name", "x;drop", "", "a".repeat(41)]) {
      expect((await restoreArchive(db, { archiveId: archive.id, mode: "staging", stagingSuffix: suffix, actor: "op" }, { deps, key: KEY })).verdict).toBe("refused");
    }
    expect((await restoreArchive(db, { archiveId: "arc_nope", mode: "source", actor: "op" }, { deps, key: KEY })).verdict).toBe("refused");
    expect((await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op", workspaceId: "ws_other" }, { deps, key: KEY })).verdict).toBe("refused");
  });

  it("restores a legacy raw-backup archive only with explicit privileged purpose and key id, auditing refusals and success", async () => {
    const { ws, archive } = await archivedAndPruned(2);
    const env = { ZENITH_BACKUP_KEY: KEY.toString("base64") };
    const legacyKey = { originalPurpose: "enc:backup", keyId: archive.keyId, reason: "restore pre-separation archive" } as const;
    const guessed = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op" }, { deps, env });
    expect(guessed.verdict).toBe("refused"); expect(await logCount(ws)).toBe(0);
    const denied = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op", legacyKey }, { deps, env });
    expect(denied.verdict).toBe("refused"); expect(await logCount(ws)).toBe(0);
    const wrong = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op", legacyKey: { ...legacyKey, keyId: "wrong-key" } }, { deps, env, privileged: true });
    expect(wrong.verdict).toBe("refused"); expect(await logCount(ws)).toBe(0);
    const secretReason = `Bearer ${randomBytes(24).toString("hex")}`;
    const leaked = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op", legacyKey: { ...legacyKey, reason: secretReason } }, { deps, env, privileged: true });
    expect(leaked.verdict).toBe("refused"); expect(await logCount(ws)).toBe(0);
    expect((await db.query<{ legacy_reason: string | null }>("select legacy_reason from platform.retention_restores where id = $1", [leaked.auditId]))[0].legacy_reason).toBeNull();
    const restored = await restoreArchive(db, { archiveId: archive.id, mode: "source", actor: "op", legacyKey }, { deps, env, privileged: true });
    expect(restored).toMatchObject({ verdict: "verified", inserted: 2 }); expect(await logCount(ws)).toBe(2);
    const audit = await db.query<{ key_purpose: string; restore_key_id: string; legacy_reason: string; verdict: string }>("select key_purpose, restore_key_id, legacy_reason, verdict from platform.retention_restores where id = $1", [restored.auditId]);
    expect(audit[0]).toEqual({ key_purpose: "enc:backup", restore_key_id: archive.keyId, legacy_reason: legacyKey.reason, verdict: "verified" });
    expect(JSON.stringify(audit)).not.toContain(env.ZENITH_BACKUP_KEY);
  });

  it("keeps the restore audit append-only", async () => {
    const { archive } = await archivedAndPruned(1);
    const r = await restoreArchive(db, { archiveId: archive.id, mode: "staging", stagingSuffix: "audit", actor: "op" }, { deps, key: KEY });
    await expect(db.query("delete from platform.retention_restores where id = $1", [r.auditId])).rejects.toThrow();
    await expect(db.query("update platform.retention_restores set verdict = 'verified' where id = $1", [r.auditId])).rejects.toThrow();
  });
});

/* ------------------------------ tenant destinations ------------------------------ */

/** An in-memory S3 client double: the real S3ObjectStore adapter runs on top of it. */
function s3Double() {
  const objects = new Map<string, Buffer>();
  const client = {
    async send(command: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) {
      const name = command.constructor.name;
      if (name === "PutObjectCommand") { objects.set(command.input.Key, Buffer.from(command.input.Body!)); return {}; }
      if (name === "GetObjectCommand") {
        const hit = objects.get(command.input.Key);
        if (!hit) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => new Uint8Array(hit) } };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  return { objects, client };
}

const creds = (bucket: string) => JSON.stringify({ region: "us-east-1", bucket, accessKeyId: "AKIA" + randomBytes(6).toString("hex"), secretAccessKey: randomBytes(16).toString("hex") });
const specDigest = (s: string) => createHash("sha256").update(s).digest("hex");

async function bucketResource(ws: string, env: string, over: Partial<{ address: string; kind: string; ownership: "managed" | "referenced" | "external"; bucket: string }> = {}) {
  const address = over.address ?? "object_store/archive";
  await repos.resources.upsertDesired(db, {
    workspaceId: ws, environmentId: env, status: "active",
    node: {
      address, kind: over.kind ?? "object_store", provider: "aws", region: "us-east-1", nativeType: "aws_s3_bucket", ownership: over.ownership ?? "managed",
      externalRef: over.bucket ?? "tenant-archive-bucket", spec: { bucketName: over.bucket ?? "tenant-archive-bucket" }, origin: [], dependsOn: [], specDigest: specDigest(address), labels: {},
    } as never,
  });
  return address;
}

describe("tenant-owned archive destinations", () => {
  it("validates the destination like a LIFE-11 export: object store, tenant-owned, matching bucket, read-back probe", async () => {
    const ws = newWorkspace();
    const env = uid("env");
    const good = await bucketResource(ws, env);
    const s3 = s3Double();
    const secret = async () => creds("tenant-archive-bucket");
    const ok = await createDestination(db, { workspaceId: ws, environmentId: env, resourceAddress: good, credentialsRef: "vault:tenant/archive", actor: "admin" }, { secret, s3Client: s3.client });
    expect(ok).toMatchObject({ workspaceId: ws, bucket: "tenant-archive-bucket", revokedAt: null });
    expect(JSON.stringify(ok)).not.toMatch(/AKIA|secretAccessKey/);
    expect([...s3.objects.keys()].some((k) => k.startsWith("zenith-retention/probe/"))).toBe(true);
    expect((await getActiveDestination(db, ws))?.id).toBe(ok.id);

    const bad = (d: Partial<{ resourceAddress: string; secret: () => Promise<string | undefined> }>) =>
      createDestination(db, { workspaceId: ws, environmentId: env, resourceAddress: d.resourceAddress ?? good, credentialsRef: "vault:tenant/archive", actor: "admin" }, { secret: d.secret ?? secret, s3Client: s3.client });
    await expect(bad({ resourceAddress: "object_store/missing" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(bad({ secret: async () => creds("someone-elses-bucket") })).rejects.toThrow(/bucket/);
    await expect(bad({ secret: async () => undefined })).rejects.toThrow(/no value/);
    await expect(bad({ secret: async () => "not json" })).rejects.toThrow();
    const ext = await bucketResource(ws, env, { address: "object_store/external", ownership: "external" });
    await expect(bad({ resourceAddress: ext })).rejects.toThrow(/external/);
    const notBucket = await bucketResource(ws, env, { address: "postgres/db", kind: "postgres" });
    await expect(bad({ resourceAddress: notBucket })).rejects.toThrow(/object store/);
    // a destination of another workspace's environment is not reachable
    await expect(createDestination(db, { workspaceId: newWorkspace(), environmentId: env, resourceAddress: good, credentialsRef: "vault:x", actor: "a" }, { secret, s3Client: s3.client })).rejects.toThrow();
  });

  it("sends a workspace's archives to its own bucket, others to the operator's, and revoke returns to the fallback", async () => {
    const tenantWs = newWorkspace();
    const otherWs = newWorkspace();
    const env = uid("env");
    const addr = await bucketResource(tenantWs, env);
    const s3 = s3Double();
    const secret = async () => creds("tenant-archive-bucket");
    const dest = await createDestination(db, { workspaceId: tenantWs, environmentId: env, resourceAddress: addr, credentialsRef: "vault:tenant/archive", actor: "admin" }, { secret, s3Client: s3.client });
    const { id: r1 } = await runner(tenantWs);
    const { id: r2 } = await runner(otherWs);
    const tenantJob = await jobWithLogs(tenantWs, r1, 60, 2);
    await jobWithLogs(otherWs, r2, 60, 2);

    const before = operatorPuts;
    const res = await run({ env: {}, load: LOAD, target: operatorTarget, tenant: { secret, s3Client: s3.client } });
    expect(res.destinationUnavailable).toBe(0);
    const tenantArchive = (await listArchives(db, { workspaceId: tenantWs }))[0];
    const otherArchive = (await listArchives(db, { workspaceId: otherWs }))[0];
    expect(tenantArchive).toMatchObject({ destinationId: dest.id });
    expect(tenantArchive.destinationLabel).toContain("s3://tenant-archive-bucket/");
    expect(s3.objects.has(`zenith-retention/${tenantArchive.objectKey}`)).toBe(true);
    expect(otherArchive.destinationId).toBeNull();
    expect(await operator.get(otherArchive.objectKey)).not.toBeNull();
    expect(await operator.get(tenantArchive.objectKey)).toBeNull();
    expect(operatorPuts - before).toBeGreaterThanOrEqual(1);

    // verify and restore read from the tenant's bucket
    const rdeps: ResolveDeps = { operator: operatorTarget, secret, s3Client: s3.client };
    expect(await verifyArchive(db, tenantArchive.id, { deps: rdeps, key: KEY })).toMatchObject({ ok: true, rows: 2 });
    expect((await verifyArchive(db, tenantArchive.id, { deps, key: KEY })).ok).toBe(false);
    const staged = await restoreArchive(db, { archiveId: tenantArchive.id, mode: "staging", stagingSuffix: "tenant", actor: "op" }, { deps: rdeps, key: KEY });
    expect(staged).toMatchObject({ verdict: "verified", selected: 2 });
    expect(await logCount(tenantWs, tenantJob)).toBe(2);

    // revoke: new archives go to the operator again; the old one stays readable while credentials resolve
    expect((await revokeDestination(db, tenantWs, "admin"))?.revokedBy).toBe("admin");
    expect(await getActiveDestination(db, tenantWs)).toBeNull();
    expect(await revokeDestination(db, tenantWs, "admin")).toBeNull();
    const r = await resolveDestination(db, tenantWs, rdeps);
    expect(r).toMatchObject({ ok: true, destination: { kind: "operator", id: null } });
    const old = await resolveDestination(db, tenantWs, rdeps, { destinationId: dest.id });
    expect(old).toMatchObject({ ok: true, destination: { kind: "tenant", id: dest.id } });
  });

  it("never falls back to the operator bucket when the tenant's destination stops working", async () => {
    const ws = newWorkspace();
    const env = uid("env");
    const addr = await bucketResource(ws, env);
    const s3 = s3Double();
    await createDestination(db, { workspaceId: ws, environmentId: env, resourceAddress: addr, credentialsRef: "vault:tenant/archive", actor: "admin" }, { secret: async () => creds("tenant-archive-bucket"), s3Client: s3.client });
    const { id: runnerId } = await runner(ws);
    await jobWithLogs(ws, runnerId, 60, 2);
    const before = operatorPuts;
    const res = await run({ env: {}, load: LOAD, target: operatorTarget, tenant: { secret: async () => undefined, s3Client: s3.client } });
    expect(res.destinationUnavailable).toBeGreaterThanOrEqual(1);
    expect(operatorPuts).toBe(before);
    expect(await listArchives(db, { workspaceId: ws })).toHaveLength(0);
    expect(await logCount(ws)).toBe(2);
  });

  it("a revoked destination row cannot be edited or deleted, and only one is active per workspace", async () => {
    const ws = newWorkspace();
    const env = uid("env");
    const addr = await bucketResource(ws, env);
    const s3 = s3Double();
    const deps2 = { secret: async () => creds("tenant-archive-bucket"), s3Client: s3.client };
    const a = await createDestination(db, { workspaceId: ws, environmentId: env, resourceAddress: addr, credentialsRef: "vault:a", actor: "admin" }, deps2);
    const b = await createDestination(db, { workspaceId: ws, environmentId: env, resourceAddress: addr, credentialsRef: "vault:b", actor: "admin" }, deps2);
    expect((await getActiveDestination(db, ws))?.id).toBe(b.id);
    await expect(db.query("delete from platform.retention_destinations where id = $1", [a.id])).rejects.toThrow();
    await expect(db.query("update platform.retention_destinations set bucket = 'other-bucket' where id = $1", [a.id])).rejects.toThrow();
    await expect(db.query("update platform.retention_destinations set revoked_at = null, revoked_by = null where id = $1", [a.id])).rejects.toThrow();
    await expect(connectTenantDestination(db, { workspaceId: ws, environmentId: env, resourceAddress: addr, credentialsRef: "vault:a" }, { secret: async () => creds("wrong-bucket-name"), s3Client: s3.client })).rejects.toThrow(/bucket/);
  });
});


if (nativePostgres) describe("legacy archive CLI [real PostgreSQL]", () => {
  it("uses the real privileged CLI and original-purpose key, with independent row and audit readback", async () => {
    const { ws, archive } = await archivedAndPruned(2);
    const env = { ZENITH_PLATFORM_DB: "postgres", ZENITH_PLATFORM_DB_URL: process.env.ZENITH_TEST_PLATFORM_PG_URL,
      ZENITH_RETENTION_ARCHIVE_TARGET: "filesystem", ZENITH_RETENTION_ARCHIVE_DIR: dir, ZENITH_BACKUP_KEY: KEY.toString("base64") };
    const output: string[] = [], errors: string[] = [];
    const runCli = (args: string[]) => retentionArchiveMain(args, line => output.push(line), line => errors.push(line), env);
    expect(await runCli(["list", "--workspace", ws])).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ id: archive.id, keyId: archive.keyId });
    expect(await runCli(["restore", archive.id, "--source"])).toBe(1);
    expect(await logCount(ws)).toBe(0);
    const named = ["restore", archive.id, "--source", "--legacy-purpose", "enc:backup", "--legacy-key-id", archive.keyId, "--reason", "native legacy rehearsal"];
    expect(await runCli(named)).toBe(0); expect(await logCount(ws)).toBe(2);
    const rows = await db.query<{ key_purpose: string; restore_key_id: string; requested_by: string; verdict: string; rows_inserted: number }>(
      "select key_purpose,restore_key_id,requested_by,verdict,rows_inserted from platform.retention_restores where workspace_id=$1 and archive_id=$2 and verdict='verified'", [ws, archive.id]);
    expect(rows).toEqual([{ key_purpose: "enc:backup", restore_key_id: archive.keyId, requested_by: "cli:operator", verdict: "verified", rows_inserted: 2 }]);
    expect(await runCli(named)).toBe(0); expect(await logCount(ws)).toBe(2);
    expect([...output, ...errors].join(" ")).not.toContain(env.ZENITH_BACKUP_KEY);
    expect([...output, ...errors].join(" ")).not.toContain(env.ZENITH_PLATFORM_DB_URL);
  });
});
