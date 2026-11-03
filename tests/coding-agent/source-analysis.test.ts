import { describe, expect, it, vi } from "vitest";
import { snapshotFromFiles } from "@/lib/analysis";
import { Manifest, type AnyManifest } from "@/lib/domain/types";
import { digest } from "@/lib/controlplane/digest";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { redactSourceText, redactSourceValue, redactedSnapshot } from "@/lib/coding-agent/redaction";
import { runTool, type ToolState } from "@/lib/coding-agent/tools";
import { runAgent } from "@/lib/coding-agent/runner";
import { newCheckpoint } from "@/lib/coding-agent/types";
import { scriptedProvider, toolUse, say } from "@/lib/coding-agent/eval/scripted";

const commit = "a".repeat(40);
const pkg = (name: string) => JSON.stringify({ name, scripts: { start: "node server.js" }, dependencies: { express: "^4.19.0" } });
function snapshot() {
  return snapshotFromFiles({
    "package.json": JSON.stringify({ name: "workspace", private: true, workspaces: ["apps/*"] }),
    "apps/web/package.json": pkg("web"),
    "apps/web/Dockerfile": "FROM node:22\nCMD [\"node\", \"server.js\"]\n",
    "apps/web/server.js": 'const app = require("express")();\napp.listen(3000);\n',
    "apps/worker/package.json": pkg("worker"),
    "apps/worker/server.js": "setInterval(() => {}, 1000);\n",
  }, { includeEvidence: true });
}
function toolState(): ToolState {
  return { snapshot: snapshot(), repository: "owner/repo", source: { repository: "owner/repo", commit, root: "apps/web", contextDir: "", contextDigest: "b".repeat(64), dockerfile: "apps/web/Dockerfile" }, injectionSignals: new Set() };
}

describe("source redaction boundary", () => {
  it("redacts quoted, unquoted, multiline and URL secrets while retaining line evidence and exact references", () => {
    const secrets = ["quoted-secret", "plain-yaml-secret", "plain-js-secret", "block-one", "block-two", "db-pass", "disguised-secret"];
    const original = [
      'password: "quoted-secret"', "apiKey: plain-yaml-secret", "const token = plain-js-secret;",
      "client_secret: |", "  block-one", "  block-two", "normal: visible",
      "url=postgres://user:db-pass@db.local/app", 'api_key: "process.env.KEY disguised-secret"',
      'password: "${DB_PASSWORD}"', "secret: vault:project/service/KEY", "apiKey: process.env.API_KEY",
      "port: 3000",
    ].join("\n");
    const redacted = redactSourceText(original);
    for (const secret of secrets) expect(redacted).not.toContain(secret);
    expect(redacted.split("\n")).toHaveLength(original.split("\n").length);
    for (const reference of ["${DB_PASSWORD}", "vault:project/service/KEY", "process.env.API_KEY", "normal: visible", "port: 3000"]) expect(redacted).toContain(reference);
  });

  it("redacts nested objects and secret-shaped keys without mutating shared data or recursing through cycles", () => {
    const token = "ghp_" + "Z".repeat(36);
    const shared = { apiKey: "literal-secret", secretRef: "vault:project/service/KEY" };
    const value: Record<string, unknown> = { first: shared, second: shared, apiKeys: ["literal-secret-array"], credentials: { value: "literal-secret-nested" }, [token]: "value" };
    value.cycle = value;
    const redacted = redactSourceValue(value);
    expect(JSON.stringify(redacted)).not.toContain(token);
    expect(redacted.first).toEqual({ apiKey: "[REDACTED]", secretRef: "vault:project/service/KEY" });
    expect(redacted.second).toEqual(redacted.first);
    expect(redacted.apiKeys).toEqual(["[REDACTED]"]);
    expect(redacted.credentials).toEqual({ value: "[REDACTED]" });
    expect(redacted.cycle).toBe("[Circular]");
    expect(shared.apiKey).toBe("literal-secret");
  });

  it("scrubs source, model output and historical messages before model calls or durable checkpoints", async () => {
    const token = "github_pat_" + "Z".repeat(40);
    const snap = snapshotFromFiles({ "package.json": pkg("web"), "server.js": `const apiKey = "${token}";\n` }, { includeEvidence: true });
    expect(redactedSnapshot(snap).files.find(f => f.path === "server.js")!.content).not.toContain(token);
    const checkpoint = newCheckpoint();
    checkpoint.messages = [{ role: "user", content: [{ type: "text", text: `old access_token=${token}` }] },
      { role: "assistant", content: [] }];
    const provider = scriptedProvider([
      () => ({ content: [toolUse("read_file", { path: "server.js" })] }),
      () => ({ content: [say(`apiKey: "${token}"`)] }),
    ]);
    const saved: unknown[] = [];
    const out = await runAgent({ task: "Review source", source: { repository: "owner/repo", commit }, snapshot: snap, checkpoint, provider,
      onCheckpoint: async state => { saved.push(structuredClone(state)); } });
    expect(out.status).toBe("completed");
    for (const value of [provider.calls, saved, out]) {
      expect(JSON.stringify(value)).not.toContain(token);
      expect(JSON.stringify(value)).not.toContain('"type":"thinking"');
    }
    expect(provider.calls.every(call => call.messages.every(message => message.content.length > 0))).toBe(true);
    expect(checkpoint.messages[0].content[0]).toMatchObject({ text: expect.stringContaining(token) });
  });
});

