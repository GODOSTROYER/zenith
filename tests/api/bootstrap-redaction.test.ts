/**
 * Bootstrap must not ship credentials.
 *
 * `db().settings` is a shared untyped bag: alert channels keep webhook HMAC
 * secrets and raw Slack incoming-webhook URLs in it, and invites keep every
 * workspace's pending-invite emails. Bootstrap once spread that bag wholesale,
 * so the first call every signed-in browser makes handed back live credentials
 * belonging to workspaces the caller was not even a member of.
 *
 * These tests drive the real route handler with a constructed NextRequest — the
 * same way tests/api/project-stream.test.ts does — and judge the *serialized*
 * response, because a leak is whatever reaches the wire. Stringifying the whole
 * body and searching for the secret catches a regression anywhere in the
 * payload, including a field nobody thought to look at.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { AlertChannel, Invite, Workspace } from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-bootstrap-redaction-"));
const { db, resetDb } = await import("@/lib/db/store");
const { GET } = await import("@/app/api/bootstrap/route");

/**
 * Distinctive on purpose: every assertion below is a substring search over the
 * whole response, so these strings must not be able to collide with anything
 * the payload legitimately contains.
 */
const WEBHOOK_SECRET = "hmac-k3y-must-never-ship-9d2f41";
const WEBHOOK_TOKEN = "tok-webhook-path-secret-77af";
const WEBHOOK_TARGET = `https://hooks.example.com/ingest/${WEBHOOK_TOKEN}?sig=1`;
const SLACK_TOKEN = "T00000000/B00000000/xoxb-slack-bearer-in-a-url";
const SLACK_TARGET = `https://hooks.slack.com/services/${SLACK_TOKEN}`;
/** A channel belonging to a workspace the caller is not in. */
const OTHER_SECRET = "other-workspace-hmac-key-5b1c";
const OTHER_TARGET = "https://hooks.slack.com/services/T99999999/B99999999/xoxb-not-yours";
/** Cross-workspace PII that also lived in the same bag. */
const OTHER_INVITE_EMAIL = "pending-invitee@other-tenant.example";

const channel = (over: Partial<AlertChannel>): AlertChannel =>
  ({
    id: "ch",
    workspaceId: "ws1",
    kind: "webhook",
    name: "#ops",
    target: WEBHOOK_TARGET,
    enabled: true,
    createdBy: { type: "user", id: "u1", name: "You" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as AlertChannel;

beforeEach(() => {
  resetDb({
    // ws1 sorts first, so it is the workspace the demo caller resolves into.
    workspaces: [
      { id: "ws1", name: "One", slug: "one" },
      { id: "ws2", name: "Two", slug: "two" },
    ] as Workspace[],
    settings: {
      // Not the "approve" that readAutonomy() falls back to, so the assertion
      // below proves the stored level is really read and not just defaulted.
      autonomy: "bounded",
      alertChannels: [
        channel({ id: "ch-webhook", kind: "webhook", secret: WEBHOOK_SECRET }),
        channel({ id: "ch-slack", kind: "slack", name: "#deploys", target: SLACK_TARGET }),
        // Same store, different tenant: bootstrap must not know this exists.
        channel({
          id: "ch-other",
          workspaceId: "ws2",
          kind: "slack",
          name: "#theirs",
          target: OTHER_TARGET,
          secret: OTHER_SECRET,
        }),
      ] as AlertChannel[],
      invites: [
        {
          id: "inv1",
          workspaceId: "ws2",
          email: OTHER_INVITE_EMAIL,
          role: "editor",
          createdBy: "m1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ] as Invite[],
    },
  });
});

interface Body {
  settings: { autonomy: string; alertChannels: Record<string, unknown>[] };
}

/** The response as the browser gets it: parsed body plus the exact bytes. */
async function read(): Promise<{ body: Body; raw: string }> {
  const response = await GET(new NextRequest("http://localhost/api/bootstrap"), {
    params: Promise.resolve({}),
  });
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { body: JSON.parse(raw) as Body, raw };
}

/** Every property name in the payload, however deeply nested. */
function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, found);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysOf(v, found);
    }
  return found;
}

describe("GET /api/bootstrap redaction", () => {
  it("ships no webhook signing secret anywhere in the response", async () => {
    const { raw } = await read();
    // Guard against a vacuous pass. Every assertion here is "the secret is not
    // in the response", which a seeding change that quietly emptied the channel
    // list would also satisfy — so first prove the credential really is sitting
    // in the store the route just read. Absent below therefore means redacted,
    // not never-there.
    const stored = (db().settings as { alertChannels: AlertChannel[] }).alertChannels;
    expect(stored.map((c) => c.secret)).toContain(WEBHOOK_SECRET);
    expect(stored.map((c) => c.target)).toContain(SLACK_TARGET);

    expect(raw).not.toContain(WEBHOOK_SECRET);
    expect(raw).not.toContain(OTHER_SECRET);
    // Not just absent by name — absent as a field. `hasSecret` is the only
    // thing the browser is told about a signing key.
    expect(keysOf(JSON.parse(raw))).not.toContain("secret");
  });

  it("ships no raw channel target — the credential-bearing part is masked off", async () => {
    const { raw } = await read();
    expect(raw).not.toContain(SLACK_TARGET);
    expect(raw).not.toContain(SLACK_TOKEN);
    expect(raw).not.toContain(WEBHOOK_TARGET);
    expect(raw).not.toContain(WEBHOOK_TOKEN);
  });

  it("still describes the channels it redacted, so Settings can render them", async () => {
    const { body } = await read();
    expect(body.settings.alertChannels).toEqual([
      expect.objectContaining({
        id: "ch-webhook",
        kind: "webhook",
        hasSecret: true,
        target: "https://hooks.example.com/…",
      }),
      expect.objectContaining({
        id: "ch-slack",
        kind: "slack",
        hasSecret: false,
        target: "https://hooks.slack.com/…",
      }),
    ]);
  });

  it("scopes channels to the caller's workspace", async () => {
    const { body, raw } = await read();
    expect(body.settings.alertChannels.map((c) => c.id)).toEqual(["ch-webhook", "ch-slack"]);
    expect(raw).not.toContain("ch-other");
    expect(raw).not.toContain("#theirs");
  });

  it("does not spread the rest of the settings bag, so cross-tenant invites stay put", async () => {
    const { body, raw } = await read();
    expect(raw).not.toContain(OTHER_INVITE_EMAIL);
    expect(Object.keys(body.settings).sort()).toEqual(["alertChannels", "autonomy"]);
  });

  it("keeps autonomy, the one setting the shell actually reads", async () => {
    const { body } = await read();
    expect(body.settings.autonomy).toBe("bounded");
  });
});
