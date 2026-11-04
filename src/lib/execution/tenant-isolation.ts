/**
 * Tenant isolation provisioning (PROD-MAN-04): apply, read back and verify a tenant's isolation bundle through the
 * platform's guard chain, and mint the tenant's operator credential with the MACH-02 minter.
 *
 * Contract: `TenantIsolationProvisioner` in `providers/zenith/onboarding.ts`. MAN-01's managed substrate calls it on
 * tenant onboarding; this module owns everything between "a tenant exists" and "its isolation is proven present".
 *
 * Guard order (the wave-5 chain, in the order each binds):
 *   1. OPS-02 quota        `assertDispatchAdmitted` before any work starts (plan and apply).
 *   2. DUR-A authority     the writer lease fence is asserted before the cluster is read for a plan and again
 *                          immediately before the call.
 *   3. DUR-B authorization the CURRENT human approval is re-read at apply time and must be bound to exactly this plan
 *                          digest (`dispatchApproval.planDigest`); a missing, rejected, unbound or different approval
 *                          refuses. The plan digest is recomputed against the live cluster and a moved digest is
 *                          `plan_changed`: nothing is applied.
 *   4. DUR-C custody       authenticated write-once direct-object artifact under enc:plan-artifacts;
 *                          scope, expiry, fence, semantics and exact object bytes checked before dispatch.
 *   5. DUR-D effect ledger one `isolation_apply` effect per (operation, plan digest) is recorded BEFORE the cluster
 *                          call; a retried activity finds it (accepted: verify only; pending, uncertain, conflict or
 *                          tombstoned: refuse).
 *   6. provider call       server-side apply under the bootstrap identity (`platform` kinds of the Kubernetes
 *                          provider), never forced, whole-batch preflight with ownership refusals.
 * Standalone review binds its isolation digest. Managed first deploy binds the isolation phase
 * into its composite deployment digest and canonical semantics; neither approval can substitute for the other.
 *
 * Fail closed, always: after the apply, every rendered object is read back and compared with what was rendered, the
 * operator token is minted, and (when an access probe is supplied) the minted identity is shown to hold its own
 * namespace and nothing else. Any failure throws `TenantIsolationError` and records the readback verdict on the effect.
 * There is no path that returns success without the readback.
 *
 * The operator token is minted by `requestVerifiedToken` (the MACH-02 TokenRequest path: audience-bound, 600..3600 s,
 * claims checked against the ServiceAccount and its UID). It goes only to the injected credential sink; it is never
 * returned, logged, put in an error, an event or evidence.
 */
