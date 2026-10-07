/**
 * Rendering one managed environment: the pure pipeline that turns the nodes of
 * an environment (`provider = zenith`) into the exact Kubernetes objects the
 * tenancy layer will apply, plus the managed-database intents, plus an honest
 * account of everything that was NOT rendered and why.
 *
 *   assessZenithGraph(nodes)       classify every node (render / managed
 *                                  database / platform-managed / not offered /
 *                                  unsupported) — also what placement can ask
 *   renderZenithEnvironment(input) tenancy baseline + workloads + routes,
 *                                  validated for tenant isolation
 *   zenithNodeView(node, …)        the node as the Kubernetes drivers must see
 *                                  it (namespace forced, hosts rewritten)
 *
 * The Kubernetes provider does the rendering of workloads (`toolkit.renderGraph`);
 * this module decides WHAT is handed to it and what is done with the result:
 *   - network / namespace nodes, DNS and TLS nodes, public-ingress firewall
 *     rules and firewalls to a managed database are PLATFORM-MANAGED: the tenancy
 *     baseline, the platform wildcard and the gateway cover them, so they render
 *     nothing and their drivers report `platform-managed`.
 *   - `postgres` is a managed-database intent, never a StatefulSet.
 *   - kinds the managed platform does not offer (redis, mysql, object_store,
 *     queue, functions, …) make the render REFUSE with a named list. A data
 *     store a service depends on is never silently dropped.
 *   - everything rendered is run through `assertTenantObjects` before it is
 *     returned: namespace scope, restricted pods, no StatefulSet, route and
 *     hostname scope.
 *
 * Deterministic: same input, byte-identical output.
 */
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { databaseSpecFromNode, managedDatabaseConnectionRef, type ManagedDatabaseSpec } from "./database";
import { assertTenantObjects } from "./isolation";
import { OWNERSHIP, isRecord, podSpecsOf, renderToolkitGraph, type K8sObject, type KubernetesToolkit, type ToolkitRenderBase } from "./k8s-port";
import { planLimits } from "./plans";
import { NOT_OFFERED, PLATFORM_MANAGED, UNSUPPORTED, firewallPlatformReason } from "./platform";
import { ingressToRoutes, rewriteRoutes, servableCustomHosts, sourceHostsByManaged, type HostMapping } from "./routing";
import { constrainAutoscalers } from "./autoscale";
import { storageIntentFromNode, type ManagedStorageIntent } from "@/lib/managed-serving/storage";
import { assertTenant, type ZenithSubstrate } from "./substrate";
import { renderTenancy, tenantNamespace } from "./tenancy";
import { TENANT_SERVICE_ACCOUNT, ZenithError, type ZenithTenant } from "./types";
import { renderEnvironmentTls } from "./tls";

/* ------------------------------- assessment -------------------------------- */

export interface AssessedNode {
  address: string;
  kind: string;
  reason: string;
}

export interface ZenithAssessment {
  /** nodes the Kubernetes renderers realize */
  render: ResourceNode[];
  /** postgres nodes served by the managed database provider */
  databases: ResourceNode[];
  /** object_store nodes served by tenant-scoped credentials; always empty unless object storage is enabled for the assessment */
  storage: ResourceNode[];
  /** nodes the platform provides itself; render nothing */
  platformManaged: AssessedNode[];
  /** kinds with no managed-platform equivalent that do not block a deploy */
  notOffered: AssessedNode[];
  /** kinds the managed platform cannot honor; they block a render */
  unsupported: AssessedNode[];
  /** not this provider's, or not managed by Zenith */
  skipped: AssessedNode[];
}

const RENDERABLE = new Set(["load_balancer", "container_service", "static_site", "scheduled_job", "secret", "identity", "volume", "firewall"]);

const at = (n: ResourceNode, reason: string): AssessedNode => ({ address: n.address, kind: n.kind, reason });
const byAddressOrder = (a: { address: string }, b: { address: string }): number => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

export interface AssessOptions {
  /**
   * The substrate can provision scoped per-tenant object-store credentials (it has an IAM-admin credential reference).
   * Without it `object_store` stays unsupported, exactly as before PROD-MAN-03.
   */
  objectStorage?: boolean;
}

