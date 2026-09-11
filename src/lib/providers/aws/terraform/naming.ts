/**
 * Naming, sizing and manifest queries: the deterministic labels and addresses
 * the emitters build HCL from, plus the small predicates they ask of a
 * manifest. Split out of the single-file exporter; the code is unchanged.
 */
import { SIZE_SPECS } from "@/lib/cost/pricing";
import type {
  Binding,
  Environment,
  Manifest,
  Route,
  Service,
  ServiceSize,
} from "@/lib/domain/types";

/* --------------------------------- helpers -------------------------------- */

/**
 * A safe Terraform block label, and the one segment of an address that a
 * manifest can influence. Identifiers are not quoted, so they cannot be
 * escaped the way strings are — they are constrained instead: anything
 * outside `[A-Za-z0-9_]` collapses to `_`, a leading digit gains a `_`, and
 * an empty result becomes `_`. The empty case matters: an address is what
 * both the declaration and every reference to it are built from, and a blank
 * one emits `aws_s3_bucket..arn`, which does not parse.
 */
export const tf = (s: string): string => {
  const out = String(s ?? "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^(\d)/, "_$1");
  return out.length > 0 ? out : "_";
};

/** Fargate only accepts a fixed CPU/memory lattice; clamp SIZE_SPECS onto it. */
export function fargateSpec(size: ServiceSize): { cpu: number; memory: number } {
  // `size` is typed but not guaranteed: a stored revision predating a
  // vocabulary change reaches here with a value that is not in the enum, and
  // destructuring `undefined` would take the whole export down.
  const { vcpu, memoryMb } = SIZE_SPECS[size] ?? SIZE_SPECS.small;
  const cpu = Math.max(256, Math.round(vcpu * 1024));
  const floor: Record<number, number> = { 256: 512, 512: 1024, 1024: 2048, 2048: 4096 };
  return { cpu, memory: Math.max(memoryMb, floor[cpu] ?? 512) };
}

export const DB_CLASS: Record<ServiceSize, string> = {
  nano: "db.t4g.micro",
  small: "db.t4g.small",
  standard: "db.t4g.medium",
  performance: "db.m6g.large",
};

export const CACHE_CLASS: Record<ServiceSize, string> = {
  nano: "cache.t4g.micro",
  small: "cache.t4g.small",
  standard: "cache.t4g.medium",
  performance: "cache.m6g.large",
};

export const DB_STORAGE: Record<ServiceSize, number> = {
  nano: 20,
  small: 20,
  standard: 50,
  performance: 200,
};

export const managed = <T extends { ownership: string }>(xs: T[]) =>
  xs.filter((x) => x.ownership === "managed");

/**
 * Two questions several emitters ask of the same manifest. They used to be
 * answered once in `terraformFiles` and threaded down as bare booleans, which
 * made `variablesTf(env, m, true, false)` unreadable at the call site and
 * unverifiable inside it. Asking here instead costs a linear scan and says
 * what it means.
 */

export interface RouteBinding {
  route: Route;
  service: Service;
}

export function routeBindings(m: Manifest): RouteBinding[] {
  const out: RouteBinding[] = [];
  for (const b of m.bindings) {
    if (b.capability !== "http") continue;
    const route = m.routes.find((r) => r.id === b.from);
    const service = m.services.find((s) => s.id === b.to);
    if (route && service && service.ownership === "managed") out.push({ route, service });
  }
  return out;
}

/** Does anything route public HTTP? Decides the ALB, its SG rules and the zone. */
export const hasRoutes = (m: Manifest): boolean => routeBindings(m).length > 0;

/** Is Zenith creating an SES identity? Decides the mail domain variable. */
export const hasEmail = (m: Manifest): boolean =>
  managed(m.resources).some((r) => r.kind === "email");

/**
 * A `referenced` node exists in the customer's account and this bundle must
 * never declare it as a resource. Its attributes come from variables the user
 * fills instead, so the HCL still validates and still plans.
 */
/**
 * A Terraform block label unique within `seen`. Sanitising is lossy, so two
 * different names arrive here as one label; duplicate labels do not parse, so
 * the second occurrence takes a numeric suffix. Deterministic.
 */
export function uniqueLabel(seen: Set<string>, base: string): string {
  let label = base;
  for (let n = 2; seen.has(label); n++) label = `${base}_${n}`;
  seen.add(label);
  return label;
}

/**
 * One Terraform label per node, decided once for the whole bundle.
 *
 * `tf()` is many-to-one — "api.v1" and "api-v1" both sanitise to "api_v1" — and
 * a service's name is reused as the label of five or six blocks (ECR repo, log
 * group, task role, task definition, ECS service, target group). Deciding the
 * label independently at each site therefore emitted duplicate block labels,
 * which is a *parse* error: the bundle would not plan at all. Deciding it once,
 * per node id, keeps every emitter agreeing on one name and every name unique.
 *
 * Services and resources are numbered separately because they never share a
 * Terraform resource *type*, and a benign manifest must keep emitting exactly
 * the HCL it emitted before. Labels follow manifest order, so re-exporting an
 * unchanged manifest is byte-identical.
 */
export interface NodeLabels {
  services: Map<string, string>;
  resources: Map<string, string>;
}

export const LABELS = new WeakMap<Manifest, NodeLabels>();

export function labelsFor(m: Manifest): NodeLabels {
  const hit = LABELS.get(m);
  if (hit) return hit;
  const services = new Map<string, string>();
  const resources = new Map<string, string>();
  const svcSeen = new Set<string>();
  const resSeen = new Set<string>();
  for (const x of m.services) services.set(x.id, uniqueLabel(svcSeen, tf(x.name)));
  for (const x of m.resources) resources.set(x.id, uniqueLabel(resSeen, tf(x.name)));
  const built = { services, resources };
  LABELS.set(m, built);
  return built;
}

/** The label for a service; falls back to the raw sanitised name off-manifest. */
export const svcLabel = (m: Manifest, s: { id: string; name: string }): string =>
  labelsFor(m).services.get(s.id) ?? tf(s.name);

/** The label for a resource; falls back to the raw sanitised name off-manifest. */
export const resLabel = (m: Manifest, r: { id: string; name: string }): string =>
  labelsFor(m).resources.get(r.id) ?? tf(r.name);

export const REF_FIELDS: Partial<Record<Binding["capability"], string[]>> = {
  sql: ["host", "port", "user", "database", "password", "url"],
  cache: ["url"],
  blob: ["bucket"],
  queue_publish: ["queue_url", "queue_arn"],
  queue_consume: ["queue_url", "queue_arn"],
  smtp: ["smtp_host", "smtp_port", "smtp_user", "smtp-password"],
};

export interface RefNames {
  names: Map<string, string>;
  paths: Map<string, string>;
}

/** Small deterministic token: identity-stable, unlike manifest-order suffixes. */
export function stableToken(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function allocateStableNames(
  entries: { key: string; identity: string; natural: string }[]
): Map<string, string> {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries)
    groups.set(entry.natural, [...(groups.get(entry.natural) ?? []), entry]);
  const reserved = new Set(groups.keys());
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const natural of [...groups.keys()].sort()) {
    const group = groups.get(natural)!;
    if (group.length === 1) {
      result.set(group[0].key, natural);
      used.add(natural);
      continue;
    }
    for (const entry of [...group].sort((a, b) => a.identity.localeCompare(b.identity))) {
      const base = `${natural}_${stableToken(entry.identity)}`;
      let candidate = base;
      for (let n = 2; reserved.has(candidate) || used.has(candidate); n++) candidate = `${base}_${n}`;
      result.set(entry.key, candidate);
      used.add(candidate);
    }
  }
  return result;
}

