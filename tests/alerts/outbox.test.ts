/**
 * The alert outbox: the part that survives the process.
 *
 * `tests/alerts/delivery.test.ts` proves the bytes on the wire. This file
 * proves the thing a webhook receiver cannot see — that Zenith.ai does not lose a
 * notification when it dies, and does not silently send one twice.
 *
 * Every crash here is simulated the only honest way: the state file is captured
 * at the exact moment of interest, the in-memory store and the delivery globals
 * are dropped, and the file is put back. What survives is what was on disk, so
 * a test that passes because the object was still in memory cannot pass here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AlertChannel,
  AlertRule,
  Deployment,
  Environment,
  Manifest,
  Project,
  Revision,
  Workspace,
} from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-outbox-"));
// Collapses the delivery backoff, the same knob that collapses step durations.
process.env.ORRERY_FAST = "1";

const STATE = path.join(process.env.ORRERY_DATA, "state.json");

const { db, flush, resetDb } = await import("@/lib/db/store");
const {
  IDEMPOTENCY_HEADER,
  OUTBOX_LEASE_MS,
  SIGNATURE_HEADER,
  channelTable,
  evaluateAll,
  flushDeliveries,
  idempotencyKeyFor,
  reclaimStale,
  replayOutbox,
} = await import("@/lib/alerts");

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const actor = { type: "user" as const, id: "local", name: "You" };

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
        author: actor,
        createdAt: ago(30),
      } as Revision,
    ],
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
        actor,
        createdAt: ago(20),
        endedAt: ago(20),
      } as unknown as Deployment,
    ],
  });
}

function channel(over: Partial<AlertChannel> = {}): AlertChannel {
  const c: AlertChannel = {
    id: over.id ?? "ch1",
    workspaceId: "ws1",
    kind: "webhook",
    name: "ops endpoint",
    target: "https://example.test/hooks/orrery",
    enabled: true,
    createdBy: actor,
    createdAt: ago(60),
    ...over,
  };
  channelTable().push(c);
  return c;
}

/** One health rule that fires against a `seed("degrade")` store. */
function rule(over: Partial<AlertRule> = {}): AlertRule {
  const r: AlertRule = {
    id: "rule1",
    projectId: "p1",
    environmentId: "env1",
    kind: "health_degraded",
    enabled: true,
    createdBy: actor,
    createdAt: ago(10),
    ...over,
  };
  db().alertRules.push(r);
  return r;
}

type Call = { url: string; init: RequestInit };

/**
 * A `fetch` that answers from a queue of statuses. `"hang"` never settles —
 * that is a send this process will never finish, which is the whole point of
 * the rows those tests look at.
 */
function stubFetch(answers: (number | Error | "hang")[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = answers[Math.min(i++, answers.length - 1)];
      if (next === "hang") return new Promise<Response>(() => {});
      if (next instanceof Error) throw next;
      return { ok: next >= 200 && next < 300, status: next } as Response;
    })
  );
  return calls;
}

const header = (call: Call, name: string): string | undefined =>
  (call.init.headers as Record<string, string>)[name];

const onDisk = () =>
  JSON.parse(fs.readFileSync(STATE, "utf8")) as ReturnType<typeof db>;

/** Let every queued microtask — the drain, and the send it starts — run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * What a restart looks like: nothing in memory, everything from disk. An
 * optional snapshot rewinds the file to an earlier moment, which is how a crash
 * *at* that moment is reproduced.
 */
function restart(snapshot?: string): void {
  flush(); // no debounced write may land after the "crash"
  if (snapshot !== undefined) fs.writeFileSync(STATE, snapshot, "utf8");
  const g = globalThis as Record<string, unknown>;
  delete g.__orreryDb;
  delete g.__orreryDeliveryInFlight;
  delete g.__orreryDeliveryScheduled;
}

beforeEach(() => {
  // A hung send from the previous test must not be awaited by this one.
  const g = globalThis as Record<string, unknown>;
  delete g.__orreryDeliveryInFlight;
  delete g.__orreryDeliveryScheduled;
  seed("degrade");
});
afterEach(() => vi.unstubAllGlobals());

/* --------------------------------- intent --------------------------------- */

