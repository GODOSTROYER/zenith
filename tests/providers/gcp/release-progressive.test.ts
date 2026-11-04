/** PROD-LIFE-10 Cloud Run weighted traffic and serving-digest readback: synthetic REST only, never a live account. */
import { describe, expect, it } from "vitest";
import type { DriverContext } from "@/lib/drivers/types";
import { StepFailedError } from "@/lib/execution/errors";
import { createReleasePorts } from "@/lib/platform/release";
import { createGcpWorkloadsPort } from "@/lib/platform/release-gcp";
import { DIGEST, IMAGE, node, service, serviceName, revisionName, world } from "./release-fixtures";

const B = `sha256:${"b".repeat(64)}`;
const IMAGE_B = IMAGE.replace(DIGEST, B);
const rev3 = `${serviceName}/revisions/zenith-env-1-web-00003`;
const short = (name: string) => name.split("/").pop()!;
const REVISION = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION";
const LATEST = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";

/** A world whose candidate revision (00003) exists and whose traffic statuses follow PATCHed traffic. */
function canaryWorld() {
  const w = world();
  w.state.service.latestCreatedRevision = rev3;
  w.state.service.latestReadyRevision = rev3;
  w.state.before = (u, init) => {
    const path = decodeURIComponent(u.pathname);
    if (path.endsWith("00003")) return w.json({ name: rev3, containers: [{ name: "web", image: IMAGE_B }] });
    if (init?.method === "PATCH" && path.endsWith("/services/zenith-env-1-web")) {
      const body = JSON.parse(String(init.body)) as { traffic?: { type: string; revision?: string; percent: number }[]; template?: unknown };
      if (body.traffic && !body.template) w.state.service.trafficStatuses = body.traffic.map((t) => ({ revision: t.type === LATEST ? short(rev3) : t.revision, percent: t.percent }));
    }
    return undefined;
  };
  return w;
}

const patches = (w: ReturnType<typeof world>) => w.fetcher.mock.calls.filter(([u, i]) => u.includes("run.googleapis.com") && i?.method === "PATCH").map(([u, i]) => ({ url: u, body: JSON.parse(String(i?.body)) as Record<string, unknown> }));

describe("capability", () => {
  it("only Cloud Run services have traffic to split", async () => {
    const w = world();
    const port = createGcpWorkloadsPort().progressive!;
    expect(await port.support(w.ctx, service)).toEqual({ supported: true });
    const job = await port.support(w.ctx, node("scheduled_job/cron", "scheduled_job"));
    expect(job.supported).toBe(false);
    expect(job.reason).toMatch(/scheduled jobs/);
  });

  it.each(["aws", "azure", "kubernetes", "oci"] as const)("%s refuses progressive rollout explicitly, with a reason, through the composed ports", async (provider) => {
    const ctx = { provider, session: { provider }, signal: new AbortController().signal } as unknown as DriverContext;
    const ports = createReleasePorts().workloads;
    const target = { ...service, provider };
    const support = await ports.progressive!.support(ctx, target);
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/rolling release/);
    await expect(ports.progressive!.stageCandidate(ctx, target, { uri: IMAGE, digest: DIGEST }, { idempotencyKey: "k" })).rejects.toBeInstanceOf(StepFailedError);
    await expect(ports.progressive!.setTrafficPercent(ctx, target, { candidateDigest: DIGEST, percent: 10, idempotencyKey: "k" })).rejects.toBeInstanceOf(StepFailedError);
    await expect(ports.progressive!.abort(ctx, target, { candidateDigest: DIGEST })).rejects.toBeInstanceOf(StepFailedError);
  });

  it("the composed gcp ports report support from the Cloud Run adapter", async () => {
    const w = world();
    expect(await createReleasePorts().workloads.progressive!.support(w.ctx, service)).toEqual({ supported: true });
  });
});

describe("serving readback", () => {
  it("reads the digest of the revision holding all traffic", async () => {
    const w = world();
    expect(await createGcpWorkloadsPort().readServing!(w.ctx, service)).toEqual({ supported: true, digest: DIGEST, steady: true });
  });
  it("reports a different digest when the serving revision runs another image", async () => {
    const w = world();
    (w.state.revision.containers as { image: string }[])[0].image = IMAGE_B;
    expect(await createGcpWorkloadsPort().readServing!(w.ctx, service)).toMatchObject({ supported: true, digest: B });
  });
  it("is not steady, and names no digest, while traffic is split", async () => {
    const w = world();
    w.state.service.trafficStatuses = [{ revision: short(revisionName), percent: 90 }, { revision: short(rev3), percent: 10 }];
    const read = await createGcpWorkloadsPort().readServing!(w.ctx, service);
    expect(read.supported).toBe(true);
    expect(read.steady).toBe(false);
    expect(read.digest).toBeUndefined();
  });
});

