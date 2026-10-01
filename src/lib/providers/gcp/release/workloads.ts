/**
 * Digest-only Cloud Run updates and revision readiness reads. Release records
 * built images on the template, alongside the actual container image; tofu
 * refresh + ignore_changes retains both on later infrastructure applies.
 * Bootstrap readiness is never application rollout success.
 * Contract-tested, not live-verified.
 */
import type { WorkloadsPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { rec, arr } from "@/lib/providers/gcp/read-kit";
import { gcpCall } from "@/lib/providers/gcp/rest";
import { IMAGE_DIGEST_ANNOTATION, BOOTSTRAP_SERVICE_IMAGE, BOOTSTRAP_JOB_IMAGE } from "@/lib/providers/gcp/drivers/compute/run-image";
import { context, workload, container, pinned, bounded, pause, get, select, RUN } from "./support";

export const TEMPLATE_KEYS = ["labels", "annotations", "scaling", "serviceAccount", "timeout", "maxRetries", "executionEnvironment", "encryptionKey", "maxInstanceRequestConcurrency", "vpcAccess", "volumes", "sessionAffinity", "containers", "nodeSelector"] as const;
const LATEST = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";
const routesLatest = (traffic: unknown) => {
  const targets = arr(traffic).map(rec).filter((t) => t.percent !== 0);
  return targets.length === 1 && targets[0].type === LATEST && targets[0].percent === 100;
};

export function createWorkloadsPort(): WorkloadsPort {
  return {
    async deployImage(raw, node, image, _opts) {
      const ctx = context(raw); pinned(image.uri, image.digest);
      const found = await workload(ctx, node);
      const current = container(found.template);
      const built = rec(node.spec.artifact).type === "built";
      const record = node.kind === "scheduled_job" ? rec(found.obj.template) : found.template;
      const recorded = !built || rec(record.annotations)[IMAGE_DIGEST_ANNOTATION] === image.digest;
      if (built && (!image.uri.startsWith(`${ctx.region}-docker.pkg.dev/${ctx.session.projectId}/`) || [BOOTSTRAP_SERVICE_IMAGE, BOOTSTRAP_JOB_IMAGE].includes(image.uri))) throw new StepFailedError("Built workload image must come from this GCP project and region's Artifact Registry.");
      const readyJob = found.obj.reconciling === false && rec(found.obj.terminalCondition).state === "CONDITION_SUCCEEDED" && typeof found.obj.generation === "string" && found.obj.generation === found.obj.observedGeneration;
      if (current.image === image.uri && recorded && (node.kind === "scheduled_job" ? readyJob : routesLatest(found.obj.traffic))) return { detail: "Cloud Run already targets the pinned image." };
      const template = { ...select(found.template, TEMPLATE_KEYS), containers: [{ ...current, image: image.uri }] };
      const outer = node.kind === "scheduled_job" ? { ...select(rec(found.obj.template), ["labels", "annotations", "parallelism", "taskCount"]), template } : template;
      if (built) Object.assign(outer, { annotations: { ...rec(record.annotations), [IMAGE_DIGEST_ANNOTATION]: image.digest } });
      const result = await gcpCall(ctx, "PATCH", `${RUN}/${found.name}?updateMask=${node.kind === "scheduled_job" ? "template" : "template,traffic"}`, { name: found.name, template: outer, ...(node.kind === "container_service" ? { traffic: [{ type: LATEST, percent: 100 }] } : {}), ...(typeof found.obj.etag === "string" ? { etag: found.obj.etag } : {}) });
      if (result.outcome !== "ok") throw new Error("Cloud Run image update was not confirmed; reconcile its outcome.");
      if (result.json.error) throw new StepFailedError("Cloud Run image update failed.");
      // Execution has no waitSteady phase for scheduled jobs. Confirm the job
      // definition here; this does not start a scheduled execution.
      if (node.kind === "scheduled_job") {
        const wait = bounded(ctx, 60_000);
        for (;;) {
          const observed = await workload(wait.ctx, node);
          if (rec(observed.obj.terminalCondition).state === "CONDITION_FAILED") throw new StepFailedError("Cloud Run job image update failed.");
          if (observed.obj.reconciling === false && rec(observed.obj.terminalCondition).state === "CONDITION_SUCCEEDED" && typeof observed.obj.generation === "string" && observed.obj.generation === observed.obj.observedGeneration && container(observed.template).image === image.uri && (!built || rec(rec(observed.obj.template).annotations)[IMAGE_DIGEST_ANNOTATION] === image.digest)) break;
          if (Date.now() >= wait.deadline) throw new Error("Cloud Run job image update timed out; outcome is unknown.");
          await pause(wait.ctx, wait.deadline);
        }
      }
      return { detail: "Cloud Run accepted the digest-pinned workload update." };
    },
    async waitSteady(raw, node, opts) {
      const original = context(raw); const wait = bounded(original, opts.timeoutMs);
      try {
        for (;;) {
          const found = await workload(wait.ctx, node);
          if (node.kind !== "container_service") throw new StepFailedError("Only Cloud Run services have a steady revision.");
          const target = container(found.template).image;
          if (typeof target !== "string") throw new Error("Cloud Run target image is unknown.");
          pinned(target);
          if (rec(node.spec.artifact).type === "built" && ([BOOTSTRAP_SERVICE_IMAGE, BOOTSTRAP_JOB_IMAGE].includes(target) || rec(found.template.annotations)[IMAGE_DIGEST_ANNOTATION] !== target.split("@")[1])) return { steady: false, detail: "Built Cloud Run workload has no matching released image digest record." };
          const terminal = rec(found.obj.terminalCondition);
          const conditions = arr(found.obj.conditions).map(rec);
          if (terminal.state === "CONDITION_FAILED" || conditions.some((c) => c.state === "CONDITION_FAILED")) return { steady: false, detail: "Cloud Run reported a failed rollout." };
          const latest = found.obj.latestCreatedRevision;
          const base = `projects/${wait.ctx.session.projectId}/locations/${wait.ctx.region}/services/${found.name.split("/").pop()}/revisions/`;
          const generation = found.obj.generation; const observed = found.obj.observedGeneration;
          if (terminal.state === "CONDITION_SUCCEEDED" && found.obj.reconciling === false && typeof generation === "string" && /^\d+$/.test(generation) && typeof observed === "string" && /^\d+$/.test(observed) && BigInt(observed) >= BigInt(generation) && typeof latest === "string" && latest === found.obj.latestReadyRevision && latest.startsWith(base) && /^[a-z0-9-]+$/.test(latest.slice(base.length))) {
            const revision = await get(wait.ctx, `${RUN}/${latest}`);
            if (revision.name !== latest || container(revision).image !== target) return { steady: false, detail: "Ready revision does not match the pinned target image." };
            const serving = arr(found.obj.trafficStatuses).map(rec).filter((t) => t.percent !== 0);
            if (serving.length === 1 && serving[0].percent === 100 && [latest, latest.split("/").pop()].includes(String(serving[0].revision))) return { steady: true, detail: "The digest-pinned Cloud Run revision is ready." };
          }
          if (Date.now() >= wait.deadline) return { steady: false, detail: "Cloud Run rollout timed out; readiness is unknown." };
          await pause(wait.ctx, wait.deadline);
        }
      } catch (e) {
        original.signal.throwIfAborted();
        if (wait.timeout.aborted) return { steady: false, detail: "Cloud Run rollout timed out; readiness is unknown." };
        throw e;
      }
    },
  };
}
