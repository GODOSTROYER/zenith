/**
 * Defense in depth for tenant isolation: `validateTenantObjects` inspects every
 * object about to be applied for a managed environment and reports each way it
 * would escape the tenancy model. It does not trust the renderers that produced
 * the objects: if a renderer regresses, a hostile node spec slips a field
 * through, or a future feature adds a kind, this is the gate that says no
 * before the API server is ever asked.
 *
 * It enforces, per object:
 *   - only allowed kinds; StatefulSet is never allowed (the managed platform
 *     does not run databases in-cluster), nor are cluster-scoped kinds other
 *     than the tenant's own Namespace;
 *   - everything namespaced lives in the tenant namespace and carries the
 *     Zenith ownership marks for THIS environment;
 *   - pods satisfy the restricted Pod Security Standard AND Zenith's own
 *     stricter rules (no host namespaces or ports, no hostPath or any volume
 *     type outside a short allow list, no privileged or escalation, all
 *     capabilities dropped and none added, non-root, seccomp, no service
 *     account token);
 *   - Services are ClusterIP only, without externalIPs;
 *   - NetworkPolicies rendered from bindings name no `ipBlock` peer and select
 *     only the tenant namespace or the gateway namespace;
 *   - HTTPRoutes attach only to the platform Gateway and serve only hostnames
 *     under this tenant's managed suffix.
 *
 * This is a LINT of rendered objects, not an admission controller. The cluster's
 * own Pod Security Admission (namespace label `enforce: restricted`) is the
 * enforcement that matters at runtime; this catches mistakes earlier and gives
 * a named reason.
 */
import { findSecret } from "@/lib/capabilities/secret-guard";
import { WORKLOAD_KINDS, dig, isRecord, podSpecsOf, OWNERSHIP, type K8sObject } from "./k8s-port";
import { tenantNamespace } from "./tenancy";
import { isManagedHost, type ZenithSubstrate } from "./substrate";
import { TENANCY_ADDRESS, TENANT_SERVICE_ACCOUNT, ZenithError, type ZenithTenant } from "./types";
import { isRouteParentFor } from "./tls";

export interface IsolationViolation {
  /** `Kind/name` of the offending object */
  object: string;
  /** stable rule id */
  rule: string;
  detail: string;
}

const ALLOWED_KINDS: ReadonlySet<string> = new Set([
  "Namespace",
  "ServiceAccount",
  "Secret",
  "PersistentVolumeClaim",
  "Service",
  "NetworkPolicy",
  "Deployment",
  "CronJob",
  "HorizontalPodAutoscaler",
  "ResourceQuota",
  "LimitRange",
  "HTTPRoute",
  "Ingress",
]);

const ALLOWED_VOLUME_TYPES: ReadonlySet<string> = new Set(["emptyDir", "configMap", "secret", "persistentVolumeClaim", "projected", "downwardAPI", "ephemeral"]);
const ALLOWED_SECCOMP: ReadonlySet<string> = new Set(["RuntimeDefault", "Localhost"]);

/** Env names that are secrets by name: a literal value under one is a plaintext secret in a manifest. */
const SECRET_ENV_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL|CONNECTION_?(STRING|URI)|DATABASE_URL)/i;

const label = (o: K8sObject): string => `${o.kind}/${String(o.metadata?.name ?? "?")}`;

