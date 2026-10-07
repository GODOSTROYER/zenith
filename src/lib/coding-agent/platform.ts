/**
 * Production wiring for coding-agent runs (PROD-MACH-06): the platform control
 * store, the workspace's GitHub source access, the real Anthropic provider and
 * the platform capability broker. The model key is read by the SDK from the
 * environment; with no key a run is refused up front (`unavailable`), never
 * answered by a stand-in.
 */
import { platformDb } from "@/lib/controlplane/db/open";
import { platformBroker } from "@/lib/capabilities/platform";
import { anthropicKeyPresent, anthropicProvider } from "./anthropic";
import { createGithubSourceReader } from "./github-source";
import { AgentServiceError, type AgentServiceDeps } from "./service";
import { platformRunStore } from "./store";

export async function codingAgentDeps(): Promise<AgentServiceDeps> {
  return {
    store: platformRunStore(await platformDb()),
    provider: modelProvider(),
    readSource: createGithubSourceReader({ db: platformDb }),
    broker: platformBroker,
  };
}

/** Run history reads need no model, so they use a store-only dependency set. */
export async function codingAgentStore() {
  return platformRunStore(await platformDb());
}

function modelProvider() {
  if (!anthropicKeyPresent()) throw new AgentServiceError("unavailable", "No model key is configured on this deployment (ANTHROPIC_API_KEY), so coding-agent runs are unavailable.");
  return anthropicProvider();
}
