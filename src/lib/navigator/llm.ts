/**
 * Optional language front-end for the Navigator.
 *
 * Design: the LLM never plans. It translates a freeform goal into the
 * deterministic planner's canonical grammar; the typed planner remains the
 * single authority on actions, risk and approvals, so every run stays exactly
 * as auditable as before. No key configured → the raw goal goes straight to
 * the deterministic parser (and the UI says so).
 *
 * Integrator-owned (added on user direction).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Environment, Project } from "@/lib/domain/types";
import { plannerMode, plannerModel } from "./config";
export { plannerMode, plannerModel, type PlannerMode } from "./config";

/**
 * Output budget. The translated command string is short, but a model that
 * thinks before answering spends this same budget doing it — at 300 the answer
 * could be cut off mid-clause, or never start. Truncation is handled below
 * rather than trusted, so this only has to be generous, not exact.
 */
const MAX_TOKENS = 2048;

/** How one goal was actually turned into clauses — reported to the UI verbatim. */
export interface Parsing {
  /** true only when a model's output was used */
  usedLlm: boolean;
  /** the model that ran, when one did */
  model?: string;
  /** why the deterministic parser was used instead, when the LLM was configured */
  fallbackReason?: string;
}

const GRAMMAR = `Clauses are joined with ", then ". Allowed clause shapes (use node/env names EXACTLY as given):
- add a <postgres|redis|queue|bucket|email> named <name>
- add a <web service|worker|cron|static site> named <name> from image <image>
- connect <nodeA> to <nodeB>
- scale <service> to <n> replicas
- resize <service> to <nano|small|standard|performance>
- set env <KEY>=<value> on <service>
- set secret <KEY> on <service>
- set a $<n> budget on <environment>
- create <staging|production|sandbox> environment
- deploy to <environment>
- roll back <environment>
- restart <service>
- fix security findings
- investigate the failed deployment`;

/**
 * Rewrite a freeform goal into canonical clauses. Falls back to the original
 * text on any error or timeout — the deterministic parser handles the rest,
 * and the returned `Parsing` says so, so the UI never claims a model ran when
 * one did not.
 */
export async function normalizeGoal(
  goal: string,
  project: Project,
  environments: Environment[]
): Promise<{ text: string } & Parsing> {
  const model = plannerModel();
  if (plannerMode() !== "llm") return { text: goal, usedLlm: false };

  const nodes = [
    ...project.workingManifest.services.map((s) => `${s.name} (${s.kind} service)`),
    ...project.workingManifest.resources.map((r) => `${r.name} (${r.kind})`),
  ].join(", ");
  const envs = environments.map((e) => `${e.name} (${e.class})`).join(", ");

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ timeout: 12_000, maxRetries: 1 });
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: `You translate infrastructure requests into a strict command grammar for a deployment tool. Output ONLY the translated command string — no explanations, no quotes, no markdown. Preserve the user's intent exactly; do not add steps they did not ask for. If part of the request has no matching clause, carry that fragment through verbatim so the tool can flag it.\n\n${GRAMMAR}`,
      messages: [
        {
          role: "user",
          content: `Existing nodes: ${nodes || "(none)"}\nEnvironments: ${envs || "(none)"}\n\nRequest: ${goal}`,
        },
      ],
    });
    if (response.stop_reason === "refusal")
      return {
        text: goal,
        usedLlm: false,
        fallbackReason: `${model} declined to translate this goal, so it was read by the deterministic parser instead.`,
      };
    // A truncated grammar string is not a shorter plan — it is a different one
    // ("deploy to production" cut to "deploy to prod" still parses). Never
    // hand a cut-off translation to the planner.
    if (response.stop_reason === "max_tokens")
      return {
        text: goal,
        usedLlm: false,
        fallbackReason: `${model} hit the ${MAX_TOKENS}-token limit before it finished translating, so the truncated command was discarded and the goal was read by the deterministic parser instead.`,
      };
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (!text)
      return {
        text: goal,
        usedLlm: false,
        fallbackReason: `${model} returned nothing, so the goal was read by the deterministic parser instead.`,
      };
    return { text, usedLlm: true, model };
  } catch (err) {
    // Network/auth/rate-limit — degrade to the deterministic path, and say so.
    return {
      text: goal,
      usedLlm: false,
      fallbackReason: `${model} was unreachable (${
        err instanceof Error ? err.message : String(err)
      }), so the goal was read by the deterministic parser instead.`,
    };
  }
}