function checkContainer(where: string, c: unknown, pod: Record<string, unknown>, out: (rule: string, detail: string) => void): void {
  if (!isRecord(c)) {
    out("container_shape", `${where}: container is not an object.`);
    return;
  }
  const name = typeof c.name === "string" ? c.name : "?";
  const at = `${where} container "${name}"`;
  const sc = isRecord(c.securityContext) ? c.securityContext : {};
  const podSc = isRecord(pod.securityContext) ? pod.securityContext : {};
  if (sc.privileged === true) out("privileged", `${at} is privileged.`);
  if (sc.allowPrivilegeEscalation !== false) out("privilege_escalation", `${at} must set allowPrivilegeEscalation: false.`);
  const caps = isRecord(sc.capabilities) ? sc.capabilities : {};
  const drop = Array.isArray(caps.drop) ? caps.drop.map(String) : [];
  if (!drop.includes("ALL")) out("capabilities", `${at} must drop ALL capabilities.`);
  if (Array.isArray(caps.add) && caps.add.length > 0) out("capabilities", `${at} adds capabilities (${caps.add.map(String).join(", ").slice(0, 80)}); the managed platform allows none.`);
  const nonRoot = sc.runAsNonRoot ?? podSc.runAsNonRoot;
  if (nonRoot !== true) out("run_as_non_root", `${at} must run as non-root (runAsNonRoot: true).`);
  const uid = sc.runAsUser ?? podSc.runAsUser;
  if (uid === 0) out("run_as_root", `${at} runs as uid 0.`);
  const seccomp = isRecord(sc.seccompProfile) ? sc.seccompProfile : isRecord(podSc.seccompProfile) ? podSc.seccompProfile : undefined;
  if (!seccomp || typeof seccomp.type !== "string" || !ALLOWED_SECCOMP.has(seccomp.type)) out("seccomp", `${at} needs a seccompProfile of RuntimeDefault or Localhost.`);
  if (Array.isArray(c.ports) && c.ports.some((p) => isRecord(p) && (p.hostPort !== undefined || p.hostIP !== undefined))) out("host_port", `${at} binds a host port.`);
  if (typeof c.image !== "string" || c.image === "") out("image", `${at} has no image.`);
  // PROD-MAN-02: secrets reach a workload only by reference (valueFrom.secretKeyRef, resolved from the vault at apply time).
  for (const e of Array.isArray(c.env) ? c.env : []) {
    if (!isRecord(e) || typeof e.name !== "string" || typeof e.value !== "string" || e.value === "") continue;
    if (SECRET_ENV_NAME.test(e.name) || findSecret({ [e.name]: e.value }) !== undefined) out("secret_value", `${at} env ${e.name.slice(0, 60)} carries a literal value that is, or is named like, a secret; deliver secrets by reference (secretRef).`);
  }
  const argv = findSecret({ command: c.command, args: c.args });
  if (argv) out("secret_value", `${at} ${argv.path} holds ${argv.what}; secrets must not be passed on the command line.`);
}

function checkPod(obj: K8sObject, pod: Record<string, unknown>, out: (rule: string, detail: string) => void): void {
  const where = label(obj);
  for (const k of ["hostNetwork", "hostPID", "hostIPC"] as const) if (pod[k] === true) out("host_namespace", `${where} sets ${k}.`);
  if (pod.automountServiceAccountToken !== false) out("service_account_token", `${where} must set automountServiceAccountToken: false; tenant pods get no Kubernetes API access.`);
  if (pod.serviceAccountName !== undefined && typeof pod.serviceAccountName !== "string") out("service_account", `${where} has a malformed serviceAccountName.`);
  const sc = isRecord(pod.securityContext) ? pod.securityContext : {};
  if (Array.isArray(sc.sysctls) && sc.sysctls.length > 0) out("sysctls", `${where} sets sysctls.`);
  if (pod.shareProcessNamespace === true) out("host_namespace", `${where} shares the process namespace.`);
  for (const v of Array.isArray(pod.volumes) ? pod.volumes : []) {
    if (!isRecord(v)) continue;
    const types = Object.keys(v).filter((k) => k !== "name");
    for (const t of types) if (!ALLOWED_VOLUME_TYPES.has(t)) out("volume_type", `${where} mounts a "${t}" volume (volume "${String(v.name)}"); only ${[...ALLOWED_VOLUME_TYPES].join(", ")} are allowed.`);
  }
  const containers = [...(Array.isArray(pod.containers) ? pod.containers : []), ...(Array.isArray(pod.initContainers) ? pod.initContainers : [])];
  if (containers.length === 0) out("container_shape", `${where} has no containers.`);
  for (const c of containers) checkContainer(where, c, pod, out);
  if (Array.isArray(pod.ephemeralContainers) && pod.ephemeralContainers.length > 0) out("ephemeral_containers", `${where} declares ephemeral containers.`);
}

