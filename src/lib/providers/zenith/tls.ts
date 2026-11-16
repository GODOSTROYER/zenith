/**
 * Platform-owned TLS for one managed environment. Gateway API v1 supports a
 * Gateway per environment without ListenerSet or a shared listener-list writer.
 * The controller must serve these Gateways from the platform gateway namespace;
 * shared addresses/data planes are implementation-specific, never assumed here.
 * Pure desired objects only: issuance, DNS and HTTPS reachability are unverified.
 *
 * Custom domains (PROD-MAN-03): a hostname whose ownership was proven (DNS TXT, see
 * `src/lib/managed-serving/domains.ts`) gets its OWN listener and cert-manager Certificate on the same environment Gateway,
 * issued by the substrate's ACME HTTP-01 ClusterIssuer. The wildcard listener only covers the managed suffix, so a route for a
 * custom host attaches to that host's listener and nothing else.
 */
import { createHash } from "node:crypto";
import { OWNERSHIP, isRecord, type K8sObject } from "./k8s-port";
import { assertTenant, isManagedHost, managedHostname, managedHostSuffix, type ZenithSubstrate } from "./substrate";
import { dnsLabelOf, tenantNamespace } from "./tenancy";
import { TENANT_ANNOTATION, TENANT_LABEL, ZenithError, type ZenithTenant } from "./types";

export const GATEWAY_API_VERSION = "gateway.networking.k8s.io/v1";
export const CERTIFICATE_API_VERSION = "cert-manager.io/v1";
export const PLATFORM_TLS_LABEL = "zenith.dev/platform-tls";

/** Stable identities use full tenant ids, not mutable DNS slugs. */
export function environmentTlsNames(tenant: ZenithTenant, substrate: ZenithSubstrate) {
  assertTenant(tenant);
  const namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  return {
    gateway: dnsLabelOf(`${substrate.gateway.name}-${namespace}`),
    certificate: dnsLabelOf(`tls-${namespace}`),
    secret: dnsLabelOf(`tls-${namespace}`),
    listener: substrate.gateway.listener ?? "https",
  };
}

/**
 * Names for a verified custom domain's listener, Certificate and Secret. They derive from a hash of the hostname so they are
 * stable, unique and DNS-safe whatever the host looks like.
 */
export function customDomainTlsNames(tenant: ZenithTenant, host: string) {
  assertTenant(tenant);
  const namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const id = createHash("sha256").update(`zenith-custom-domain-v1\u0000${host}`).digest("hex").slice(0, 12);
  return { listener: `c-${id}`, certificate: dnsLabelOf(`tlsc-${namespace}-${id}`), secret: dnsLabelOf(`tlsc-${namespace}-${id}`) };
}

/** The listener a route for `host` must attach to: the wildcard listener for a managed host, the host's own otherwise. */
export function listenerForHost(host: string, tenant: ZenithTenant, substrate: ZenithSubstrate): string {
  return isManagedHost(host, tenant, substrate.baseDomain) ? environmentTlsNames(tenant, substrate).listener : customDomainTlsNames(tenant, host).listener;
}

export function environmentGatewayParent(tenant: ZenithTenant, substrate: ZenithSubstrate, sectionName?: string) {
  const names = environmentTlsNames(tenant, substrate);
  return { group: "gateway.networking.k8s.io", kind: "Gateway", name: names.gateway, namespace: substrate.gateway.namespace, sectionName: sectionName ?? names.listener };
}

/** The omitted group/kind defaults are allowed; a listener is always explicit. */
export function isEnvironmentGatewayParent(parent: unknown, tenant: ZenithTenant, substrate: ZenithSubstrate, sectionName?: string): boolean {
  const expected = environmentGatewayParent(tenant, substrate, sectionName);
  return isRecord(parent) && parent.name === expected.name && parent.namespace === expected.namespace
    && (parent.group === undefined || parent.group === expected.group)
    && (parent.kind === undefined || parent.kind === expected.kind)
    && parent.sectionName === expected.sectionName && (parent.port === undefined || parent.port === 443);
}

/** Does this parentRef attach exactly the listener the route's hostnames require? One kind of host per route, or it is refused. */
export function isRouteParentFor(parent: unknown, hostnames: readonly unknown[], tenant: ZenithTenant, substrate: ZenithSubstrate): boolean {
  const sections = new Set(hostnames.map((h) => (typeof h === "string" ? listenerForHost(h, tenant, substrate) : "")));
  return sections.size === 1 && !sections.has("") && isEnvironmentGatewayParent(parent, tenant, substrate, [...sections][0]);
}

