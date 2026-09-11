/**
 * The activation scorecard, computed from a synthetic cohort.
 *
 * The fixture below is built so that every exclusion and every "unknown" has
 * something to catch: a founder and a test actor who both do real-looking
 * work, a builder who writes in their own app, a colleague who converts and
 * comes back in days 7-13, a newcomer whose cohort is too young to judge, and
 * someone who accepted an invitation and never wrote anything.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-events-scorecard-");
process.env.ZENITH_EVENTS_SALT = "scorecard-salt";
const FOUNDER = "99999999-9999-4999-8999-999999999999";
const TESTER = "88888888-8888-4888-8888-888888888888";
process.env.ZENITH_FOUNDER_SUBJECTS = FOUNDER;
process.env.ZENITH_TEST_SUBJECTS = TESTER;

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { scorecard, subjectHash } = await import("@/lib/hosted/events");
const { seedApp } = await import("../backup/_ops-fixtures");

const a = openAuthority();

const BUILDER = "11111111-1111-4111-8111-111111111111";
const COLLEAGUE = "22222222-2222-4222-8222-222222222222";
const NEWCOMER = "33333333-3333-4333-8333-333333333333";
const LURKER = "44444444-4444-4444-8444-444444444444";

const app = await seedApp(a, { slug: "score-app", workspaceId: "ws-score", createdBy: BUILDER });

const DAY = 24 * 60 * 60_000;
const NOW = Date.now();
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

type Actor = "founder" | "test" | "external" | "system";

/** Append one synthetic event with an exact timestamp and actor class. */
async function event(
  name: Parameters<typeof scorecard> extends never ? never : string,
  opts: {
    subject?: string;
    actorClass?: Actor;
    ts: string;
    logicalId?: string;
    outcome?: "ok" | "error" | "denied";
    assisted?: boolean;
    appId?: string;
  }
): Promise<void> {
  await a.tx(async (repos) =>
    repos.events.append({
      id: randomUUID(),
      event: name as "record.created",
      workspaceId: "ws-score",
      appId: opts.appId ?? app.id,
      subjectHash: opts.subject ? await subjectHash(opts.subject) : undefined,
      outcome: opts.outcome ?? "ok",
      logicalId: opts.logicalId,
      assisted: opts.assisted ?? false,
      actorClass: opts.actorClass ?? (opts.subject ? "external" : "system"),
      ts: opts.ts,
    })
  );
}

/* The cohort. */
// Four invitations went out; three were accepted.
for (const n of [1, 2, 3, 4]) await event("invite.sent", { subject: BUILDER, ts: at(25 * DAY), logicalId: `invite-${n}` });
await event("invite.accepted", { subject: COLLEAGUE, ts: at(20 * DAY + 5 * 60_000) });
await event("invite.accepted", { subject: NEWCOMER, ts: at(3 * DAY + 2 * 60_000) });
await event("invite.accepted", { subject: LURKER, ts: at(10 * DAY) });

// The colleague writes on day 0 of their cohort and again on day 7.
await event("record.created", { subject: COLLEAGUE, ts: at(20 * DAY) });
await event("record.updated", { subject: COLLEAGUE, ts: at(13 * DAY) });
// The newcomer writes two minutes after accepting; their cohort is 3 days old.
await event("record.created", { subject: NEWCOMER, ts: at(3 * DAY) });
// The builder's own writes in their own app never activate it.
await event("record.created", { subject: BUILDER, ts: at(21 * DAY) });
// Founder and test actors do the same work and are excluded from all of it.
await event("record.created", { subject: FOUNDER, actorClass: "founder", ts: at(5 * DAY) });
await event("record.updated", { subject: TESTER, actorClass: "test", ts: at(5 * DAY), assisted: true });

// Four publish jobs started, three reached an active release.
for (const n of [1, 2, 3, 4]) await event("build.started", { subject: BUILDER, ts: at(24 * DAY), logicalId: `job-${n}` });
for (const n of [1, 2, 3]) await event("release.activated", { subject: BUILDER, ts: at(24 * DAY), logicalId: `job-${n}` });
// A test actor's publish is excluded from the rate entirely.
await event("build.started", { subject: TESTER, actorClass: "test", ts: at(24 * DAY), logicalId: "job-test" });

afterAll(async () => {
  closeAuthority();
  removeDir(dataDir);
});

const card = () => scorecard({ since: at(60 * DAY), until: new Date(NOW).toISOString() });

