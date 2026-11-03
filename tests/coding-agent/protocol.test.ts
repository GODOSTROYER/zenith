import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { snapshotFromFiles } from "@/lib/analysis";
import { anthropicProvider } from "@/lib/coding-agent/anthropic";
import { runAgent } from "@/lib/coding-agent/runner";
import { newCheckpoint, type Block, type ModelRequest } from "@/lib/coding-agent/types";
import { scriptedProvider, say, toolUse } from "@/lib/coding-agent/eval/scripted";
import { runView } from "@/lib/coding-agent/view";
import { buildRunHandoff } from "@/lib/coding-agent/handoff";
import type { CodingAgentRunRow } from "@/lib/coding-agent/store";

const signature = "opaque-signature-" + "X".repeat(200);
const encrypted = "provider-encrypted-" + "Y".repeat(200);
const blocks: Block[] = [{ type: "thinking", thinking: "", signature }, { type: "redacted_thinking", data: encrypted }, toolUse("list_files", {})];
const snapshot = snapshotFromFiles({ "package.json": JSON.stringify({ name: "web", scripts: { start: "node server.js" }, dependencies: { express: "^4.19.0" } }) });
const source = { repository: "owner/repo", commit: "a".repeat(40) };

describe("Anthropic opaque thinking protocol", () => {
  it("requests omitted adaptive summaries and preserves the provider's opaque blocks at the adapter boundary", async () => {
    const create = vi.fn(async () => ({ content: blocks, stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 20 } }));
    const provider = anthropicProvider({ client: { messages: { create } } as unknown as Pick<Anthropic, "messages"> });
    const request: ModelRequest = { model: "claude-sonnet-5-5", maxTokens: 1000, system: "Fixed instructions", tools: [], messages: [{ role: "user", content: [say("Inspect source")] }] };
    const response = await provider.complete(request);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "low" } }), undefined);
    expect(response.content).toEqual(blocks);
  });

  it("carries empty signed and encrypted blocks unchanged across durable tool-result continuations", async () => {
    const provider = scriptedProvider([
      () => ({ content: structuredClone(blocks) }),
      request => {
        expect(request.messages.find(m => m.role === "assistant")!.content).toEqual(blocks);
        expect(request.messages.at(-1)!.content).toMatchObject([{ type: "tool_result" }]);
        return { content: [say("Done")] };
      },
    ]);
    const args = { task: "Inspect source", source, snapshot, provider, step: true };
    const first = await runAgent(args);
    expect(first.checkpoint.messages.find(m => m.role === "assistant")!.content).toEqual(blocks);
    const second = await runAgent({ ...args, checkpoint: first.checkpoint });
    expect(second.status).toBe("running");
    const completed = await runAgent({ ...args, checkpoint: second.checkpoint });
    expect(completed.status).toBe("completed");
    expect(completed.checkpoint.messages.find(m => m.role === "assistant")!.content).toEqual(blocks);
    expect(provider.calls).toHaveLength(2);
  });

  it.each([
    { kind: "readable summary", content: [{ type: "thinking", thinking: "readable-private-summary", signature }] as Block[] },
    { kind: "redaction changes signed content", content: [{ type: "thinking", thinking: "", signature }, say('apiKey: "literal-secret"')] as Block[] },
  ])("fails closed for $kind", async ({ content }) => {
    const provider = scriptedProvider([() => ({ content })]);
    const out = await runAgent({ task: "Inspect", source, snapshot, provider });
    expect(out.status).toBe("failed");
    expect(out.stopReason).toEqual({ kind: "provider_error", detail: "thinking_contract_violation" });
    expect(out.checkpoint.usage.outputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(out.checkpoint)).not.toContain("readable-private-summary");
    expect(JSON.stringify(out.checkpoint)).not.toContain("literal-secret");
    expect(JSON.stringify(out.checkpoint)).not.toContain(signature);
  });

  it("fails legacy readable or changed signed history before any provider call and requires a fresh analysis", async () => {
    for (const content of [[{ type: "thinking", thinking: "legacy-private-summary", signature }] as Block[], [say('password: "legacy-secret"'), ...blocks]]) {
      const checkpoint = newCheckpoint();
      checkpoint.messages = [{ role: "user", content: [say("Inspect")] }, { role: "assistant", content }];
      const provider = scriptedProvider([]);
      const out = await runAgent({ task: "Inspect", source, snapshot, provider, checkpoint });
      expect(out.status).toBe("failed");
      expect(out.stopReason).toEqual({ kind: "provider_error", detail: "legacy_thinking_requires_new_analysis" });
      expect(provider.calls).toHaveLength(0);
      expect(JSON.stringify(out.checkpoint)).not.toMatch(/legacy-private-summary|legacy-secret/);
    }
  });

  it("never exposes protocol ciphertext or summaries through a run view or handoff", () => {
    const now = new Date();
    const row: CodingAgentRunRow = { id: "run-a", workspaceId: "ws-a", createdBy: "alice", status: "completed", model: "test", task: "Inspect", source: { ...source,
      repositoryId: 17, sourceIdentity: { owner: "owner", repo: "repo", repositoryId: 17, commitSha: source.commit, binding: null } },
      limits: {}, usage: {}, checkpoint: { ...newCheckpoint(), messages: [{ role: "assistant", content: blocks }] },
      result: { finalText: "Redacted findings" }, workflowId: "wf-a", version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    for (const result of [runView(row), buildRunHandoff(row, now)]) {
      expect(JSON.stringify(result)).not.toContain(signature);
      expect(JSON.stringify(result)).not.toContain(encrypted);
      expect(result).not.toHaveProperty("checkpoint");
    }
  });
});