describe("intent is durable before anything is sent", () => {
  it("writes one outbox row per channel in the same save as the event", async () => {
    channel({ id: "a" });
    channel({ id: "b", kind: "slack", target: "https://hooks.slack.com/services/T/B/x" });
    rule();
    const calls = stubFetch(["hang"]);

    expect(evaluateAll(NOW)).toBe(1);
    // Nothing awaited in between: this is the evaluator's own save, and it must
    // already carry both the open event and the intent to tell somebody.
    flush();

    const saved = onDisk();
    expect(calls).toHaveLength(0); // not one byte has left yet
    expect(saved.alertEvents).toHaveLength(1);
    const eventId = saved.alertEvents[0].id;
    expect(saved.alertOutbox).toHaveLength(2);
    expect(saved.alertOutbox.map((r) => r.channelId).sort()).toEqual(["a", "b"]);
    for (const row of saved.alertOutbox) {
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.eventId).toBe(eventId);
      expect(row.transition).toBe("fired");
      expect(row.workspaceId).toBe("ws1");
      expect(row.idempotencyKey).toBe(idempotencyKeyFor(eventId, "fired", row.channelId));
      expect(row.settledAt).toBeUndefined();
    }

    // And the claim is durable too: `sending` reaches disk before the send.
    await tick();
    expect(calls).toHaveLength(2);
    for (const row of onDisk().alertOutbox) {
      expect(row.status).toBe("sending");
      expect(row.claimedAt).toBeTruthy();
    }
  });

  it("does not queue a second intent for a transition already queued", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    // A second pass over the same firing rule finds the event already open, so
    // nothing new is queued — and even a re-entrant enqueue is keyed out.
    evaluateAll(NOW + 1_000);
    flush();
    expect(onDisk().alertOutbox).toHaveLength(1);
  });

  it("`[]` channelIds still means deliver nowhere, durably", async () => {
    channel({ id: "a" });
    rule({ channelIds: [] });
    const calls = stubFetch([200]);

    expect(evaluateAll(NOW)).toBe(1);
    flush();
    // No row: there is nothing to deliver, so nothing may be replayed later.
    expect(onDisk().alertOutbox).toEqual([]);
    // `[]` — "Zenith.ai tried and had nowhere to send" — not `undefined`.
    expect(onDisk().alertEvents[0].deliveries).toEqual([]);

    await flushDeliveries();
    expect(calls).toHaveLength(0);
    restart();
    expect(db().alertEvents[0].deliveries).toEqual([]);
  });
});

/* --------------------------------- replay --------------------------------- */

describe("a crash does not lose the notification", () => {
  it("replays a row that was still pending when the process died", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    flush();
    const pending = fs.readFileSync(STATE, "utf8");
    expect(JSON.parse(pending).alertOutbox[0].status).toBe("pending");
    await tick(); // the send starts and never comes back

    // Rewind to the instant after the evaluator's save: the event is open, the
    // intent is recorded, and nothing has been sent.
    restart(pending);
    expect(db().alertEvents[0].resolvedAt).toBeUndefined();
    expect(db().alertOutbox[0].status).toBe("pending");

    const calls = stubFetch([200]);
    expect(await replayOutbox()).toBe(1);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body as string).event).toBe("alert.fired");
    const row = onDisk().alertOutbox[0];
    expect(row.status).toBe("delivered");
    expect(row.settledAt).toBeTruthy();
    expect(row.attempts).toBe(1);
    // The honest per-event log the Observe and Settings screens read.
    expect(onDisk().alertEvents[0].deliveries).toHaveLength(1);
    expect(onDisk().alertEvents[0].deliveries?.[0]).toMatchObject({ channelId: "a", ok: true });
  });

  it("retries a send that was never settled, under the same idempotency key", async () => {
    channel({ id: "a", secret: "hunter2" });
    rule();

    // The receiver got attempt 1; the settle never reached disk. Capturing the
    // state file from inside `fetch` is exactly that moment.
    let midSend = "";
    const first: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        first.push({ url, init });
        if (!midSend) midSend = fs.readFileSync(STATE, "utf8");
        return { ok: true, status: 200 } as Response;
      })
    );

    evaluateAll(NOW);
    await flushDeliveries();
    expect(first).toHaveLength(1);
    const key = header(first[0], IDEMPOTENCY_HEADER);
    expect(key).toBe(idempotencyKeyFor(db().alertEvents[0].id, "fired", "a"));
    // The key travels next to the signature, not instead of it.
    expect(header(first[0], SIGNATURE_HEADER)).toMatch(/^sha256=/);
    expect(JSON.parse(midSend).alertOutbox[0].status).toBe("sending");

    // Crash after the send, before the settle. The claim is seconds old, and
    // boot reclaims it anyway: `claimDataDir` has just proved nobody else can
    // be holding it.
    restart(midSend);
    const second = stubFetch([200]);
    expect(await replayOutbox()).toBe(1);

    expect(second).toHaveLength(1);
    expect(header(second[0], IDEMPOTENCY_HEADER)).toBe(key);
    expect(header(second[0], SIGNATURE_HEADER)).toMatch(/^sha256=/);
    expect(onDisk().alertOutbox[0].status).toBe("delivered");
    // One record of one transition, not two — the duplicate is the receiver's
    // to drop, and the key is what lets it.
    expect(onDisk().alertEvents[0].deliveries).toHaveLength(1);
  });

  it("reclaims a claim older than the lease and leaves a live one alone", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    await tick();
    const row = db().alertOutbox[0];
    expect(row.status).toBe("sending");
    expect(row.claimedAt).toBeTruthy();

    // Inside the lease: this row may still be in flight, so it is not stolen.
    expect(reclaimStale(OUTBOX_LEASE_MS)).toBe(0);
    expect(db().alertOutbox[0].status).toBe("sending");

    row.claimedAt = new Date(Date.now() - OUTBOX_LEASE_MS - 1_000).toISOString();
    expect(reclaimStale(OUTBOX_LEASE_MS)).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.claimedAt).toBeUndefined();
    // Reclaiming is itself durable: the next boot must not re-decide it.
    expect(onDisk().alertOutbox[0].status).toBe("pending");
  });

  it("replays the close, so a receiver's open alert does not stick", async () => {
    // Healthy store: the open event below closes on the first pass.
    seed();
    channel({ id: "a" });
    rule();
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
    stubFetch(["hang"]);

    expect(evaluateAll(NOW)).toBe(1);
    flush();
    const closed = fs.readFileSync(STATE, "utf8");
    expect(JSON.parse(closed).alertEvents[0].resolvedAt).toBeTruthy();
    expect(JSON.parse(closed).alertOutbox[0].transition).toBe("resolved");
    await tick();

    restart(closed);
    const calls = stubFetch([200]);
    await replayOutbox();
    expect(JSON.parse(calls[0].init.body as string).event).toBe("alert.resolved");
    expect(onDisk().alertOutbox[0].status).toBe("delivered");
  });
});

