/**
 * project.updateManifest — replace the working manifest from the Source view.
 * The whole-document counterpart to the per-field system.* actions: same
 * validation, same diff-driven preview, same audit trail.
 *
 * Registered via defs/index.ts.
 */
import { z } from "zod";
import { defineAction, type ActionPlan } from "@/lib/actions/core";
import { diffManifests, validateManifest } from "@/lib/domain/graph";
import { contentHash, Manifest, type Project } from "@/lib/domain/types";
import { save } from "@/lib/db/store";
import { requireProject } from "./_shared";

/**
 * The optimistic-concurrency token for a working copy.
 *
 * `GET /api/projects/:id` returns it as `manifestHash`; a client that loaded a
 * copy sends it back as `expectedHash` when saving. Same hash ⇒ nothing moved
 * under the editor. Key order does not affect it, so a client that
 * re-serializes the manifest still matches.
 */
export const manifestHash = (m: Manifest): string => contentHash(m);

const Input = z.object({
  projectId: z.string().optional(),
  /** the full replacement manifest, as edited in the Source view */
  manifest: z.unknown(),
  /**
   * `manifestHash` of the working copy this edit started from. Omit to force
   * the write (the map and single-field editors read and write in one turn);
   * send it from any surface that holds text across time, like Source.
   */
  expectedHash: z.string().optional(),
});
type Input = z.infer<typeof Input>;

/** Someone else saved while this editor held text. Never silently clobber it. */
function staleWrite(project: Project, expectedHash?: string): string | undefined {
  if (!expectedHash) return undefined;
  const current = manifestHash(project.workingManifest);
  if (current === expectedHash) return undefined;
  return (
    `The working copy changed after you loaded it — another tab, another person, or an edit from the map saved in between. ` +
    `Saving now would overwrite that change. Reload Source to pick up the current copy (your text stays in the editor until you do), ` +
    `or use Revert to discard your edits and start from what is saved.`
  );
}

/**
 * A lookup that refused is a blocked plan here, not an exception: the Source
 * view renders the preview and disables Save with this sentence on it, and it
 * has done so since before the tenancy fix. What changed is where the sentence
 * comes from — it is now `requireProject`'s own, which is identical for an id
 * that never existed and for one that exists in another workspace. So the
 * preview cannot be used to test whether an id is real anywhere, and it never
 * names the object or the tenant that holds it.
 *
 * The shape matches what `runAction` builds when a plan throws, so a refusal
 * reads the same whichever action produced it.
 */
function blockedPlan(err: unknown): ActionPlan {
  const message = err instanceof Error ? err.message : String(err);
  return {
    summary: "This cannot be planned as things stand.",
    details: [message],
    costDeltaUsd: 0,
    risk: "low",
    warnings: [],
    requiresApproval: false,
    blocked: message,
  };
}

function parseManifest(raw: unknown): { manifest?: Manifest; errors: string[] } {
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`),
    };
  }
  const issues = validateManifest(parsed.data).filter((i) => i.level === "error");
  if (issues.length) {
    return {
      errors: issues.map((i) => `${i.message}${i.fix ? ` ${i.fix}` : ""}`),
    };
  }
  return { manifest: parsed.data, errors: [] };
}

defineAction<Input>({
  id: "project.updateManifest",
  title: "Update manifest source",
  category: "system",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: Input,
  plan(ctx, input) {
    /*
     * TENANCY. This action replaces an entire system definition, so the
     * project it resolves decides whose system gets overwritten. It used to
     * resolve `input.projectId ?? ctx.projectId` through `q.project`, which
     * reads the whole store and matches on id OR slug: an admin of one
     * workspace who passed another's project id — or merely shared its slug,
     * since two tenants may both call a project "atlas" — planned and then
     * saved over a stranger's manifest.
     *
     * `requireProject` searches inside `ctx.workspaceId` only. It also owns the
     * `?? ctx.projectId` fallback, which matters because the context id is
     * caller-influenced too: a forged `ctx.projectId` now resolves through the
     * same scoped search as a forged `input.projectId`, and is refused with the
     * same sentence rather than becoming the way around the check.
     */
    let project: Project;
    try {
      project = requireProject(ctx, input.projectId);
    } catch (err) {
      return blockedPlan(err);
    }
    const { manifest, errors } = parseManifest(input.manifest);
    if (!manifest)
      return {
        summary: "The edited manifest is not valid yet.",
        details: errors,
        costDeltaUsd: 0,
        risk: "low",
        warnings: [],
        requiresApproval: false,
        blocked: `This source cannot be saved yet: ${errors.join(" · ")}`,
      };
    const stale = staleWrite(project, input.expectedHash);
    const cs = diffManifests(project.workingManifest, manifest);
    if (stale)
      return {
        summary: "This save would overwrite a newer working copy.",
        details: [stale, ...cs.items.slice(0, 10).map((i) => i.explanation)],
        costDeltaUsd: cs.totalCostDeltaUsd,
        risk: "high",
        warnings: [],
        requiresApproval: false,
        blocked: stale,
      };
    return {
      summary:
        cs.items.length === 0
          ? "No changes — the source matches the current working copy."
          : `Replaces the working copy: ${cs.items.length} change${cs.items.length === 1 ? "" : "s"}.`,
      details: cs.items.slice(0, 10).map((i) => i.explanation),
      costDeltaUsd: cs.totalCostDeltaUsd,
      risk: cs.items.some((i) => i.risk === "high")
        ? "high"
        : cs.items.some((i) => i.risk === "medium")
          ? "medium"
          : "low",
      warnings: cs.warnings,
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    /*
     * The same scoped resolution as `plan`. Refusing only in the preview would
     * be no defence at all — the write is what lands, and any caller can post
     * straight to execute. `requireProject` throws, and `runAction` turns that
     * into `{ ok: false, error }` carrying the identical not-found sentence.
     */
    const project = requireProject(ctx, input.projectId);
    const { manifest, errors } = parseManifest(input.manifest);
    if (!manifest)
      return {
        ok: false,
        summary: "The edited manifest is not valid.",
        error: errors.join(" · "),
      };
    const stale = staleWrite(project, input.expectedHash);
    if (stale)
      return {
        ok: false,
        summary: "This save would overwrite a newer working copy.",
        error: stale,
      };
    const cs = diffManifests(project.workingManifest, manifest);
    project.workingManifest = manifest;
    save();
    return {
      ok: true,
      summary:
        cs.items.length === 0
          ? "Source saved — no effective changes."
          : `Source saved — ${cs.items.length} change${cs.items.length === 1 ? "" : "s"} staged for the next deploy.`,
      data: {
        changes: cs.items.length,
        costDeltaUsd: cs.totalCostDeltaUsd,
        /** the token to send as `expectedHash` on the next save */
        manifestHash: manifestHash(manifest),
      },
    };
  },
});
