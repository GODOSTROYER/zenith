/**
 * Does each managed serving integration actually operate? (PROD-MAN-02)
 *
 * Configuration is not operation. This report keeps the two apart and never reports an integration as working without a
 * probe that observed it working:
 *
 *   not_configured          the substrate variables for it are absent
 *   configured_unverified   configured; nothing has observed it operate (the honest default)
 *   verified                a probe observed it operating just now (what it observed is in `detail`)
 *   failing                 a probe ran and it did not operate (why is in `detail`)
 *
 * Probes are operator-configured targets only (the registry host, the app domain), never a tenant-supplied address, and are
 * bounded by timeouts. The per-environment TLS and gateway status comes from the Kubernetes objects' own conditions through
 * the narrow gateway-namespace client (`environmentServingStatus`), which is what turns "desired objects were accepted" into
 * "the certificate was issued and the gateway programmed".
 */
import { dig } from "@/lib/providers/zenith/k8s-port";
import type { ZenithSubstrate } from "@/lib/providers/zenith/substrate";
import { customDomainTlsNames, environmentTlsNames, CERTIFICATE_API_VERSION, GATEWAY_API_VERSION } from "@/lib/providers/zenith/tls";
import type { TlsObjectClient } from "@/lib/providers/zenith/tls-client";
import type { ZenithTenant } from "@/lib/providers/zenith/types";

export type IntegrationId = "cluster" | "registry" | "gateway" | "dns" | "tls" | "secret_delivery" | "object_storage" | "managed_database" | "custom_domains" | "autoscaling";
export type IntegrationState = "not_configured" | "configured_unverified" | "verified" | "failing";

export interface IntegrationStatus {
  id: IntegrationId;
  state: IntegrationState;
  detail: string;
}

export interface ProbeResult { ok: boolean; detail: string }

export interface ReadinessProbes {
  /** `GET https://<host>/v2/`: a Docker registry v2 API answers 200 or 401 with its API-version header */
  registry?(host: string): Promise<ProbeResult>;
  /** the app domain's wildcard DNS: `zenith-probe.<domain>` must resolve to something */
  wildcardDns?(baseDomain: string): Promise<ProbeResult>;
}

const unverified = (id: IntegrationId, detail: string): IntegrationStatus => ({ id, state: "configured_unverified", detail });
const missing = (id: IntegrationId, detail: string): IntegrationStatus => ({ id, state: "not_configured", detail });
const fromProbe = (id: IntegrationId, r: ProbeResult): IntegrationStatus => ({ id, state: r.ok ? "verified" : "failing", detail: r.detail });

export async function managedIntegrationReadiness(substrate: ZenithSubstrate | undefined, probes: ReadinessProbes = {}): Promise<IntegrationStatus[]> {
  if (!substrate) {
    const detail = "The platform is not configured (see GET /api/platform/v1/managed-services for the variables).";
    return (["cluster", "registry", "gateway", "dns", "tls", "secret_delivery", "object_storage", "managed_database", "custom_domains", "autoscaling"] as IntegrationId[]).map((id) => missing(id, detail));
  }
  const out: IntegrationStatus[] = [unverified("cluster", "the managed cluster API; its credential is a vault reference and is not probed here")];
  out.push(substrate.registry
    ? probes.registry ? fromProbe("registry", await probes.registry(substrate.registry.host)) : unverified("registry", `${substrate.registry.host}; not probed`)
    : missing("registry", "No platform registry: only prebuilt image references run."));
  out.push(unverified("gateway", substrate.gateway.mode === "gateway_api" ? `Gateway API, one Gateway per environment in ${substrate.gateway.namespace}; per-environment status is read with environmentServingStatus` : `Ingress class ${substrate.gateway.ingressClass ?? "?"}; no per-environment gateway or automated TLS`));
  out.push(probes.wildcardDns ? fromProbe("dns", await probes.wildcardDns(substrate.baseDomain)) : unverified("dns", `wildcard *.${substrate.baseDomain} is operator-provisioned; not probed`));
  out.push(substrate.gateway.mode === "gateway_api" ? unverified("tls", `wildcard certificate per environment from ClusterIssuer ${substrate.certManager.clusterIssuer} (DNS-01); issuance is proven only by the Certificate's Ready condition`) : missing("tls", "Ingress mode: certificates are the ingress controller's."));
  out.push(unverified("secret_delivery", "values resolve from the encrypted vault at apply time into Secret objects; rendered manifests carry references only"));
  out.push(!substrate.objectStorage ? missing("object_storage", "No shared bucket configured.")
    : substrate.objectStorage.adminCredentialRef ? unverified("object_storage", `bucket ${substrate.objectStorage.bucket}; one scoped principal per object store`)
    : missing("object_storage", "A bucket is configured but no IAM-admin credential reference: tenant object stores are unavailable."));
  out.push(substrate.database ? unverified("managed_database", `${substrate.database.provider} ${substrate.database.regionId}; not probed`) : missing("managed_database", "No managed database provider."));
  out.push(substrate.gateway.mode === "gateway_api" && substrate.certManager.httpClusterIssuer ? unverified("custom_domains", `DNS TXT proof, ACME HTTP-01 via ClusterIssuer ${substrate.certManager.httpClusterIssuer}`) : missing("custom_domains", "Needs Gateway API mode and ZENITH_MANAGED_HTTP_CLUSTER_ISSUER."));
  out.push(unverified("autoscaling", "HorizontalPodAutoscaler objects are rendered; scaling needs metrics-server in the cluster, which is not probed"));
  return out;
}

