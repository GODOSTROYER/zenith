/**
 * The non-presentational half of the inspector: what an edit actually sends,
 * what it honestly cannot send, and how a request is keyed. All pure, so they
 * are tested directly instead of through a rendered form.
 */
import type { Service } from "@/lib/domain/types";

/* ------------------------------ service draft ------------------------------ */

export interface ServiceDraft {
  name: string;
  kind: Service["kind"];
  size: Service["size"];
  replicas: string;
  port: string;
  healthPath: string;
  schedule: string;
  sourceMode: "image" | "repo";
  image: string;
  repo: string;
  ref: string;
}

export const serviceDraft = (s: Service): ServiceDraft => ({
  name: s.name,
  kind: s.kind,
  size: s.size,
  replicas: String(s.replicas),
  port: s.port ? String(s.port) : "",
  healthPath: s.healthPath ?? "",
  schedule: s.schedule ?? "",
  sourceMode: s.source.type === "git" ? "repo" : "image",
  image: s.source.type === "image" ? s.source.image : "",
  repo: s.source.type === "git" ? s.source.repo : "",
  ref: s.source.type === "git" ? s.source.ref : "main",
});

/**
 * Only the fields that actually differ. A blank field is "leave it alone", not
 * zero and not empty string: `system.updateService` has no way to unset a port
 * or an image, so an emptied one is reported by `serviceEditIssues` instead of
 * being silently dropped.
 */
export function serviceUpdateInput(s: Service, d: ServiceDraft): Record<string, unknown> {
  const input: Record<string, unknown> = { serviceId: s.id };
  const name = d.name.trim();
  if (name && name !== s.name) input.name = name;
  if (d.kind !== s.kind) input.kind = d.kind;
  if (d.size !== s.size) input.size = d.size;
  // Blank stays blank: Number("") is 0, and scaling to zero is not what an
  // empty box means. Anything non-blank goes as typed so the server's own
  // validation is what rejects 99 or "abc" — with its reason on screen.
  if (d.replicas.trim() !== "" && Number(d.replicas) !== s.replicas)
    input.replicas = Number(d.replicas);
  if (d.port.trim() !== "" && Number(d.port) !== s.port) input.port = Number(d.port);
  if (d.healthPath !== (s.healthPath ?? "")) input.healthPath = d.healthPath;
  if (d.schedule !== (s.schedule ?? "")) input.schedule = d.schedule;
  if (
    d.sourceMode === "image" &&
    d.image.trim() &&
    !(s.source.type === "image" && s.source.image === d.image.trim())
  )
    input.image = d.image.trim();
  if (d.sourceMode === "repo" && d.repo.trim()) {
    const ref = d.ref.trim() || "main";
    const same = s.source.type === "git" && s.source.repo === d.repo.trim() && s.source.ref === ref;
    if (!same) {
      input.repo = d.repo.trim();
      input.ref = ref;
    }
  }
  return input;
}

export interface EditIssue {
  field: string;
  reason: string;
}

/**
 * Emptied fields the update action cannot express. Each one blocks Apply with
 * its own sentence — the alternative is a form that shows an empty box and
 * quietly keeps the old value.
 */
export function serviceEditIssues(s: Service, d: ServiceDraft): EditIssue[] {
  const issues: EditIssue[] = [];

  if (!d.name.trim())
    issues.push({
      field: "Name",
      reason: "A service always has a name. Put one back, or remove the service from the Danger tab.",
    });

  if (s.port !== undefined && d.port.trim() === "" && d.kind !== "static" && d.kind !== "cron")
    issues.push({
      field: "Port",
      reason:
        "Port cannot be cleared — system.updateService has no way to unset it. Type the port back in, or change the kind to one that does not listen.",
    });

  if (d.sourceMode === "image" && !d.image.trim())
    issues.push({
      field: "Image",
      reason:
        s.source.type === "image"
          ? "Image cannot be cleared — a service always runs something. Give an image, or switch Source to a Git repository."
          : "Switching to a container image needs the image. Nothing is sent until you give one.",
    });

  if (d.sourceMode === "repo" && !d.repo.trim())
    issues.push({
      field: "Repository",
      reason:
        s.source.type === "git"
          ? "Repository cannot be cleared — a service always runs something. Give a repository, or switch Source to a container image."
          : "Switching to a Git repository needs the repository. Nothing is sent until you give one.",
    });

  return issues;
}

/* ------------------------------- idempotency ------------------------------- */

/** Deterministic JSON: key order can never change the hash. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** FNV-1a. Not a checksum — just a short stable label for one intent. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * A retry of the same apply must replay, not apply twice — which a Date.now()
 * key never did. The base state is part of the identity on purpose: the same
 * edit against a system that has since moved is a different intent, so it runs
 * again instead of replaying a stale result.
 */
export function idempotencyKey(actionId: string, intent: unknown, base?: unknown): string {
  return `${actionId}-${fnv1a(canonical({ intent, base }))}`;
}

/* ---------------------------------- plans ---------------------------------- */