describe("scorecard", () => {
  it("counts a workspace as activated only for a write by someone other than the builder", async () => {
    const metric = (await card()).metrics.teamActivation;
    expect(metric.unknown).toBe(false);
    expect(metric.value).toBe(1);
    expect(metric.n).toBe(1);
    // The builder's own write, the founder's and the tester's do not qualify.
    expect(metric.detail.qualifyingWrites).toBe(3);
    expect(metric.definition).toMatch(/differs from the hash of that app's creator/);
  });

  it("reports publish success as activated jobs over started jobs, excluding test actors", async () => {
    const metric = (await card()).metrics.publishSuccess;
    expect(metric.detail).toMatchObject({ started: 4, activated: 3 });
    expect(metric.value).toBeCloseTo(0.75, 10);
    expect(metric.n).toBe(4);
  });

  it("measures recipient conversion against invitations sent, not delivered", async () => {
    const metric = (await card()).metrics.recipientConversion;
    expect(metric.detail).toMatchObject({ sent: 4, accepted: 3, useful: 2 });
    expect(metric.value).toBeCloseTo(0.5, 10);
    expect(metric.definition).toMatch(/delivery is not verified/);
  });

  it("takes the median time from acceptance to a first write", async () => {
    const metric = (await card()).metrics.timeToUsefulAction;
    // Five minutes and two minutes; the median of two is their mean.
    expect(metric.value).toBe(3.5 * 60_000);
    expect(metric.n).toBe(2);
    expect(metric.detail).toMatchObject({ accepted: 3, acted: 2, minMs: 2 * 60_000, maxMs: 5 * 60_000 });
  });

  it("judges next-week return only on cohorts old enough to have had one", async () => {
    const metric = (await card()).metrics.nextWeekReturn;
    expect(metric.detail).toMatchObject({ cohort: 1, immature: 1, returned: 1 });
    expect(metric.value).toBe(1);
    expect(metric.n).toBe(1);
  });

  it("says unknown, with a reason, when every cohort is too young", async () => {
    // A window whose end is right after the newcomer's only write: nobody in
    // it has had the chance to come back.
    const young = await scorecard({ since: at(4 * DAY), until: at(3 * DAY - 60_000) });
    const metric = young.metrics.nextWeekReturn;
    expect(metric.unknown).toBe(true);
    expect(metric.value).toBeNull();
    expect(metric.n).toBe(0);
    expect(metric.reason).toMatch(/younger than 14 days/);
    expect(metric.detail).toMatchObject({ immature: 1 });
  });

  it("counts founder assistance and admits the minutes are not instrumented", async () => {
    const metric = (await card()).metrics.founderAssistance;
    expect(metric.value).toBe(1);
    expect(metric.detail.minutes).toBe("unknown");
    expect(metric.definition).toMatch(/minutes spent are not instrumented/);
  });

  it("reports how many events each class of actor contributed", async () => {
    const actors = (await card()).actors;
    expect(actors.founder).toBe(1);
    expect(actors.test).toBe(2);
    expect(actors.external).toBeGreaterThan(0);
    expect(actors.system).toBe(0);
  });

  it("reports every per-person measure as unknown when there is no salt", async () => {
    const salt = process.env.ZENITH_EVENTS_SALT;
    delete process.env.ZENITH_EVENTS_SALT;
    try {
      const unsalted = await card();
      expect(unsalted.salted).toBe(false);
      for (const id of ["teamActivation", "recipientConversion", "timeToUsefulAction", "nextWeekReturn"] as const) {
        expect(unsalted.metrics[id].unknown).toBe(true);
        expect(unsalted.metrics[id].value).toBeNull();
        expect(unsalted.metrics[id].reason).toMatch(/ZENITH_EVENTS_SALT/);
      }
      // Publish success does not depend on knowing who anybody is.
      expect(unsalted.metrics.publishSuccess.unknown).toBe(false);
      expect(unsalted.limitations.join(" ")).toMatch(/ZENITH_EVENTS_SALT is unset/);
    } finally {
      process.env.ZENITH_EVENTS_SALT = salt;
    }
  });

  it("says unknown rather than zero for a window with nothing in it", async () => {
    const empty = await scorecard({ since: at(59 * DAY), until: at(58 * DAY) });
    expect(empty.events).toBe(0);
    expect(empty.metrics.publishSuccess.unknown).toBe(true);
    expect(empty.metrics.publishSuccess.reason).toMatch(/No build was started/);
    expect(empty.metrics.recipientConversion.unknown).toBe(true);
    expect(empty.metrics.founderAssistance.unknown).toBe(true);
    // Team activation is not unknown: a workspace with an app exists, and none
    // of them activated in this window.
    expect(empty.metrics.teamActivation.value).toBe(0);
  });

  it("states what it cannot answer", async () => {
    const limitations = (await card()).limitations.join(" ");
    expect(limitations).toMatch(/minutes a founder actually spent are not instrumented/);
    expect(limitations).toMatch(/not mailbox delivery/);
  });
});
