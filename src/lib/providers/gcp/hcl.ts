/**
 * Helpers for building OpenTofu JSON fragments safely.
 *
 * Fragments are assembled from manifest-derived strings and executed with
 * real credentials, so every literal that originates outside this code
 * (env values, descriptions, image references, domain names) is escaped with
 * `lit()` before it is placed in a fragment: `${` and `%{` would otherwise
 * start a template expression and evaluate arbitrary HCL. Expressions that
 * *should* interpolate come only from `ctx.ref()` and from this package's own
 * resource addresses, through `expr()` / `ref()`.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "./errors";

/** Escape a literal so HCL does not treat it as a template. */
export function lit(s: string): string {
  return String(s).replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
}

/** `${expr}` from a bare traversal like `google_compute_network.x.id`. */
export const expr = (traversal: string): string => `\${${traversal}}`;

/**
 * Normalize whatever `ctx.ref` returns to a `${…}` template. The contract says
 * only that it returns "another node's compiled tofu address/attribute
 * reference"; accept both a bare traversal and an already-wrapped template.
 */
export function asTemplate(reference: string): string {
  const s = String(reference);
  return /^\$\{[\s\S]*\}$/.test(s) ? s : `\${${s}}`;
}

/** A reference to another node's primary resource attribute. */
export function ref(ctx: CompileContext, address: string, attribute: string): string {
  return asTemplate(ctx.ref(address, attribute));
}

/** The inner traversal of a template (`${a.b.c}` → `a.b.c`), for use inside larger expressions. */
export function inner(template: string): string {
  const m = /^\$\{([\s\S]*)\}$/.exec(template);
  return m ? m[1] : template;
}

/** Nodes this node depends on, resolved, of a given portable kind. Sorted by address. */
export function depsOfKind(node: ResourceNode, ctx: CompileContext, kind: ResourceNode["kind"]): ResourceNode[] {
  const out: ResourceNode[] = [];
  for (const a of [...node.dependsOn].sort()) {
    const n = ctx.node(a);
    if (n && n.kind === kind) out.push(n);
  }
  return out;
}

/** The compile-time address of the node's primary resource, as listed first in `addresses`. */
export function fragmentOf(resource: TofuFragment["resource"], addresses: string[], extra: Omit<TofuFragment, "resource" | "addresses"> = {}): TofuFragment {
  return { ...(resource && Object.keys(resource).length ? { resource } : {}), ...extra, addresses };
}

/** Assert a region string is safe to embed. */
export function safeRegion(region: string): string {
  if (!/^[a-z]{2,}-[a-z]+[0-9]{1,2}$/.test(region)) throw new GcpCompileError("invalid_region", `"${region}" is not a GCP region.`);
  return region;
}

/** Collapse empty/undefined members so JSON stays minimal and deterministic. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * Data-source fragment for a `referenced`/`external` node: Zenith reads the
 * object, never declares it. `args` are the data source's lookup arguments.
 */
export function dataFragment(type: string, label: string, args: Record<string, unknown>): TofuFragment {
  return { data: { [type]: { [label]: args } }, addresses: [`data.${type}.${label}`] };
}

/** The last path segment of a provider-side reference (`projects/p/…/zones/z` → `z`). */
export function lastSegment(externalRef: string | undefined, what: string): string {
  const seg = String(externalRef ?? "").replace(/\/+$/, "").split("/").pop();
  if (!seg) throw new GcpCompileError("missing_external_ref", `${what}: a referenced node needs an externalRef.`);
  return seg;
}
