/**
 * OCI signal reads use broker-owned environment bindings, never a whole
 * compartment as a substitute. External responses remain bounded data.
 * Service/allowlist additions are owned by the OCI runner workstream;
 * absent entries fail closed. No OCI tenancy was exercised live.
 */
import type { OciSession as BrokerOciSession, OciResourceBinding } from "@/lib/credentials/types";
import { capability, isCapability } from "@/lib/capabilities/catalog";
import type { OciApiRequest, OciSession } from "@/lib/providers/oci/transport";
import { OCI_SERVICE_HOSTS, isOcid, isRegionId, type OciServiceId } from "@/lib/providers/oci/services";
import { isAllowed } from "@/lib/providers/oci/allowlist";
import { raceAbort } from "../abort";
import type { SignalScope } from "../types";

export type OciSignalSession = OciSession & Partial<Pick<BrokerOciSession, "scope" | "capability" | "expiresAt">>;
export const OCI_READ_BUDGET = 10;
export const OCI_RESPONSE_BYTES = 1024 * 1024;

/** Narrow through the authoritative table; never cast a new logical service past it. */
function registeredService(service: string): service is OciServiceId {
  return Object.hasOwn(OCI_SERVICE_HOSTS, service);
}

export function signalRequest(session: OciSignalSession, service: string, path: string): OciApiRequest | undefined {
  if (!session.capability || !isCapability(session.capability) || capability(session.capability).mutates || !registeredService(service) || !isRegionId(session.region) || !isOcid(session.compartmentOcid)) return undefined;
  const req: OciApiRequest = { service, region: session.region, method: "POST", path };
  return isAllowed(session.capability, req) ? req : undefined;
}

export function boundResources(session: OciSignalSession, scope: SignalScope): readonly OciResourceBinding[] | undefined {
  const binding = session.scope;
  if (!binding || binding.workspaceId !== scope.workspaceId || binding.environmentId !== scope.environmentId || (scope.projectId !== undefined && scope.projectId !== binding.projectId)) return undefined;
  if (session.expiresAt && (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now())) return undefined;
  const addresses = scope.addresses?.length ? new Set(scope.addresses) : undefined;
  return binding.resources.filter((r) => isOcid(r.externalId) && (!addresses || addresses.has(r.address)));
}

/** Caller aborts propagate; provider and timeout errors use fixed, secret-free text. */
export async function readSignal(session: OciSignalSession, req: OciApiRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  try {
    const response = await raceAbort(session.transport.request(req, { signal: bounded }), bounded);
    signal.throwIfAborted();
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error("OCI runner returned an invalid HTTP status.");
    if (response.status < 200 || response.status >= 300) throw new Error(`OCI signal read returned HTTP ${response.status}.`);
    const json = JSON.stringify(response.body);
    if (json === undefined || Buffer.byteLength(json, "utf8") > OCI_RESPONSE_BYTES) throw new Error("OCI signal response is missing or exceeds the response limit.");
    return response;
  } catch (error) {
    signal.throwIfAborted();
    // No provider text escapes. Numeric status is the only remote error detail.
    const message = error instanceof Error && /^OCI (?:signal read returned HTTP \d{3}\.|runner returned an invalid HTTP status\.|signal response is missing or exceeds the response limit\.)$/.test(error.message) ? error.message : bounded.aborted ? "OCI signal read timed out." : "OCI runner signal read is unavailable.";
    throw new Error(message);
  }
}

export function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}
