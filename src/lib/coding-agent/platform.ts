/**
 * Production wiring for the web side of coding-agent runs (PROD-MACH-06): the
 * platform control store, GitHub source resolution (pins a commit, downloads
 * nothing) and the Temporal launcher. The web process holds no model key and
 * does no agent work; the execution worker runs the steps.
 */
import { platformDb } from "@/lib/controlplane/db/open";
import { anthropicKeyPresent } from "./anthropic";
import { createGithubSource } from "./github-source";
import { temporalRunLauncher } from "./launcher";
import type { AgentControlDeps } from "./service";
import { platformRunStore } from "./store";

export async function codingAgentControl(): Promise<AgentControlDeps> {
  return { store: platformRunStore(await platformDb()), resolveSource: createGithubSource({ db: platformDb }).resolve, launcher: temporalRunLauncher(), modelConfigured: anthropicKeyPresent };
}

export async function codingAgentStore() {
  return platformRunStore(await platformDb());
}
