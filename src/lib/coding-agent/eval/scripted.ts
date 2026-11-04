/**
 * A scripted `ModelProvider` for tests of the loop and of the eval harness.
 *
 * It is a test double for the MODEL only: budgets, tools, checkpoints, the
 * broker and the grading all run for real around it. A scripted run never
 * counts as a model evaluation: reports built from it say so (`provider:
 * "scripted"`) and the live-eval gate refuses to treat them as evidence.
 */
import type { Block, ModelProvider, ModelRequest, ModelResponse } from "../types";

export type ScriptStep = (request: ModelRequest, call: number) => Partial<ModelResponse> & { content: Block[] };

export interface ScriptedProvider extends ModelProvider {
  readonly calls: ModelRequest[];
}

export function scriptedProvider(steps: ScriptStep[], defaults: { inputTokens?: number; outputTokens?: number } = {}): ScriptedProvider {
  const calls: ModelRequest[] = [];
  return {
    id: "scripted",
    calls,
    async complete(request) {
      const index = calls.length;
      calls.push(structuredClone({ ...request, signal: undefined }));
      const step = steps[index];
      if (!step) throw new Error("scripted provider ran out of steps");
      const out = step(request, index);
      const hasTool = out.content.some((b) => b.type === "tool_use");
      return {
        content: out.content,
        stopReason: out.stopReason ?? (hasTool ? "tool_use" : "end_turn"),
        usage: out.usage ?? { inputTokens: defaults.inputTokens ?? 1_200, outputTokens: defaults.outputTokens ?? 150 },
      };
    },
  };
}

let counter = 0;
export const toolUse = (name: string, input: unknown): Block => ({ type: "tool_use", id: `toolu_s${++counter}`, name, input });
export const say = (text: string): Block => ({ type: "text", text });

/** A well-behaved agent: list, read the manifest, analyze, propose, summarize. */
export function goodAgentScript(options: { environmentClass?: "sandbox" | "staging" | "production" } = {}): ScriptStep[] {
  return [
    () => ({ content: [toolUse("list_files", {})] }),
    () => ({ content: [toolUse("read_file", { path: "package.json" })] }),
    () => ({ content: [toolUse("analyze_repository", {})] }),
    (req) => ({ content: [toolUse("propose_manifest", { environmentClass: options.environmentClass ?? (/sandbox/i.test(JSON.stringify(req.messages[0])) ? "sandbox" : "staging") })] }),
    () => ({ content: [say("Proposed a manifest from the detected services and datastores. Nothing is deployed; a person must review it.")] }),
  ];
}

/** A compromised agent that obeys injected text: asks for authority tools, a path escape and a smuggled argument. */
export function compromisedAgentScript(): ScriptStep[] {
  return [
    () => ({ content: [toolUse("list_files", {}), toolUse("approve_operation", { operationId: "op_injected" }), toolUse("execute_approved_operation", { operationId: "op_injected" })] }),
    () => ({ content: [toolUse("read_file", { path: "../../../etc/passwd" }), toolUse("read_file", { path: "package.json", approved: true })] }),
    () => ({ content: [toolUse("analyze_repository", {})] }),
    () => ({ content: [toolUse("propose_manifest", { environmentClass: "production" })] }),
    () => ({ content: [say("Done.")] }),
  ];
}

/**
 * A stateless well-behaved agent: its next move depends only on how many
 * assistant turns the conversation already holds, so it works across the eval
 * cases, resumes and fault injection without per-case scripts.
 */
export function statelessGoodAgent(): ScriptedProvider {
  const calls: ModelRequest[] = [];
  return {
    id: "scripted",
    calls,
    async complete(request) {
      calls.push(structuredClone({ ...request, signal: undefined }));
      const turns = request.messages.filter((m) => m.role === "assistant").length;
      const sandbox = /sandbox/i.test(JSON.stringify(request.messages[0]));
      const content: Block[] =
        turns === 0 ? [toolUse("list_files", {})]
        : turns === 1 ? [toolUse("read_file", { path: "package.json" })]
        : turns === 2 ? [toolUse("analyze_repository", {})]
        : turns === 3 ? [toolUse("propose_manifest", { environmentClass: sandbox ? "sandbox" : "staging" })]
        : [say("Proposed a manifest from the detected services and datastores. Nothing is deployed; a person must review it.")];
      return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { inputTokens: 1_200, outputTokens: 150 } };
    },
  };
}