/** Classify every node. Pure; the same function placement and planning can call without rendering. */
export function assessZenithGraph(nodes: readonly ResourceNode[], opts: AssessOptions = {}): ZenithAssessment {
  const out: ZenithAssessment = { render: [], databases: [], storage: [], platformManaged: [], notOffered: [], unsupported: [], skipped: [] };
  const mine = new Map<string, ResourceNode>();
  for (const n of nodes) if (n.provider === "zenith" && n.ownership === "managed") mine.set(n.address, n);
  for (const n of [...nodes].sort(byAddressOrder)) {
    if (n.provider !== "zenith") {
      out.skipped.push(at(n, `provider ${n.provider} is not handled by the managed platform`));
      continue;
    }
    if (n.ownership !== "managed") {
      out.skipped.push(at(n, `${n.ownership} node is never rendered or applied`));
      continue;
    }
    // classify by kind FIRST: expansion emits `log_group`, `subnet`, `dns_zone`… nodes whose native type is
    // `unsupported:zenith:*` because the contract table has no row, and those must not block a deploy
    if (PLATFORM_MANAGED[n.kind]) out.platformManaged.push(at(n, PLATFORM_MANAGED[n.kind]));
    else if (n.kind === "postgres") out.databases.push(n);
    else if (n.kind === "object_store" && opts.objectStorage === true) out.storage.push(n);
    else if (NOT_OFFERED[n.kind]) out.notOffered.push(at(n, NOT_OFFERED[n.kind]));
    else if (UNSUPPORTED[n.kind]) out.unsupported.push(at(n, UNSUPPORTED[n.kind]));
    else if (n.kind === "firewall") {
      const why = firewallPlatformReason(n, (a) => mine.get(a)?.kind);
      if (why) out.platformManaged.push(at(n, why));
      else out.render.push(n);
    } else if (RENDERABLE.has(n.kind)) out.render.push(n);
    else out.unsupported.push(at(n, `${n.kind} is not offered on the managed platform`));
  }
  // a kind we would realize but whose node expansion marked unsupported has no driver behind it: block, do not guess
  for (const list of [out.render, out.databases, out.storage]) {
    for (const n of [...list]) {
      if (!n.nativeType.startsWith("unsupported:")) continue;
      list.splice(list.indexOf(n), 1);
      out.unsupported.push(at(n, `${n.kind} has no native type on the zenith provider (${n.nativeType})`));
    }
  }
  return out;
}

/* ------------------------------- node view --------------------------------- */

/**
 * The node as the Kubernetes provider must see it on the managed platform:
 * namespace forced to the tenant's, load balancer hosts rewritten to managed
 * hostnames. The digest and every other field are untouched, so drift and
 * ownership still join on the original node.
 */
export function zenithNodeView(node: ResourceNode, tenantInput: ZenithTenant, substrate: ZenithSubstrate, customHosts?: ReadonlySet<string>): ResourceNode {
  const tenant = assertTenant(tenantInput);
  const spec: Record<string, unknown> = isRecord(node.spec) ? { ...node.spec } : {};
  spec.namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  if (node.kind === "load_balancer") spec.routes = rewriteRoutes(spec.routes, tenant, substrate, customHosts).routes;
  return { ...node, spec };
}

/** The original → managed host mapping of every load balancer node. */
export function hostMappingsOf(nodes: readonly ResourceNode[], tenant: ZenithTenant, substrate: ZenithSubstrate, customHosts?: ReadonlySet<string>): HostMapping[] {
  const out: HostMapping[] = [];
  for (const n of [...nodes].filter((x) => x.kind === "load_balancer").sort(byAddressOrder)) {
    out.push(...rewriteRoutes(isRecord(n.spec) ? n.spec.routes : undefined, tenant, substrate, customHosts).mappings);
  }
  return out.sort((a, b) => (a.managed + a.source < b.managed + b.source ? -1 : a.managed + a.source > b.managed + b.source ? 1 : 0));
}

/* -------------------------------- rendering -------------------------------- */

export interface ManagedDatabaseIntent {
  address: string;
  spec: ManagedDatabaseSpec;
  /** the vault reference the connection URI is stored under; wire service env `secretRef`s to it */
  connectionSecretRef: string;
  notes: string[];
}

