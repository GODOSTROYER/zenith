/**
 * Small helpers every GCP driver file uses: capability/evidence declaration,
 * externalId → URL resolvers that cannot leave the session's project, and
 * spec accessors.
 */
import type { DriverCapabilities, EvidenceLevel } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { computePath } from "./read-kit";
import type { GcpDriverContext } from "./types";

export const COMPUTE = "https://compute.googleapis.com/compute/v1";
export const RUN = "https://run.googleapis.com/v2";

/**
 * Evidence is `contract` for everything: no GCP account exists, so nothing has
 * run against Google. `tofu validate` proves compile output satisfies the
 * provider schema, which is still `contract`, not `real`.
 */
export function contractCapabilities(ops: { compile?: boolean; observe?: boolean; runtime?: boolean; verify?: boolean; discover?: boolean; operations?: string[] }): DriverCapabilities {
  const evidence: Record<string, EvidenceLevel> = {};
  const c: DriverCapabilities = {
    compile: ops.compile ?? true,
    observe: ops.observe ?? true,
    runtime: ops.runtime ?? false,
    verify: ops.verify ?? true,
    discover: ops.discover ?? false,
    operations: ops.operations ?? [],
    evidence,
  };
  for (const k of ["compile", "observe", "runtime", "verify", "discover"] as const) if (c[k]) evidence[k] = "contract";
  for (const op of c.operations) evidence[op] = "contract";
  return c;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build a resolver that accepts only names shaped like `template` inside the
 * session's project and turns them into `<base>/<name>`.
 *
 * `template(project)` returns the anchored pattern for the canonical name
 * (path segments are constrained to `[A-Za-z0-9_.-]`, so the result is safe to
 * put in a URL without further escaping).
 */
export function nameResolver(template: (project: string) => string, base: string, what: string, normalize: (s: string) => string = (s) => s) {
  return (ctx: GcpDriverContext, externalId: string): { url: string; externalId: string } | { error: string } => {
    const name = normalize(String(externalId));
    const re = new RegExp(`^${template(escapeRe(ctx.session.projectId))}$`);
    if (!re.test(name)) return { error: `externalId is not a ${what} in project ${ctx.session.projectId}.` };
    return { url: `${base}/${name}`, externalId: name };
  };
}

const SEG = "[A-Za-z0-9][A-Za-z0-9_.-]{0,254}";
const LOC = "[a-z0-9-]{2,40}";

export const cloudRunServiceName = nameResolver((p) => `projects/${p}/locations/${LOC}/services/${SEG}`, RUN, "Cloud Run service");
export const cloudRunJobName = nameResolver((p) => `projects/${p}/locations/${LOC}/jobs/${SEG}`, RUN, "Cloud Run job");

export const computeGlobal = (collection: string, what: string) => nameResolver((p) => `projects/${p}/global/${collection}/${SEG}`, COMPUTE, what, computePath);
export const computeRegional = (collection: string, what: string) => nameResolver((p) => `projects/${p}/regions/${LOC}/${collection}/${SEG}`, COMPUTE, what, computePath);

/** `spec` of a node, typed by the caller. The node's spec is plain JSON by contract. */
export function specOf<T>(node: ResourceNode): T {
  return node.spec as unknown as T;
}

/** `deletionPolicy` → tofu `deletion_policy` and whether deletion protection flags stay on. */
export function deletionGuard(spec: { deletionPolicy?: string } | undefined): { protect: boolean; policy: "PREVENT" | "DELETE" } {
  const allow = spec?.deletionPolicy === "allow";
  return { protect: !allow, policy: allow ? "DELETE" : "PREVENT" };
}