import { digest } from "@/lib/controlplane/digest";
import type { KubernetesSession } from "@/lib/credentials/types";
import { buildReadback } from "@/lib/effects/binding";
import { EffectTombstonedError, EffectUnresolvedError, type EffectLedger } from "@/lib/effects/ledger";
import type { EffectRecord, ProviderReceipt, Readback } from "@/lib/effects/types";
import { assertDispatchAdmitted } from "@/lib/ops/admission";
import { diff, serverSideApply, type DiffItem } from "@/lib/providers/kubernetes/apply";
import { createK8sClient, readObject } from "@/lib/providers/kubernetes/client";
import { createGuestClusterPort, GuestCredentialError, requestVerifiedToken, type AccessAttributes, type GuestClusterPort } from "@/lib/providers/kubernetes/guest";
import { platformOrder, type PlatformApplyPolicy } from "@/lib/providers/kubernetes/platform-kinds";
import { K8sError, ANNOTATION, refOf, type K8sObject, type ObjectRef } from "@/lib/providers/kubernetes/types";
import { isRecord } from "@/lib/providers/kubernetes/util";
import { bundleObjects, operatorSubjectOf, renderIsolationBundle, validateIsolationBundle, type IsolationBundle } from "@/lib/providers/zenith/isolation-bundle";
import { validateTenantObjects } from "@/lib/providers/zenith/isolation";
import {
  TenantIsolationError,
  createIsolationSemanticsGuard,
  isolationExecutableSemantics,
  type TenantIsolationPlan,
  type TenantIsolationProvisioner,
  type TenantIsolationRequest,
  type TenantIsolationResult,
} from "@/lib/providers/zenith/onboarding";
import { assertTenant } from "@/lib/providers/zenith/substrate";
import { renderTenancy, tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { ZenithError } from "@/lib/providers/zenith/types";
import { errorText } from "./text";
import type { Runtime } from "./runtime";
import type { IsolationReview } from "./isolation-custody";

/** The pieces of the execution runtime this step uses; the real `Runtime` satisfies it. */
export type TenantIsolationRuntime = Pick<Runtime, "d" | "emit" | "evidence" | "log" | "now">;

export interface TenantIsolationDeps {
  rt: TenantIsolationRuntime;
  /**
   * A session for the platform BOOTSTRAP identity (never a tenant's), with an allowlist of exactly `namespaces`
   * (the tenant namespace and the operator namespace). `close` runs after the step.
   */
  openBootstrapSession(request: TenantIsolationRequest, namespaces: readonly string[], signal: AbortSignal): Promise<{ session: KubernetesSession; close?(): void | Promise<void> }>;
  /** Where the operator token is stored (the vault under `<prefix>/<tenant namespace>`). The token never leaves this call. */
  storeOperatorCredential(input: { ref: string; token: string; expiresAt: string; workspaceId: string; environmentId: string }): Promise<void>;
  /**
   * A SelfSubjectAccessReview probe AS the operator identity holding `token`. Supplied: the minted identity must hold
   * its own namespace and be refused the other checks, or onboarding fails. Optional only for compositions that cannot
   * reach the API server as the operator; the result records `operatorProbe: false` in the effect readback then.
   */
  openOperatorProbe?(token: string, request: TenantIsolationRequest): Promise<Pick<GuestClusterPort, "allowed">>;
  /** default `createGuestClusterPort` (the MACH-02 cluster port) over the bootstrap session */
  guestPort?(session: KubernetesSession, signal: AbortSignal): GuestClusterPort;
  /** default: quota admission of OPS-02 */
  admit?(input: { workspaceId: string; operationId: string }): Promise<void>;
  signal?: () => AbortSignal;
}

const OPERATOR_PROBES: { allow: boolean; attrs: (ns: string) => AccessAttributes }[] = [
  { allow: true, attrs: (ns) => ({ verb: "create", group: "apps", resource: "deployments", namespace: ns }) },
  { allow: true, attrs: (ns) => ({ verb: "get", group: "", resource: "secrets", namespace: ns }) },
  { allow: false, attrs: () => ({ verb: "list", group: "", resource: "namespaces" }) },
  { allow: false, attrs: () => ({ verb: "get", group: "", resource: "secrets", namespace: "kube-system" }) },
  { allow: false, attrs: (ns) => ({ verb: "create", group: "", resource: "pods", subresource: "exec", namespace: ns }) },
  { allow: false, attrs: (ns) => ({ verb: "create", group: "rbac.authorization.k8s.io", resource: "rolebindings", namespace: ns }) },
  { allow: false, attrs: () => ({ verb: "create", group: "rbac.authorization.k8s.io", resource: "clusterrolebindings" }) },
  { allow: false, attrs: () => ({ verb: "get", group: "", resource: "nodes" }) },
];

const fail = (code: ConstructorParameters<typeof TenantIsolationError>[0], message: string): TenantIsolationError => new TenantIsolationError(code, message);

/** The operator must hold only the authority tested by the isolation contract. Read-only authorization reviews. */
export async function assertTenantOperatorAccess(probe: Pick<GuestClusterPort, "allowed">, namespace: string): Promise<void> {
  for (const check of OPERATOR_PROBES) {
    const attrs = check.attrs(namespace);
    if (await probe.allowed(attrs) !== check.allow) {
      throw fail("verify_failed", `The operator identity ${check.allow ? "lacks" : "holds"} ${attrs.verb} ${attrs.resource}${attrs.subresource ? `/${attrs.subresource}` : ""}${attrs.namespace ? ` in ${attrs.namespace}` : " (cluster scope)"}.`);
    }
  }
}

/* ------------------------------- comparison -------------------------------- */

const UNIT: Record<string, number> = { "": 1, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
const QUANTITY = /^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|k|K|M|G|T)?$/;

function quantity(v: string): number | undefined {
  const m = QUANTITY.exec(v);
  return m ? Number(m[1]) * UNIT[m[2] ?? ""] : undefined;
}

/** Every leaf of `desired` is present and equal in `live` (the API server adds defaults; it must not change what was asked). */
export function subsetMismatches(desired: unknown, live: unknown, at = "", out: string[] = []): string[] {
  if (out.length >= 20) return out;
  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || live.length !== desired.length) out.push(at || "(root)");
    else desired.forEach((d, i) => subsetMismatches(d, live[i], `${at}[${i}]`, out));
  } else if (isRecord(desired)) {
    if (!isRecord(live)) out.push(at || "(root)");
    else for (const [k, v] of Object.entries(desired)) subsetMismatches(v, live[k], at ? `${at}.${k}` : k, out);
  } else if (typeof desired === "string" && typeof live === "string") {
    if (desired !== live && !(quantity(desired) !== undefined && quantity(desired) === quantity(live))) out.push(at);
  } else if (desired !== live) out.push(at || "(root)");
  return out;
}