/* -------------------------------- outcomes -------------------------------- */

describe("terminal outcomes are persisted, not just logged", () => {
  it("keeps a permanent failure on the row and on the event", async () => {
    channel({ id: "a" });
    rule();
    const calls = stubFetch([404]);

    evaluateAll(NOW);
    await flushDeliveries();
    // A 4xx that is not 429 is a wrong URL, not a bad moment: one attempt.
    expect(calls).toHaveLength(1);

    restart(); // everything below is read back from the file
    const row = db().alertOutbox[0];
    expect(row.status).toBe("failed");
    expect(row.httpStatus).toBe(404);
    expect(row.attempts).toBe(1);
    expect(row.settledAt).toBeTruthy();
    expect(row.claimedAt).toBeUndefined();
    expect(row.error).toContain("Check the URL");
    const delivery = db().alertEvents[0].deliveries?.[0];
    expect(delivery).toMatchObject({ channelId: "a", ok: false, status: 404 });

    // A settled row is not re-driven: a wrong URL fails the same way forever.
    const later = stubFetch([200]);
    expect(await replayOutbox()).toBe(0);
    expect(later).toHaveLength(0);
  });

  it("records a retried failure with the attempts it made", async () => {
    channel({ id: "a" });
    rule();
    const calls = stubFetch([500]);

    evaluateAll(NOW);
    await flushDeliveries();
    expect(calls).toHaveLength(3);

    restart();
    const row = db().alertOutbox[0];
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(row.error).toContain("Tried 3 times");
    expect(db().alertEvents[0].deliveries?.[0].attempts).toBe(3);
  });

  it("settles honestly when the channel was deleted before the replay", async () => {
    channel({ id: "a" });
    rule();
    stubFetch(["hang"]);

    evaluateAll(NOW);
    flush();
    const pending = fs.readFileSync(STATE, "utf8");
    await tick();

    restart(pending);
    // The operator deleted the channel while the server was down.
    const settings = db().settings as { alertChannels?: AlertChannel[] };
    settings.alertChannels = [];
    const calls = stubFetch([200]);
    await replayOutbox();

    expect(calls).toHaveLength(0);
    const row = onDisk().alertOutbox[0];
    expect(row.status).toBe("failed");
    expect(row.error).toContain("was deleted before this alert could be sent");
    expect(onDisk().alertEvents[0].deliveries).toHaveLength(1);
  });
});
