/**
 * What every manifest-edit group needs: the wrapper that turns a manifest
 * mutation into a registered action, and the two helpers more than one group
 * asks of a manifest. Split out of the single-file module; the code is
 * unchanged.
 */
import { z } from "zod";
import {
  defineAction,
  type ActionContext,
  type ActionResult,
  type Risk,
  type Role,
} from "@/lib/actions/core";
import {
  type Manifest,
  type Project,
} from "@/lib/domain/types";
import { nodeName } from "@/lib/domain/graph";
import {
  clone,
  commit,
  editSummary,
  planFromDiff,
  requireProject,
} from "../_shared";
/* --------------------------- manifest-action shape ------------------------- */

interface Built {
  next: Manifest;
  /** what the change is, in one clause: "Adds web service \"api\"" */
  what: string;
  details?: string[];
  warnings?: string[];
  data?: unknown;
  /**
   * Set when this edit must not be applied at all — the reason and the fix.
   * Surfaces read it off the plan and disable their confirm control; execute
   * refuses with the same words. Used where an edit would destroy data.
   */
  blocked?: string;
  /**
   * Side effect outside the manifest, run on execute only — never on plan.
   * The secret actions are the only users: the value goes into the store
   * BEFORE the manifest is committed, so a failed write leaves the plaintext
   * where it was rather than replacing it with a reference to nothing.
   */
  apply?: () => void;
}

/**
 * Every system.* action is the same shape: build the next manifest
 * purely, preview it with a real diff, commit it on execute.
 */
export function manifestAction<I extends { projectId?: string }>(def: {
  id: string;
  title: string;
  risk: Risk;
  requiredRole?: Role;
  input: z.ZodType<I>;
  /** Pure apart from reads. `ctx` is here for the workspace-scoped secret store. */
  build(project: Project, input: I, ctx: ActionContext): Built;
}) {
  return defineAction<I>({
    id: def.id,
    title: def.title,
    category: "system",
    risk: def.risk,
    requiredRole: def.requiredRole ?? "editor",
    mutates: true,
    input: def.input,
    plan(ctx: ActionContext, input: I) {
      const project = requireProject(ctx, input.projectId);
      const built = def.build(project, input, ctx);
      const plan = planFromDiff(project.workingManifest, built.next, built.what, {
        details: built.details,
        warnings: built.warnings,
      });
      return built.blocked ? { ...plan, blocked: built.blocked } : plan;
    },
    execute(ctx: ActionContext, input: I): ActionResult {
      const project = requireProject(ctx, input.projectId);
      const before = clone(project.workingManifest);
      const built = def.build(project, input, ctx);
      if (built.blocked)
        return { ok: false, summary: `${def.title} was not applied.`, error: built.blocked };
      // Store first, manifest second: if this throws, nothing is committed.
      built.apply?.();
      commit(project, built.next);
      return { ok: true, summary: editSummary(before, built.next, built.what), data: built.data };
    },
  });
}

export const takenNames = (m: Manifest) => [...m.services.map((s) => s.name), ...m.resources.map((r) => r.name)];

/** Drop every binding that touches a node id, and say which. */
export function dropBindings(m: Manifest, nodeId: string): string[] {
  const doomed = m.bindings.filter((b) => b.from === nodeId || b.to === nodeId);
  m.bindings = m.bindings.filter((b) => !doomed.includes(b));
  return doomed.map((b) => `${nodeName(m, b.from)} → ${nodeName(m, b.to)}`);
}
