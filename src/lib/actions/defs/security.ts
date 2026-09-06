/**
 * Security findings. Resolving a finding runs its own fix action when it has
 * one — the "one-click fix" is not a second code path, it is the same action
 * catalog, audited like everything else.
 */
import { z } from "zod";
import { defineAction, getAction, runAction, type ActionContext } from "@/lib/actions/core";
import { db, save } from "@/lib/db/store";
import type { SecurityFinding } from "@/lib/domain/types";
import { requireProject } from "./_shared";

/**
 * A fix that edits the working copy has not made the environment safe — it has
 * queued a change. Reporting that as "resolved" closes a finding that is still
 * live in production. `system.*` actions are exactly the manifest edits, so the
 * registry decides this rather than a hand-kept list.
 */
const fixLandsOnDeploy = (actionId: string): boolean =>
  getAction(actionId).category === "system";

/*
 * TENANCY — why this lookup takes a context.
 *
 * A finding id is a bearer token, and this one is sharper than most: a finding
 * carries a stored `fix` — an action id and its input, including that input's
 * OWN projectId — and `security.resolveFinding` runs it. A global finder makes
 * the resolver a confused deputy: workspace A's session quotes one of B's
 * finding ids and Orrery runs B's fix against B's project, with A's role check
 * as the only thing that was ever consulted.
 *
 * So the finding is resolved through the project that owns it, under the
 * caller's own workspace. A foreign id gets the SAME sentence as an id that was
 * never real — "you don't have access to that" would confirm the finding exists
 * and make the id space enumerable across tenants.
 */
const noFinding = (ref: string) =>
  new Error(`Finding "${ref}" was not found. Reload the Security page — it may already be resolved.`);

function requireFinding(ctx: ActionContext, findingId: string): SecurityFinding {
  const f = db().findings.find((x) => x.id === findingId);
  if (!f) throw noFinding(findingId);
  try {
    // `requireProject` resolves inside ctx.workspaceId, and it also matches a
    // slug — which is user-chosen, so a project slugged with another tenant's
    // project id must not resolve their finding. `f.projectId` is an id: demand
    // the id back. Anything that does not resolve — foreign project, deleted
    // project, no workspace in scope — is a finding this caller cannot see.
    if (requireProject(ctx, f.projectId).id !== f.projectId) throw noFinding(findingId);
  } catch {
    throw noFinding(findingId);
  }
  return f;
}

const ResolveInput = z.object({
  findingId: z.string().min(1),
  /** run the finding's fix action (default) or just mark it handled */
  applyFix: z.boolean().optional(),
});
type ResolveInput = z.infer<typeof ResolveInput>;

defineAction<ResolveInput>({
  id: "security.resolveFinding",
  title: "Resolve finding",
  category: "operations",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: ResolveInput,
  async plan(ctx: ActionContext, input) {
    const f = requireFinding(ctx, input.findingId);
    const willFix = f.fix && input.applyFix !== false;
    if (!willFix)
      return {
        summary: `Mark "${f.title}" resolved.`,
        details: [
          f.detail,
          f.fix
            ? "The fix action is skipped; only the finding is marked resolved."
            : "This finding has no automatic fix — change the system yourself, then mark it resolved.",
        ],
        costDeltaUsd: 0,
        risk: "low",
        warnings: ["Marking a finding resolved does not change the system."],
        requiresApproval: false,
      };
    const inner = await runAction(f.fix!.actionId, ctx, f.fix!.input, { mode: "plan" });
    const p = inner.plan!;
    const pending = fixLandsOnDeploy(f.fix!.actionId);
    return {
      summary: `Fix "${f.title}" — ${f.fix!.label}.`,
      details: [
        f.detail,
        `Runs ${f.fix!.actionId}:`,
        ...p.details,
        pending
          ? "This edits the working copy. The finding stays open as \"fixed, pending deploy\" until a deployment lands it — the environment is exposed until then."
          : "This takes effect immediately, so the finding closes as soon as it runs.",
      ],
      costDeltaUsd: p.costDeltaUsd,
      risk: p.risk,
      warnings: p.warnings,
      requiresApproval: p.requiresApproval,
      // A fix whose own action refuses is not a fix. Carry the reason up so the
      // Security screen disables the button with it instead of failing on click.
      blocked: p.blocked
        ? `"${f.fix!.label}" cannot run: ${p.blocked}`
        : undefined,
      requiredRole: p.requiredRole,
    };
  },
  async execute(ctx, input) {
    const f = requireFinding(ctx, input.findingId);
    if (f.status !== "open")
      return { ok: true, summary: `"${f.title}" was already ${f.status}.`, data: { findingId: f.id, status: f.status } };

    if (f.fix && input.applyFix !== false) {
      const { result } = await runAction(f.fix.actionId, ctx, f.fix.input, { mode: "execute" });
      if (!result?.ok)
        return {
          ok: false,
          summary: `Could not fix "${f.title}".`,
          error: result?.error ?? `${f.fix.actionId} did not complete. Apply the change by hand, then dismiss the finding with a reason.`,
        };
      // Working-copy fixes are not yet true of the environment. Say so.
      const pending = fixLandsOnDeploy(f.fix.actionId);
      f.status = pending ? "fixed_pending_deploy" : "resolved";
      f.resolvedAt = new Date().toISOString();
      f.resolvedBy = ctx.actor;
      f.resolvedReason = `Fixed via ${f.fix.actionId} (${f.fix.label}).`;
      save();
      return {
        ok: true,
        summary: pending
          ? `Fixed "${f.title}" in the working copy — ${result.summary} It stays open until a deploy lands it.`
          : `Fixed "${f.title}" — ${result.summary}`,
        data: { findingId: f.id, status: f.status, via: f.fix.actionId },
      };
    }

    f.status = "resolved";
    f.resolvedAt = new Date().toISOString();
    f.resolvedBy = ctx.actor;
    f.resolvedReason = "Marked resolved by hand; no action was run.";
    save();
    return {
      ok: true,
      summary: `"${f.title}" marked resolved. Nothing in the system was changed by this.`,
      data: { findingId: f.id, status: f.status },
    };
  },
});

