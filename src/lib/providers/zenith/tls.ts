/**
 * Platform-owned TLS for one managed environment. Gateway API v1 supports a
 * Gateway per environment without ListenerSet or a shared listener-list writer.
 * The controller must serve these Gateways from the platform gateway namespace;
 * shared addresses/data planes are implementation-specific, never assumed here.
 * Pure desired objects only: issuance, DNS and HTTPS reachability are unverified.
 */
import { OWNERSHIP, isRecord, type K8sObject } from "./k8s-port";
import { assertTenant, managedHostname, managedHostSuffix, type ZenithSubstrate } from "./substrate";
import { dnsLabelOf, tenantNamespace } from "./tenancy";
import { TENANT_ANNOTATION, TENANT_LABEL, type ZenithTenant } from "./types";

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

export function environmentGatewayParent(tenant: ZenithTenant, substrate: ZenithSubstrate) {
  const names = environmentTlsNames(tenant, substrate);
  return { group: "gateway.networking.k8s.io", kind: "Gateway", name: names.gateway, namespace: substrate.gateway.namespace, sectionName: names.listener };
}

/** The omitted group/kind defaults are allowed; a listener is always explicit. */
export function isEnvironmentGatewayParent(parent: unknown, tenant: ZenithTenant, substrate: ZenithSubstrate): boolean {
  const expected = environmentGatewayParent(tenant, substrate);
  return isRecord(parent) && parent.name === expected.name && parent.namespace === expected.namespace
    && (parent.group === undefined || parent.group === expected.group)
    && (parent.kind === undefined || parent.kind === expected.kind)
    && parent.sectionName === expected.sectionName && (parent.port === undefined || parent.port === 443);
}

/** Ownership also marks the generated Secret, so teardown never adopts a key. */
export function platformTlsMetadata(tenant: ZenithTenant, substrate: ZenithSubstrate, kind: "Gateway" | "Certificate" | "Secret") {
  const names = environmentTlsNames(tenant, substrate);
  const name = kind === "Gateway" ? names.gateway : kind === "Certificate" ? names.certificate : names.secret;
  return {
    name, namespace: substrate.gateway.namespace,
    labels: { [OWNERSHIP.managedByLabel]: OWNERSHIP.managedByValue, [PLATFORM_TLS_LABEL]: "true" },
    annotations: {
      [OWNERSHIP.environmentAnnotation]: tenant.environmentId,
      [OWNERSHIP.resourceAnnotation]: `platform/tls-${kind.toLowerCase()}`,
      [TENANT_ANNOTATION.workspaceId]: tenant.workspaceId,
    },
  };
}

/** Certificate first, then its HTTPS listener. Tenant object lint never accepts either kind. */
export function renderEnvironmentTls(tenant: ZenithTenant, substrate: ZenithSubstrate): K8sObject[] {
  assertTenant(tenant);
  if (substrate.gateway.mode !== "gateway_api") return [];
  // Reuse hostname validation, including the DNS wire-length bound for '*.zone'.
  managedHostname({ service: "a", environmentSlug: tenant.environmentSlug, workspaceSlug: tenant.workspaceSlug, baseDomain: substrate.baseDomain });
  const names = environmentTlsNames(tenant, substrate);
  const wildcard = `*${managedHostSuffix(tenant, substrate.baseDomain)}`;
  const secret = platformTlsMetadata(tenant, substrate, "Secret");
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
    {
      apiVersion: GATEWAY_API_VERSION, kind: "Gateway", metadata: platformTlsMetadata(tenant, substrate, "Gateway"),
      spec: {
        gatewayClassName: substrate.gateway.className,
        listeners: [{
          name: names.listener, protocol: "HTTPS", port: 443, hostname: wildcard,
          tls: { mode: "Terminate", certificateRefs: [{ group: "", kind: "Secret", name: names.secret }] },
          allowedRoutes: {
            kinds: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute" }],
            namespaces: { from: "Selector", selector: { matchLabels: {
              "kubernetes.io/metadata.name": tenantNamespace(tenant.workspaceId, tenant.environmentId), [TENANT_LABEL.tenant]: "true",
            } } },
          },
        }],
      },
    },
  ];
}
