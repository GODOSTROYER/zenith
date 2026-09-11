/**
 * Recording an event: pseudonymous, classified, deduplicated, and unable to
 * break the request it was recorded from.
 */
import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-events-record-");
process.env.ZENITH_EVENTS_SALT = "test-salt-not-a-secret";
process.env.ZENITH_FOUNDER_SUBJECTS = "99999999-9999-4999-8999-999999999999";
process.env.ZENITH_TEST_SUBJECTS = "88888888-8888-4888-8888-888888888888";

const { closeAuthority, openAuthority, sqliteConnection } = await import("@/lib/hosted/authority");
const { actorClassOf, eventsSalted, listEvents, recordEvent, subjectHash } = await import(
  "@/lib/hosted/events"
);
const { seedApp } = await import("../backup/_ops-fixtures");

let a = openAuthority();
const app = await seedApp(a, { slug: "events-app", workspaceId: "ws-events" });

const FOUNDER = "99999999-9999-4999-8999-999999999999";
const TEST_SUBJECT = "88888888-8888-4888-8888-888888888888";
const PERSON = "12345678-1234-4123-8123-123456789012";

afterAll(async () => {
  closeAuthority();
  removeDir(dataDir);
});

beforeEach(async () => {
  sqliteConnection(a).exec("DELETE FROM hosted_events");
  process.env.ZENITH_EVENTS_SALT = "test-salt-not-a-secret";
});

describe("recordEvent", () => {
  it("stores an HMAC of the subject and never the subject itself", async () => {
    expect(await recordEvent({ event: "app.opened", workspaceId: "ws-events", appId: app.id, subject: PERSON })).toBe(true);

    const [event] = await listEvents({ workspaceId: "ws-events" });
    const expected = createHmac("sha256", "test-salt-not-a-secret").update(PERSON, "utf8").digest("hex");
    expect(event.subjectHash).toBe(expected);
    expect(event.subjectHash).not.toBe(PERSON);
    expect(await subjectHash(PERSON)).toBe(expected);

    // Nothing anywhere in the row is the subject, the email or a plain hash of
    // either — the salt is what stops a copy of the database being reversed.
    const row = JSON.stringify(event);
    expect(row).not.toContain(PERSON);
    expect(row).not.toContain("@");
  });

  it("omits the hash entirely when no salt is configured", async () => {
    delete process.env.ZENITH_EVENTS_SALT;
    expect(await eventsSalted()).toBe(false);
    expect(await subjectHash(PERSON)).toBeUndefined();

    await recordEvent({ event: "app.opened", workspaceId: "ws-events", appId: app.id, subject: PERSON });
    const [event] = await listEvents({ workspaceId: "ws-events" });
    expect(event.subjectHash).toBeUndefined();
    // Still recorded: the class of actor does not depend on the salt.
    expect(event.actorClass).toBe("external");
  });

  it("classifies founder, test, external and system actors", async () => {
    expect(await actorClassOf(FOUNDER)).toBe("founder");
    expect(await actorClassOf(TEST_SUBJECT)).toBe("test");
    expect(await actorClassOf(PERSON, "someone@example.test")).toBe("test");
    expect(await actorClassOf(PERSON, "someone@zenith.test")).toBe("test");
    expect(await actorClassOf(PERSON, "someone@acme.com")).toBe("external");
    expect(await actorClassOf(PERSON)).toBe("external");
    expect(await actorClassOf(undefined)).toBe("system");
    // A founder with a test address is still a founder.
    expect(await actorClassOf(FOUNDER, "founder@example.test")).toBe("founder");
  });

  it("records the class it computed, not one the caller asserted", async () => {
    await recordEvent({ event: "record.created", workspaceId: "ws-events", appId: app.id, subject: FOUNDER });
    await recordEvent({
      event: "record.updated",
      workspaceId: "ws-events",
      appId: app.id,
      subject: PERSON,
      email: "tester@example.test",
    });
    await recordEvent({ event: "backup.completed", workspaceId: "ws-events" });

    // Three rows written in the same millisecond tie on `ts` and are ordered
    // by their random ids, so this asserts the set rather than the sequence.
    const classes = (await listEvents({ workspaceId: "ws-events" })).map(
      (event) => `${event.event}:${event.actorClass}`
    );
    expect(classes.sort()).toEqual([
      "backup.completed:system",
      "record.created:founder",
      "record.updated:test",
    ]);
  });

  it("records one row per logical operation, however many times it is retried", async () => {
    const input = {
      event: "release.activated" as const,
      workspaceId: "ws-events",
      appId: app.id,
      logicalId: "job-42",
      subject: PERSON,
    };
    expect(await recordEvent(input)).toBe(true);
    expect(await recordEvent(input)).toBe(false);
    expect(await recordEvent({ ...input, outcome: "error" })).toBe(false);
    expect(await listEvents({ workspaceId: "ws-events" })).toHaveLength(1);

    // A different event name with the same logical id is a different operation.
    expect(await recordEvent({ ...input, event: "build.started" })).toBe(true);
    expect(await listEvents({ workspaceId: "ws-events" })).toHaveLength(2);
  });

  it("records every row when there is no logical id to dedupe on", async () => {
    for (let n = 0; n < 3; n++)
      await recordEvent({ event: "app.opened", workspaceId: "ws-events", appId: app.id, subject: PERSON });
    expect(await listEvents({ workspaceId: "ws-events" })).toHaveLength(3);
  });

  it("refuses an event name the contract does not define, without throwing", async () => {
    expect(
      await recordEvent({
        event: "totally.invented" as unknown as "app.opened",
        workspaceId: "ws-events",
      })
    ).toBe(false);
    expect(await listEvents({ workspaceId: "ws-events" })).toHaveLength(0);
  });

  it("never throws into the request that recorded it", async () => {
    closeAuthority();
    try {
      // No authority at all: the worst case a request path can hand it.
      expect(() => recordEvent({ event: "app.opened", workspaceId: "ws-events" })).not.toThrow();
      expect(await recordEvent({ event: "app.opened", workspaceId: "ws-events" })).toBe(false);
    } finally {
      a = openAuthority();
    }
  });

  it("carries the release id and small content-free props", async () => {
    await recordEvent({
      event: "record.created",
      workspaceId: "ws-events",
      appId: app.id,
      subject: PERSON,
      releaseId: "rel-7",
      assisted: true,
      props: { bytes: 412, status: "requested" },
    });
    const [event] = await listEvents({ workspaceId: "ws-events" });
    expect(event.releaseId).toBe("rel-7");
    expect(event.assisted).toBe(true);
    expect(event.props).toEqual({ bytes: 412, status: "requested" });
  });
});

describe("listEvents", () => {
  it("filters by app and by event, oldest first, bounded by the limit", async () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    await recordEvent({ event: "app.opened", workspaceId: "ws-events", appId: app.id, subject: PERSON, ts: older });
    await recordEvent({ event: "record.created", workspaceId: "ws-events", appId: app.id, subject: PERSON });
    await recordEvent({ event: "app.opened", workspaceId: "ws-events", appId: "other-app", subject: PERSON });

    expect((await listEvents({ appId: app.id })).map((event) => event.event)).toEqual(["app.opened", "record.created"]);
    expect(await listEvents({ appId: app.id, event: "record.created" })).toHaveLength(1);
    expect(await listEvents({ workspaceId: "ws-events", limit: 1 })).toHaveLength(1);
  });
});
