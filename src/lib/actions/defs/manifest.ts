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
import { Manifest } from "@/lib/domain/types";
import { q, save } from "@/lib/db/store";

const Input = z.object({
  projectId: z.string().optional(),
  /** the full replacement manifest, as edited in the Source view */
  manifest: z.unknown(),
});
type Input = z.infer<typeof Input>;

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
        warnings: ["Project not found."],
        requiresApproval: false,
      };
    const { manifest, errors } = parseManifest(input.manifest);
    if (!manifest)
      return {
        summary: "The edited manifest is not valid yet.",
        details: errors,
        costDeltaUsd: 0,
        risk: "low",
        warnings: errors,
        requiresApproval: false,
      };
    const cs = diffManifests(project.workingManifest, manifest);
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
    const cs = diffManifests(project.workingManifest, manifest);
    project.workingManifest = manifest;
    save();
    return {
      ok: true,
      summary:
        cs.items.length === 0
          ? "Source saved — no effective changes."
          : `Source saved — ${cs.items.length} change${cs.items.length === 1 ? "" : "s"} staged for the next deploy.`,
      data: { changes: cs.items.length, costDeltaUsd: cs.totalCostDeltaUsd },
    };
  },
});