/** API representations may omit empty optional lists; they must not add policy rules or selector keys. */
function normalizedIsolationSpec(value: unknown, quantities = false): unknown {
  if (Array.isArray(value)) return value.map(v => normalizedIsolationSpec(v, quantities));
  if (!isRecord(value)) return quantities && typeof value === "string" ? quantity(value) ?? value : value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => [k, normalizedIsolationSpec(v, quantities || k === "hard")]));
}

const COMPARED = ["spec", "rules", "subjects", "roleRef", "automountServiceAccountToken"] as const;

function mismatchesOf(desired: K8sObject, live: Record<string, unknown>): string[] {
  const out: string[] = [];
  const d = desired as unknown as Record<string, unknown>;
  for (const key of COMPARED) if (d[key] !== undefined) subsetMismatches(d[key], live[key], key, out);
  // Subset comparison alone permits a live default-deny to add allow-all ingress,
  // or a quota/policy to narrow its selector. Those additions weaken isolation.
  if (["NetworkPolicy", "CiliumNetworkPolicy", "ResourceQuota"].includes(desired.kind)
    && digest(normalizedIsolationSpec(d.spec)) !== digest(normalizedIsolationSpec(live.spec))) out.push("spec (isolation policy changed)");
  if (desired.kind === "CiliumNetworkPolicy" && Array.isArray(live.specs) && live.specs.length) out.push("specs (additional isolation policies)");
  if (desired.kind === "ClusterRole" && live.aggregationRule !== undefined) out.push("aggregationRule");
  const meta = isRecord(live.metadata) ? live.metadata : {};
  subsetMismatches(desired.metadata.labels ?? {}, meta.labels ?? {}, "metadata.labels", out);
  subsetMismatches(desired.metadata.annotations ?? {}, meta.annotations ?? {}, "metadata.annotations", out);
  return out;
}

const keyOf = (o: { kind: string; metadata: { name: string; namespace?: string } }): string => `${o.kind}/${o.metadata.namespace ?? ""}/${o.metadata.name}`;
const refText = (r: ObjectRef): string => `${r.kind}/${r.name}${r.namespace ? ` in ${r.namespace}` : ""}`;

/* --------------------------------- prepare --------------------------------- */

interface Prepared {
  tenant: TenantIsolationRequest["tenant"];
  namespace: string;
  bundle: IsolationBundle;
  objects: K8sObject[];
  bundleDigest: string;
  vet: PlatformApplyPolicy;
  namespaces: string[];
}

const bundleDigestOf = (objects: readonly K8sObject[]): string => digest({ kind: "zenith.tenant-isolation-bundle.v1", objects: platformOrder(objects as K8sObject[]) });

/** Render and validate. Pure; refuses before any cluster contact. */
export function prepareIsolation(request: TenantIsolationRequest): Prepared {
  try {
    const tenant = assertTenant(request.tenant);
    const substrate = request.substrate;
    if (!substrate.isolation?.operatorCredentialPrefix) {
      throw fail("not_configured", "Per-tenant operator credentials are not configured (ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX). A tenant is not onboarded without its own operator identity.");
    }
    const namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
    const baseline = renderTenancy(tenant, substrate, { withManagedDatabase: request.withManagedDatabase === true });
    const violations = validateTenantObjects(baseline.objects, { tenant, substrate });
    if (violations.length > 0) throw fail("plan_failed", `The tenancy baseline violates the isolation gate (${violations[0].rule}).`);
    const bundle = renderIsolationBundle(tenant, substrate, { egressFqdns: request.egressFqdns });
    validateIsolationBundle(bundle, { tenant, substrate });
    const objects = platformOrder([...baseline.objects, ...bundleObjects(bundle)]);
    const bundleDigest = bundleDigestOf(objects);
    const vet: PlatformApplyPolicy = {
      vet(batch) {
        // Defense in depth after DUR-C: only the exact custodied batch may use the platform apply set.
        if (bundleDigestOf(batch) !== bundleDigest) throw new K8sError("invalid_object", "The batch is not the rendered tenant isolation bundle; refusing before any write.");
      },
    };
    return { tenant, namespace, bundle, objects, bundleDigest, vet, namespaces: [namespace, operatorSubjectOf(namespace).namespace] };
  } catch (e) {
    if (e instanceof TenantIsolationError) throw e;
    if (e instanceof ZenithError) throw fail(e.code === "unsupported" || e.code === "isolation_violation" ? "plan_failed" : "invalid_request", e.message);
    throw fail("invalid_request", "The tenant isolation request could not be rendered.");
  }
}

