/** Server page uses real view/rendering code; data and live provider authorization are explicit fakes. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageContext } from "@/app/(product)/platform/_lib/loaders";
import type { CodingAgentRunRow } from "@/lib/coding-agent/store";
import { DEFAULT_LIMITS } from "@/lib/coding-agent/budget";
import CodingAgentPage from "@/app/(product)/platform/coding-agent/page";
import CodingAgentRunPage from "@/app/(product)/platform/coding-agent/[id]/page";
import { analyzeRepository } from "@/lib/analysis/analyze";
import { snapshotFromFiles } from "@/lib/analysis/snapshot";
import { mount, text } from "../screens/platform/render";

const state = vi.hoisted(() => ({ rows: [] as CodingAgentRunRow[], authorize: vi.fn() }));
vi.mock("@/lib/controlplane/db", () => ({ platformDb: async () => ({}), repos: { codingAgentRuns: {
  listRuns: async () => state.rows,
  getRun: async (_db: unknown, _workspaceId: string, id: string) => state.rows.find(row => row.id === id),
} } }));
vi.mock("@/lib/coding-agent/platform", () => ({ assertRunSourceAccess: (row: CodingAgentRunRow) => state.authorize(row) }));
vi.mock("@/lib/db/store", () => ({ db: () => ({ projects: [], environments: [] }) }));
vi.mock("@/app/(product)/platform/coding-agent/run-controls", () => ({ AutoRefresh: () => null, StartRun: () => null, RunControls: () => null }));
vi.mock("@/app/(product)/platform/_lib/loaders", () => ({
  loadPage: async <T,>(read: (context: PageContext) => Promise<T>) => {
    const context: PageContext = { workspaceId: "workspace_one", role: "admin", principal: { kind: "user", id: "admin", name: "Admin" }, surface: "ui", environments: [] };
    return { context, data: await read(context) };
  },
}));

const source = { repository: "acme/school", commit: "a".repeat(40), repositoryId: 101 };
function row(id: string, expired = false): CodingAgentRunRow {
  return {
    id, workspaceId: "workspace_one", createdBy: "admin", status: "completed", model: "fixture", task: `${id} task`, source,
    limits: DEFAULT_LIMITS, usage: { ...DEFAULT_LIMITS, spendMicroUsd: 0, toolCalls: 2 }, checkpoint: { version: 1, messages: [] },
    workflowId: `workflow_${id}`, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    payloadExpiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(),
  };
}
beforeEach(() => {
  state.rows = [];
  state.authorize.mockReset();
  state.authorize.mockImplementation(async (run: CodingAgentRunRow) => {
    if (run.payloadPurgedAt || Date.parse(run.payloadExpiresAt!) <= Date.now()) throw new Error("Retained content unavailable.");
  });
});

describe("per-run retention in the analysis list", () => {
  it.each(["current first", "expired first"])("checks identical-source runs independently with %s", async order => {
    const current = row("current"), expired = row("expired", true);
    state.rows = order === "current first" ? [current, expired] : [expired, current];
    const el = mount(await CodingAgentPage({}));
    expect(text(el)).toContain("current task");
    expect(text(el)).not.toContain("expired task");
    expect(el.querySelector('a[href="/platform/coding-agent/current"]')).not.toBeNull();
    expect(el.querySelector('a[href="/platform/coding-agent/expired"]')).toBeNull();
    expect(state.authorize).toHaveBeenCalledTimes(2);
    expect(state.authorize).toHaveBeenCalledWith(current);
    expect(state.authorize).toHaveBeenCalledWith(expired);
  });

  it("does not reuse a current run's authorization for deleted same-source content", async () => {
    state.rows = [row("current"), { ...row("deleted"), payloadPurgedAt: new Date().toISOString() }];
    const el = mount(await CodingAgentPage({}));
    expect(text(el)).toContain("current task");
    expect(text(el)).not.toContain("deleted task");
    expect(state.authorize).toHaveBeenCalledTimes(2);
  });
});

describe("saved analysis findings", () => {
  it("renders real analyzer requirements and partial coverage even when a budget stop produced no manifest", async () => {
    const requirements = analyzeRepository(snapshotFromFiles({
      "package.json": JSON.stringify({ name: "teacher-app", scripts: { start: "node server.js" }, dependencies: { express: "^4.0.0", pg: "^8.0.0" } }),
      "Dockerfile": "FROM node:22\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]\n",
      "server.js": "const app = require('express')();\napp.listen(3000);\n",
    }, { includeEvidence: true }));
    requirements.truncated = true;
    requirements.unknowns.push("Choose a database backup policy.");
    requirements.risks.push("Confirm migration order before deployment.");
    requirements.envVars.push({ value: { name: "LOG_LEVEL", classification: "config", roots: [""], defaultValue: "DO_NOT_RENDER_CONFIG_VALUE" }, confidence: "high", evidence: [{ path: "server.js", line: 2, rule: "fixture" }] });
    const current = row("partial");
    state.rows = [{ ...current, status: "budget_exhausted", checkpoint: {
      version: 1, messages: [], requirements,
      coverage: { retainedFiles: 3, truncated: true, readPaths: ["server.js", "package.json"], skipped: [{ reason: "oversize", count: 2 }] },
    } }];
    const el = mount(await CodingAgentRunPage({ params: Promise.resolve({ id: "partial" }) }));
    expect(text(el)).toContain("This run stopped before completing");
    expect(text(el)).toContain("Partial repository coverage");
    expect(text(el)).toContain("Retained text files: 3");
    expect(text(el)).toContain("Files opened or matched by model tools: 2");
    expect(text(el)).toContain("2 · oversize");
    expect(text(el)).toContain(requirements.services[0].value.name);
    expect(text(el)).toContain("postgres");
    expect(text(el)).toContain("LOG_LEVEL");
    expect(text(el)).not.toContain("DO_NOT_RENDER_CONFIG_VALUE");
    expect(text(el)).toContain("package.json");
    expect(text(el)).toContain("Choose a database backup policy");
    expect(text(el)).toContain("Confirm migration order before deployment");
  });

  it("shows the final summary as text without rendering source-supplied HTML", async () => {
    state.rows = [{ ...row("complete"), result: { finalText: "Review <script>sourceInstruction()</script> before changing ports." } }];
    const el = mount(await CodingAgentRunPage({ params: Promise.resolve({ id: "complete" }) }));
    expect(el.querySelector('[aria-label="Analysis summary"]')?.textContent).toContain("<script>sourceInstruction()</script>");
    expect(el.querySelector("script")).toBeNull();
  });
});
