/**
 * Validation shared by the additional Azure drivers. No I/O or credentials.
 * New kinds are not emitted by manifest expansion yet: these helpers validate
 * explicit graph specs and refuse unsupported combinations before producing IaC.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { AzureCompileError, dependencies, requireNode } from "@/lib/providers/azure/compile-util";
import { armTypeOf, parseArmId, sameArmType } from "@/lib/providers/azure/arm";
import { exportRef } from "@/lib/providers/azure/exports";

export function invalid(node: ResourceNode, message: string): never {
  throw new AzureCompileError(message, node.address);
}

export function textSpec(node: ResourceNode, key: string, fallback?: string): string {
  const value = node.spec[key] ?? fallback;
  if (typeof value !== "string" || !value.trim() || value.includes("${") || value.includes("%{")) invalid(node, `spec.${key} must be a nonempty literal string.`);
  return value;
}

export function integerSpec(node: ResourceNode, key: string, fallback: number, min: number, max: number): number {
  const value = node.spec[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) invalid(node, `spec.${key} must be an integer between ${min} and ${max}.`);
  return value;
}

export function boolSpec(node: ResourceNode, key: string, fallback: boolean): boolean {
  const value = node.spec[key] ?? fallback;
  if (typeof value !== "boolean") invalid(node, `spec.${key} must be a boolean.`);
  return value;
}

export function armIdSpec(node: ResourceNode, key: string, type: string): string {
  const id = textSpec(node, key);
  const actual = armTypeOf(id);
  if (!parseArmId(id)?.resourceGroup || !actual || !sameArmType(actual, type)) invalid(node, `spec.${key} must identify ${type}.`);
  return id;
}

/** Caller supplied credentials must never be echoed in a diagnostic or IaC. */
export function rejectCredentials(node: ResourceNode): void {
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (/password|private.?key|access.?key|connection.?string|client.?secret|adminLogin/i.test(key)) invalid(node, "inline credentials are not supported; use identity and secret references.");
      walk(v);
    }
  };
  walk(node.spec);
}

/** Escape Terraform template delimiters when a user string is data. */
export const tfLiteral = (value: string): string => value.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");

/** Resolve one explicitly chosen or unambiguous private subnet in this place. */
export function privateSubnet(node: ResourceNode, ctx: CompileContext, role?: "mysql" | "functions"): ResourceNode {
  const subnet = typeof node.spec.subnet === "string"
    ? requireNode(ctx, node.spec.subnet, "the workload subnet", node.address)
    : (() => {
        const matches = dependencies(node, ctx, (n) => n.kind === "subnet" && n.spec.tier === "private" && n.spec.role === role);
        if (matches.length !== 1) invalid(node, "spec.subnet must choose exactly one private subnet.");
        return matches[0];
      })();
  if (subnet.provider !== "azure" || subnet.region !== node.region || subnet.kind !== "subnet" || subnet.spec.tier !== "private" || subnet.spec.role !== role) {
    invalid(node, `the subnet must be a private Azure subnet in this region${role ? ` with spec.role=${role}` : " without delegation"}.`);
  }
  return subnet;
}

export function workloadIdentity(node: ResourceNode, ctx: CompileContext): { id: string; clientId: string; address: string } {
  const identities = dependencies(node, ctx, (n) => n.kind === "identity" && n.spec.workload === node.address);
  if (identities.length !== 1) invalid(node, "exactly one user-assigned workload identity dependency is required.");
  const identity = identities[0];
  if (identity.provider !== "azure" || identity.region !== node.region || identity.ownership !== "managed") invalid(node, "the workload identity must be managed by Azure in this region.");
  return { id: exportRef(identity.address, "id"), clientId: exportRef(identity.address, "client_id"), address: identity.address };
}

/** Typed property reads: malformed ARM values stay unknown. */
export const readString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
export const readBool = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
export const readNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
