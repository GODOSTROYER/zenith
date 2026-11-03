import { describe, expect, it, vi } from "vitest";
import { buildRunHandoff, createRunHandoff, HANDOFF_TTL_MS } from "@/lib/coding-agent/handoff";
import { digest } from "@/lib/controlplane/digest";
import { contentHash } from "@/lib/domain/hash";
import type { CodingAgentRunRow } from "@/lib/coding-agent/store";

const NOW = new Date("2026-11-03T10:00:00Z");
const commit = "a".repeat(40);
const token = "ghp_" + "Z".repeat(36);
function row(): CodingAgentRunRow {
  return { id: "run-a", workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-a", createdBy: "alice", status: "completed", model: "test", task: `Improve deployment. api_key="${token}"`,
    source: { repository: "owner/repo", repositoryId: 17, commit, root: "apps/web", contextDir: "", bindingId: "binding-a", bindingVersion: 3,
      sourceIdentity: { owner: "owner", repo: "repo", repositoryId: 17, commitSha: commit, binding: { appId: "app-1", installationId: 2, repositoryId: 17, version: 3 } } },
    limits: {}, usage: {}, workflowId: "wf-a", version: 5, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    checkpoint: { messages: [{ role: "user", content: token }], targetBase: { manifestHash: "b".repeat(64), manifest: { secret: token } } },
    result: { finalText: `Use a database. access_token=${token}`, artifact: { manifestDigest: "c".repeat(64), requirementsDigest: "d".repeat(64), explanations: [`api_key="${token}"`], unresolved: ["Confirm database size"], confidence: "medium",
      manifest: { services: [{ id: "web", kind: "web", env: [{ key: "PASSWORD", value: token }] }], resources: [{ id: "db", kind: "postgres", config: { token } }] } } },
  };
}

describe("repository continuation context", () => {
  it("accepts the actual domain working-copy hash while keeping artifact and context digests SHA-256", () => {
    const stored = row();
    const manifest = { version: 1, services: [], resources: [], routes: [], bindings: [] };
    const manifestHash = contentHash(manifest);
    expect(manifestHash).toHaveLength(8);
    stored.checkpoint = { targetBase: { manifest, manifestHash } };
    const handoff = buildRunHandoff(stored, NOW);
    expect(handoff.context.baseManifestHash).toBe(manifestHash);
    expect(handoff.digest).toHaveLength(64);
    expect(handoff.context.analysis.manifestDigest).toHaveLength(64);
  });
  it("exports deterministic exact provenance and redacted findings without a transcript or manifest values", () => {
    const source = row();
    const handoff = buildRunHandoff(source, NOW);
    expect(handoff.context.source).toMatchObject({ repositoryId: 17, commit, bindingId: "binding-a", bindingVersion: 3, root: "apps/web" });
    expect(handoff.digest).toBe(digest(handoff.context));
    expect(buildRunHandoff(source, new Date(NOW.getTime() + 60_000))).toEqual(handoff);
    expect(handoff.context.baseManifestHash).toBe("b".repeat(64));
    expect(handoff.context.analysis.services[0].environmentVariableNames).toEqual(["PASSWORD"]);
    expect(handoff.mcp?.arguments.expectedDigest).toBe(handoff.digest);
    expect(handoff.context).not.toHaveProperty("checkpoint");
    expect(handoff.context.analysis).not.toHaveProperty("manifest");
    expect(JSON.stringify(handoff)).not.toContain(token);
    expect(JSON.stringify(source)).toContain(token);
  });
  it("refuses old, inconsistent, cancelled, running or expired source contexts", () => {
    const old = row(); old.source = { repository: "owner/repo", commit };
    expect(() => buildRunHandoff(old, NOW)).toThrow(/exact source identity/);
    const other = row(); (other.source as { commit: string }).commit = "f".repeat(40);
    expect(() => buildRunHandoff(other, NOW)).toThrow(/inconsistent/);
    for (const status of ["running", "cancelled"] as const) expect(() => buildRunHandoff({ ...row(), status }, NOW)).toThrow(/before preparing a handoff/);
    expect(() => buildRunHandoff(row(), new Date(NOW.getTime() + HANDOFF_TTL_MS))).toThrow(/expired/);
    expect(() => buildRunHandoff({ ...row(), checkpoint: {} }, NOW)).toThrow(/captured target revision/);
    for (const fields of [{ payloadPurgedAt: NOW.toISOString() }, { payloadExpiresAt: NOW.toISOString() }, { payloadExpiresAt: "invalid" }]) {
      expect(() => buildRunHandoff({ ...row(), ...fields }, NOW)).toThrow(/expired/);
    }
    const shorter = new Date(NOW.getTime() + 1_000).toISOString();
    expect(buildRunHandoff({ ...row(), payloadExpiresAt: shorter }, NOW).expiresAt).toBe(shorter);
  });
  it("allows a paused partial run and targetless downloadable context without an overbroad MCP target", () => {
    const partial = row(); partial.status = "budget_exhausted"; delete partial.projectId; delete partial.environmentId;
    const result = partial.result as { artifact: unknown; finalText: string };
    partial.checkpoint = { ...partial.checkpoint as object, artifact: result.artifact, finalText: result.finalText, coverage: { retainedFiles: 42, readPaths: ["package.json"], truncated: true } };
    delete partial.result;
    const handoff = buildRunHandoff(partial, NOW);
    expect(handoff.context.analysis.partial).toBe(true);
    expect(handoff.context.analysis.summary).toContain("Use a database");
    expect(handoff.context.analysis.unresolved).toEqual(["Confirm database size"]);
    expect(handoff.context.analysis.inspection).toEqual({ retainedFiles: 42, readFiles: 1, truncated: true });
    expect(JSON.stringify(handoff)).not.toContain(token);
    expect(handoff.context.target).toBeNull();
    expect(handoff.mcp).toBeNull();
  });
  it("checks tenant, target, version and digest before touching provider authority", async () => {
    const stored = row();
    const store = { get: vi.fn(async (workspaceId: string) => workspaceId === stored.workspaceId ? stored : null) };
    const authorizeSource = vi.fn(async () => undefined);
    const deps = { store, authorizeSource };
    for (const req of [
      { workspaceId: "foreign", runId: stored.id },
      { workspaceId: stored.workspaceId, runId: stored.id, target: { workspaceId: stored.workspaceId, projectId: "other", environmentId: "env-a" } },
      { workspaceId: stored.workspaceId, runId: stored.id, expectedVersion: 4 },
      { workspaceId: stored.workspaceId, runId: stored.id, expectedDigest: "0".repeat(64) },
    ]) await expect(createRunHandoff(deps, { ...req, now: NOW })).rejects.toThrow();
    expect(authorizeSource).not.toHaveBeenCalled();
  });
  it("reauthorizes every retrieval and refuses a revocation or concurrent run change", async () => {
    const stored = row();
    const store = { get: vi.fn(async () => structuredClone(stored)) };
    const authorizeSource = vi.fn(async () => undefined);
    const request = { workspaceId: stored.workspaceId, runId: stored.id, now: NOW };
    const first = await createRunHandoff({ store, authorizeSource }, request);
    expect(authorizeSource).toHaveBeenCalledWith(stored.workspaceId, first.context.source, stored);
    authorizeSource.mockRejectedValueOnce(new Error("revoked"));
    await expect(createRunHandoff({ store, authorizeSource }, request)).rejects.toThrow("revoked");
    authorizeSource.mockImplementationOnce(async () => { stored.version += 1; });
    await expect(createRunHandoff({ store, authorizeSource }, request)).rejects.toThrow(/changed during export/);
  });
});
