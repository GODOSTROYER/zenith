/**
 * Alert delivery: the part that leaves the browser.
 *
 * `fetch` is stubbed throughout — these tests prove the bytes Zenith.ai would put
 * on the wire and what it does with the answer, not that a webhook endpoint
 * exists. The two things a reviewer should be able to check here are the
 * signature (computed over the exact posted body, independently recomputed in
 * the test) and the honesty of a failure: three attempts, then a recorded
 * result with a reason, never a silent drop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AlertChannel,
  Deployment,
  Environment,
  Manifest,
  Project,
  Revision,
  Workspace,
} from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-delivery-"));
// Collapses the delivery backoff, the same knob that collapses step durations.
process.env.ORRERY_FAST = "1";

const { db, resetDb } = await import("@/lib/db/store");
const {
  DELIVERY_ATTEMPTS,
  MISSING_NODEMAILER,
  NODEMAILER,
  SIGNATURE_HEADER,
  channelTable,
  channelsForRule,
  deliverToChannel,
  evaluateAll,
  flushDeliveries,
  maskTarget,
  publicChannels,
  sign,
  slackBody,
  webhookBody,
} = await import("@/lib/alerts");
const { runAction } = await import("@/lib/actions/core");
const { registerAllActions } = await import("@/lib/actions/defs");

registerAllActions();

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const ctx = {
  workspaceId: "ws1",
  projectId: "p1",
  environmentId: "env1",
  actor: { type: "user" as const, id: "local", name: "You" },
};

const manifest = (chaos?: string): Manifest => ({
  version: 1,
  services: [
    {
      id: "svc-api",
      name: "api",
      kind: "web",
      source: { type: "image", image: "nginx" },
      size: "small",
      replicas: 2,
      port: 3000,
      env: chaos ? [{ key: "ORRERY_CHAOS", value: chaos }] : [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

/** A workspace with one project, one environment and one deployed revision. */
function seed(chaos?: string) {
  const m = manifest(chaos);
  resetDb({
    workspaces: [
      { id: "ws1", name: "Atlas", slug: "atlas", createdAt: ago(500) } as unknown as Workspace,
    ],
    projects: [
      {
        id: "p1",
        workspaceId: "ws1",
        name: "atlas",
        slug: "atlas",
        workingManifest: m,
        createdAt: ago(500),
        origin: { type: "blank" },
      } as Project,
    ],
    environments: [
      {
        id: "env1",
        projectId: "p1",
        name: "sandbox",
        class: "sandbox",
        connectionId: "c1",
        region: "local",
        deployedRevisionId: "rev1",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "test",
        createdAt: ago(500),
      } as unknown as Environment,
    ],
    revisions: [
      {
        id: "rev1",
        projectId: "p1",
        number: 1,
        manifest: m,
        message: "r1",
        author: ctx.actor,
        createdAt: ago(30),
      } as Revision,
    ],
    // Health is derived from the last deployment as well as the manifest, so a
    // store without one reads as degraded and every rule fires.
    deployments: [
      {
        id: "dep1",
        projectId: "p1",
        environmentId: "env1",
        revisionId: "rev1",
        status: "succeeded",
        steps: [],
        outputs: [],
        changeSummary: "first deploy",
        estCostDeltaUsd: 0,
        actor: ctx.actor,
        createdAt: ago(20),
        endedAt: ago(20),
      } as unknown as Deployment,
    ],
  });
}

/** A channel straight in the store — the action path is tested separately. */
function channel(over: Partial<AlertChannel> = {}): AlertChannel {
  const c: AlertChannel = {
    id: over.id ?? "ch1",
    workspaceId: "ws1",
    kind: "webhook",
    name: "ops endpoint",
    target: "https://example.test/hooks/orrery",
    enabled: true,
    createdBy: ctx.actor,
    createdAt: ago(60),
    ...over,
  };
  channelTable().push(c);
  return c;
}

const msg = {
  phase: "fired" as const,
  title: "api degraded in sandbox.",
  body: "api: one replica is failing its probe.",
  severity: "high" as const,
  simulated: true,
  eventId: "ev1",
  ruleId: "rule1",
  projectId: "p1",
  environmentId: "env1",
  firedAt: ago(1),
};

/** A `fetch` that records every call and answers from a queue of statuses. */
function stubFetch(statuses: (number | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = statuses[Math.min(i++, statuses.length - 1)];
      if (next instanceof Error) throw next;
      return { ok: next >= 200 && next < 300, status: next } as Response;
    })
  );
  return calls;
}

beforeEach(() => {
  seed();
  NODEMAILER.spec = "nodemailer";
  delete process.env.ORRERY_SMTP_URL;
  delete process.env.ORRERY_ALERT_FROM;
});
afterEach(() => vi.unstubAllGlobals());

