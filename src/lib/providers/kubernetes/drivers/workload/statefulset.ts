/**
 * `k8s:StatefulSet` — the DEV-TIER postgres / redis rendering (and only that).
 *
 * Honesty: this realizes a database as one StatefulSet replica on cluster
 * storage. It is labeled `zenith.dev/tier: dev-only`; it is not a production
 * managed database. The observed `tier` attribute is compared to `dev-only` so
 * a cluster object that lost the label shows as drift. Expansion and placement
 * should prefer a managed database service for production environments.
 *
 * `mysql` shares this native type but has no rendering yet; its nodes render
 * to a `render_error` and observe with only ownership expectations.
 *
 * Operations: service.restart, container.logs, events.read. No scale (a
 * single-replica dev tier) and no rollback (StatefulSet revisions are not
 * modelled here).
 */
import { readEvents, readLogs, restartWorkload } from "../../ops";
import { dataExpectations } from "../../renderers/data";
import { LABEL } from "../../types";
import { dig } from "../../util";
import { compact, containerAttributes, labelsOf, safeExpected } from "../attrs";
import { podBasedRuntime } from "../runtime";
import { makeKubernetesDriver, type KindDef } from "../shared";
import { rolloutChecks } from "./deployment";

export const statefulSetDef: KindDef = {
  suffix: "statefulset",
  nativeType: "k8s:StatefulSet",
  kind: "StatefulSet",
  portable: ["postgres", "redis", "mysql"],
  attributes: (live) => {
    const replicas = dig(live, "spec", "replicas");
    const c = containerAttributes(dig(live, "spec", "template", "spec", "containers", 0));
    return { replicas: typeof replicas === "number" ? replicas : undefined, image: c.image, tier: labelsOf(live)[LABEL.tier] };
  },
  expected: safeExpected(dataExpectations),
  summary: (live) => compact({ image: containerAttributes(dig(live, "spec", "template", "spec", "containers", 0)).image, replicas: dig(live, "spec", "replicas") }),
  runtime: podBasedRuntime,
  extraChecks: rolloutChecks,
  operations: {
    "service.restart": (ctx, node) => restartWorkload(ctx, node),
    "container.logs": (ctx, node, input) => readLogs(ctx, node, input),
    "events.read": (ctx, node, input) => readEvents(ctx, node, input),
  },
};

export const statefulSetDriver = makeKubernetesDriver(statefulSetDef);