function peerProblems(peers: unknown, allowedNamespaces: readonly string[]): string[] {
  const problems: string[] = [];
  for (const p of Array.isArray(peers) ? peers : []) {
    if (!isRecord(p)) continue;
    if (p.ipBlock !== undefined) problems.push("names an ipBlock peer");
    const sel = dig(p, "namespaceSelector", "matchLabels", "kubernetes.io/metadata.name");
    if (p.namespaceSelector !== undefined && (typeof sel !== "string" || !allowedNamespaces.includes(sel))) problems.push("selects a namespace other than the tenant's or the gateway's");
  }
  return problems;
}

export interface IsolationContext {
  tenant: ZenithTenant;
  substrate: ZenithSubstrate;
  /** verified custom hostnames this environment may serve (PROD-MAN-03); absent = managed hostnames only */
  customHosts?: ReadonlySet<string>;
}

/** Every way `objects` would escape the tenancy model; empty means none found. */
export function validateTenantObjects(objects: readonly K8sObject[], ctx: IsolationContext): IsolationViolation[] {
  const { tenant, substrate } = ctx;
  const customHosts = ctx.customHosts ?? new Set<string>();
  const ns = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const violations: IsolationViolation[] = [];
  for (const obj of objects) {
    const push = (rule: string, detail: string) => violations.push({ object: label(obj), rule, detail });
    if (!isRecord(obj) || typeof obj.kind !== "string" || !isRecord(obj.metadata) || typeof obj.metadata.name !== "string") {
      violations.push({ object: "?", rule: "object_shape", detail: "Object needs kind and metadata.name." });
      continue;
    }
    if (!ALLOWED_KINDS.has(obj.kind)) {
      push("kind_not_allowed", obj.kind === "StatefulSet" ? "StatefulSet is never rendered on the managed platform; databases are a managed service, not an in-cluster workload." : `${obj.kind} is not a kind the managed platform applies for a tenant.`);
      continue;
    }
    if (obj.kind === "Ingress" && substrate.gateway.mode !== "ingress") push("kind_not_allowed", "Ingress is only rendered when the substrate's gateway mode is ingress.");
    if (obj.kind === "HTTPRoute" && substrate.gateway.mode !== "gateway_api") push("kind_not_allowed", "HTTPRoute is only rendered when the substrate's gateway mode is gateway_api.");

    if (obj.kind === "Namespace") {
      if (obj.metadata.name !== ns) push("namespace_scope", `Namespace ${obj.metadata.name} is not this tenant's namespace (${ns}).`);
      if (obj.metadata.labels?.["pod-security.kubernetes.io/enforce"] !== "restricted") push("pod_security", "Namespace must enforce the restricted Pod Security Standard.");
    } else if (obj.metadata.namespace !== ns) {
      push("namespace_scope", `${label(obj)} is in namespace "${String(obj.metadata.namespace)}", not the tenant namespace ${ns}.`);
    }
    if (obj.metadata.labels?.[OWNERSHIP.managedByLabel] !== OWNERSHIP.managedByValue) push("ownership", `missing ${OWNERSHIP.managedByLabel}=${OWNERSHIP.managedByValue}.`);
    if (obj.metadata.annotations?.[OWNERSHIP.environmentAnnotation] !== tenant.environmentId) push("ownership", `${OWNERSHIP.environmentAnnotation} is not this tenant's environment.`);
    if (typeof obj.metadata.annotations?.[OWNERSHIP.resourceAnnotation] !== "string") push("ownership", `missing ${OWNERSHIP.resourceAnnotation}.`);
    if (obj.kind === "Secret" && ("data" in obj || "stringData" in obj)) push("secret_value", "A rendered Secret must not carry data.");

    if (WORKLOAD_KINDS.has(obj.kind)) {
      const pods = podSpecsOf(obj);
      if (pods.length === 0) push("pod_spec", "workload has no pod spec.");
      for (const pod of pods) checkPod(obj, pod, push);
    }
    if (obj.kind === "ServiceAccount" && obj.automountServiceAccountToken !== false) push("service_account_token", "ServiceAccount must set automountServiceAccountToken: false.");
    if (obj.kind === "ServiceAccount" && obj.metadata.annotations?.[OWNERSHIP.resourceAnnotation] !== TENANCY_ADDRESS.serviceAccount && obj.metadata.name === TENANT_SERVICE_ACCOUNT) push("ownership", "the tenant ServiceAccount must be the tenancy baseline's own.");
    if (obj.kind === "Service") {
      const spec = isRecord(obj.spec) ? obj.spec : {};
      if (spec.type !== undefined && spec.type !== "ClusterIP") push("service_type", `Service type ${String(spec.type)} is not allowed; tenants are exposed only through the platform gateway.`);
      if (Array.isArray(spec.externalIPs) && spec.externalIPs.length > 0) push("service_type", "Service sets externalIPs.");
      if (spec.loadBalancerIP !== undefined) push("service_type", "Service sets loadBalancerIP.");
    }
    const isTenancy = typeof obj.metadata.annotations?.[OWNERSHIP.resourceAnnotation] === "string" && String(obj.metadata.annotations[OWNERSHIP.resourceAnnotation]).startsWith("tenancy/");
    if (obj.kind === "NetworkPolicy" && !isTenancy) {
      const spec = isRecord(obj.spec) ? obj.spec : {};
      if (Array.isArray(spec.egress) && spec.egress.length > 0) push("network_policy", "A binding-derived NetworkPolicy may not add egress rules; egress is the tenancy baseline's alone.");
      if (Array.isArray(spec.policyTypes) && spec.policyTypes.includes("Egress")) push("network_policy", "A binding-derived NetworkPolicy may not govern egress.");
      for (const rule of Array.isArray(spec.ingress) ? spec.ingress : []) {
        for (const problem of peerProblems(isRecord(rule) ? rule.from : undefined, [ns, substrate.gateway.namespace])) push("network_policy", `ingress rule ${problem}.`);
      }
    }
    if (obj.kind === "HTTPRoute") {
      const spec = isRecord(obj.spec) ? obj.spec : {};
      const parents = Array.isArray(spec.parentRefs) ? spec.parentRefs : [];
      if (parents.length !== 1) push("route_parent", "HTTPRoute must attach to exactly one environment HTTPS listener.");
      const hosts = Array.isArray(spec.hostnames) ? spec.hostnames : [];
      for (const p of parents) {
        if (!isRouteParentFor(p, hosts, tenant, substrate)) push("route_parent", "HTTPRoute may attach only to this environment's platform HTTPS listener for its own hostnames.");
      }
      if (hosts.length === 0) push("route_hostname", "HTTPRoute has no hostnames; it would match every host.");
      for (const h of hosts) {
        if (typeof h !== "string" || !(isManagedHost(h, tenant, substrate.baseDomain) || customHosts.has(h))) push("route_hostname", `hostname "${String(h).slice(0, 80)}" is not under this tenant's managed suffix or one of its verified custom domains.`);
      }
    }
  }
  return violations;
}

/** Throw a single `isolation_violation` error naming the first violations (bounded), or return. */
export function assertTenantObjects(objects: readonly K8sObject[], ctx: IsolationContext): void {
  const v = validateTenantObjects(objects, ctx);
  if (v.length === 0) return;
  const shown = v.slice(0, 5).map((x) => `${x.object} [${x.rule}] ${x.detail}`);
  throw new ZenithError("isolation_violation", `${v.length} isolation violation(s): ${shown.join(" | ")}${v.length > 5 ? ` | … and ${v.length - 5} more` : ""}`);
}