describe("bounded requirements and proposals", () => {
  it("refuses a model attempt to downgrade the trusted production target class", () => {
    const state = toolState();
    state.environmentClass = "production";
    expect(runTool("propose_manifest", { environmentClass: "sandbox" }, state)).toMatchObject({ isError: true, unsafe: "invalid_arguments" });
    expect(state.artifact).toBeUndefined();
    expect(runTool("propose_manifest", { environmentClass: "production" }, state).isError).not.toBe(true);
    expect(state.artifact?.environmentClass).toBe("production");
  });

  it("selects the requested application and accepts only evidence from the exact retained snapshot", () => {
    const state = toolState();
    expect(runTool("analyze_repository", {}, state).isError).not.toBe(true);
    expect(state.requirements!.services.map(s => s.value.root)).toEqual(["apps/web"]);
    const service = state.requirements!.services[0].value;
    const before = digest(state.requirements);
    const input = { services: [{ root: service.root, name: service.name, port: 8080, evidence: [{ path: "apps/web/server.js", line: 2 }], reason: "Listener should use the reviewed application port." }] };
    for (const evidence of [[{ path: "missing.js", line: 1 }], [{ path: "apps/web/server.js", line: 999 }]]) {
      expect(runTool("refine_requirements", { services: [{ ...input.services[0], evidence }] }, state).isError).toBe(true);
      expect(digest(state.requirements)).toBe(before);
    }
    expect(runTool("refine_requirements", { ...input, approved: true }, state).isError).toBe(true);
    expect(runTool("refine_requirements", input, state).isError).not.toBe(true);
    expect(state.requirements!.services[0].value.port).toMatchObject({ value: 8080, confidence: "medium", evidence: [{ path: "apps/web/server.js", line: 2 }] });
    expect(runTool("propose_manifest", { environmentClass: "staging" }, state).isError).not.toBe(true);
    const manifest = state.artifact!.manifest as AnyManifest;
    expect(manifest.services[0].port).toBe(8080);
    expect(manifest.services[0].source).toMatchObject({ type: "git", repo: "https://github.com/owner/repo", ref: commit, dockerfile: "apps/web/Dockerfile", contextDigest: "b".repeat(64) });
    expect(state.artifact!.requirementsDigest).toBe(digest(state.requirements));
    const originalDigest = state.artifact!.manifestDigest;
    expect(runTool("refine_requirements", { questions: ["Confirm traffic"] }, state).isError).not.toBe(true);
    expect(state.artifact).toBeUndefined();
    expect(runTool("propose_manifest", { environmentClass: "staging" }, state).isError).not.toBe(true);
    expect(state.artifact!.manifestDigest).toBe(originalDigest);
    expect(state.artifact!.unresolved).toContain("Confirm traffic");
  });

  it("retains operator sizing, secret references, stable IDs and V2 placement/policies in an existing project", () => {
    const state = toolState();
    runTool("analyze_repository", {}, state);
    const name = state.requirements!.services[0].value.name;
    const base = upgradeManifest(Manifest.parse({ version: 1,
      services: [
        { id: "stable-web", name, kind: "web", source: { type: "image", image: "example/web:v1" }, size: "performance", replicas: 3, env: [{ key: "DATABASE_URL", secretRef: "vault:proj/web/DATABASE_URL" }] },
        { id: "unrelated", name: "operator-worker", kind: "worker", source: { type: "image", image: "example/worker:v1" }, size: "small", replicas: 1, env: [] },
      ], resources: [], routes: [], bindings: [],
    }), { provider: "aws", region: "us-east-1", policies: { approvalRequired: true, budgetUsdMonthly: 200 } });
    state.baseManifest = base;
    const baseDigest = digest(base);
    expect(runTool("propose_manifest", { environmentClass: "staging" }, state).isError).not.toBe(true);
    const manifest = state.artifact!.manifest as typeof base;
    expect(manifest.placement).toEqual(base.placement);
    expect(manifest.policies).toEqual(base.policies);
    expect(manifest.constraints).toEqual(base.constraints);
    expect(manifest.services.find(s => s.id === "unrelated")).toEqual(base.services[1]);
    expect(manifest.services.find(s => s.id === "stable-web")).toMatchObject({ size: "performance", replicas: 3, env: base.services[0].env, source: { type: "git", ref: commit } });
    expect(digest(base)).toBe(baseDigest);
    expect(manifest.bindings.every(b => !b.from.startsWith("svc-") || manifest.services.some(s => s.id === b.from))).toBe(true);
  });

  it("runs static analysis with zero model calls or spend and honors cancellation before work", async () => {
    const state = toolState();
    const provider = { id: "must-not-run", complete: vi.fn(async (): Promise<never> => { throw new Error("Model must not run"); }) };
    const out = await runAgent({ task: "Inspect statically", source: state.source!, snapshot: state.snapshot, provider, staticOnly: true });
    expect(out.status).toBe("completed");
    expect(out.checkpoint.artifact).toBeDefined();
    expect(out.checkpoint.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, spendMicroUsd: 0, toolCalls: 2 });
    expect(out.checkpoint.coverage?.retainedFiles).toBe(state.snapshot.files.length);
    expect(provider.complete).not.toHaveBeenCalled();
    const stopped = await runAgent({ task: "Inspect statically", source: state.source!, snapshot: state.snapshot, provider, staticOnly: true, signal: AbortSignal.abort() });
    expect(stopped.status).toBe("cancelled");
    expect(stopped.checkpoint.usage.toolCalls).toBe(0);
  });

  it.each(["production", "sandbox"] as const)("preserves the trusted %s target class in a static proposal", async environmentClass => {
    const state = toolState();
    const checkpoint = newCheckpoint();
    checkpoint.environmentClass = environmentClass;
    const provider = { id: "must-not-run", complete: vi.fn(async (): Promise<never> => { throw new Error("Model must not run"); }) };
    const out = await runAgent({ task: "Inspect statically", source: state.source!, snapshot: state.snapshot, provider, checkpoint, staticOnly: true });
    expect(out.status).toBe("completed");
    expect(out.checkpoint.artifact?.environmentClass).toBe(environmentClass);
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