/* --------------------------- live probes (network) -------------------------- */

export function registryProbe(fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): ReadinessProbes["registry"] {
  return async (host) => {
    try {
      const res = await fetchImpl(`https://${host}/v2/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      const api = res.headers.get("docker-distribution-api-version");
      if ((res.status === 200 || res.status === 401) && (api !== null || res.status === 401)) return { ok: true, detail: `registry v2 API answered ${res.status}` };
      return { ok: false, detail: `answered ${res.status} without the registry v2 API signature` };
    } catch {
      return { ok: false, detail: "the registry did not answer" };
    }
  };
}

export function wildcardDnsProbe(resolve: (name: string) => Promise<string[]>): ReadinessProbes["wildcardDns"] {
  return async (baseDomain) => {
    try {
      const answers = await resolve(`zenith-probe.${baseDomain}`);
      return answers.length > 0 ? { ok: true, detail: `wildcard resolves (${answers.length} address${answers.length === 1 ? "" : "es"})` } : { ok: false, detail: "the wildcard does not resolve" };
    } catch {
      return { ok: false, detail: "the wildcard does not resolve" };
    }
  };
}

/* ------------------------ per-environment TLS and gateway ------------------------ */

export interface ServingObjectStatus {
  object: "wildcard_certificate" | "gateway" | "custom_certificate";
  host?: string;
  state: "ready" | "not_ready" | "missing" | "unknown";
  detail: string;
}

const condition = (live: Record<string, unknown> | undefined, type: string): { status: string; message?: string } | undefined => {
  const conds = dig(live, "status", "conditions");
  if (!Array.isArray(conds)) return undefined;
  const c = conds.find((x) => x && typeof x === "object" && (x as Record<string, unknown>).type === type) as Record<string, unknown> | undefined;
  return c ? { status: String(c.status), ...(typeof c.reason === "string" ? { message: c.reason } : {}) } : undefined;
};

/**
 * Read the environment's Certificate and Gateway conditions. A Certificate is `ready` only on `Ready=True`; the Gateway only on
 * `Programmed=True`. Reasons are the controllers' short reason codes, never message text or Secret content.
 */
export async function environmentServingStatus(client: TlsObjectClient, tenant: ZenithTenant, substrate: ZenithSubstrate, customDomains: readonly string[] = []): Promise<ServingObjectStatus[]> {
  if (substrate.gateway.mode !== "gateway_api") return [];
  const ns = substrate.gateway.namespace;
  const names = environmentTlsNames(tenant, substrate);
  const status = async (object: ServingObjectStatus["object"], kind: "Certificate" | "Gateway", name: string, type: "Ready" | "Programmed", host?: string): Promise<ServingObjectStatus> => {
    try {
      const live = await client.read({ apiVersion: kind === "Gateway" ? GATEWAY_API_VERSION : CERTIFICATE_API_VERSION, kind, namespace: ns, name });
      if (!live) return { object, ...(host ? { host } : {}), state: "missing", detail: `${kind} ${name} does not exist` };
      const c = condition(live, type);
      if (!c) return { object, ...(host ? { host } : {}), state: "unknown", detail: `${kind} has not reported ${type} yet` };
      return { object, ...(host ? { host } : {}), state: c.status === "True" ? "ready" : "not_ready", detail: c.status === "True" ? `${type}=True` : `${type}=${c.status}${c.message ? ` (${c.message})` : ""}` };
    } catch {
      return { object, ...(host ? { host } : {}), state: "unknown", detail: `${kind} could not be read` };
    }
  };
  return [
    await status("wildcard_certificate", "Certificate", names.certificate, "Ready"),
    await status("gateway", "Gateway", names.gateway, "Programmed"),
    ...(await Promise.all([...customDomains].sort().map((host) => status("custom_certificate", "Certificate", customDomainTlsNames(tenant, host).certificate, "Ready", host)))),
  ];
}
