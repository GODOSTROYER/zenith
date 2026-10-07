/**
 * PROD-DUR-06: state backend restore on the real platform schema (PGlite always, PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is
 * set). The OBJECT STORE is a scripted in-memory versioned bucket behind the same port the AWS adapter implements, so these
 * cases prove ownership, approval binding, the guarded state machine, lease exclusion and fail-closed behaviour, not real S3.
 * The plan artifact rows that prove ownership are explicitly synthetic storage.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import * as repos from "@/lib/controlplane/db/repos";
import * as recovery from "@/lib/controlplane/db/repos/state-backend-recovery";
import { proposeOperation } from "@/lib/controlplane/operations";
import type { Principal, Sql } from "@/lib/controlplane/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import { BrokerError } from "@/lib/capabilities/errors";
import { backendForConnection } from "@/lib/tofu/backends";
import type { BackendProbeVerdict } from "@/lib/tofu/backend-capabilities";
import { StateBackendError, type StateBackendStore, type StateObjectVersion } from "@/lib/tofu/state-backend-s3";
import { backendDigestFor, createStateRecovery, type RecoveryCaller } from "@/lib/platform/state-recovery";
import { LANES, newWorkspace, openLane, proposalFor, uid, user } from "./_support/harness";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const future = "2099-01-01T00:00:00.000Z";

class FakeStore implements StateBackendStore {
  versions = [{ id: "v1", bytes: Buffer.from('{"serial":1}'), etag: '"e1"' }, { id: "v2", bytes: Buffer.from('{"serial":2}'), etag: '"e2"' }];
  lock = false; versioning: BackendProbeVerdict["versioning"] = "enabled"; corruptReadback = false; writes = 0; counter = 2;
  private latest() { return this.versions[this.versions.length - 1]; }
  async probe(): Promise<BackendProbeVerdict> {
    return { backendKind: "s3", versioning: this.versioning, encryption: "sse_s3", lockObject: this.lock ? "present" : "absent", currentVersionId: this.latest().id,
      restoreReady: this.versioning === "enabled" && !this.lock, refusals: [] };
  }
  async listVersions(): Promise<StateObjectVersion[]> { return [...this.versions].reverse().map((v, i) => ({ versionId: v.id, isLatest: i === 0, size: v.bytes.length })); }
  async readVersion(id: string) {
    const v = this.versions.find(x => x.id === id);
    if (!v) throw new StateBackendError("version_unavailable", "missing");
    return { bytes: v.bytes, sha256: sha(v.bytes), versionId: v.id, etag: v.etag };
  }
  async readCurrent() { const v = this.latest(); return { bytes: v.bytes, sha256: sha(v.bytes), versionId: v.id, etag: v.etag }; }
  async writeRestored(bytes: Buffer, expect: { currentEtag: string }) {
    if (this.latest().etag !== expect.currentEtag) throw new StateBackendError("state_changed", "changed");
    this.writes++; this.counter++;
    this.versions.push({ id: `v${this.counter}`, bytes: this.corruptReadback ? Buffer.from("corrupt") : Buffer.from(bytes), etag: `"e${this.counter}"` });
    return { versionId: `v${this.counter}` };
  }
}

describe.each(LANES)("state backend recovery [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let db: Sql;
  beforeAll(async () => { ctx = await openLane(lane); db = ctx.db; }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  const awsConnection = (workspaceId: string): ProviderConnection => ({ id: uid("conn"), workspaceId, status: "verified", createdBy: "u", createdAt: new Date().toISOString(),
    config: { provider: "aws", mode: "static_dev", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/o", deployRoleArn: "arn:aws:iam::123456789012:role/d",
      region: "us-east-1", stateBucket: "ws-state-bucket" } } as unknown as ProviderConnection);
  const gcpConnection = (workspaceId: string): ProviderConnection => ({ id: uid("conn"), workspaceId, status: "verified", createdBy: "u", createdAt: new Date().toISOString(),
    config: { provider: "gcp", region: "us-central1", stateBucket: "ws-gcs-state-bucket" } } as unknown as ProviderConnection);

  async function seedArtifact(workspaceId: string, environmentId: string, connection: ProviderConnection) {
    const { backend, stateKey } = backendForConnection(connection, { workspaceId, environmentId });
    const backendDigest = backendDigestFor(backend, (connection.config as { region: string }).region, stateKey);
    const { operation: op } = await proposeOperation(db, { workspaceId, principal: user(),
      proposal: proposalFor(workspaceId, { scope: { workspaceId, projectId: "proj_1", environmentId } }), status: "approved" });
    const planDigest = digest({ plan: op.id });
    const manifest = { workspaceId, operationId: op.id, projectId: "proj_1", environmentId, planDigest, backendDigest };
    await db.query(`insert into platform.plan_artifacts (workspace_id,operation_id,manifest,manifest_digest,plan_digest,iv,auth_tag,ciphertext,expires_at)
      values ($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,$9::timestamptz)`,
      [workspaceId, op.id, JSON.stringify(manifest), digest(manifest), planDigest, "x".repeat(16), "x".repeat(24), "synthetic-encrypted-storage", future]);
    return { backendDigest, stateKey };
  }
  const human = (id: string, workspaceId: string): RecoveryCaller => ({ principal: { kind: "user", id, name: id }, workspaceId, session: { method: "browser_session", subject: id, verifiedAtMs: Date.now() } });
  async function world(opts: { connection?: (ws: string) => ProviderConnection; store?: FakeStore | null } = {}) {
    const workspaceId = newWorkspace(), environmentId = uid("env");
    const connection = (opts.connection ?? awsConnection)(workspaceId);
    const store = opts.store === null ? undefined : opts.store ?? new FakeStore();
    const seeded = await seedArtifact(workspaceId, environmentId, connection);
    const service = createStateRecovery({
      db, roles: { resolve: async (p: Principal) => ({ role: p.id.startsWith("viewer") ? "viewer" : "admin" }) },
      connection: async (ws, id) => (ws === workspaceId && id === connection.id ? connection : null),
      secret: async (ws, ref) => (ws === workspaceId && ref === "vault:state-creds" ? JSON.stringify({ accessKeyId: "id-value", secretAccessKey: "secret-value" }) : undefined),
      ...(store ? { openStore: async () => store } : {}),
    });
    const input = (sourceVersionId = "v1") => ({ environmentId, connectionId: connection.id, credentialsRef: "vault:state-creds", sourceVersionId });
    return { workspaceId, environmentId, connection, store: store!, service, input, ...seeded, approver: human("approver-1", workspaceId) };
  }
  const code = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "ok"; } catch (e) { return e instanceof BrokerError ? e.code : `other:${String(e)}`; } };

  it("describes the capability matrix and rejects a connection from another workspace", async () => {
    const w = await world();
    const view = await w.service.describe(w.approver, w.environmentId, w.connection.id);
    expect(view).toMatchObject({ backendKind: "s3", stateKey: `zenith/${w.workspaceId}/${w.environmentId}/terraform.tfstate`, restores: [], evidence: "contract" });
    expect(view.capabilities).toMatchObject({ locking: "supported", versioning: "unverified", restoreAdapter: true });
    expect(await code(w.service.describe(human("approver-1", newWorkspace()), w.environmentId, w.connection.id))).toBe("not_found");
  });

  it("refuses to propose for a backend with no recorded plan, proving ownership first", async () => {
    const w = await world();
    const stranger = createStateRecovery({ db, roles: { resolve: async () => ({ role: "admin" as const }) }, connection: async () => w.connection, secret: async () => undefined });
    expect(await code(stranger.propose(w.approver, { ...w.input(), environmentId: uid("env") }))).toBe("invalid_state");
  });

  it("proposes, binds the exact effect, and approval needs the exact digest and a person", async () => {
    const w = await world();
    const proposed = await w.service.propose(w.approver, w.input());
    expect(proposed).toMatchObject({ status: "proposed", sourceVersionId: "v1", currentVersionId: "v2", sourceSha256: sha(Buffer.from('{"serial":1}')) });
    expect((await w.service.propose(w.approver, w.input())).id).toBe(proposed.id); // identical live proposal is idempotent
    const integration: RecoveryCaller = { principal: { kind: "integration", id: "int-1", name: "agent", onBehalfOf: "approver-1", integrationId: "link" }, workspaceId: w.workspaceId };
    expect(await code(w.service.approve(integration, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest }))).toBe("approver_not_human");
    expect(await code(w.service.approve(human("viewer-1", w.workspaceId), { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest }))).toBe("role_insufficient");
    expect(await code(w.service.approve(w.approver, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: "f".repeat(64) }))).toBe("digest_mismatch");
    expect(await code(w.service.approve(w.approver, { environmentId: uid("env"), restoreId: proposed.id, proposalDigest: proposed.proposalDigest }))).toBe("not_found");
    expect(await code(w.service.approve(human("approver-1", newWorkspace()), { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest }))).toBe("not_found");
    expect(await code(w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }))).toBe("approval_required");
    const approved = await w.service.approve(w.approver, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest });
    expect(approved).toMatchObject({ status: "approved", approvedBy: "approver-1" });
    expect(await code(w.service.approve(w.approver, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest }))).toBe("digest_mismatch");
  });

  it("runs an approved restore: new current version, readback proof, nothing deleted", async () => {
    const w = await world();
    const proposed = await w.service.propose(w.approver, w.input());
    await w.service.approve(w.approver, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest });
    const done = await w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id });
    expect(done).toMatchObject({ status: "restored", readbackSha256: sha(Buffer.from('{"serial":1}')) });
    expect(done.restoredVersionId).toBe("v3");
    expect(w.store.versions.map(v => v.id)).toEqual(["v1", "v2", "v3"]);
    expect(w.store.versions[2].bytes.toString()).toBe('{"serial":1}');
    expect(await code(w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }))).toBe("approval_required");
    expect(w.store.writes).toBe(1);
    // The environment lease was released, and a probe row was stored as immutable evidence.
    expect(await repos.leases.acquire(db, { scope: `env:${w.environmentId}`, holder: "after-restore", ttlMs: 60_000, workspaceId: w.workspaceId })).not.toBeNull();
    expect((await recovery.latestProbe(db, w.workspaceId, w.environmentId, w.backendDigest))?.verdict.versioning).toBe("enabled");
  });

  it("refuses when the state changed or is locked after review and writes nothing", async () => {
    const w = await world();
    const proposed = await w.service.propose(w.approver, w.input());
    await w.service.approve(w.approver, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest });
    w.store.versions.push({ id: "v9", bytes: Buffer.from('{"serial":9}'), etag: '"e9"' });
    expect(await code(w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }))).toBe("invalid_state");
    w.store.versions.pop();
    w.store.lock = true;
    expect(await code(w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }))).toBe("invalid_state");
    expect(w.store.writes).toBe(0);
    expect((await recovery.get(db, w.workspaceId, proposed.id))?.status).toBe("approved");
  });

  it("refuses to propose when versioning is not proven enabled", async () => {
    const store = new FakeStore(); store.versioning = "disabled";
    const w = await world({ store });
    expect(await code(w.service.propose(w.approver, w.input()))).toBe("invalid_state");
    expect(await db.query("select 1 from platform.state_backend_restores where workspace_id=$1", [w.workspaceId])).toHaveLength(0);
  });

  it("records a restore that does not read back as approved as failed_uncertain and never retries", async () => {
    const store = new FakeStore();
    const w = await world({ store });
    const proposed = await w.service.propose(w.approver, w.input());
    await w.service.approve(w.approver, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest });
    store.corruptReadback = true;
    expect(await code(w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }))).toBe("invalid_state");
    expect(await recovery.get(db, w.workspaceId, proposed.id)).toMatchObject({ status: "failed_uncertain", failureCode: "readback_mismatch" });
    expect(await code(w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }))).toBe("approval_required");
    expect(store.writes).toBe(1);
    expect(store.versions.map(v => v.id)).toEqual(["v1", "v2", "v3"]); // the original versions remain
  });

  it("lets exactly one of two concurrent executions write", async () => {
    const w = await world();
    const proposed = await w.service.propose(w.approver, w.input());
    await w.service.approve(w.approver, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest });
    const results = await Promise.allSettled([
      w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }),
      w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(w.store.writes).toBe(1);
    expect(w.store.versions).toHaveLength(3);
  });

  it("refuses a backend whose credentials secret is not usable for its provider and creates nothing", async () => {
    const w = await world({ connection: gcpConnection, store: null });
    expect(await code(w.service.propose(w.approver, w.input()))).toBe("invalid_state");
    expect(await db.query("select 1 from platform.state_backend_restores where workspace_id=$1", [w.workspaceId])).toHaveLength(0);
  });

  it("the database refuses edits to a reviewed proposal, invalid transitions and any delete", async () => {
    const w = await world();
    const proposed = await w.service.propose(w.approver, w.input());
    await expect(db.query("update platform.state_backend_restores set source_version_id='v1x' where workspace_id=$1 and id=$2", [w.workspaceId, proposed.id])).rejects.toThrow();
    await expect(db.query("update platform.state_backend_restores set status='restored' where workspace_id=$1 and id=$2", [w.workspaceId, proposed.id])).rejects.toThrow();
    await expect(db.query("delete from platform.state_backend_restores where workspace_id=$1 and id=$2", [w.workspaceId, proposed.id])).rejects.toThrow();
    await expect(db.query("update platform.state_backend_probes set backend_kind='s3' where workspace_id=$1", [w.workspaceId])).rejects.toThrow();
  });

  it("a rejected proposal can never be approved or executed, and expiry sweeps change nothing live", async () => {
    const w = await world();
    const proposed = await w.service.propose(w.approver, w.input());
    expect(await recovery.expireStale(db, w.workspaceId)).toBe(0);
    const rejected = await w.service.reject(w.approver, { environmentId: w.environmentId, restoreId: proposed.id });
    expect(rejected.status).toBe("rejected");
    expect(await code(w.service.approve(w.approver, { environmentId: w.environmentId, restoreId: proposed.id, proposalDigest: proposed.proposalDigest }))).toBe("digest_mismatch");
    expect(await code(w.service.execute(w.approver, { environmentId: w.environmentId, restoreId: proposed.id }))).toBe("approval_required");
    expect(w.store.writes).toBe(0);
  });
});