/** Read every rendered object back and compare. Throws `verify_failed` naming the object and field paths, never values. */
export async function readBackTenantIsolation(session: KubernetesSession, p: Pick<Prepared, "tenant" | "objects" | "bundleDigest">, s: AbortSignal): Promise<{ verified: number; facts: Record<string, string | number | boolean | null> }> {
  const client = createK8sClient(session, { environmentId: p.tenant.environmentId, signal: s });
  let verified = 0;
  for (const o of p.objects) {
    const ref = refOf(o);
    let live: Record<string, unknown> | undefined;
    try {
      if (ref.namespace) await client.guard.assert(ref.namespace);
      live = await readObject(client, ref);
    } catch (e) {
      throw fail("verify_failed", `${refText(ref)} could not be read back (${errorText(e, 100)}).`);
    }
    if (!live) throw fail("verify_failed", `${refText(ref)} is not present after the apply.`);
    if (isRecord(live.metadata) && live.metadata.deletionTimestamp) throw fail("verify_failed", `${refText(ref)} is being deleted.`);
    const marks = isRecord(live.metadata) && isRecord(live.metadata.annotations) ? live.metadata.annotations : {};
    if (marks[ANNOTATION.environment] !== p.tenant.environmentId) throw fail("verify_failed", `${refText(ref)} is not owned by this environment.`);
    const wrong = mismatchesOf(o, live);
    if (wrong.length > 0) throw fail("verify_failed", `${refText(ref)} does not match what was rendered (${wrong.slice(0, 6).join(", ")}).`);
    verified++;
  }
  return { verified, facts: { objects: p.objects.length, verified, bundleDigest: p.bundleDigest } };
}

/* --------------------------------- provisioner ------------------------------ */

