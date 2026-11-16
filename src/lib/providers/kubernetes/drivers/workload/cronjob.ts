/**
 * `k8s:CronJob` — scheduled_job, and the native `k8s:CronJob` (PROD-LIFE-07).
 *
 * Observe compares schedule, suspend, concurrency policy and history limits.
 * Runtime reads the Jobs the CronJob created, so health says whether the last
 * run succeeded; a CronJob that has never run stays `unknown` rather than
 * guessed healthy.
 */
import type { VerificationCheck } from "@/lib/drivers/types";
import type { Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { readEvents } from "../../ops";
import { cronExpectations } from "../../renderers/stateful";
import { workloadExpectations } from "../../renderers/workload";
import { dig } from "../../util";
import { compact, containerAttributes, safeExpected } from "../attrs";
import { cronJobRuntime } from "../runtime";
import { makeKubernetesDriver, type KindDef } from "../shared";

const container = (live: Record<string, unknown>) => dig(live, "spec", "jobTemplate", "spec", "template", "spec", "containers", 0);

/** Present only once Jobs were read: a CronJob that has not run yet has no run to judge, and says so through runtime signals. */
function runChecks(_node: ResourceNode, _observation: Observation, runtime?: RuntimeState): VerificationCheck[] {
  if (runtime === undefined || typeof runtime.counts.jobs !== "number") return [];
  const failed = runtime.signals.includes("last_run_failed");
  return [
    {
      id: "last_run",
      description: "the most recent run did not fail",
      passed: failed ? false : runtime.health === "healthy" ? true : "unknown",
      detail: failed ? "the latest finished Job failed" : undefined,
    },
  ];
}

export const cronJobDef: KindDef = {
  suffix: "cronjob",
  nativeType: "k8s:CronJob",
  kind: "CronJob",
  portable: ["scheduled_job"],
  attributes: (live) => {
    const c = containerAttributes(container(live));
    return {
      schedule: dig(live, "spec", "schedule"),
      suspend: dig(live, "spec", "suspend") === true,
      image: c.image,
      cpuMillicores: c.cpuMillicores,
      memoryMi: c.memoryMi,
      // absent values are the API defaults
      concurrencyPolicy: dig(live, "spec", "concurrencyPolicy") ?? "Allow",
      successfulJobsHistoryLimit: dig(live, "spec", "successfulJobsHistoryLimit") ?? 3,
      failedJobsHistoryLimit: dig(live, "spec", "failedJobsHistoryLimit") ?? 1,
    };
  },
  expected: safeExpected((node) => (node.kind === "provider_native" ? cronExpectations(node) : workloadExpectations(node))),
  summary: (live) => compact({ schedule: dig(live, "spec", "schedule"), image: containerAttributes(container(live)).image }),
  runtime: cronJobRuntime,
  extraChecks: runChecks,
  operations: { "events.read": (ctx, node, input) => readEvents(ctx, node, input) },
};

export const cronJobDriver = makeKubernetesDriver(cronJobDef);
