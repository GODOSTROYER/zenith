/** Container Apps digest rollouts; readiness belongs to the target revision, never an older healthy one. Contract evidence only. */
import type { WorkloadsPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { digest } from "@/lib/controlplane/digest";
import { armClient } from "@/lib/providers/azure/arm";
import { API } from "@/lib/providers/azure/platform";
import { context, locate, workloadType, pinned, container, rec, select, bounded, pause } from "./support";

export const TEMPLATE_KEYS = ["containers", "initContainers", "scale", "volumes", "revisionSuffix", "terminationGracePeriodSeconds"] as const;

export function createWorkloadsPort(): WorkloadsPort {
  return {
    async deployImage(raw, node, image, opts) {
      const ctx = context(raw); pinned(image.uri, image.digest);
      if (!opts.idempotencyKey) throw new StepFailedError("Azure image rollout requires an idempotency key.");
      const res = await locate(ctx, node, workloadType(node));
      if (node.kind === "container_service" && rec(rec(res.properties).configuration).activeRevisionsMode !== "Single") throw new StepFailedError("Azure release requires Single revision mode before rollout.");
      const template = rec(rec(res.properties).template); const current = container(template);
      if (current.image === image.uri) return { detail: "Azure workload already targets the pinned image." };
      const next = { ...select(template, TEMPLATE_KEYS), containers: [{ ...current, image: image.uri }], ...(node.kind === "container_service" ? { revisionSuffix: `zn-${digest([ctx.workspaceId, ctx.environmentId, node.address, opts.idempotencyKey, image.digest]).slice(0, 32)}` } : {}) };
      try {
        await armClient(ctx.session, ctx.signal).patch(res.id, { apiVersion: API.containerApps, headers: res.etag ? { "if-match": res.etag } : undefined, body: { location: res.location, properties: { template: next } } });
      } catch { ctx.signal.throwIfAborted(); throw new Error("Azure image update was not confirmed; reconcile its outcome."); }
      if (node.kind === "scheduled_job") {
        const wait = bounded(ctx, 60_000);
        for (;;) {
          const job = await locate(wait.ctx, node, workloadType(node)); const props = rec(job.properties);
          if (props.provisioningState === "Failed" || props.provisioningState === "Canceled") throw new StepFailedError("Azure job image update failed.");
          if (props.provisioningState === "Succeeded" && container(rec(props.template)).image === image.uri) break;
          if (Date.now() >= wait.deadline) throw new Error("Azure job image update timed out; outcome is unknown.");
          await pause(wait.ctx, wait.deadline);
        }
      }
      return { detail: "Azure accepted the digest-pinned workload update." };
    },
    async waitSteady(raw, node, opts) {
      const original = context(raw); const wait = bounded(original, opts.timeoutMs); const ctx = wait.ctx;
      if (node.kind !== "container_service") throw new StepFailedError("Only Azure Container Apps have a steady revision.");
      try {
        for (;;) {
          const res = await locate(ctx, node, workloadType(node)); const props = rec(res.properties); const template = rec(props.template); const target = container(template);
          if (typeof target.image !== "string") throw new Error("Azure target image is unknown.");
          pinned(target.image);
          const configuration = rec(props.configuration);
          if (configuration.activeRevisionsMode !== "Single") return { steady: false, detail: "Azure revision routing is not in Single mode." };
          if (props.provisioningState === "Failed" || props.provisioningState === "Canceled") return { steady: false, detail: "Azure reported a failed rollout." };
          const latest = props.latestRevisionName;
          if (props.provisioningState === "Succeeded" && typeof latest === "string" && latest === props.latestReadyRevisionName && /^[a-z0-9-]{1,100}$/.test(latest) && (!template.revisionSuffix || latest.endsWith(`--${template.revisionSuffix}`))) {
            let rev;
            try { rev = (await armClient(ctx.session, ctx.signal).get(`${res.id}/revisions/${latest}`, { apiVersion: API.containerApps })).body; } catch { throw new Error("Azure target revision could not be read; readiness is unknown."); }
            if (rev.id !== `${res.id}/revisions/${latest}` || rev.name !== latest) throw new Error("Azure target revision identity is unknown.");
            const state = rec(rev.properties);
            if (container(rec(state.template)).image !== target.image) return { steady: false, detail: "Azure ready revision does not match the target digest." };
            if (["Failed", "Degraded", "Stopped"].includes(String(state.runningState)) || state.healthState === "Unhealthy" || state.provisioningState === "Failed") return { steady: false, detail: "Azure target revision is unhealthy." };
            const ingress = rec(configuration.ingress);
            const traffic = Array.isArray(ingress.traffic) ? ingress.traffic.map(rec).filter((t) => t.weight !== 0) : [];
            const routed = configuration.ingress === undefined || (traffic.length === 1 && traffic[0].weight === 100 && (traffic[0].latestRevision === true || traffic[0].revisionName === latest));
            if (routed && state.active === true && state.provisioningState === "Provisioned" && state.healthState === "Healthy" && state.runningState === "Running") return { steady: true, detail: "The digest-pinned Azure revision is healthy." };
          }
          if (Date.now() >= wait.deadline) return { steady: false, detail: "Azure rollout timed out; readiness is unknown." };
          await pause(ctx, wait.deadline);
        }
      } catch (e) { original.signal.throwIfAborted(); if (wait.timeout.aborted) return { steady: false, detail: "Azure rollout timed out; readiness is unknown." }; throw e; }
    },
  };
}
