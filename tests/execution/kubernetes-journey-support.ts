/**
 * The deploy journey for a `kubernetes`-provider environment, driven through the
 * real execution activities in the order the workflow calls them:
 *
 *   validate -> lease -> plan -> policy -> approval -> final plan -> apply_infrastructure
 *     -> deploy (release ports) -> verify_infrastructure
 *
 * Real: the activities, graph expansion, the Kubernetes renderers, drivers, apply,
 * release ports and verification. Scripted (as in every execution test): the
 * ledger/store fakes, the capability broker and the credential broker, whose
 * `withSession` hands the activities the Kubernetes session the caller supplies.
 * With a fake API server that is contract evidence; with a real cluster
 * (lifecycle-acceptance.test.ts) the cluster side is real and the platform side
 * stays scripted, which the acceptance document says in as many words.
 */
import { vi } from "vitest";
import { createExecutionActivities } from "@/lib/execution/activities";
import { createKubernetesMigrationsPort, createKubernetesWorkloadsPort } from "@/lib/platform/release-k8s";
import { findDriver } from "@/lib/drivers/types";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes/drivers";
import type { KubernetesSession } from "@/lib/credentials/types";
import { createWorld, type World } from "./fakes/world";
import { OP } from "./fakes/fixtures";

export interface JourneyOptions {
  session: KubernetesSession;
  namespace: string;
  /** native StatefulSet config (see native-k8s-workloads.ts); `namespace` is filled in */
  sts: Record<string, unknown>;
  /** a pinned image for a portable web Deployment; omit for no web service */
  webImage?: string;
}

export function journeyManifest(o: JourneyOptions): Record<string, unknown> {
  const svc = (over: Record<string, unknown>) => ({ size: "small", replicas: 1, env: [], ownership: "managed", ...over });
  return {
    version: 2,
    services: [
      ...(o.webImage ? [svc({ id: "svc-web", name: "web", kind: "worker", source: { type: "image", image: o.webImage } })] : []),
      // a job that never fires: it exists so the environment has a namespace and a CronJob to read back
      svc({ id: "svc-nightly", name: "nightly", kind: "cron", schedule: "0 0 1 1 *", source: { type: "image", image: o.webImage ?? `registry.example.com/acme/job@sha256:${"d".repeat(64)}` } }),
    ],
    resources: [],
    routes: [],
    bindings: [],
    native: [{ id: "ledger", provider: "kubernetes", type: "k8s:StatefulSet", config: { ...o.sts, namespace: o.namespace } }],
    providerConfig: { kubernetes: { namespace: o.namespace } },
  };
}

export interface Journey {
  w: World;
  activities: ReturnType<typeof createExecutionActivities>;
  operationId: string;
  validate(): ReturnType<World["activities"]["validateDesiredState"]>;
  plan(): ReturnType<World["activities"]["planInfrastructure"]>;
  policy(planDigest: string): ReturnType<World["activities"]["evaluatePolicy"]>;
  approve(approved?: boolean): void;
  finalPlan(planDigest: string): ReturnType<World["activities"]["finalPlan"]>;
  apply(planDigest: string): ReturnType<World["activities"]["applyInfrastructure"]>;
  /** the deploy step with the given pinned images, through the real Kubernetes release ports */
  deploy(images?: { service: string; imageUri: string; digest: string }[]): ReturnType<World["activities"]["deployWorkloads"]>;
  verify(): ReturnType<World["activities"]["verifyInfrastructure"]>;
  releaseLease(): Promise<void>;
}

export async function startJourney(o: JourneyOptions): Promise<Journey> {
  registerKubernetesDrivers();
  const w = createWorld();
  w.product.base.environment.provider = "kubernetes";
  w.product.base.environment.region = "contract";
  w.product.setManifest(journeyManifest(o));
  vi.spyOn(w.credentials, "withSession").mockImplementation(async (_req, fn) => fn(o.session as never));
  const activities = createExecutionActivities({
    ...w.deps,
    drivers: (provider, nativeType) => findDriver(provider, nativeType) as never,
    workloads: createKubernetesWorkloadsPort(),
    migrations: createKubernetesMigrationsPort(),
  });
  let lease: Awaited<ReturnType<World["lease"]>> | undefined;
  const need = async () => (lease ??= await activities.acquireLease({ operationId: OP, scope: `env:${w.product.base.environment.id}`, ttlMs: 300_000 }));
  await activities.markOperation({ operationId: OP, status: "running" });
  return {
    w,
    activities,
    operationId: OP,
    validate: () => activities.validateDesiredState({ operationId: OP }),
    plan: async () => activities.planInfrastructure({ operationId: OP, lease: await need() }),
    policy: (planDigest) => activities.evaluatePolicy({ operationId: OP, planDigest }),
    approve: (approved = true) => { w.broker.approval = { approved, rejected: false, ...(approved ? { approvalId: "human-fixture" } : {}) }; },
    finalPlan: async (planDigest) => activities.finalPlan({ operationId: OP, approvedPlanDigest: planDigest, lease: await need() }),
    apply: async (planDigest) => activities.applyInfrastructure({ operationId: OP, planDigest, lease: await need() }),
    deploy: async (images = []) => activities.deployWorkloads({ operationId: OP, lease: await need(), images }),
    verify: () => activities.verifyInfrastructure({ operationId: OP }),
    releaseLease: async () => { if (lease) await activities.releaseLease({ lease }); lease = undefined; w.dispose(); },
  };
}
