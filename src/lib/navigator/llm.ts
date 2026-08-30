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
import Anthropic from "@anthropic-ai/sdk";
import type { Environment, Project } from "@/lib/domain/types";

export type PlannerMode = "llm" | "deterministic";

export function plannerMode(): PlannerMode {
  return process.env.ANTHROPIC_API_KEY ? "llm" : "deterministic";
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
 * text on any error or timeout — the deterministic parser handles the rest.
 */
export async function normalizeGoal(
  goal: string,
  project: Project,
  environments: Environment[]
): Promise<{ text: string; usedLlm: boolean }> {
  if (plannerMode() !== "llm") return { text: goal, usedLlm: false };

  const nodes = [
    ...project.workingManifest.services.map((s) => `${s.name} (${s.kind} service)`),
    ...project.workingManifest.resources.map((r) => `${r.name} (${r.kind})`),
  ].join(", ");
  const envs = environments.map((e) => `${e.name} (${e.class})`).join(", ");

  try {
    const client = new Anthropic({ timeout: 12_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 300,
      system: `You translate infrastructure requests into a strict command grammar for a deployment tool. Output ONLY the translated command string — no explanations, no quotes, no markdown. Preserve the user's intent exactly; do not add steps they did not ask for. If part of the request has no matching clause, carry that fragment through verbatim so the tool can flag it.\n\n${GRAMMAR}`,
      messages: [
        {
          role: "user",
          content: `Existing nodes: ${nodes || "(none)"}\nEnvironments: ${envs || "(none)"}\n\nRequest: ${goal}`,
        },
      ],
    });
    if ((response.stop_reason as string) === "refusal") return { text: goal, usedLlm: false };
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (!text) return { text: goal, usedLlm: false };
    return { text, usedLlm: true };
  } catch {
    // Network/auth/rate-limit — degrade silently to the deterministic path.
    return { text: goal, usedLlm: false };
  }
}
