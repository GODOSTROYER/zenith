/**
 * What an OCI driver needs at compile time that `CompileContext` does not carry.
 *
 * `CompileContext` (src/lib/drivers/types.ts, a fixed contract) has no account
 * scoping. OCI resources cannot be declared without a compartment OCID, and
 * identity resources (dynamic groups) live in the TENANCY, so the orchestrator
 * must wrap the context it passes to `compile` for an OCI node:
 *
 *   compile(node, ociCompileContext(ctx, { compartmentOcid, tenancyOcid }))
 *
 * Both values come from the verified `OciConnectionConfig`; neither is a
 * secret. A driver given a plain `CompileContext` refuses to compile with a
 * message saying exactly this (it never guesses a compartment). Proposed
 * contract change for the orchestrator: give `CompileContext` an optional
 * `providerScope?: Record<string, string>` so this wrapper is unnecessary.
 */
import type { CompileContext } from "@/lib/drivers/types";
import { OciCompileError } from "./errors";
import { isOcid } from "./services";

export interface OciCompileContext extends CompileContext {
  compartmentOcid: string;
  tenancyOcid: string;
}

export function ociCompileContext(base: CompileContext, scope: { compartmentOcid: string; tenancyOcid: string }): OciCompileContext {
  if (!isOcid(scope.compartmentOcid)) throw new OciCompileError("compartmentOcid is not a valid OCID.");
  if (!isOcid(scope.tenancyOcid)) throw new OciCompileError("tenancyOcid is not a valid OCID.");
  return { ...base, compartmentOcid: scope.compartmentOcid, tenancyOcid: scope.tenancyOcid };
}

const MISSING = "OCI compile needs the connection's compartment and tenancy OCIDs: wrap the context with ociCompileContext(ctx, { compartmentOcid, tenancyOcid }).";

export function compartmentOf(ctx: CompileContext): string {
  const v = (ctx as Partial<OciCompileContext>).compartmentOcid;
  if (!isOcid(v)) throw new OciCompileError(MISSING);
  return v;
}

export function tenancyOf(ctx: CompileContext): string {
  const v = (ctx as Partial<OciCompileContext>).tenancyOcid;
  if (!isOcid(v)) throw new OciCompileError(MISSING);
  return v;
}