describe("candidate staging holds traffic", () => {
  it("creates the candidate revision while pinning all traffic to the serving revision, never to LATEST", async () => {
    const w = world();
    await createGcpWorkloadsPort().progressive!.stageCandidate(w.ctx, service, { uri: IMAGE_B, digest: B }, { idempotencyKey: "k" });
    const [patch] = patches(w);
    expect(patch.url).toContain("updateMask=template,traffic");
    expect(patch.body.traffic).toEqual([{ type: REVISION, revision: short(revisionName), percent: 100 }]);
    const template = patch.body.template as { containers: { image: string }[]; annotations?: Record<string, string> };
    expect(template.containers[0].image).toBe(IMAGE_B);
    expect(Object.values(template.annotations ?? {})).toContain(B);
  });
  it("refuses to stage when no single revision is serving", async () => {
    const w = world();
    w.state.service.trafficStatuses = [{ revision: short(revisionName), percent: 50 }, { revision: short(rev3), percent: 50 }];
    await expect(createGcpWorkloadsPort().progressive!.stageCandidate(w.ctx, service, { uri: IMAGE_B, digest: B }, { idempotencyKey: "k" })).rejects.toThrow(/no single serving revision/);
    expect(patches(w)).toHaveLength(0);
  });
  it("refuses an image that is not pinned to its digest", async () => {
    const w = world();
    await expect(createGcpWorkloadsPort().progressive!.stageCandidate(w.ctx, service, { uri: IMAGE_B.replace(`@${B}`, ":latest"), digest: B }, { idempotencyKey: "k" })).rejects.toThrow(/pinned/);
  });
});

describe("traffic percentage", () => {
  it("splits traffic between the candidate and the serving revision, then routes 100% to latest", async () => {
    const w = canaryWorld();
    const port = createGcpWorkloadsPort().progressive!;
    expect(await port.setTrafficPercent(w.ctx, service, { candidateDigest: B, percent: 10, idempotencyKey: "k1" })).toMatchObject({ observedPercent: 10 });
    expect(patches(w)[0].body.traffic).toEqual([{ type: REVISION, revision: short(rev3), percent: 10 }, { type: REVISION, revision: short(revisionName), percent: 90 }]);
    expect(patches(w)[0].url).toContain("updateMask=traffic");
    expect(await port.setTrafficPercent(w.ctx, service, { candidateDigest: B, percent: 100, idempotencyKey: "k2" })).toMatchObject({ observedPercent: 100 });
    expect(patches(w)[1].body.traffic).toEqual([{ type: LATEST, percent: 100 }]);
  });
  it("does not shift traffic to a revision that is not ready or is not the bound digest", async () => {
    const notReady = canaryWorld();
    notReady.state.service.latestReadyRevision = revisionName;
    await expect(createGcpWorkloadsPort().progressive!.setTrafficPercent(notReady.ctx, service, { candidateDigest: B, percent: 10, idempotencyKey: "k" })).rejects.toThrow(/not ready/);
    expect(patches(notReady)).toHaveLength(0);
    const wrong = canaryWorld();
    await expect(createGcpWorkloadsPort().progressive!.setTrafficPercent(wrong.ctx, service, { candidateDigest: `sha256:${"c".repeat(64)}`, percent: 10, idempotencyKey: "k" })).rejects.toThrow(/not the bound candidate digest/);
    expect(patches(wrong)).toHaveLength(0);
  });
  it.each([0, 101, 1.5])("rejects the percentage %s", async (percent) => {
    const w = canaryWorld();
    await expect(createGcpWorkloadsPort().progressive!.setTrafficPercent(w.ctx, service, { candidateDigest: B, percent, idempotencyKey: "k" })).rejects.toThrow(/whole number/);
  });
  it("reports an unconfirmed provider update as an unknown outcome, not success", async () => {
    const w = canaryWorld();
    const hook = w.state.before!;
    w.state.before = (u, init) => (init?.method === "PATCH" ? w.json({ error: { message: "opaque-secret-sentinel" } }, 500) : hook(u, init));
    const err = await createGcpWorkloadsPort().progressive!.setTrafficPercent(w.ctx, service, { candidateDigest: B, percent: 10, idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("opaque-secret-sentinel");
  });
});

describe("abort returns traffic to the previous revision", () => {
  it("puts all traffic back on the revision that was serving", async () => {
    const w = canaryWorld();
    w.state.service.trafficStatuses = [{ revision: short(rev3), percent: 10 }, { revision: short(revisionName), percent: 90 }];
    await createGcpWorkloadsPort().progressive!.abort(w.ctx, service, { candidateDigest: B });
    expect(patches(w)[0].body).toMatchObject({ traffic: [{ type: REVISION, revision: short(revisionName), percent: 100 }] });
  });
  it("refuses when nothing but the candidate is serving", async () => {
    const w = canaryWorld();
    w.state.service.trafficStatuses = [{ revision: short(rev3), percent: 100 }];
    await expect(createGcpWorkloadsPort().progressive!.abort(w.ctx, service, { candidateDigest: B })).rejects.toThrow(/No previous revision/);
    expect(patches(w)).toHaveLength(0);
  });
});