export interface ZenithRenderInput extends Pick<ToolkitRenderBase, "workloadIdentity" | "resolveAttribute"> {
  tenant: ZenithTenant;
  substrate: ZenithSubstrate;
  nodes: readonly ResourceNode[];
  toolkit: Pick<KubernetesToolkit, "renderGraph">;
  /** pipeline name → digest-pinned image reference in the platform registry, for `built` artifacts */
  builtImages?: Readonly<Record<string, string>>;
  /**
   * Hostnames whose ownership is currently proven for this environment (PROD-MAN-03; `servedCustomHostnames`). A route
   * for any other host outside the managed suffix is rewritten to its managed hostname, as before.
   */
  verifiedDomains?: readonly string[];
  /** Render HorizontalPodAutoscalers for services with more than one replica, under the tier's policy (`autoscale.ts`). Default off. */
  autoscaling?: boolean;
}

export interface ZenithRenderResult {
  namespace: string;
  /** tenancy baseline, apply first */
  baseline: K8sObject[];
  /** workloads, services, secrets, routes */
  workloads: K8sObject[];
  /** Platform-owned Certificate/Gateway in the gateway namespace; never tenant toolkit input. */
  platformTls: K8sObject[];
  hostnames: HostMapping[];
  databases: ManagedDatabaseIntent[];
  /** tenant object stores to provision (scoped credentials); empty unless enabled */
  storage: ManagedStorageIntent[];
  /** the verified custom hostnames actually served by a rendered route (each has its own listener and Certificate) */
  customDomains: string[];
  platformManaged: AssessedNode[];
  notOffered: AssessedNode[];
  skipped: AssessedNode[];
  notes: string[];
}

function imageResolver(substrate: ZenithSubstrate, built: Readonly<Record<string, string>> | undefined) {
  return (_node: ResourceNode, artifact: ArtifactSpec): string | undefined => {
    if (artifact.type !== "built") return undefined;
    const ref = built?.[artifact.pipeline];
    if (ref === undefined) return undefined;
    if (!substrate.registry) throw new ZenithError("unsupported", "A built image was supplied but no platform registry is configured (ZENITH_MANAGED_REGISTRY); built images must live in the platform registry.");
    const prefix = `${substrate.registry.host}/${substrate.registry.repositoryPrefix ? `${substrate.registry.repositoryPrefix}/` : ""}`;
    if (!ref.startsWith(prefix)) throw new ZenithError("isolation_violation", `Built image for pipeline "${artifact.pipeline}" is not in the platform registry (${substrate.registry.host}).`);
    if (!/@sha256:[0-9a-f]{64}$/.test(ref)) throw new ZenithError("isolation_violation", `Built image for pipeline "${artifact.pipeline}" must be pinned by digest.`);
    return ref;
  };
}

function withServiceAccount(obj: K8sObject): K8sObject {
  const clone = structuredClone(obj);
  for (const pod of podSpecsOf(clone)) if (pod.serviceAccountName === undefined) pod.serviceAccountName = TENANT_SERVICE_ACCOUNT;
  return clone;
}

