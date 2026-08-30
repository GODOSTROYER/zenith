/**
 * Shared vocabulary for importers (and the naming/capability helpers the
 * action defs reuse, so there is exactly one slugifier in the codebase).
 *
 * Import honesty rule: every input element ends up in `mapped` or `unmapped`.
 * Nothing is ever silently dropped — an importer that quietly loses a volume
 * mount is worse than one that says "I did not translate this".
 */
import type { BindingCapability, ResourceKind } from "@/lib/domain/types";

export interface ImportMapped {
  /** where it came from, e.g. "services.api" or "resource.aws_s3_bucket.assets" */
  source: string;
  /** what it became, e.g. "service api (web)" */
  result: string;
  /** exact = a faithful translation; assumed = we had to guess something */
  confidence: "exact" | "assumed";
  note: string;
}

export interface ImportUnmapped {
  source: string;
  /** why it did not translate */
  reason: string;
  /** what the user should do about it — every gap names its fix */
  suggestion: string;
}

export interface ImportReport {
  mapped: ImportMapped[];
  unmapped: ImportUnmapped[];
  warnings: string[];
}

export const emptyReport = (): ImportReport => ({
  mapped: [],
  unmapped: [],
  warnings: [],
});

/** Manifest node names are /^[a-z][a-z0-9-]{1,30}$/ — coerce anything into that. */
export function slugify(raw: string, fallback = "app"): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 31);
  return s.length >= 2 ? s : fallback;
}

/** Append -2, -3 … until the name is free. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 28)}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 24)}-${Date.now().toString(36).slice(-4)}`;
}

/** What a binding to this kind of node grants. Service targets are http. */
export function inferCapability(
  targetKind: ResourceKind | "service"
): BindingCapability {
  switch (targetKind) {
    case "postgres":
      return "sql";
    case "redis":
      return "cache";
    case "object_store":
      return "blob";
    case "queue":
      return "queue_publish";
    case "email":
      return "smtp";
    default:
      return "http";
  }
}

/** Keys whose values must never land in the manifest as plain text. */
export const SECRET_KEY_RE =
  /(password|passwd|secret|token|api_?key|access_?key|private_?key|credential|dsn|_pw$)/i;