/* -------------------------------- payloads -------------------------------- */

describe("what goes on the wire", () => {
  it("signs the exact bytes it posts, and only when a secret is set", async () => {
    const secret = "s3cret-shared-with-the-receiver";
    const signed = channel({ id: "ch-signed", secret });
    const calls = stubFetch([200]);

    const result = await deliverToChannel(signed, msg);
    expect(result.ok).toBe(true);

    const { init } = calls[0];
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    // Recomputed here rather than trusted: the header must match the body that
    // was actually sent, not the one the code meant to send.
    expect(headers[SIGNATURE_HEADER]).toBe(
      `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`
    );
    expect(sign(body, secret)).toBe(headers[SIGNATURE_HEADER]);
    expect(sign(body, "a different secret")).not.toBe(headers[SIGNATURE_HEADER]);

    const sent = JSON.parse(body) as { event: string; alert: Record<string, unknown> };
    expect(sent.event).toBe("alert.fired");
    expect(sent.alert.summary).toBe(msg.title);
    expect(sent.alert.severity).toBe("high");
    expect(sent.alert.simulated).toBe(true);

    // Same channel without a secret: no signature header at all.
    vi.unstubAllGlobals();
    const plainCalls = stubFetch([200]);
    await deliverToChannel(channel({ id: "ch-plain" }), msg);
    expect((plainCalls[0].init.headers as Record<string, string>)[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("sends Slack's own payload shape to a slack channel", async () => {
    const calls = stubFetch([200]);
    await deliverToChannel(
      channel({ id: "ch-slack", kind: "slack", target: "https://hooks.slack.com/services/T/B/x" }),
      msg
    );

    const body = JSON.parse(calls[0].init.body as string) as ReturnType<typeof slackBody>;
    expect(body).toEqual(slackBody(msg));
    expect(body.text).toContain("[Zenith.ai]");
    expect(body.text).toContain(msg.title);
    const blocks = body.blocks as { type: string; text?: { type: string; text: string } }[];
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text?.type).toBe("mrkdwn");
    expect(blocks[0].text?.text).toContain(msg.body);
    expect(blocks[1].type).toBe("context");
    // A Slack webhook URL is a credential: no signature, and never echoed.
    expect((calls[0].init.headers as Record<string, string>)[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("a resolved event says so in the payload both channels build", () => {
    const resolved = { ...msg, phase: "resolved" as const, resolvedReason: "api recovered." };
    expect(JSON.parse(webhookBody(resolved)).event).toBe("alert.resolved");
    expect(slackBody(resolved).text).toContain("Resolved");
  });
});

/* ------------------------------ retry / timeout ---------------------------- */

describe("retry, backoff and timeout", () => {
  it("retries a 503 and reports the attempt it succeeded on", async () => {
    const calls = stubFetch([503, 503, 200]);
    const result = await deliverToChannel(channel(), msg);
    expect(calls).toHaveLength(DELIVERY_ATTEMPTS);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("gives up after three attempts and records the reason", async () => {
    const calls = stubFetch([500]);
    const c = channel();
    const result = await deliverToChannel(c, msg);
    expect(calls).toHaveLength(DELIVERY_ATTEMPTS);
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toContain("answered 500");
    expect(result.error).toContain("Tried 3 times");
    // The channel carries the last outcome, which is what Settings shows.
    expect(c.lastDelivery?.ok).toBe(false);
  });

  it("does not retry a 404 — it names the fix and stops", async () => {
    const calls = stubFetch([404]);
    const result = await deliverToChannel(channel(), msg);
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("Check the URL");
  });

  it("passes a timeout signal and reports a timeout as one", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const calls = stubFetch([timeout]);
    const result = await deliverToChannel(channel(), msg);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls).toHaveLength(DELIVERY_ATTEMPTS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No response within 10s");
  });
});

/* -------------------------------- selection -------------------------------- */

describe("which channels a rule uses", () => {
  const rule = (channelIds?: string[]) => ({
    id: "rule1",
    projectId: "p1",
    environmentId: "env1",
    kind: "health_degraded" as const,
    enabled: true,
    channelIds,
    createdBy: ctx.actor,
    createdAt: ago(10),
  });

  it("defaults to every enabled channel, and never a disabled one", () => {
    channel({ id: "a" });
    channel({ id: "b", kind: "slack", target: "https://hooks.slack.com/services/T/B/x" });
    channel({ id: "off", enabled: false });

    expect(channelsForRule(rule()).map((c) => c.id)).toEqual(["a", "b"]);
    expect(channelsForRule(rule(["a"])).map((c) => c.id)).toEqual(["a"]);
    expect(channelsForRule(rule(["off"]))).toHaveLength(0);
    // An explicit empty selection is "deliver nowhere", not "deliver to all".
    expect(channelsForRule(rule([]))).toHaveLength(0);
  });

  it("masks a webhook URL past its host and never returns a secret", () => {
    channel({ id: "a", secret: "hunter2" });
    channel({ id: "m", kind: "email", target: "ops@example.com" });

    const [a, m] = publicChannels("ws1");
    expect(a.target).toBe("https://example.test/…");
    expect(a.hasSecret).toBe(true);
    expect(JSON.stringify(a)).not.toContain("hunter2");
    // An address is not a credential, so masking it would only hide the recipient.
    expect(m.target).toBe("ops@example.com");
    expect(maskTarget("slack", "https://hooks.slack.com/services/T/B/xyz")).toBe(
      "https://hooks.slack.com/…"
    );
  });
});

/* -------------------------------- the log ---------------------------------- */

describe("the delivery log on the event", () => {
  it("records a result per channel when a rule fires, without blocking evaluation", async () => {
    seed("degrade");
    channel({ id: "a" });
    channel({ id: "b", kind: "slack", target: "https://hooks.slack.com/services/T/B/x" });
    db().alertRules.push({
      id: "rule1",
      projectId: "p1",
      environmentId: "env1",
      kind: "health_degraded",
      enabled: true,
      createdBy: ctx.actor,
      createdAt: ago(10),
    });
    const calls = stubFetch([200]);

    expect(evaluateAll(NOW)).toBe(1);
    const event = db().alertEvents[0];
    // Evaluation returned before anything was sent — that is the whole point.
    expect(calls).toHaveLength(0);
    expect(event.deliveries).toBeUndefined();

    await flushDeliveries();
    expect(calls).toHaveLength(2);
    expect(event.deliveries?.map((d) => d.channelId).sort()).toEqual(["a", "b"]);
    expect(event.deliveries?.every((d) => d.ok)).toBe(true);
  });

  it("records an empty list when there is nowhere to send, not nothing", async () => {
    seed("degrade");
    db().alertRules.push({
      id: "rule1",
      projectId: "p1",
      environmentId: "env1",
      kind: "health_degraded",
      enabled: true,
      createdBy: ctx.actor,
      createdAt: ago(10),
    });
    stubFetch([200]);

    evaluateAll(NOW);
    await flushDeliveries();
    // `[]` is "Zenith.ai tried and had nowhere to send"; `undefined` would be
    // "this alert predates channels". The Observe screen says different things.
    expect(db().alertEvents[0].deliveries).toEqual([]);
  });

  it("delivers the close too, so a receiver's open alert does not stick", async () => {
    // Healthy: the rule's condition is false, so the open event below closes on
    // the first pass — which is the transition this test is about.
    channel({ id: "a" });
    const calls = stubFetch([200]);
    db().alertRules.push({
      id: "rule1",
      projectId: "p1",
      environmentId: "env1",
      kind: "health_degraded",
      enabled: true,
      createdBy: ctx.actor,
      createdAt: ago(10),
    });
    db().alertEvents.push({
      id: "ev-open",
      ruleId: "rule1",
      projectId: "p1",
      environmentId: "env1",
      firedAt: ago(5),
      summary: "api degraded in sandbox.",
      severity: "medium",
      detail: "…",
      simulated: true,
    });

    expect(evaluateAll(NOW)).toBe(1);
    await flushDeliveries();
    const closed = db().alertEvents.find((e) => e.id === "ev-open")!;
    expect(closed.resolvedAt).toBeTruthy();
    expect(JSON.parse(calls[0].init.body as string).event).toBe("alert.resolved");
    expect(closed.deliveries?.[0].ok).toBe(true);
  });
});

/* --------------------------------- actions --------------------------------- */

describe("channel actions", () => {
  it("plans, creates, tests, updates and deletes — saying where the secret lives", async () => {
    const calls = stubFetch([200]);

    const { plan } = await runAction(
      "alerts.createChannel",
      ctx,
      {
        kind: "webhook",
        name: "ops endpoint",
        target: "https://example.test/hooks/orrery",
        secret: "hunter2",
      },
      { mode: "plan" }
    );
    const details = plan!.details.join(" ");
    expect(plan!.blocked).toBeUndefined();
    expect(details).toContain("https://example.test/…"); // masked, even in the plan
    expect(details).toContain("X-Orrery-Signature");
    expect(details).toContain("plain text in this server's state file");
    expect(calls).toHaveLength(0); // planning sends nothing

    const created = await runAction(
      "alerts.createChannel",
      ctx,
      {
        kind: "webhook",
        name: "ops endpoint",
        target: "https://example.test/hooks/orrery",
        secret: "hunter2",
      },
      { mode: "execute" }
    );
    expect(created.result?.ok).toBe(true);
    const channelId = (created.result?.data as { channelId: string }).channelId;

    // The same target twice would deliver every alert twice.
    const dup = await runAction(
      "alerts.createChannel",
      ctx,
      { kind: "webhook", name: "again", target: "https://example.test/hooks/orrery" },
      { mode: "plan" }
    );
    expect(dup.plan?.blocked).toContain("already sends to this exact webhook target");

    // A target that cannot work is refused with the fix, before anything is sent.
    const bad = await runAction(
      "alerts.createChannel",
      ctx,
      { kind: "email", name: "ops", target: "not-an-address" },
      { mode: "plan" }
    );
    expect(bad.plan?.blocked).toContain("is not an email address");

    const tested = await runAction("alerts.testChannel", ctx, { channelId }, { mode: "execute" });
    expect(tested.result?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body as string).event).toBe("alert.test");
    expect(publicChannels("ws1")[0].lastDelivery?.ok).toBe(true);

    const off = await runAction(
      "alerts.updateChannel",
      ctx,
      { channelId, enabled: false },
      { mode: "execute" }
    );
    expect(off.result?.ok).toBe(true);
    expect(publicChannels("ws1")[0].enabled).toBe(false);

    // A rule that named this channel must not keep pointing at a deleted one.
    db().alertRules.push({
      id: "rule1",
      projectId: "p1",
      environmentId: "env1",
      kind: "health_degraded",
      enabled: true,
      channelIds: [channelId],
      createdBy: ctx.actor,
      createdAt: ago(10),
    });
    await runAction("alerts.deleteChannel", ctx, { channelId }, { mode: "execute" });
    expect(publicChannels("ws1")).toHaveLength(0);
    expect(db().alertRules[0].channelIds).toEqual([]);
  });

  it("a rule plan names the channels it will reach, and refuses one that does not exist", async () => {
    channel({ id: "a", name: "ops endpoint" });

    const { plan } = await runAction(
      "alerts.createRule",
      ctx,
      { environmentId: "env1", kind: "health_degraded" },
      { mode: "plan" }
    );
    expect(plan!.details.join(" ")).toContain("ops endpoint");

    const bad = await runAction(
      "alerts.createRule",
      ctx,
      { environmentId: "env1", kind: "deploy_failed", channelIds: ["nope"] },
      { mode: "plan" }
    );
    expect(bad.plan?.blocked).toContain("not a delivery channel");
  });

  it("says a workspace with no channels is on-screen only, in the plan itself", async () => {
    const { plan } = await runAction(
      "alerts.createRule",
      ctx,
      { environmentId: "env1", kind: "health_degraded" },
      { mode: "plan" }
    );
    expect(plan!.details.join(" ")).toContain("no delivery channels");
  });
});

/* ---------------------------------- email ---------------------------------- */

describe("email", () => {
  it("refuses honestly when nodemailer is not installed, naming npm install", async () => {
    process.env.ORRERY_SMTP_URL = "smtp://user:pass@smtp.example.test:587";
    process.env.ORRERY_ALERT_FROM = "orrery@example.test";
    // Point the loader at something that cannot resolve: the refusal must be
    // the same whether or not the package happens to be installed here.
    NODEMAILER.spec = "nodemailer-not-installed-on-purpose";

    const result = await deliverToChannel(
      channel({ id: "mail", kind: "email", target: "ops@example.test" }),
      msg
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MISSING_NODEMAILER);
    expect(result.error).toContain("npm install");
    // Not retried: an uninstalled package does not install itself.
    expect(result.attempts).toBe(1);
  });

  it("refuses with the variable to set when SMTP is not configured", async () => {
    const result = await deliverToChannel(
      channel({ id: "mail", kind: "email", target: "ops@example.test" }),
      msg
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ORRERY_SMTP_URL");
    expect(result.attempts).toBe(1);
  });

  it("sends through the transport when one is available", async () => {
    process.env.ORRERY_SMTP_URL = "smtp://user:pass@smtp.example.test:587";
    process.env.ORRERY_ALERT_FROM = "Zenith.ai <orrery@example.test>";
    const sent: Record<string, string>[] = [];
    // A stand-in for the package, resolved through the same seam a test uses to
    // prove the missing-package path. `vi.mock` cannot intercept a specifier
    // that does not resolve on disk.
    NODEMAILER.spec = new URL("./fake-nodemailer.mjs", import.meta.url).href;
    (globalThis as { __orreryFakeMail?: unknown[] }).__orreryFakeMail = sent;

    const result = await deliverToChannel(
      channel({ id: "mail", kind: "email", target: "ops@example.test" }),
      msg
    );
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ops@example.test");
    expect(sent[0].from).toBe("Zenith.ai <orrery@example.test>");
    expect(sent[0].subject).toContain(msg.title);
    expect(sent[0].text).toContain(msg.body);
  });
});