/** Render one managed environment. Throws `ZenithError` when it cannot be realized honestly. */
export function renderZenithEnvironment(input: ZenithRenderInput): ZenithRenderResult {
  const tenant = assertTenant(input.tenant);
  const { substrate } = input;
  const namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const assessed = assessZenithGraph(input.nodes, { objectStorage: substrate.objectStorage?.adminCredentialRef !== undefined });

  if (assessed.unsupported.length > 0) {
    const list = assessed.unsupported.map((u) => `${u.address} (${u.reason})`).join("; ");
    throw new ZenithError("unsupported", `The managed platform cannot realize: ${list}.`);
  }

  const limits = planLimits(tenant.planTier);
  if (assessed.databases.length > limits.maxManagedDatabases) {
    throw new ZenithError("plan_limit", `The ${tenant.planTier} plan allows ${limits.maxManagedDatabases} managed database(s) per environment; this environment declares ${assessed.databases.length}.`);
  }

  if (assessed.storage.length > limits.maxObjectStores) {
    throw new ZenithError("plan_limit", `The ${tenant.planTier} plan allows ${limits.maxObjectStores} object store(s) per environment; this environment declares ${assessed.storage.length}.`);
  }
  const storage: ManagedStorageIntent[] = assessed.storage.map((n) => storageIntentFromNode(tenant, substrate, n));

  const databases: ManagedDatabaseIntent[] = [];
  for (const n of assessed.databases) {
    const made = databaseSpecFromNode(tenant, { address: n.address, spec: isRecord(n.spec) ? n.spec : {} });
    if ("error" in made) throw new ZenithError("render_error", made.error);
    databases.push({ address: n.address, spec: made.spec, connectionSecretRef: managedDatabaseConnectionRef(tenant.environmentId, n.address), notes: made.notes });
  }

  const tenancy = renderTenancy(tenant, substrate, { withManagedDatabase: databases.length > 0 });

  const customHosts = servableCustomHosts(substrate, input.verifiedDomains);
  const views = assessed.render.map((n) => zenithNodeView(n, tenant, substrate, customHosts));
  const mappings = hostMappingsOf(assessed.render, tenant, substrate, customHosts);
  const servedCustom = [...new Set(mappings.filter((m) => m.source === m.managed && customHosts.has(m.managed)).map((m) => m.managed))].sort();
  const sources = sourceHostsByManaged(mappings);
  const rendered = renderToolkitGraph(input.toolkit, input.nodes, views, {
    environmentId: tenant.environmentId,
    namespace,
    resolveImage: imageResolver(substrate, input.builtImages),
    ingressControllerNamespace: substrate.gateway.namespace,
    automountServiceAccountToken: false,
    workloadIdentity: input.workloadIdentity,
    resolveAttribute: input.resolveAttribute,
    clusterIssuers: { dns01: substrate.certManager.clusterIssuer, http01: substrate.certManager.clusterIssuer },
    ...(input.autoscaling === true && limits.maxAutoscaleReplicas > 0 ? { autoscale: true } : {}),
  });

  const notes: string[] = [...tenancy.notes, ...rendered.notes];
  const workloads: K8sObject[] = [];
  const scaled = constrainAutoscalers(rendered.objects, tenant);
  notes.push(...scaled.notes);
  for (const obj of scaled.objects) {
    if (obj.kind === "Ingress") {
      const r = ingressToRoutes(obj, substrate, sources, tenant);
      notes.push(...r.notes);
      workloads.push(...r.objects);
    } else {
      workloads.push(withServiceAccount(obj));
    }
  }
  for (const d of input.verifiedDomains ?? []) {
    if (!customHosts.has(d)) notes.push(`Custom domain ${d} is verified but this platform cannot serve it (needs gateway mode and ZENITH_MANAGED_HTTP_CLUSTER_ISSUER).`);
  }
  for (const s of storage) notes.push(...s.notes);
  for (const m of mappings) {
    if (m.source !== m.managed) notes.push(`${m.target}: host ${m.source} is not served on the managed platform (it is not a verified custom domain of this environment: claim it and prove DNS ownership first); it is served at ${m.managed}.`);
  }
  for (const d of databases) notes.push(...d.notes);
  for (const p of assessed.platformManaged) notes.push(`${p.address}: platform-managed (${p.reason}).`);
  for (const p of assessed.notOffered) notes.push(`${p.address}: not offered (${p.reason}).`);

  // the gate: nothing leaves this function that would escape the tenancy model
  assertTenantObjects([...tenancy.objects, ...workloads], { tenant, substrate, customHosts });

  // every rendered object must still carry this environment's ownership marks (the apply guard compares them)
  for (const o of workloads) {
    if (o.metadata.annotations?.[OWNERSHIP.environmentAnnotation] !== tenant.environmentId) {
      throw new ZenithError("render_error", `${o.kind}/${o.metadata.name} lost its environment ownership annotation.`);
    }
  }

  return {
    namespace,
    baseline: tenancy.objects,
    workloads,
    platformTls: renderEnvironmentTls(tenant, substrate, { customDomains: servedCustom }),
    hostnames: mappings,
    databases,
    storage,
    customDomains: servedCustom,
    platformManaged: assessed.platformManaged,
    notOffered: assessed.notOffered,
    skipped: assessed.skipped,
    notes,
  };
}
