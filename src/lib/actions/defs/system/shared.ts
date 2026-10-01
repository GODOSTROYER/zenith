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
  type AnyManifest,
  type Project,
} from "@/lib/domain/types";
import { nodeName } from "@/lib/domain/graph";
import { parseEditableManifest } from "../_manifest";
import {
  clone,
  commit,
  editSummary,
  planFromDiff,
  requireProject,
} from "../_shared";
/* --------------------------- manifest-action shape ------------------------- */

interface Built {
  next: AnyManifest;
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
  apply?: () => void | Promise<void>;
}

function validateBuilt(built: Built): void {
  if (built.blocked || built.next.version !== 2) return;
  // V2 references (release targets and placement pins) must stay valid after
  // a per-node edit too. Refuse before any secret-store side effect occurs.
  const parsed = parseEditableManifest(built.next, false);
  if (!parsed.ok) built.blocked = parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join(" · ");
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
  build(project: Project, input: I, ctx: ActionContext): Built | Promise<Built>;
}) {
  return defineAction<I>({
    id: def.id,
    title: def.title,
    category: "system",
    risk: def.risk,
    requiredRole: def.requiredRole ?? "editor",
    mutates: true,
    input: def.input,
    async plan(ctx: ActionContext, input: I) {
      const project = requireProject(ctx, input.projectId);
      const built = await def.build(project, input, ctx);
      validateBuilt(built);
      const plan = planFromDiff(project.workingManifest, built.next, built.what, {
        details: built.details,
        warnings: built.warnings,
      });
      return built.blocked ? { ...plan, blocked: built.blocked } : plan;
    },
    async execute(ctx: ActionContext, input: I): Promise<ActionResult> {
      const project = requireProject(ctx, input.projectId);
      const before = clone(project.workingManifest);
      const built = await def.build(project, input, ctx);
      validateBuilt(built);
      if (built.blocked)
        return { ok: false, summary: `${def.title} was not applied.`, error: built.blocked };
      // Store first, manifest second: if this throws, nothing is committed.
      await built.apply?.();
      commit(project, built.next);
      return { ok: true, summary: editSummary(before, built.next, built.what), data: built.data };
    },
  });
}

export const takenNames = (m: AnyManifest) => [...m.services.map((s) => s.name), ...m.resources.map((r) => r.name)];

/** Drop every binding that touches a node id, and say which. */
export function dropBindings(m: AnyManifest, nodeId: string): string[] {
  const doomed = m.bindings.filter((b) => b.from === nodeId || b.to === nodeId);
  m.bindings = m.bindings.filter((b) => !doomed.includes(b));
  return doomed.map((b) => `${nodeName(m, b.from)} → ${nodeName(m, b.to)}`);
}
