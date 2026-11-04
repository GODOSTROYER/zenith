/**
 * Shared plumbing for the managed-serving routes (PROD-MAN-02/03): the domain service wired to the platform store, the real DNS
 * port and the substrate's app domain, and the translation of its refusals into the platform error body.
 */
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { platformDb } from "@/lib/controlplane/db";
import { ManagedDomainError, type DomainServiceDeps } from "@/lib/managed-serving/domain-service";
import { systemDomainDns } from "@/lib/managed-serving/domains";
import { readSubstrateConfig } from "@/lib/providers/zenith/substrate";

export async function domainDeps(): Promise<DomainServiceDeps> {
  const cfg = readSubstrateConfig(process.env);
  if (!cfg.configured) throw new BrokerError("invalid_state", "Zenith-managed hosting is not configured on this platform, so custom domains cannot be claimed.", "Ask the operator to configure ZENITH_MANAGED_* (docs/platform/MANAGED-PLATFORM.md).");
  return { sql: await platformDb(), dns: systemDomainDns(), baseDomain: cfg.substrate.baseDomain };
}

/** Reads need no substrate (a list of existing claims is useful even while hosting is being reconfigured). */
export async function readDomainDeps(): Promise<DomainServiceDeps> {
  return { sql: await platformDb(), dns: systemDomainDns(), baseDomain: "" };
}

const CODE: Record<ManagedDomainError["code"], ConstructorParameters<typeof BrokerError>[0]> = {
  invalid_hostname: "invalid_request",
  managed_suffix: "invalid_request",
  reserved_hostname: "invalid_request",
  unavailable: "conflict",
  limit_reached: "conflict",
  not_found: "not_found",
  challenge_expired: "invalid_state",
  revoked: "invalid_state",
  stale: "conflict",
};

/** Run `fn`, mapping a domain refusal to the platform's error shape. Anything else is rethrown untouched. */
export async function managedRefusals<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ManagedDomainError) throw error.code === "not_found" ? notFound() : new BrokerError(CODE[error.code], error.message);
    throw error;
  }
}
