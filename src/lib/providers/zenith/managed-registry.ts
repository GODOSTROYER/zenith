/**
 * The Zenith-operated registry as a NAMING and OWNERSHIP policy (PROD-MAN-01).
 *
 * Pure: no network, no credentials. It answers "where does this tenant's
 * image live" and "is this reference one this tenant may run". Pushing and
 * digest verification are the build path's business (`managed-build.ts`); a
 * registry the platform does not operate is never trusted by this policy.
 *
 * Layout: `<host>/<repositoryPrefix>/<workspace-segment>/<environment-segment>/<service>`.
 * A segment is the id itself when it is already a valid lowercase OCI path
 * component, otherwise `h-<20 hex of sha256(id)>`, so two different ids never
 * share a segment and an id that cannot be a path component is never altered
 * in a way that could collide with another tenant's.
 */
import { createHash } from "node:crypto";
import type { ManagedRegistryPort } from "./managed-port";
import { ManagedSubstrateError } from "./managed-port";
import type { ZenithSubstrate } from "./substrate";
import type { ZenithTenant } from "./types";

const SEGMENT_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SERVICE_RE = /^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** A path component derived from an id; injective in practice (ids that are valid pass through, others hash). */
export function registrySegment(id: string): string {
  if (SEGMENT_RE.test(id) && !id.startsWith("h-")) return id;
  return `h-${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
}

type TenantIds = Pick<ZenithTenant, "workspaceId" | "environmentId">;

export function createManagedRegistry(registry: NonNullable<ZenithSubstrate["registry"]>): ManagedRegistryPort {
  const base = `${registry.host}${registry.repositoryPrefix ? `/${registry.repositoryPrefix}` : ""}`;
  const root = (t: TenantIds): string => `${base}/${registrySegment(t.workspaceId)}/${registrySegment(t.environmentId)}`;
  const repositoryFor = (t: TenantIds, serviceName: string): string => {
    if (!SERVICE_RE.test(serviceName)) {
      throw new ManagedSubstrateError("registry_refused", "The service name is not a valid registry repository name (lowercase letters, digits, '.', '_' and '-').");
    }
    return `${root(t)}/${serviceName}`;
  };
  return {
    host: registry.host,
    tenantRepositoryRoot: root,
    repositoryFor,
    ownsPinnedImage(t, imageRef) {
      const at = imageRef.lastIndexOf("@");
      if (at <= 0 || !DIGEST_RE.test(imageRef.slice(at + 1))) return false;
      const repo = imageRef.slice(0, at);
      const prefix = `${root(t)}/`;
      if (!repo.startsWith(prefix)) return false;
      const service = repo.slice(prefix.length);
      return SERVICE_RE.test(service);
    },
    isManagedHost(imageRef) {
      return imageRef.startsWith(`${registry.host}/`);
    },
  };
}