const DismissInput = z.object({
  findingId: z.string().min(1),
  reason: z.string().min(1, "say why this is being dismissed — it stays in the audit log"),
});
type DismissInput = z.infer<typeof DismissInput>;

defineAction<DismissInput>({
  id: "security.dismissFinding",
  title: "Dismiss finding",
  category: "operations",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: DismissInput,
  plan(ctx, input) {
    const f = requireFinding(ctx, input.findingId);
    return {
      summary: `Dismiss "${f.title}" (${f.severity}).`,
      details: [f.detail, `Reason recorded: "${input.reason}".`, "The finding stays visible under Dismissed, and the reason is in the audit log."],
      costDeltaUsd: 0,
      risk: f.severity === "high" ? "medium" : "low",
      warnings: f.severity === "high" ? ["This is a high-severity finding. Dismissing it does not make it safe."] : [],
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const f = requireFinding(ctx, input.findingId);
    f.status = "dismissed";
    f.resolvedAt = new Date().toISOString();
    f.resolvedBy = ctx.actor;
    f.resolvedReason = input.reason;
    save();
    return {
      ok: true,
      summary: `Dismissed "${f.title}": ${input.reason}`,
      data: { findingId: f.id, status: f.status },
    };
  },
});

const ReopenInput = z.object({ findingId: z.string().min(1) });
type ReopenInput = z.infer<typeof ReopenInput>;

/**
 * The way back out of a dismissal. Only a dismissal can be reopened: every
 * other status is the scanner's to decide — anything it still detects is
 * reported open on the next sync without asking anyone.
 */
defineAction<ReopenInput>({
  id: "security.reopenFinding",
  title: "Reopen finding",
  category: "operations",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: ReopenInput,
  plan(ctx, input) {
    const f = requireFinding(ctx, input.findingId);
    const who = f.resolvedBy?.name ?? "someone";
    return {
      summary: `Reopen "${f.title}" (${f.severity}).`,
      details: [
        f.detail,
        f.resolvedReason
          ? `Dismissed by ${who}: “${f.resolvedReason}”.`
          : `Dismissed by ${who}.`,
        "The dismissal stays in the audit log. The finding counts as open again and its fix, if it has one, comes back.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: [],
      requiresApproval: false,
      blocked:
        f.status === "dismissed"
          ? undefined
          : `"${f.title}" is ${f.status}, not dismissed — there is no dismissal to undo. The scanner reopens anything it still detects on its own.`,
    };
  },
  execute(ctx, input) {
    const f = requireFinding(ctx, input.findingId);
    if (f.status !== "dismissed")
      return {
        ok: false,
        summary: `"${f.title}" is ${f.status}, not dismissed.`,
        error:
          "Only a dismissed finding can be reopened. Reload the Security page — the scanner reopens anything it still detects on its own.",
      };
    const reason = f.resolvedReason;
    f.status = "open";
    delete f.resolvedAt;
    delete f.resolvedBy;
    delete f.resolvedReason;
    delete f.fixedInRevisionId;
    save();
    return {
      ok: true,
      summary: reason
        ? `Reopened "${f.title}". The dismissal (“${reason}”) stays in the audit log.`
        : `Reopened "${f.title}".`,
      data: { findingId: f.id, status: f.status, reopenedBy: ctx.actor.id },
    };
  },
});