/** Ownership also marks the generated Secret, so teardown never adopts a key. */
export function platformTlsMetadata(tenant: ZenithTenant, substrate: ZenithSubstrate, kind: "Gateway" | "Certificate" | "Secret", customHost?: string) {
  const names = environmentTlsNames(tenant, substrate);
  const custom = customHost === undefined ? undefined : customDomainTlsNames(tenant, customHost);
  const name = kind === "Gateway" ? names.gateway : custom ? (kind === "Certificate" ? custom.certificate : custom.secret) : kind === "Certificate" ? names.certificate : names.secret;
  return {
    name, namespace: substrate.gateway.namespace,
    labels: { [OWNERSHIP.managedByLabel]: OWNERSHIP.managedByValue, [PLATFORM_TLS_LABEL]: "true" },
    annotations: {
      [OWNERSHIP.environmentAnnotation]: tenant.environmentId,
      [OWNERSHIP.resourceAnnotation]: custom ? `platform/tls-${kind.toLowerCase()}-${custom.listener}` : `platform/tls-${kind.toLowerCase()}`,
      [TENANT_ANNOTATION.workspaceId]: tenant.workspaceId,
    },
  };
}

/** Certificate first, then its HTTPS listener. Tenant object lint never accepts either kind. */
export function renderEnvironmentTls(tenant: ZenithTenant, substrate: ZenithSubstrate, opts: { customDomains?: readonly string[] } = {}): K8sObject[] {
  assertTenant(tenant);
  if (substrate.gateway.mode !== "gateway_api") return [];
  // Reuse hostname validation, including the DNS wire-length bound for '*.zone'.
  managedHostname({ service: "a", environmentSlug: tenant.environmentSlug, workspaceSlug: tenant.workspaceSlug, baseDomain: substrate.baseDomain });
  const names = environmentTlsNames(tenant, substrate);
  const wildcard = `*${managedHostSuffix(tenant, substrate.baseDomain)}`;
  const secret = platformTlsMetadata(tenant, substrate, "Secret");
  const custom = [...new Set(opts.customDomains ?? [])].sort();
  if (custom.length > 0 && !substrate.certManager.httpClusterIssuer) {
    throw new ZenithError("unsupported", "Custom domains need an ACME HTTP-01 ClusterIssuer (ZENITH_MANAGED_HTTP_CLUSTER_ISSUER); none is configured.");
  }
  const allowedRoutes = {
    kinds: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute" }],
    namespaces: { from: "Selector", selector: { matchLabels: {
      "kubernetes.io/metadata.name": tenantNamespace(tenant.workspaceId, tenant.environmentId), [TENANT_LABEL.tenant]: "true",
    } } },
  };
  const customCertificates: K8sObject[] = custom.map((host) => {
    const n = customDomainTlsNames(tenant, host);
    const sec = platformTlsMetadata(tenant, substrate, "Secret", host);
    return {
      apiVersion: CERTIFICATE_API_VERSION, kind: "Certificate", metadata: platformTlsMetadata(tenant, substrate, "Certificate", host),
      spec: {
        secretName: n.secret, dnsNames: [host],
        issuerRef: { group: "cert-manager.io", kind: "ClusterIssuer", name: substrate.certManager.httpClusterIssuer },
        secretTemplate: { labels: sec.labels, annotations: sec.annotations },
        privateKey: { rotationPolicy: "Always" },
      },
    };
  });
  const customListeners = custom.map((host) => {
    const n = customDomainTlsNames(tenant, host);
    return { name: n.listener, protocol: "HTTPS", port: 443, hostname: host, tls: { mode: "Terminate", certificateRefs: [{ group: "", kind: "Secret", name: n.secret }] }, allowedRoutes };
  });
  return [
    {
      apiVersion: CERTIFICATE_API_VERSION, kind: "Certificate", metadata: platformTlsMetadata(tenant, substrate, "Certificate"),
      spec: {
        secretName: names.secret, dnsNames: [wildcard],
        issuerRef: { group: "cert-manager.io", kind: "ClusterIssuer", name: substrate.certManager.clusterIssuer },
        secretTemplate: { labels: secret.labels, annotations: secret.annotations },
        privateKey: { rotationPolicy: "Always" },
      },
    },
    ...customCertificates,
    {
      apiVersion: GATEWAY_API_VERSION, kind: "Gateway", metadata: platformTlsMetadata(tenant, substrate, "Gateway"),
      spec: {
        gatewayClassName: substrate.gateway.className,
        listeners: [{
          name: names.listener, protocol: "HTTPS", port: 443, hostname: wildcard,
          tls: { mode: "Terminate", certificateRefs: [{ group: "", kind: "Secret", name: names.secret }] },
          allowedRoutes,
        }, ...customListeners],
      },
    },
  ];
}
