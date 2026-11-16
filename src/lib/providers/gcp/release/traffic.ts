/**
 * Cloud Run weighted traffic for progressive release (PROD-LIFE-10) and the serving-digest readback.
 *
 * `stageCandidate` creates the candidate revision while pinning 100% of traffic to the revision
 * that serves now (a plain `deployImage` would route 100% to LATEST). `setTrafficPercent` splits
 * traffic between the candidate and the previous revision; 100 routes to LATEST again, which is
 * the state `deployImage` and `waitSteady` already understand. Only services have traffic.
 * Contract-tested against synthetic REST, not live-verified.
 */
import type { ProgressiveWorkloadsPort, WorkloadsPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { progressiveUnsupportedReason } from "@/lib/release-safety/rollout";
import { arr, rec } from "@/lib/providers/gcp/read-kit";
import { gcpCall } from "@/lib/providers/gcp/rest";
import { IMAGE_DIGEST_ANNOTATION } from "@/lib/providers/gcp/drivers/compute/run-image";
import { bounded, container, context, get, pause, pinned, RUN, select, workload } from "./support";
import { TEMPLATE_KEYS } from "./workloads";

const LATEST = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";
const REVISION = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION";
const shortName = (rev: unknown): string => String(rev).split("/").pop() ?? "";

/** The one revision serving all traffic now, from observed status (never from the spec alone). */
function servingRevision(obj: Record<string, unknown>): string | undefined {
  const live = arr(obj.trafficStatuses).map(rec).filter((t) => t.percent !== 0);
  if (live.length === 1 && live[0].percent === 100 && live[0].revision) return shortName(live[0].revision);
  return undefined;
}

export function createGcpProgressivePort(): ProgressiveWorkloadsPort {
  return {
    async support(_raw, node) {
      if (node.kind !== "container_service") return { supported: false, reason: progressiveUnsupportedReason("gcp", node.kind) };
      return { supported: true };
    },

    async stageCandidate(raw, node, image) {
      const ctx = context(raw);
      pinned(image.uri, image.digest);
      if (node.kind !== "container_service") throw new StepFailedError(progressiveUnsupportedReason("gcp", node.kind));
      const found = await workload(ctx, node);
      const current = container(found.template);
      const serving = servingRevision(found.obj);
      if (!serving) throw new StepFailedError("Cloud Run has no single serving revision to hold traffic on, so a candidate cannot be staged safely.");
      const latest = typeof found.obj.latestCreatedRevision === "string" ? found.obj.latestCreatedRevision : undefined;
      if (current.image === image.uri && latest && shortName(latest) !== serving) return { detail: "The candidate revision is already staged." };
      const built = rec(node.spec.artifact).type === "built";
      const template = { ...select(found.template, TEMPLATE_KEYS), containers: [{ ...current, image: image.uri }] };
      if (built) Object.assign(template, { annotations: { ...rec(found.template.annotations), [IMAGE_DIGEST_ANNOTATION]: image.digest } });
      const result = await gcpCall(ctx, "PATCH", `${RUN}/${found.name}?updateMask=template,traffic`, {
        name: found.name,
        template,
        traffic: [{ type: REVISION, revision: serving, percent: 100 }],
        ...(typeof found.obj.etag === "string" ? { etag: found.obj.etag } : {}),
      });
      if (result.outcome !== "ok") throw new Error("Cloud Run candidate staging was not confirmed; reconcile its outcome.");
      if (result.json.error) throw new StepFailedError("Cloud Run candidate staging failed.");
      return { detail: "Cloud Run accepted the candidate revision with traffic held on the serving revision." };
    },

    async setTrafficPercent(raw, node, input) {
      const original = context(raw);
      if (!Number.isInteger(input.percent) || input.percent < 1 || input.percent > 100) throw new StepFailedError("A traffic percentage is a whole number from 1 to 100.");
      pinned(`${original.region}-docker.pkg.dev/x/y@${input.candidateDigest}`, input.candidateDigest);
      if (node.kind !== "container_service") throw new StepFailedError(progressiveUnsupportedReason("gcp", node.kind));
      const wait = bounded(original, 120_000);
      const ctx = wait.ctx;
      const found = await workload(ctx, node);
      const latest = found.obj.latestCreatedRevision;
      if (typeof latest !== "string" || latest !== found.obj.latestReadyRevision) throw new StepFailedError("The candidate revision is not ready, so traffic was not shifted.");
      const revision = await get(ctx, `${RUN}/${latest}`);
      const image = container(revision).image;
      if (revision.name !== latest || typeof image !== "string" || !image.endsWith(`@${input.candidateDigest}`)) throw new StepFailedError("The ready revision is not the bound candidate digest, so traffic was not shifted.");
      const candidate = shortName(latest);

      let traffic: Record<string, unknown>[];
      if (input.percent === 100) traffic = [{ type: LATEST, percent: 100 }];
      else {
        const baseline = arr(found.obj.trafficStatuses).map(rec).filter((t) => t.percent !== 0 && shortName(t.revision) !== candidate).sort((a, b) => Number(b.percent) - Number(a.percent))[0];
        if (!baseline?.revision) throw new StepFailedError("Cloud Run has no previous revision to keep serving the remaining traffic.");
        traffic = [{ type: REVISION, revision: candidate, percent: input.percent }, { type: REVISION, revision: shortName(baseline.revision), percent: 100 - input.percent }];
      }
      const result = await gcpCall(ctx, "PATCH", `${RUN}/${found.name}?updateMask=traffic`, { name: found.name, traffic, ...(typeof found.obj.etag === "string" ? { etag: found.obj.etag } : {}) });
      if (result.outcome !== "ok") throw new Error("Cloud Run traffic update was not confirmed; reconcile its outcome.");
      if (result.json.error) throw new StepFailedError("Cloud Run traffic update failed.");

      for (;;) {
        const observed = await workload(ctx, node);
        const share = arr(observed.obj.trafficStatuses).map(rec).filter((t) => shortName(t.revision) === candidate).reduce((n, t) => n + Number(t.percent ?? 0), 0);
        if (share === input.percent) return { observedPercent: share, detail: `Cloud Run reports ${share}% of traffic on the candidate.` };
        if (Date.now() >= wait.deadline) throw new Error("Cloud Run traffic shift was not observed in time; its outcome is unknown.");
        await pause(ctx, wait.deadline);
      }
    },

    async abort(raw, node, input) {
      const ctx = context(raw);
      if (node.kind !== "container_service") throw new StepFailedError(progressiveUnsupportedReason("gcp", node.kind));
      const found = await workload(ctx, node);
      const latest = typeof found.obj.latestCreatedRevision === "string" ? shortName(found.obj.latestCreatedRevision) : undefined;
      const statuses = arr(found.obj.trafficStatuses).map(rec).filter((t) => t.percent !== 0);
      const baseline = statuses.filter((t) => shortName(t.revision) !== latest).sort((a, b) => Number(b.percent) - Number(a.percent))[0];
      if (!baseline?.revision) {
        // Nothing but the candidate is serving: there is no previous revision to return traffic to.
        throw new StepFailedError(`No previous revision is serving, so traffic for ${input.candidateDigest.slice(0, 19)} cannot be returned automatically.`);
      }
      const result = await gcpCall(ctx, "PATCH", `${RUN}/${found.name}?updateMask=traffic`, { name: found.name, traffic: [{ type: REVISION, revision: shortName(baseline.revision), percent: 100 }], ...(typeof found.obj.etag === "string" ? { etag: found.obj.etag } : {}) });
      if (result.outcome !== "ok") throw new Error("Cloud Run traffic abort was not confirmed; reconcile its outcome.");
      if (result.json.error) throw new StepFailedError("Cloud Run traffic abort failed.");
      return { detail: "All traffic was returned to the previously serving revision. Data was not touched." };
    },
  };
}

/** What Cloud Run says it is serving: the digest of the revision holding all traffic. */
export function createGcpReadServing(): NonNullable<WorkloadsPort["readServing"]> {
  return async (raw, node) => {
    const ctx = context(raw);
    const found = await workload(ctx, node);
    if (node.kind === "scheduled_job") {
      const image = container(found.template).image;
      const ready = found.obj.reconciling === false && rec(found.obj.terminalCondition).state === "CONDITION_SUCCEEDED";
      return { supported: true, digest: typeof image === "string" ? image.split("@")[1] : undefined, steady: ready };
    }
    const serving = servingRevision(found.obj);
    if (!serving) return { supported: true, steady: false, detail: "Cloud Run is not serving a single revision." };
    const revision = await get(ctx, `${RUN}/projects/${ctx.session.projectId}/locations/${ctx.region}/services/${found.name.split("/").pop()}/revisions/${serving}`);
    const image = container(revision).image;
    const steady = found.obj.reconciling === false && rec(found.obj.terminalCondition).state === "CONDITION_SUCCEEDED";
    return { supported: true, digest: typeof image === "string" ? image.split("@")[1] : undefined, steady };
  };
}
