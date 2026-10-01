/**
 * Deterministic names, tofu labels and tags for Azure fragments.
 *
 * - `tfLabel(address, part)`: `[a-z0-9_]` tofu block label derived from the
 *   node address (`service/web` → `container_service_web` style), one suffix
 *   per resource a node declares. Injective for every address the expansion
 *   can produce (node names are `[a-z][a-z0-9-]*`, hosts add `.`); any other
 *   character adds a hash so two sanitized addresses can never collide.
 * - `cloudName(ctx, address, …)`: `${ctx.namePrefix}-<node-name>` within the
 *   resource's length and character rules; when truncated a deterministic
 *   6-hex fnv1a suffix keeps it unique.
 * - `scopedName(address, …)`: prefix-free, for resources whose name only has
 *   to be unique inside the environment resource group or inside a parent.
 *   Drivers use it where `observe` must find a NON-TAGGABLE child (subnet,
 *   NSG rule) without knowing `namePrefix`, which `DriverContext` does not carry.
 * - `azureTags`: the node's Zenith tags, valid under Azure's tag rules.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";

/** 32-bit FNV-1a. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Six lowercase hex digits (24 bits) of fnv1a. */
export const hash6 = (input: string): string => fnv1a(input).toString(16).padStart(8, "0").slice(0, 6);

/** `kind/name` → `name`; an address without a slash is its own name. */
export const nodeNameOf = (address: string): string => address.slice(address.indexOf("/") + 1);
export const nodeKindOf = (address: string): string => (address.includes("/") ? address.slice(0, address.indexOf("/")) : "");

/** `[a-z0-9-]`, lowercase, no leading/trailing/double hyphens; never empty. */
export function slug(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "x";
}

/** A tofu block label unique per (address, part). */
export function tfLabel(address: string, part?: string): string {
  // the expansion's node names are `[a-z][a-z0-9-]*` (hosts add `.`); anything else in the NAME part, or in
  // the kind part, is hashed so two different addresses can never sanitize to one label
  const slash = address.indexOf("/");
  const kindPart = slash < 0 ? "" : address.slice(0, slash);
  const lossy = /[^a-z0-9.-]/.test(slash < 0 ? address : address.slice(slash + 1)) || /[^a-z0-9_]/.test(kindPart);
  const base = address
    .replace(/\//g, "_")
    .replace(/\./g, "__")
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]/gi, "_")
    .toLowerCase();
  const withPart = part ? `${base}_${part}` : base;
  const label = lossy ? `${withPart}_${hash6(address)}` : withPart;
  return /^[0-9]/.test(label) ? `_${label}` : label;
}

export interface NameRule {
  /** hard maximum length */
  max: number;
  /** `-` (default) or `""` for names that may only contain `[a-z0-9]` */
  sep?: "-" | "";
  /** extra stem segment, e.g. `kv`; included in the hash input */
  suffix?: string;
}

/** `${namePrefix}-<node-name>[-suffix]`, truncated with a deterministic hash suffix. */
export function cloudName(ctx: Pick<CompileContext, "namePrefix">, address: string, rule: NameRule): string {
  const sep = rule.sep ?? "-";
  const parts = [slug(ctx.namePrefix), slug(nodeNameOf(address)), rule.suffix ? slug(rule.suffix) : ""].filter(Boolean);
  let base = parts.join(sep);
  if (sep === "") base = base.replace(/[^a-z0-9]/g, "");
  // most Azure names must start with a letter
  if (/^[0-9]/.test(base)) base = `z${base}`;
  if (base.length <= rule.max) return base;
  const h = hash6(`${ctx.namePrefix}|${address}|${rule.suffix ?? ""}`);
  const keep = Math.max(1, rule.max - 6 - sep.length);
  const stem = base.slice(0, keep).replace(/-+$/g, "");
  return `${stem}${sep}${h}`;
}

/** Prefix-free name, unique per node address: `<node-name>[-suffix]`. */
export function scopedName(address: string, rule: { max: number; suffix?: string }): string {
  const base = [slug(nodeNameOf(address)), rule.suffix ? slug(rule.suffix) : ""].filter(Boolean).join("-");
  if (base.length <= rule.max) return base;
  const stem = base.slice(0, Math.max(1, rule.max - 7)).replace(/-+$/g, "");
  return `${stem}-${hash6(address)}`;
}

/* ---------------------------------- tags ----------------------------------- */

const BAD_TAG_NAME = /[<>%&\\?/]/g;

/**
 * Tags for a node's taggable resources: the node's own labels
 * (`zenith:environment`, `zenith:managed`, `zenith:resource`) overlaid with the
 * compile context's (`zenith:workspace`, …). Azure limits: name ≤ 512 chars and
 * none of `< > % & \ ? /`, value ≤ 256 chars. Sorted for determinism.
 */
export function azureTags(ctx: Pick<CompileContext, "tags">, node: Pick<ResourceNode, "labels">): Record<string, string> {
  const merged: Record<string, string> = { ...node.labels, ...ctx.tags };
  const out: Record<string, string> = {};
  for (const k of Object.keys(merged).sort()) {
    const v = String(merged[k]);
    const name = k.replace(BAD_TAG_NAME, "_").slice(0, 512);
    out[name] = v.slice(0, 256);
  }
  return out;
}
