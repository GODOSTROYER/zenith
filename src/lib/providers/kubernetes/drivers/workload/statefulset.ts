/**
 * `k8s:StatefulSet` — two things share this native type:
 *
 *   1. the DEV-TIER postgres / redis rendering. Honesty: one StatefulSet replica
 *      on cluster storage, labeled `zenith.dev/tier: dev-only`; not a production
 *      managed database. The observed `tier` attribute is compared to `dev-only`
 *      so a cluster object that lost the label shows as drift. `mysql` has no
 *      rendering yet; its nodes render to a `render_error`.
 *   2. a native `k8s:StatefulSet` (provider_native, PROD-LIFE-07): replicas,
 *      volume claim templates, ordered rollout, explicit PVC retention. Observe
 *      compares those fields; runtime reads ordered readiness, revision
 *      convergence and the state of every claim.
 *
 * Operations: service.restart, container.logs, events.read for both. The
 * rest apply to the native shape only and refuse dev-tier databases (a fixed
 * single replica with no revision history): service.scale (ordered, with a
 * data-loss acknowledgement when scale-down deletes claims), deployment.rollback
 * (ControllerRevision template restore, volumes untouched), database.snapshot
 * and database.restore (CSI VolumeSnapshots; refuse where the cluster cannot).
 */
import type { VerificationCheck } from "@/lib/drivers/types";
import type { Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { readEvents, readLogs, restartWorkload, rollbackWorkload, scaleWorkload } from "../../ops";
import { dataExpectations } from "../../renderers/data";
import { statefulExpectations } from "../../renderers/stateful";
import { restoreData, snapshotData } from "../../snapshots";
import { LABEL } from "../../types";
import { dig, isRecord } from "../../util";
import { compact, containerAttributes, labelsOf, safeExpected, sortedStrings } from "../attrs";
import { podBasedRuntime } from "../runtime";
import { makeKubernetesDriver, type KindDef } from "../shared";
import { rolloutChecks } from "./deployment";

function claimSummaries(live: Record<string, unknown>): string[] {
  const templates = dig(live, "spec", "volumeClaimTemplates");
  if (!Array.isArray(templates)) return [];
  const out: string[] = [];
  for (const t of templates) {
    const name = dig(t, "metadata", "name");
    const storage = dig(t, "spec", "resources", "requests", "storage");
    if (typeof name === "string" && typeof storage === "string") out.push(`${name}:${storage}`);
  }
  return sortedStrings(out);
}

/** Rollout checks plus what only a StatefulSet can get wrong: ordinal order and the data volumes. */
function statefulChecks(node: ResourceNode, observation: Observation, runtime?: RuntimeState): VerificationCheck[] {
  const checks = rolloutChecks(node, observation, runtime);
  const c = runtime?.counts;
  const signals = runtime?.signals ?? [];
  const read = runtime !== undefined && c !== undefined && typeof c.desired === "number";
  checks.push({
    id: "ordered_readiness",
    description: "pods became ready in ordinal order",
    passed: !read ? "unknown" : !signals.includes("ordinal_gap"),
    detail: read && signals.includes("ordinal_gap") ? "a higher ordinal is ready while a lower one is not" : undefined,
  });
  if (read && typeof c.claims_expected === "number") {
    checks.push({
      id: "claims_bound",
      description: "every persistent volume claim is bound",
      passed: (c.claims_bound ?? 0) >= c.claims_expected,
      detail: `${c.claims_bound ?? 0} of ${c.claims_expected} bound`,
    });
  }
  return checks;
}

export const statefulSetDef: KindDef = {
  suffix: "statefulset",
  nativeType: "k8s:StatefulSet",
  kind: "StatefulSet",
  portable: ["postgres", "redis", "mysql"],
  attributes: (live) => {
    const replicas = dig(live, "spec", "replicas");
    const c = containerAttributes(dig(live, "spec", "template", "spec", "containers", 0));
    const retention = dig(live, "spec", "persistentVolumeClaimRetentionPolicy");
    const partition = dig(live, "spec", "updateStrategy", "rollingUpdate", "partition");
    const policy = dig(live, "spec", "podManagementPolicy");
    return {
      replicas: typeof replicas === "number" ? replicas : undefined,
      image: c.image,
      tier: labelsOf(live)[LABEL.tier],
      // An absent policy is the cluster default: both Retain.
      pvcRetentionWhenDeleted: isRecord(retention) && typeof retention.whenDeleted === "string" ? retention.whenDeleted : "Retain",
      pvcRetentionWhenScaled: isRecord(retention) && typeof retention.whenScaled === "string" ? retention.whenScaled : "Retain",
      podManagementPolicy: typeof policy === "string" ? policy : "OrderedReady",
      partition: typeof partition === "number" ? partition : 0,
      volumeClaims: claimSummaries(live),
    };
  },
  expected: safeExpected((node) => (node.kind === "provider_native" ? statefulExpectations(node) : dataExpectations(node))),
  summary: (live) => compact({ image: containerAttributes(dig(live, "spec", "template", "spec", "containers", 0)).image, replicas: dig(live, "spec", "replicas") }),
  runtime: podBasedRuntime,
  extraChecks: statefulChecks,
  operations: {
    "service.restart": (ctx, node) => restartWorkload(ctx, node),
    "service.scale": (ctx, node, input) => scaleWorkload(ctx, node, input),
    "deployment.rollback": (ctx, node, input) => rollbackWorkload(ctx, node, input),
    "database.snapshot": (ctx, node, input) => snapshotData(ctx, node, input),
    "database.restore": (ctx, node, input) => restoreData(ctx, node, input),
    "container.logs": (ctx, node, input) => readLogs(ctx, node, input),
    "events.read": (ctx, node, input) => readEvents(ctx, node, input),
  },
};

export const statefulSetDriver = makeKubernetesDriver(statefulSetDef);