/**
 * Allocate all referenced inputs as a set. A unique natural key/path is kept
 * byte-for-byte for compatibility. Every member of a genuinely ambiguous
 * group gets an identity-derived suffix, so reordering the manifest cannot
 * swap meanings. All natural keys are reserved before suffix allocation, so a
 * generated name cannot steal another resource's already-valid natural key.
 * This is intentionally recomputed: manifests are mutable working copies.
 */
export function refNamesFor(m: Manifest): RefNames {
  const entries: { key: string; identity: string; natural: string; path: string }[] = [];
  for (const resource of m.resources) {
    if (resource.ownership === "managed") continue;
    const fields = new Set<string>();
    for (const binding of m.bindings.filter((b) => b.to === resource.id)) {
      for (const field of REF_FIELDS[binding.capability] ?? []) fields.add(field);
    }
    for (const field of fields) {
      entries.push({
        key: `${resource.id}\0${field}`,
        identity: `${resource.id}\0${field}`,
        natural: tf(`ref_${resource.name}_${field}`),
        path: `refs/${ssmSafe(resource.name)}/${field}`,
      });
    }
  }
  return {
    names: allocateStableNames(entries.map((e) => ({ ...e, natural: e.natural }))),
    paths: allocateStableNames(entries.map((e) => ({ ...e, natural: e.path }))),
  };
}

export const refVar = (m: Manifest, node: { id: string; name: string }, field: string) =>
  refNamesFor(m).names.get(`${node.id}\0${field}`) ?? tf(`ref_${node.name}_${field}`);

export const refPath = (m: Manifest, node: { id: string; name: string }, field: string) =>
  refNamesFor(m).paths.get(`${node.id}\0${field}`) ?? `refs/${ssmSafe(node.name)}/${field}`;

/** SSM parameter names accept only these characters. */
export const ssmSafe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "-");

/** A `variable` block the bundle must declare. */
export interface TfVariable {
  name: string;
  description: string;
  /** HCL default. Omitted = the user must supply it. */
  default?: string;
}

/**
 * A SecureString parameter the bundle creates so the first `terraform apply`
 * does not fail when ECS resolves the task definition's `secrets` block.
 */
export interface SecretParam {
  /** terraform resource label */
  label: string;
  /** name under /${var.name_prefix}/ */
  path: string;
  /** key into var.secret_values */
  key: string;
  description: string;
}

/** Route serving this service, if any. */
export function routeOf(m: Manifest, serviceId: string): Route | undefined {
  const b = m.bindings.find(
    (x) => x.capability === "http" && x.to === serviceId && m.routes.some((r) => r.id === x.from)
  );
  return b ? m.routes.find((r) => r.id === b.from) : undefined;
}

export const projectSlug = (env: Environment) => String(env.baseDomain ?? "").split(".")[0] || "zenith";

/** Sandbox regions are Zenith-internal; a real bundle needs a real region. */
export const exportRegion = (env: Environment) => {
  const r = String(env.region ?? "");
  return r.startsWith("sim-") || r === "" ? "us-east-1" : r;
};

/** `<project>-<environment>`, the default for `var.name_prefix`. */
export const namePrefix = (env: Environment) => `${projectSlug(env)}-${String(env.name ?? "")}`;
