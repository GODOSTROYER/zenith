/**
 * Lazy handle on the deployment engine.
 *
 * The engine imports actions (rollback, security fixes) and actions start
 * deployments, so the edge is deliberately dynamic — the module graph stays
 * acyclic and nothing spins up a 250ms ticker just because an action file was
 * imported.
 */
import type { EngineApi } from "@/lib/engine/types";

export async function getEngine(): Promise<EngineApi> {
  const mod = await import("@/lib/engine/engine");
  mod.ensureEngine();
  return mod.engine;
}
