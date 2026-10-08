/** J15 operated private-source admission. A deliberately revoked source MUST never reach build/apply. */
import path from "node:path";
import { ensure, ok, until } from "../../../tests/e2e/default/support.mjs";
import { immutableSourceSnapshot, sourceSnapshotDigest } from "@/lib/execution/source-snapshot";
import { githubFixture } from "./github-fixture";
import { runOperated, driverCli, hash, type Operated } from "./operated";

export function assertSnapshot(row: { snapshot: unknown; snapshot_digest: string }, expected: {
  workspaceId: string; projectId: string; environmentId: string; operationId: string; commit: string; archive: string; dockerfile: string;
}) {
  const s = immutableSourceSnapshot(row.snapshot);
  ensure(s.workspaceId === expected.workspaceId && s.projectId === expected.projectId && s.environmentId === expected.environmentId
    && s.operationId === expected.operationId && s.commitSha === expected.commit && s.archiveDigest === expected.archive
    && s.dockerfileDigest === hash(expected.dockerfile) && s.githubBinding?.appId === "815" && s.githubBinding.repositoryId === 817
    && s.requestedRef === "main" && sourceSnapshotDigest(s) === row.snapshot_digest, "independent-exact-source-snapshot");
  return s;
}
export async function run(receipt: string, env = process.env) {
  return runOperated("private-source", receipt, env, async (ctx, step) => {
    let fixture!: Awaited<ReturnType<typeof githubFixture>>;
    await step("browser-source-binding", async () => {
      fixture = await githubFixture(ctx);
      await ctx.a!.goto(ctx.stack!.apiUrl + "/api/platform/v1/github/callback");
      await ctx.a!.getByLabel("Repository (owner/name)").fill(fixture.fixture.repository);
      await ctx.a!.getByRole("button", { name: "Install and bind repository", exact: true }).click();
      await ctx.a!.getByRole("heading", { name: "GitHub source connected", exact: true }).waitFor();
      const binding = ok(await ctx.request("/api/platform/v1/github/binding"));
      ensure(binding.binding?.state === "connected" && binding.binding.owner + "/" + binding.binding.repo === fixture.fixture.repository, "source-binding-readback");
    });
    let operationId = "", initialDigest = "";
    await step("private-source-snapshot", async () => {
      const manifest = ctx.manifest("private-source-local");
      const source = { type: "git", repo: "github.com/" + fixture.fixture.repository, ref: "main", dockerfile: "Dockerfile" };
      await ctx.action("project.updateManifest", { projectId: ctx.project!.id, manifest: { ...manifest, services: [{ ...manifest.services[0], source }] } });
      const proposal = await ctx.propose(); operationId = proposal.operationId;
      const rows = await snapshotRows(ctx, operationId);
      ensure(rows.length === 1, "one-retained-source");
      const snapshot = assertSnapshot(rows[0]!, { workspaceId: ctx.workspaceId, projectId: ctx.project!.id, environmentId: ctx.environmentId,
        operationId, commit: fixture.fixture.commit, archive: fixture.expectedArchive, dockerfile: fixture.fixture.dockerfile });
      initialDigest = rows[0]!.snapshot_digest;
      const reviewed = await ctx.detail(operationId), view = reviewed.planReview?.view;
      ensure(view?.approvedSources?.length === 1 && view.approvedSources[0].commit === snapshot.commitSha
        && view.approvedSources[0].archiveDigest === snapshot.archiveDigest, "reviewed-exact-source");
      await fixture.control(true, false); // moving a branch cannot rewrite the retained immutable snapshot
    });
    let paused = false;
    const worker = (await ctx.stack!.modules.compose(ctx.stack!.state, ["ps", "-q", "execution-worker"])).trim();
    const recover = async () => { if (paused) { await ctx.stack!.modules.docker(["unpause", worker]); paused = false; } };
    ctx.recoveries.push({ id: "unpause-owned-source-worker", run: recover });
    try {
      await step("browser-snapshot-approval", async () => {
        const [current] = JSON.parse(await ctx.stack!.modules.docker(["inspect", worker]));
        ensure(current.Config.Labels?.["io.zenith.installation"] === ctx.stack!.state.applicationInstallationId, "owned-worker-injection");
        // Hold only the owned local worker while the genuine UI records approval and revocation.
        // This closes the race where a valid approval could dispatch before our intended injection.
        await ctx.stack!.modules.docker(["pause", worker]); paused = true;
        await ctx.approve(operationId);
        await ctx.a!.goto(ctx.stack!.apiUrl + "/api/platform/v1/github/callback");
        await ctx.a!.getByRole("button", { name: "Revoke source access", exact: true }).click();
        await ctx.a!.getByRole("heading", { name: "GitHub source revoked", exact: true }).waitFor();
        ensure(ok(await ctx.request("/api/platform/v1/github/binding")).binding?.state === "revoked", "browser-source-revoked");
      });
    } finally { await recover(); }
    await step("source-revocation-refused", async () => {
      const terminal = await ctx.settle(operationId);
      ensure(terminal.operation.status === "failed" && /source|binding|github/i.test(terminal.operation.error ?? ""), "source-refusal-required");
      const response = await ctx.request("/api/platform/v1/github/inspect?ref=main");
      ensure(response.status === 403 && response.data.error?.message === "GitHub source access was refused.", "revoked-source-no-anonymous-fallback");
    });
    await step("independent-source-readback", async () => {
      await ctx.eventReadback(operationId);
      const rows = await snapshotRows(ctx, operationId);
      ensure(rows.length === 1 && rows[0]!.snapshot_digest === initialDigest, "snapshot-not-recaptured");
      assertSnapshot(rows[0]!, { workspaceId: ctx.workspaceId, projectId: ctx.project!.id, environmentId: ctx.environmentId, operationId,
        commit: fixture.fixture.commit, archive: fixture.expectedArchive, dockerfile: fixture.fixture.dockerfile });
      const stats = await fixture.stats();
      ensure(stats.minted >= 1 && stats.authenticated >= 1 && stats.archiveReads >= 1 && stats.movedArchiveReads === 0, "private-authenticated-pinned-reads");
      const workloads = JSON.parse(await ctx.kubectl(["get", "deployments,jobs", "-o", "json"]));
      ensure(!workloads.items.some((v: { metadata: { annotations?: Record<string, string> } }) => v.metadata.annotations?.["zenith.dev/environment"] === ctx.environmentId), "no-source-effect-after-revocation");
      const effects = await ctx.sql("select effect_id from platform.external_effects where workspace_id=$1 and operation_id=$2", [ctx.workspaceId, operationId]);
      ensure(effects.length === 0, "no-provider-dispatch-after-revocation");
    });
  }, ["GitHub provider HTTP/OAuth is an authenticated local emulator; no live GitHub installation is established.",
    "The declared build profile binds review semantics. Source revocation deliberately prevents apply/build; running build isolation and private-build deployment are not established."]);
}
async function snapshotRows(ctx: Operated, operationId: string) {
  return until(() => ctx.sql<{ snapshot: unknown; snapshot_digest: string }>(
    "select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and project_id=$2 and environment_id=$3 and operation_id=$4",
    [ctx.workspaceId, ctx.project!.id, ctx.environmentId, operationId]), (rows: { snapshot: unknown; snapshot_digest: string }[]) => rows.length === 1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/release/drivers/private-source.ts"))
  void driverCli(run, process.argv.slice(2)).then(code => { process.exitCode = code; });
