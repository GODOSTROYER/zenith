/**
 * Deterministic names, labels and tags for GCP objects (DRIVER-CONVENTIONS).
 *
 *   - tofu labels: the node address sanitized to `[a-z0-9_]` (`service/web` →
 *     `service_web`); extra resources of one node take a `_<suffix>`;
 *   - cloud-side names: `<namePrefix>-<node-name>` lowercased to `[a-z0-9-]`,
 *     truncated to the object's limit with a deterministic 6-hex FNV-1a
 *     suffix (never silently cut);
 *   - labels: `ctx.tags` sanitized to GCP label rules (lowercase
 *     `[a-z0-9_-]`, key starts with a letter, ≤ 63 chars, ≤ 64 labels);
 *   - network tags (VPC firewall targeting): `zn-<slug>-<hash6>`, derived from
 *     the node address only, so a workload and the firewall rule that names it
 *     agree without looking at each other;
 *   - compute objects that have no `labels` field (networks, subnetworks,
 *     firewalls) carry the Zenith tags in `description` instead, which
 *     discovery parses.
 */
import { fnv1a } from "@/lib/domain/hash";
import type { ResourceNode } from "@/lib/resources/types";

export const fnv6 = (s: string): string => fnv1a(s).toString(16).padStart(8, "0").slice(0, 6);

/** `service/web` → `service_web`; never empty, never starts with a digit. */
export function tfLabel(address: string): string {
  const s = String(address).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (s === "") return "n";
  return /^[0-9]/.test(s) ? `n_${s}` : s;
}

/** tofu label for an additional resource of the same node, e.g. `service_web_run`. */
export const tfSub = (address: string, suffix: string): string => `${tfLabel(address)}_${suffix}`;

/** The part of an address after the first `/` (`service/web` → `web`). */
export function nodeName(address: string): string {
  const i = address.indexOf("/");
  return i < 0 ? address : address.slice(i + 1);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface CloudNameOptions {
  /** provider limit for this object type */
  max: number;
  /** minimum length the API accepts */
  min?: number;
  /** extra words between prefix and node name (`sql`, `psa`) */
  suffix?: string;
  /** add a hash of the node identity even when not truncated (globally unique names) */
  unique?: string;
}

/**
 * `<prefix>-<node-name>[-<suffix>]`, valid as a GCP resource id: starts with a
 * letter, `[a-z0-9-]`, ends alphanumeric, length ≤ `max`.
 */
export function cloudName(namePrefix: string, address: string, opts: CloudNameOptions): string {
  const prefix = slug(namePrefix);
  const parts = [prefix, slug(nodeName(address)), opts.suffix ? slug(opts.suffix) : ""].filter((p) => p !== "");
  let full = parts.join("-");
  if (!/^[a-z]/.test(full)) full = `z${full}`;
  const tail = opts.unique ? `-${fnv6(`${opts.unique}\0${address}`)}` : "";
  let out = `${full}${tail}`;
  if (out.length > opts.max) {
    const h = fnv6(`${full}${tail}`);
    const keep = opts.max - 7;
    out = `${full.slice(0, Math.max(1, keep)).replace(/-+$/g, "")}-${h}`;
  }
  const min = opts.min ?? 1;
  if (out.length < min) out = `${out}-${fnv6(out)}`.slice(0, Math.max(min, out.length));
  return out.replace(/-+$/g, "") || `z${fnv6(address)}`;
}

/* --------------------------------- labels --------------------------------- */

const LABEL_MAX = 63;
const LABELS_MAX = 64;

function labelPart(s: string, isKey: boolean): string {
  let out = String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  if (isKey && !/^[a-z]/.test(out)) out = `z${out}`;
  return out.slice(0, LABEL_MAX);
}

/** `ctx.tags` → GCP labels. Sorted; later keys win on collision. */
export function gcpLabels(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(tags).sort()) {
    const key = labelPart(k, true);
    if (key === "") continue;
    out[key] = labelPart(tags[k] ?? "", false);
  }
  const keys = Object.keys(out).sort().slice(0, LABELS_MAX);
  return Object.fromEntries(keys.map((k) => [k, out[k]]));
}

/** The tags for this node: `ctx.tags` plus `zenith:resource` when the caller did not scope it. */
export function nodeTags(tags: Record<string, string>, node: Pick<ResourceNode, "address">): Record<string, string> {
  return tags["zenith:resource"] ? { ...tags } : { ...tags, "zenith:resource": node.address };
}

export const nodeLabels = (tags: Record<string, string>, node: Pick<ResourceNode, "address">): Record<string, string> => gcpLabels(nodeTags(tags, node));

/** Do API-returned `labels` identify this environment + resource? */
export function labelsMatch(found: Record<string, unknown> | undefined, expected: Record<string, string>): boolean {
  if (!found) return false;
  const env = expected.zenith_environment;
  const res = expected.zenith_resource;
  if (env === undefined || res === undefined) return false;
  return found.zenith_environment === env && found.zenith_resource === res;
}

/** Was this object created by Zenith at all (any environment)? */
export function zenithTagged(found: Record<string, unknown> | undefined): boolean {
  return !!found && typeof found.zenith_environment === "string" && found.zenith_environment !== "";
}

/* ------------------------ description-carried tags ------------------------- */

const DESC_PREFIX = "Managed by Zenith";

/**
 * For objects without labels: a description Zenith can parse back. Values are
 * label-sanitized (same rules as `gcpLabels`) so one comparison serves both.
 */
export function tagDescription(tags: Record<string, string>, node: Pick<ResourceNode, "address">, what?: string, max = 2000): string {
  const l = nodeLabels(tags, node);
  const pairs = ["zenith_environment", "zenith_resource"].filter((k) => l[k] !== undefined).map((k) => `${k}=${l[k]}`);
  const text = `${DESC_PREFIX}${what ? `: ${what}` : ""}. ${pairs.join("; ")}`;
  return text.length > max ? text.slice(0, max) : text;
}

/** Parse `zenith_environment=…; zenith_resource=…` back out of a description. */
export function parseTagDescription(description: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof description !== "string" || !description.includes(DESC_PREFIX)) return out;
  for (const m of description.matchAll(/\b(zenith_[a-z_]+)=([a-z0-9_-]*)/g)) out[m[1]] = m[2];
  return out;
}

/* ------------------------------- network tags ------------------------------ */

/** VPC network tag for a workload: stable function of its address. */
export function networkTag(address: string): string {
  const s = slug(nodeName(address)).slice(0, 40).replace(/-+$/g, "") || "w";
  return `zn-${s}-${fnv6(address)}`;
}

/** Suffix of a queue node's subscription resource (`google_pubsub_subscription.<label>_sub`). */
export const SUBSCRIPTION_SUFFIX = "sub";
