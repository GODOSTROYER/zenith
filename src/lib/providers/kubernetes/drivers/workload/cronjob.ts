/**
 * `k8s:CronJob` — scheduled_job.
 *
 * Runtime health is `unknown` by design: a CronJob object does not say whether
 * its last run succeeded, and this driver does not guess from it.
 */
import { readEvents } from "../../ops";
import { workloadExpectations } from "../../renderers/workload";
import { dig } from "../../util";
import { compact, containerAttributes, safeExpected } from "../attrs";
import { cronJobRuntime } from "../runtime";
import { makeKubernetesDriver, type KindDef } from "../shared";

const container = (live: Record<string, unknown>) => dig(live, "spec", "jobTemplate", "spec", "template", "spec", "containers", 0);

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
    };
  },
  expected: safeExpected(workloadExpectations),
  summary: (live) => compact({ schedule: dig(live, "spec", "schedule"), image: containerAttributes(container(live)).image }),
  runtime: cronJobRuntime,
  operations: { "events.read": (ctx, node, input) => readEvents(ctx, node, input) },
};

export const cronJobDriver = makeKubernetesDriver(cronJobDef);
