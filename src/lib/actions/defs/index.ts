/**
 * The action catalog. Importing a def module registers its actions as a side
 * effect, so this file is the single place that knows the catalog exists.
 *
 * Call registerAllActions() on first server touch (API route, server
 * component, script, test) before runAction / actionRegistry are used.
 */
import { actionRegistry, type ActionDef } from "@/lib/actions/core";

import "./project";
import "./manifest";
import "./system";
import "./env";
import "./deploy";
import "./ops";
import "./security";
import "./connection";
import "./workspace";

/** Idempotent: defineAction overwrites by id, so repeat calls are free. */
export function registerAllActions(): Map<string, ActionDef<unknown>> {
  return actionRegistry();
}

/** Everything registered, for pickers and the Navigator's vocabulary. */
export function listActions(): ActionDef<unknown>[] {
  return [...registerAllActions().values()].sort((a, b) => a.id.localeCompare(b.id));
}

export { blueprints, getBlueprint } from "@/lib/blueprints";
