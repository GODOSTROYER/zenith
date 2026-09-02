/**
 * project.updateManifest — replace the working manifest from the Source view.
 * The whole-document counterpart to the per-field system.* actions: same
 * validation, same diff-driven preview, same audit trail.
 *
 * Integrator-owned addition (post wave 1); registered via defs/index.ts.
 */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { diffManifests, validateManifest } from "@/lib/domain/graph";
import { contentHash, Manifest, type Project } from "@/lib/domain/types";
import { q, save } from "@/lib/db/store";

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
    const project = q.project(input.projectId ?? ctx.projectId ?? "");
    if (!project)
      return {
        summary: "Project not found.",
        details: ["Pass a valid projectId, or open the project first."],
        costDeltaUsd: 0,
        risk: "low",
        warnings: [],
        requiresApproval: false,
        blocked: "Project not found. Pass a valid projectId, or open the project first.",
      };
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
    const project = q.project(input.projectId ?? ctx.projectId ?? "");
    if (!project)
      return {
        ok: false,
        summary: "Project not found.",
        error: "Pass a valid projectId, or open the project first.",
      };
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
