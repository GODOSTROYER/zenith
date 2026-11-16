/**
 * Autoscaling on the managed platform (PROD-MAN-03).
 *
 * The Kubernetes renderer already knows how to emit a `HorizontalPodAutoscaler` (and to leave `Deployment.spec.replicas` to it)
 * when its `autoscale` option is set and a service declares more than one replica. This module is the managed tier's policy on
 * top of that output, applied to the rendered objects before they pass the isolation gate:
 *
 *   - autoscaling is part of a tier only when `maxAutoscaleReplicas > 0` (free: no);
 *   - `maxReplicas` is clamped to the tier ceiling, to the namespace pod quota, and to what the namespace CPU request quota
 *     can hold at the pod's CPU request, so the autoscaler can never be asked to scale into a quota rejection loop;
 *   - scale-down is damped (300 s stabilization) so a brief lull does not drop capacity;
 *   - an autoscaler must target a Deployment in this same render, never anything else.
 *
 * The clamp is an approximation per workload (the quota is shared); the ResourceQuota stays the hard limit. Real scaling needs
 * a metrics source in the cluster (metrics-server); nothing here proves one exists, and the substrate readiness report says so.
 */
import { dig, isRecord, type K8sObject } from "./k8s-port";
import { planLimits } from "./plans";
import { ZenithError, type ZenithTenant } from "./types";

/** `100m` -> 100, `1` -> 1000, `0.5` -> 500; undefined when it is not a plain CPU quantity. */
export function cpuMillis(q: unknown): number | undefined {
  if (typeof q === "number" && Number.isFinite(q)) return Math.round(q * 1000);
  if (typeof q !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(q.trim());
  if (!m) return undefined;
  return m[2] === "m" ? Math.round(Number(m[1])) : Math.round(Number(m[1]) * 1000);
}

function podCpuRequestMillis(deployment: K8sObject): number | undefined {
  const containers = dig(deployment, "spec", "template", "spec", "containers");
  if (!Array.isArray(containers)) return undefined;
  let total = 0;
  for (const c of containers) {
    const req = dig(c, "resources", "requests", "cpu") ?? dig(c, "resources", "limits", "cpu");
    const m = cpuMillis(req);
    if (m === undefined) return undefined;
    total += m;
  }
  return total > 0 ? total : undefined;
}

export interface AutoscaleResult {
  objects: K8sObject[];
  notes: string[];
}

/** Apply the tier's autoscaling policy to rendered workloads. Pure; returns new objects, never mutates the input. */
export function constrainAutoscalers(objects: readonly K8sObject[], tenant: ZenithTenant): AutoscaleResult {
  const limits = planLimits(tenant.planTier);
  const notes: string[] = [];
  const deployments = new Map(objects.filter((o) => o.kind === "Deployment").map((o) => [o.metadata.name, o]));
  const quotaCpu = cpuMillis(limits.quota["requests.cpu"]) ?? Infinity;
  const quotaPods = Number(limits.quota.pods);
  const out: K8sObject[] = [];
  for (const obj of objects) {
    if (obj.kind !== "HorizontalPodAutoscaler") { out.push(obj); continue; }
    const address = obj.metadata.annotations?.["zenith.dev/resource"] ?? obj.metadata.name;
    if (limits.maxAutoscaleReplicas <= 0) {
      throw new ZenithError("plan_limit", `${address}: autoscaling is not part of the ${tenant.planTier} plan.`);
    }
    const spec = isRecord(obj.spec) ? obj.spec : {};
    const ref = isRecord(spec.scaleTargetRef) ? spec.scaleTargetRef : {};
    const target = typeof ref.name === "string" ? deployments.get(ref.name) : undefined;
    if (ref.kind !== "Deployment" || !target) throw new ZenithError("render_error", `${address}: an autoscaler may only target a Deployment rendered with it.`);
    const requested = typeof spec.maxReplicas === "number" ? spec.maxReplicas : 1;
    const minReplicas = typeof spec.minReplicas === "number" ? spec.minReplicas : 1;
    const perPod = podCpuRequestMillis(target) ?? Number(cpuMillis(limits.container.defaultRequest.cpu));
    const byQuota = Number.isFinite(quotaCpu) && perPod > 0 ? Math.floor(quotaCpu / perPod) : Infinity;
    const maxReplicas = Math.max(1, Math.min(requested, limits.maxAutoscaleReplicas, quotaPods, byQuota));
    if (minReplicas > maxReplicas) throw new ZenithError("plan_limit", `${address}: ${minReplicas} minimum replicas do not fit the ${tenant.planTier} plan (at most ${maxReplicas} can run).`);
    out.push({
      ...obj,
      spec: {
        ...spec,
        minReplicas,
        maxReplicas,
        behavior: { scaleDown: { stabilizationWindowSeconds: 300, policies: [{ type: "Percent", value: 50, periodSeconds: 60 }] } },
      },
    });
    notes.push(`${address}: autoscaling ${minReplicas}-${maxReplicas} replicas on CPU${maxReplicas < requested ? ` (requested ${requested}, limited by the ${tenant.planTier} plan quota)` : ""}; it needs a metrics source (metrics-server) in the cluster.`);
  }
  return { objects: out, notes };
}