export function createTenantIsolationProvisioner(deps: TenantIsolationDeps): TenantIsolationProvisioner {
  const { rt } = deps;
  const signal = () => deps.signal?.() ?? AbortSignal.timeout(300_000);
  const scopeOf = (request: TenantIsolationRequest) => ({
    id: request.operationId,
    operationId: request.operationId,
    workspaceId: request.tenant.workspaceId,
    environmentId: request.tenant.environmentId,
    correlationId: `tenant-isolation:${request.operationId}`,
  });

  async function admit(request: TenantIsolationRequest): Promise<void> {
    try {
      await (deps.admit ?? ((i) => assertDispatchAdmitted({ workspaceId: i.workspaceId, kind: "dayTwo", operationId: i.operationId })))({ workspaceId: request.tenant.workspaceId, operationId: request.operationId });
    } catch {
      throw fail("admission_refused", "This workspace is at its operation limit or in maintenance; onboarding was not started.");
    }
  }

  async function fence(request: TenantIsolationRequest): Promise<void> {
    try {
      await rt.d.leases.assertFence(request.lease.scope, request.lease.fenceToken);
    } catch {
      throw fail("lease_lost", "The writer lease for this onboarding is no longer held; nothing was changed.");
    }
  }

  async function withBootstrap<T>(request: TenantIsolationRequest, p: Prepared, run: (session: KubernetesSession, s: AbortSignal) => Promise<T>): Promise<T> {
    const s = signal();
    let opened: Awaited<ReturnType<TenantIsolationDeps["openBootstrapSession"]>>;
    try {
      opened = await deps.openBootstrapSession(request, p.namespaces, s);
    } catch {
      throw fail("apply_failed", "The platform bootstrap session could not be opened; nothing was changed.");
    }
    try {
      return await run(opened.session, s);
    } finally {
      await Promise.resolve(opened.close?.()).catch(() => undefined);
    }
  }

  async function dryRun(session: KubernetesSession, p: Prepared, s: AbortSignal): Promise<{ plan: TenantIsolationPlan }> {
    let changes: DiffItem[];
    try {
      const namespace = await readObject(createK8sClient(session, { environmentId: p.tenant.environmentId, signal: s }), { apiVersion: "v1", kind: "Namespace", name: p.namespace });
      // The API cannot dry-run namespaced objects before the reviewed namespace create.
      // Only those absent-namespace objects are projected locally; all other objects are server checked.
      const candidates = namespace ? p.objects : p.objects.filter(o => o.metadata.namespace !== p.namespace);
      const candidateDigest = bundleDigestOf(candidates);
      changes = await diff(candidates, session, { environmentId: p.tenant.environmentId, signal: s, platform: { vet(batch) { if (bundleDigestOf(batch) !== candidateDigest) throw fail("plan_changed", "The isolation planning batch changed."); } } });
    } catch (e) {
      throw fail("plan_failed", `The cluster could not be consulted for the plan (${errorText(e, 120)}).`);
    }
    const bad = changes.find((c) => c.action === "conflict" || c.action === "ownership_conflict" || c.action === "error");
    if (bad) {
      const why = bad.action === "ownership_conflict" ? "an object exists that Zenith does not own" : bad.action === "conflict" ? "another field manager owns a field" : "the cluster refused it";
      throw fail("plan_failed", `The isolation plan cannot be made: ${refText(bad.ref)}: ${why}.`);
    }
    const byKey = new Map(changes.map((c) => [`${c.ref.kind}/${c.ref.namespace ?? ""}/${c.ref.name}`, c]));
    const objects = p.objects.map((o) => {
      const c = byKey.get(keyOf(o));
      const action: "create" | "update" | "none" = !c || c.action === "create" ? "create" : c.action === "update" ? "update" : "none";
      return { kind: o.kind, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}), name: o.metadata.name, action };
    });
    const planDigest = digest({ kind: "zenith.tenant-isolation-plan.v1", bundleDigest: p.bundleDigest, actions: objects.map((o) => [o.kind, o.namespace ?? "", o.name, o.action]) });
    return { plan: { planDigest, bundleDigest: p.bundleDigest, namespace: p.namespace, objects, notes: p.bundle.notes } };
  }

  async function preview(request: TenantIsolationRequest): Promise<TenantIsolationPlan> {
    const p = prepareIsolation(request);
    await admit(request);
    await fence(request);
    const { plan: made } = await withBootstrap(request, p, (session, s) => dryRun(session, p, s));
    return made;
  }

  const semanticsGuard = createIsolationSemanticsGuard(rt.d.semantics, rt.d.broker);
  const custody = () => {
    if (!rt.d.isolationCustody) throw fail("not_configured", "Durable isolation custody is not configured; onboarding must not dispatch.");
    return rt.d.isolationCustody;
  };
  async function recordReviewed(request: TenantIsolationRequest, made: TenantIsolationPlan, review?: IsolationReview): Promise<void> {
    const p = prepareIsolation(request);
    if (p.bundleDigest !== made.bundleDigest || p.namespace !== made.namespace) throw fail("plan_changed", "The isolation bundle changed before review.");
    const semantics = isolationExecutableSemantics(request, made);
    if (!review) {
      await semanticsGuard.recordReviewed(request, made);
      review = { planDigest: made.planDigest, semanticsDigest: semantics.digest };
    } else {
      const registered = await rt.d.semantics?.get(request.tenant.workspaceId, request.operationId, review.planDigest);
      if (!registered || registered.semantics.digest !== review.semanticsDigest) throw fail("plan_changed", "The composite reviewed semantics are unavailable.");
    }
    await custody().publish(request, { plan: made, objects: p.objects, isolationSemanticsDigest: semantics.digest, review });
  }
  async function plan(request: TenantIsolationRequest): Promise<TenantIsolationPlan> {
    const made = await preview(request);
    await recordReviewed(request, made);
    const semantics = isolationExecutableSemantics(request, made);
    await rt.evidence(scopeOf(request), { kind: "tofu_plan", digest: made.planDigest, key: `isolation-plan:${made.planDigest}`, simulated: false, summary: { planDigest: made.planDigest, semantics, engine: "tenant-isolation", custody: "zenith.isolation-artifact.v1", resources: made.objects.length, create: made.objects.filter(o => o.action === "create").length, update: made.objects.filter(o => o.action === "update").length } }, { critical: true });
    return made;
  }
  async function assertCustody(request: TenantIsolationRequest, p: Prepared, approvedPlanDigest: string, review?: IsolationReview): Promise<void> {
    // DUR-B precedes every DUR-C decrypt/read and every credential resolution.
    if (!review) await semanticsGuard.assertReviewed(request, { planDigest: approvedPlanDigest, bundleDigest: p.bundleDigest, namespace: p.namespace });
    else {
      const registered = await rt.d.semantics?.get(request.tenant.workspaceId, request.operationId, review.planDigest);
      if (!registered || registered.semantics.digest !== review.semanticsDigest) throw fail("plan_changed", "Reviewed composite semantics are missing or changed.");
      await approvalBound(request, review.planDigest);
    }
    await custody().inspect(request, review?.planDigest ?? approvedPlanDigest, async artifact => {
      const registered = await rt.d.semantics?.get(request.tenant.workspaceId, request.operationId, artifact.review.planDigest);
      if (!registered || registered.semantics.digest !== artifact.review.semanticsDigest || review && review.semanticsDigest !== artifact.review.semanticsDigest
        || artifact.plan.planDigest !== approvedPlanDigest || artifact.plan.bundleDigest !== p.bundleDigest || bundleDigestOf(artifact.objects) !== p.bundleDigest
        || isolationExecutableSemantics(request, artifact.plan).digest !== artifact.isolationSemanticsDigest) throw fail("plan_changed", "The reviewed isolation semantics or custody changed; nothing was dispatched.");
      await approvalBound(request, artifact.review.planDigest);
      await fence(request);
    });
  }

  async function approvalBound(request: TenantIsolationRequest, planDigest: string): Promise<void> {
    const authority = await rt.d.broker.approvalStatus(request.operationId);
    const bound = authority.dispatchApproval?.planDigest === planDigest;
    if (!authority.approved || authority.rejected || !authority.approvalId || !bound) {
      throw fail("approval_required", "There is no current approval bound to exactly this isolation plan; nothing was applied.");
    }
  }

  /** Mint with the MACH-02 TokenRequest path, probe the identity, store the token. Returns only where it went. */
  async function mintAndStore(request: TenantIsolationRequest, p: Prepared, session: KubernetesSession, s: AbortSignal, beforeCredential: () => Promise<void>): Promise<{ ref: string; expiresAt: string; probed: boolean }> {
    const prefix = request.substrate.isolation?.operatorCredentialPrefix as string;
    const ref = `${prefix}/${p.namespace}`;
    const subject = p.bundle.operatorSubject;
    const sa = p.bundle.operatorAccess.find((o) => o.kind === "ServiceAccount") as K8sObject;
    const cluster = (deps.guestPort ?? ((sess, sig) => createGuestClusterPort(sess, sig)))(session, s);
    let token: string;
    let expiresAt: Date;
    try {
      // ensureServiceAccount reads the live account (created by the apply), refuses a foreign one, and returns the UID the token is bound to
      const account = await cluster.ensureServiceAccount(subject.namespace, subject.name, sa.metadata.labels ?? {});
      await beforeCredential();
      const issued = await requestVerifiedToken(cluster, { namespace: subject.namespace, serviceAccount: subject.name, uid: account.uid, audiences: request.audiences, tokenTtlSec: request.tokenTtlSec, now: rt.now });
      token = issued.token;
      expiresAt = issued.expiresAt;
    } catch (e) {
      throw fail("credential_failed", `The operator credential could not be minted (${e instanceof GuestCredentialError ? e.code : "cluster_error"}).`);
    }
    let probed = false;
    if (deps.openOperatorProbe) {
      let probe: Pick<GuestClusterPort, "allowed">;
      try {
        probe = await deps.openOperatorProbe(token, request);
        await assertTenantOperatorAccess(probe, p.namespace);
      } catch (e) {
        if (e instanceof TenantIsolationError) throw e;
        throw fail("verify_failed", "The minted operator identity could not be probed.");
      }
      probed = true;
    }
    try {
      await beforeCredential();
      await deps.storeOperatorCredential({ ref, token, expiresAt: expiresAt.toISOString(), workspaceId: p.tenant.workspaceId, environmentId: p.tenant.environmentId });
    } catch {
      throw fail("credential_failed", "The operator credential could not be stored; onboarding is not complete.");
    }
    return { ref, expiresAt: expiresAt.toISOString(), probed };
  }

  const effectInput = (request: TenantIsolationRequest, p: Prepared, planDigest: string) => ({
    workspaceId: p.tenant.workspaceId,
    family: "isolation_apply" as const,
    operationId: request.operationId,
    environmentId: p.tenant.environmentId,
    provider: "kubernetes",
    dedupKey: `isolation:${request.operationId}:${planDigest}`,
    requestDigest: digest({ kind: "zenith.isolation-apply.v1", workspaceId: p.tenant.workspaceId, environmentId: p.tenant.environmentId, operationId: request.operationId, planDigest, bundleDigest: p.bundleDigest }),
    target: { environmentId: p.tenant.environmentId, namespace: p.namespace, planDigest, bundleDigest: p.bundleDigest, objects: p.objects.length },
    idempotencySupported: true,
    fence: { scope: request.lease.scope, token: request.lease.fenceToken },
    actor: "system:tenant-isolation",
  });

  async function settleReadback(ledger: EffectLedger, effect: EffectRecord, readback: Omit<Readback, "digest">): Promise<void> {
    await ledger.recordReadback(effect.workspaceId, effect.effectId, buildReadback(readback), "system:tenant-isolation").catch(() => undefined);
  }

  async function apply(request: TenantIsolationRequest, approvedPlanDigest: string, review?: IsolationReview): Promise<TenantIsolationResult> {
    if (!/^[a-f0-9]{64}$/.test(approvedPlanDigest)) throw fail("invalid_request", "The plan digest is not a SHA-256 hex digest; refusing to apply.");
    const p = prepareIsolation(request);
    const ledger = rt.d.effects;
    if (!ledger) throw fail("not_configured", "The external-effect ledger is not available in this composition; refusing to apply without a record.");
    await admit(request);
    await fence(request);
    await assertCustody(request, p, approvedPlanDigest, review);
    return withBootstrap(request, p, async (session, s) => {
      // A repeat of an apply this ledger already holds (accepted or confirmed) changes nothing: it is verified again, and
      // the live cluster no longer matches the plan it was made against, so the plan is not recomputed. Any other recorded
      // state (pending, uncertain, conflict, retired) refuses: it will not be repeated.
      const input = effectInput(request, p, approvedPlanDigest);
      const prior = await ledger.getByDedup(p.tenant.workspaceId, "isolation_apply", input.dedupKey).catch(() => null);
      const alreadyApplied = prior !== null && (prior.state === "accepted" || prior.state === "confirmed") && prior.requestDigest === input.requestDigest;
      if (prior && !alreadyApplied) throw fail("effect_unresolved", "An earlier apply of this plan is unresolved or retired; it will not be repeated. Inspect and resolve the effect, then propose a new operation.");
      if (!alreadyApplied) {
        // DUR-B: recompute the plan against the live cluster; the approved digest must still be the one that would be applied
        const fresh = (await dryRun(session, p, s)).plan;
        if (fresh.planDigest !== approvedPlanDigest) throw fail("plan_changed", "The isolation plan changed since it was approved; a new review is required. Nothing was applied.");
      }
      await assertCustody(request, p, approvedPlanDigest, review);
      await fence(request);
      await rt.emit(scopeOf(request), "resource.applying", `isolation:${approvedPlanDigest}`, { planDigest: approvedPlanDigest, engine: "tenant-isolation" });

      let applied = 0;
      let deduplicated = false;
      let effect!: EffectRecord;
      try {
        const outcome = await ledger.dispatchOnce(input, async () => {
          await assertCustody(request, p, approvedPlanDigest, review);
          const report = await serverSideApply(p.objects, session, { environmentId: p.tenant.environmentId, signal: s, platform: p.vet });
          if (!report.ok) {
            const failed = report.results.filter((r) => !["created", "configured", "unchanged"].includes(r.status));
            const detail = failed.slice(0, 3).map((r) => `${r.ref.kind}/${r.ref.name}: ${r.status}`).join("; ");
            throw fail("apply_failed", report.refused ? `The apply was refused before anything was written (${detail}).` : `The apply stopped part way (${detail}); partial apply; the effect is recorded uncertain.`);
          }
          const changed = report.results.filter((r) => r.status === "created" || r.status === "configured").length;
          const receipt: ProviderReceipt = { resourceId: `tenant-isolation:${p.bundleDigest.slice(0, 32)}`, requestIds: [], identity: { namespace: p.namespace, applied: String(changed) } };
          return { value: changed, receipt };
        }, (error) => (error instanceof TenantIsolationError && /refused before anything was written/.test(error.message) ? "rejected" : "unknown"));
        effect = outcome.effect;
        if (outcome.kind === "dispatched") applied = outcome.value;
        else deduplicated = true;
      } catch (e) {
        if (e instanceof TenantIsolationError) throw e;
        if (e instanceof EffectUnresolvedError || e instanceof EffectTombstonedError) throw fail("effect_unresolved", "An earlier apply of this plan is unresolved or retired; it will not be repeated. Inspect and resolve the effect, then propose a new operation.");
        throw fail("apply_failed", `The apply did not complete (${errorText(e, 120)}).`);
      }

      let verified: { verified: number; facts: Record<string, string | number | boolean | null> };
      try {
        verified = await readBackTenantIsolation(session, p, s);
      } catch (e) {
        await settleReadback(ledger, effect, { outcome: "mismatch", source: "kubernetes.read", observedAt: rt.now().toISOString(), facts: { objects: p.objects.length }, reason: e instanceof TenantIsolationError ? e.message.slice(0, 400) : "readback failed" });
        throw e instanceof TenantIsolationError ? e : fail("verify_failed", "The isolation objects could not be read back.");
      }
      await assertCustody(request, p, approvedPlanDigest, review);
      const credential = await mintAndStore(request, p, session, s, () => assertCustody(request, p, approvedPlanDigest, review)).catch(async (e) => {
        // A failed access probe is evidence the cluster does not hold what was rendered: the effect goes to conflict for an
        // operator. A mint or sink failure is not: the apply is accepted and verified, and a retry only re-mints.
        if (e instanceof TenantIsolationError && e.code === "verify_failed") {
          await settleReadback(ledger, effect, { outcome: "mismatch", source: "kubernetes.operator-probe", observedAt: rt.now().toISOString(), facts: verified.facts, reason: e.message.slice(0, 400) });
        }
        throw e;
      });
      await settleReadback(ledger, effect, { outcome: "present", source: "kubernetes.read", observedAt: rt.now().toISOString(), resourceId: `tenant-isolation:${p.bundleDigest.slice(0, 32)}`, facts: { ...verified.facts, operatorProbe: credential.probed } });
      await rt.emit(scopeOf(request), "resource.applied", `isolation:${approvedPlanDigest}`, { planDigest: approvedPlanDigest, applied, verified: verified.verified });
      return { planDigest: approvedPlanDigest, bundleDigest: p.bundleDigest, namespace: p.namespace, applied, verified: verified.verified, credential: { ref: credential.ref, expiresAt: credential.expiresAt }, deduplicated };
    });
  }

  return {
    preview,
    recordReviewed,
    async reviewedPlan(request, reviewedPlanDigest) {
      const reviewed = await rt.d.semantics?.get(request.tenant.workspaceId, request.operationId, reviewedPlanDigest);
      if (!reviewed) throw fail("plan_changed", "Reviewed isolation semantics are unavailable.");
      await approvalBound(request, reviewedPlanDigest);
      return custody().inspect(request, reviewedPlanDigest, async artifact => {
        if (artifact.review.semanticsDigest !== reviewed.semantics.digest) throw fail("plan_changed", "Reviewed isolation custody does not match its semantics.");
        return structuredClone(artifact.plan);
      });
    },
    assertReviewed: (request, approvedPlanDigest, review) => assertCustody(request, prepareIsolation(request), approvedPlanDigest, review),
    plan,
    apply,
    async provision(request) {
      const made = await plan(request);
      return apply(request, made.planDigest);
    },
    async rotateCredential(request) {
      const p = prepareIsolation(request);
      await admit(request);
      await fence(request);
      const authority = await rt.d.broker.approvalStatus(request.operationId);
      const approved = authority.dispatchApproval?.planDigest;
      if (!approved) throw fail("approval_required", "Credential rotation requires the reviewed onboarding plan.");
      const artifact = await custody().inspect(request, approved, async a => ({ plan: a.plan, review: a.review }));
      await assertCustody(request, p, artifact.plan.planDigest, artifact.review);
      return withBootstrap(request, p, async (session, s) => {
        // rotation never applies anything: the bundle must already be present and matching, or the token is not minted
        await readBackTenantIsolation(session, p, s);
        const c = await mintAndStore(request, p, session, s, () => assertCustody(request, p, artifact.plan.planDigest, artifact.review));
        return { ref: c.ref, expiresAt: c.expiresAt };
      });
    },
  };
}
