/**
 * The OCI services the drivers talk to, by LOGICAL id.
 *
 * TypeScript never chooses a host. A request names a `service` and a `region`;
 * the runner (docs/platform/RUNNER-PROTOCOL-OCI.md) owns the authoritative
 * service → host table, refuses anything that does not resolve to
 * `https://*.oraclecloud.com`, and signs with its local instance / resource
 * principal. That keeps hostnames out of model- and manifest-influenced
 * strings: the only external text that reaches a URL is an OCID or a resource
 * name, and those are validated and percent-encoded here (`ociPath`).
 *
 * `OCI_SERVICE_HOSTS` mirrors the runner table for documentation and tests.
 * HONEST LIMIT: the host templates and API versions are taken from the OCI
 * SDK endpoint conventions and were NOT exercised against a live tenancy
 * (WS-OCI has no OCI account). The runner should derive endpoints from the OCI
 * Go SDK's own service clients rather than from this table; a mismatch would
 * surface as a 404/connect error on the first live call, never as a silently
 * wrong answer.
 */

export type OciServiceId =
  | "core"
  | "loadbalancer"
  | "certificates"
  | "dns"
  | "containerinstances"
  | "artifacts"
  | "postgresql"
  | "objectstorage"
  | "queue"
  | "queue-data"
  | "vault"
  | "identity"
  | "logging"
  | "redis"
  | "containerengine"
  | "mysql";

export interface OciServiceHost {
  /** `{region}` is substituted by the runner from the request's region */
  host: string;
  /** API version path segment, where the service has one */
  version?: string;
}

export const OCI_SERVICE_HOSTS: Readonly<Record<OciServiceId, OciServiceHost>> = {
  core: { host: "iaas.{region}.oraclecloud.com", version: "20160918" },
  loadbalancer: { host: "iaas.{region}.oraclecloud.com", version: "20170115" },
  certificates: { host: "certificates.{region}.oci.oraclecloud.com", version: "20210224" },
  dns: { host: "dns.{region}.oraclecloud.com", version: "20180115" },
  containerinstances: { host: "compute-containers.{region}.oci.oraclecloud.com", version: "20210415" },
  artifacts: { host: "artifacts.{region}.oci.oraclecloud.com", version: "20160918" },
  postgresql: { host: "postgresql.{region}.oci.oraclecloud.com", version: "20220915" },
  objectstorage: { host: "objectstorage.{region}.oraclecloud.com" },
  queue: { host: "messaging.{region}.oci.oraclecloud.com", version: "20210201" },
  /** data-plane host comes from the queue's own `messagesEndpoint`; the runner checks it is `*.oraclecloud.com` */
  "queue-data": { host: "{messagesEndpoint}", version: "20210201" },
  vault: { host: "vaults.{region}.oci.oraclecloud.com", version: "20180608" },
  identity: { host: "identity.{region}.oci.oraclecloud.com", version: "20160918" },
  logging: { host: "logging.{region}.oci.oraclecloud.com", version: "20200531" },
  redis: { host: "redis.{region}.oci.oraclecloud.com", version: "20220315" },
  containerengine: { host: "containerengine.{region}.oraclecloud.com", version: "20180222" },
  mysql: { host: "mysql.{region}.ocp.oraclecloud.com", version: "20190415" },
};

const OCID = /^ocid1\.[a-z0-9_]+\.[a-z0-9]+\.[a-z0-9-]*\.[A-Za-z0-9]{6,120}$/;
const REGION = /^[a-z]{2}-[a-z0-9-]{3,30}-\d$/;

/** Is `s` shaped like an OCID? Shape only: OCI is the authority on whether it exists. */
export const isOcid = (s: unknown): s is string => typeof s === "string" && s.length <= 300 && OCID.test(s);

export const isRegionId = (s: unknown): s is string => typeof s === "string" && REGION.test(s);

/**
 * `/<version>/<seg>/<seg>…` with every segment percent-encoded. A segment may
 * come from an externalId or a resource name, so it is encoded, never spliced.
 */
export function ociPath(service: OciServiceId, ...segments: (string | number)[]): string {
  const version = OCI_SERVICE_HOSTS[service].version;
  const enc = segments.map((s) => {
    const raw = String(s);
    // `encodeURIComponent` leaves "." and ".." alone; a dot-only segment is a path traversal, never a name
    if (raw === "" || /^[.]+$/.test(raw)) throw new Error("A path segment is empty or made only of dots.");
    return encodeURIComponent(raw);
  });
  return `/${[...(version ? [version] : []), ...enc].join("/")}`;
}

/** An OCID that is safe to place in a path, or a thrown error naming the field. */
export function requireOcid(value: unknown, what: string): string {
  if (!isOcid(value)) throw new Error(`${what} is not a valid OCID.`);
  return value;
}
