/**
 * Findings, alerts and delivery channels: an id from one workspace is worth
 * nothing in another.
 *
 * Same property as tests/actions/workspace-isolation.test.ts, on the three
 * objects that file does not reach — and two of them are worse than a leak:
 *
 *  - A SecurityFinding carries a stored `fix`: an action id and its input,
 *    including that input's own projectId. `security.resolveFinding` runs it.
 *    A global finding lookup therefore makes Zenith a confused deputy — A's
 *    session, A's role check, B's project mutated. So the proof here is not
 *    that an error was thrown: it is that B's manifest and B's findings are
 *    byte-identical after the refused execute to what they were before it.
 *  - An AlertChannel is where a workspace's alerts go and `secret` is what
 *    signs them. `alerts.updateChannel` rewrites both, so a global channel
 *    lookup is a one-call redirect of someone else's alert traffic to an
 *    endpoint the caller owns. The assertion is on `target` and `secret`.
 *
 * The second property matters as much as the first: a foreign id must read
 * exactly like an id that was never real. A refusal that says "you don't have
 * access" confirms the object exists and makes the id space enumerable across
 * tenants, so every case below is compared against the same call with pure
 * nonsense in place of the id, and the two sentences have to match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionContext } from "@/lib/actions/core";
import type {
  Actor,
  AlertChannel,
  AlertEvent,
  AlertRule,
  CloudConnection,
  Environment,
  Manifest,
  Member,
  Project,
  SecurityFinding,
  Workspace,
} from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-sec-alerts-isolation-"));
process.env.ORRERY_FAST = "1";

const { runAction } = await import("@/lib/actions/core");
const { db, resetDb } = await import("@/lib/db/store");
const { channelTable, scopedChannel, scopedEvent, scopedRule } = await import("@/lib/alerts");
const { registerAllActions } = await import("@/lib/actions/defs");

registerAllActions();

const AT = "2026-09-01T10:00:00.000Z";

/* --------------------------------- fixture -------------------------------- */

const wsA: Workspace = { id: "ws-a", name: "Kepler Labs", slug: "kepler", createdAt: AT };
const wsB: Workspace = { id: "ws-b", name: "Orbital", slug: "orbital", createdAt: AT };

const ada: Actor = { type: "user", id: "u-ada", name: "Ada" };
const bo: Actor = { type: "user", id: "u-bo", name: "Bo" };

const member = (id: string, workspaceId: string, name: string): Member => ({
  id,
  workspaceId,
  name,
  email: `${name.toLowerCase()}@orrery.test`,
  role: "admin",
});

/** One service and one plaintext route — the route is what the finding is about. */
const manifest = (suffix: string): Manifest => ({
  version: 1,
  services: [
    {
      id: `svc-${suffix}`,
      name: "api",
      kind: "web",
      source: { type: "image", image: "ghcr.io/orrery/hello-web:1" },
      size: "small",
      replicas: 1,
      port: 3000,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [{ id: `rt-${suffix}`, host: `${suffix}.orrery.app`, pathPrefix: "/", tls: false, managedDns: true }],
  bindings: [],
});

const connection = (id: string, workspaceId: string): CloudConnection => ({
  id,
  workspaceId,
  provider: "sandbox",
  label: "Sandbox",
  region: "sim-a",
  status: "healthy",
  grantedPermissions: [],
  createdAt: AT,
});

const project = (id: string, workspaceId: string, name: string, suffix: string): Project => ({
  id,
  workspaceId,
  name,
  slug: "atlas",
  workingManifest: manifest(suffix),
  origin: { type: "blank" },
  createdAt: AT,
});

const environment = (id: string, projectId: string, connectionId: string): Environment => ({
  id,
  projectId,
  name: "production",
  class: "production",
  connectionId,
  region: "sim-a",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: `${projectId}.orrery.app`,
  createdAt: AT,
});

/**
 * The scanner's real "route serves traffic without TLS" finding, whose fix
 * names its own project. That projectId inside `fix.input` is the confused
 * deputy: it is what runs if the finding itself was never scoped to the caller.
 */
const finding = (id: string, projectId: string, suffix: string): SecurityFinding => ({
  id,
  projectId,
  severity: "high",
  title: `${suffix}.orrery.app serves traffic without TLS`,
  detail: `Requests to ${suffix}.orrery.app travel as plaintext.`,
  targetId: `rt-${suffix}`,
  fix: {
    actionId: "system.updateRoute",
    input: { projectId, routeId: `rt-${suffix}`, tls: true },
    label: "Turn TLS on",
  },
  status: "open",
  createdAt: AT,
});

const rule = (id: string, projectId: string, environmentId: string): AlertRule => ({
  id,
  projectId,
  environmentId,
  kind: "budget_exceeded",
  threshold: 90,
  enabled: true,
  channelIds: [],
  createdBy: ada,
  createdAt: AT,
});

const event = (id: string, ruleId: string, projectId: string, environmentId: string): AlertEvent => ({
  id,
  ruleId,
  projectId,
  environmentId,
  firedAt: AT,
  summary: "production is at 120% of its budget.",
  severity: "medium",
  detail: "Priced from the working copy.",
  simulated: true,
});

const channel = (id: string, workspaceId: string, host: string): AlertChannel => ({
  id,
  workspaceId,
  kind: "webhook",
  name: "ops",
  target: `https://${host}/orrery`,
  secret: `signing-key-${id}`,
  enabled: true,
  createdBy: ada,
  createdAt: AT,
});

/**
 * Ada is an admin of A with no seat at all in B; Bo is an admin of B. Each
 * workspace gets a project, an environment, an open finding with a fix, an
 * alert rule, an open alert and an enabled webhook channel with a secret.
 */
function seedTwo() {
  resetDb({
    workspaces: [wsA, wsB],
    members: [member("u-ada", wsA.id, "Ada"), member("u-bo", wsB.id, "Bo")],
    connections: [connection("conn-a", wsA.id), connection("conn-b", wsB.id)],
    projects: [
      project("prj-a", wsA.id, "Kepler Atlas", "a"),
      project("prj-b", wsB.id, "Orbital Atlas", "b"),
    ],
    environments: [environment("env-a", "prj-a", "conn-a"), environment("env-b", "prj-b", "conn-b")],
    findings: [finding("find-a", "prj-a", "a"), finding("find-b", "prj-b", "b")],
    alertRules: [rule("rule-a", "prj-a", "env-a"), rule("rule-b", "prj-b", "env-b")],
    alertEvents: [
      event("evt-a", "rule-a", "prj-a", "env-a"),
      event("evt-b", "rule-b", "prj-b", "env-b"),
    ],
    settings: {
      alertChannels: [channel("chan-a", wsA.id, "kepler.example"), channel("chan-b", wsB.id, "orbital.example")],
    },
  });
}

/* --------------------------------- helpers -------------------------------- */

const ctx = (actor: Actor, workspaceId: string): ActionContext => ({ workspaceId, actor });

/** Ada, acting in her own workspace — where she really is an admin. */
const asAda = () => ctx(ada, wsA.id);
const asBo = () => ctx(bo, wsB.id);

const plan = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "plan" })).plan!;

const execute = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "execute" })).result!;

/** The exact sentences the scoped lookups produce. Absent and foreign share them. */
const notFound = {
  finding: (ref: string) =>
    `Finding "${ref}" was not found. Reload the Security page — it may already be resolved.`,
  rule: (ref: string) =>
    `Alert rule "${ref}" was not found. Reload Observe — someone may have deleted it.`,
  event: (ref: string) => `Alert "${ref}" was not found. Reload Observe — the alert list may have moved on.`,
  channel: (ref: string) =>
    `Delivery channel "${ref}" was not found. Reload Settings → Alerts — someone may have deleted it.`,
};

/**
 * Nothing in a refusal may hint that the object is real: no "access", no
 * workspace names, no object names, no endpoint. The id the caller already
 * typed is fine — they supplied it.
 */
function revealsNothing(message: string) {
  expect(message).not.toMatch(/access|permitt|permission|not allowed|forbidden|denied|belongs to/i);
  expect(message).not.toMatch(/another workspace|other workspace|different workspace/i);
  for (const secret of ["Orbital", "orbital", "Kepler", "kepler", "u-bo", "Bo", "signing-key"])
    expect(message).not.toContain(secret);
}

/** Everything of B's these actions can touch, as bytes. */
const snapshotB = () =>
  JSON.stringify({
    project: db().projects.find((p) => p.id === "prj-b"),
    findings: db().findings.filter((f) => f.projectId === "prj-b"),
    rules: db().alertRules.filter((r) => r.projectId === "prj-b"),
    events: db().alertEvents.filter((e) => e.projectId === "prj-b"),
    channels: channelTable().filter((c) => c.workspaceId === "ws-b"),
    outbox: db().alertOutbox,
  });

const channelB = () => channelTable().find((c) => c.id === "chan-b")!;

beforeEach(() => {
  seedTwo();
  // Nothing here should reach the network. If a refusal ever did deliver, this
  // is what would catch it.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("ok", { status: 200 }))
  );
});

afterEach(() => vi.unstubAllGlobals());

/* -------------------------------- findings -------------------------------- */

const FINDING_ACTIONS: { id: string; input: (findingId: string) => unknown }[] = [
  { id: "security.resolveFinding", input: (findingId) => ({ findingId }) },
  { id: "security.resolveFinding", input: (findingId) => ({ findingId, applyFix: false }) },
  { id: "security.dismissFinding", input: (findingId) => ({ findingId, reason: "not a problem" }) },
  { id: "security.reopenFinding", input: (findingId) => ({ findingId }) },
];

describe("an admin of A cannot reach B's security finding by id", () => {
  for (const [i, { id, input }] of FINDING_ACTIONS.entries()) {
    it(`${id} #${i} — plan is blocked with the not-found sentence`, async () => {
      const p = await plan(id, asAda(), input("find-b"));
      expect(p.blocked).toBe(notFound.finding("find-b"));
      expect(p.details[0]).toBe(p.blocked);
      revealsNothing(p.blocked!);
    });

    it(`${id} #${i} — execute refuses and B's finding is untouched`, async () => {
      const before = snapshotB();
      const r = await execute(id, asAda(), input("find-b"));
      expect(r.ok).toBe(false);
      expect(r.error).toBe(notFound.finding("find-b"));
      revealsNothing(r.error!);
      expect(snapshotB()).toBe(before);
    });

    it(`${id} #${i} — B's id reads exactly like an id that was never real`, async () => {
      const foreign = (await execute(id, asAda(), input("find-b"))).error!;
      const fiction = (await execute(id, asAda(), input("find-nope-000"))).error!;
      expect(foreign.replace("find-b", "REF")).toBe(fiction.replace("find-nope-000", "REF"));
    });
  }
});

describe("the confused deputy: B's stored fix does not run under A's session", () => {
  /**
   * The whole point of the finding fix. `find-b.fix` is
   * `system.updateRoute { projectId: "prj-b", routeId: "rt-b", tls: true }` —
   * a payload that names its own project and so needs nothing from Ada's
   * context to land. The assertion is the absence of the mutation, not the
   * presence of an error.
   */
  it("resolveFinding leaves B's manifest and findings byte-identical", async () => {
    const before = snapshotB();
    const route = () => db().projects.find((p) => p.id === "prj-b")!.workingManifest.routes[0];
    expect(route().tls).toBe(false);

    const r = await execute("security.resolveFinding", asAda(), { findingId: "find-b" });

    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.finding("find-b"));
    // The fix did not run: B's route is still plaintext…
    expect(route().tls).toBe(false);
    // …the finding is still open, unresolved and unattributed…
    const f = db().findings.find((x) => x.id === "find-b")!;
    expect(f.status).toBe("open");
    expect(f.resolvedBy).toBeUndefined();
    expect(f.resolvedAt).toBeUndefined();
    // …and nothing else of B's moved either.
    expect(snapshotB()).toBe(before);
  });

  /**
   * The other half, and the one that used to write straight through: with
   * `applyFix: false` there is no inner action to refuse the projectId, so the
   * finding row itself was the only thing between A's session and closing B's
   * high-severity finding.
   */
  it("resolveFinding with applyFix:false does not close B's finding", async () => {
    const before = snapshotB();
    const r = await execute("security.resolveFinding", asAda(), {
      findingId: "find-b",
      applyFix: false,
    });
    expect(r.ok).toBe(false);
    expect(db().findings.find((x) => x.id === "find-b")!.status).toBe("open");
    expect(snapshotB()).toBe(before);
  });

  it("dismissFinding does not write A's actor onto B's finding", async () => {
    const before = snapshotB();
    const r = await execute("security.dismissFinding", asAda(), {
      findingId: "find-b",
      reason: "accepted risk",
    });
    expect(r.ok).toBe(false);
    const f = db().findings.find((x) => x.id === "find-b")!;
    expect(f.status).toBe("open");
    expect(f.resolvedReason).toBeUndefined();
    expect(snapshotB()).toBe(before);
  });

  it("A's own finding still resolves, and B gains nothing from it", async () => {
    const beforeB = snapshotB();
    const r = await execute("security.resolveFinding", asAda(), { findingId: "find-a" });
    expect(r.ok).toBe(true);
    expect(db().projects.find((p) => p.id === "prj-a")!.workingManifest.routes[0].tls).toBe(true);
    // A working-copy fix is not yet true of the environment, and says so.
    expect(db().findings.find((x) => x.id === "find-a")!.status).toBe("fixed_pending_deploy");
    expect(snapshotB()).toBe(beforeB);
  });
});

/* ------------------------------ rules and alerts ---------------------------- */

const RULE_ACTIONS: { id: string; input: (ruleId: string) => unknown }[] = [
  { id: "alerts.updateRule", input: (ruleId) => ({ ruleId, enabled: false }) },
  { id: "alerts.updateRule", input: (ruleId) => ({ ruleId, threshold: 5 }) },
  { id: "alerts.deleteRule", input: (ruleId) => ({ ruleId }) },
];

describe("an admin of A cannot reach B's alert rule by id", () => {
  for (const [i, { id, input }] of RULE_ACTIONS.entries()) {
    it(`${id} #${i} — plan is blocked with the not-found sentence`, async () => {
      const p = await plan(id, asAda(), input("rule-b"));
      expect(p.blocked).toBe(notFound.rule("rule-b"));
      revealsNothing(p.blocked!);
    });

    it(`${id} #${i} — execute refuses and B's rule stays exactly as it was`, async () => {
      const before = snapshotB();
      const r = await execute(id, asAda(), input("rule-b"));
      expect(r.ok).toBe(false);
      expect(r.error).toBe(notFound.rule("rule-b"));
      revealsNothing(r.error!);
      expect(db().alertRules.map((x) => x.id)).toContain("rule-b");
      expect(snapshotB()).toBe(before);
    });

    it(`${id} #${i} — B's id reads exactly like an id that was never real`, async () => {
      const foreign = (await execute(id, asAda(), input("rule-b"))).error!;
      const fiction = (await execute(id, asAda(), input("rule-nope-000"))).error!;
      expect(foreign.replace("rule-b", "REF")).toBe(fiction.replace("rule-nope-000", "REF"));
    });
  }
});

describe("an admin of A cannot acknowledge B's alert", () => {
  it("plan is blocked with the not-found sentence", async () => {
    const p = await plan("alerts.acknowledge", asAda(), { eventId: "evt-b" });
    expect(p.blocked).toBe(notFound.event("evt-b"));
    revealsNothing(p.blocked!);
  });

  it("execute refuses and nobody is recorded as being on it", async () => {
    const before = snapshotB();
    const r = await execute("alerts.acknowledge", asAda(), { eventId: "evt-b", note: "mine now" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.event("evt-b"));
    revealsNothing(r.error!);
    const e = db().alertEvents.find((x) => x.id === "evt-b")!;
    expect(e.acknowledgedBy).toBeUndefined();
    expect(e.acknowledgedNote).toBeUndefined();
    expect(snapshotB()).toBe(before);
  });

  it("B's id reads exactly like an id that was never real", async () => {
    const foreign = (await execute("alerts.acknowledge", asAda(), { eventId: "evt-b" })).error!;
    const fiction = (await execute("alerts.acknowledge", asAda(), { eventId: "evt-nope-000" })).error!;
    expect(foreign.replace("evt-b", "REF")).toBe(fiction.replace("evt-nope-000", "REF"));
  });
});

/* -------------------------------- channels -------------------------------- */

const REDIRECT = {
  channelId: "chan-b",
  target: "https://attacker.example/collect",
  secret: "attacker-key",
  name: "ops",
};

const CHANNEL_ACTIONS: { id: string; input: (channelId: string) => unknown }[] = [
  { id: "alerts.updateChannel", input: (channelId) => ({ ...REDIRECT, channelId }) },
  { id: "alerts.deleteChannel", input: (channelId) => ({ channelId }) },
  { id: "alerts.testChannel", input: (channelId) => ({ channelId }) },
];

describe("an admin of A cannot reach B's delivery channel by id", () => {
  for (const { id, input } of CHANNEL_ACTIONS) {
    it(`${id} — plan is blocked with the not-found sentence`, async () => {
      const p = await plan(id, asAda(), input("chan-b"));
      expect(p.blocked).toBe(notFound.channel("chan-b"));
      revealsNothing(p.blocked!);
      // The plan cannot have described the endpoint it refused to resolve.
      expect(p.details.join(" ")).not.toContain("orbital.example");
    });

    it(`${id} — execute refuses and B's channel is untouched`, async () => {
      const before = snapshotB();
      const r = await execute(id, asAda(), input("chan-b"));
      expect(r.ok).toBe(false);
      expect(r.error).toBe(notFound.channel("chan-b"));
      revealsNothing(r.error!);
      expect(snapshotB()).toBe(before);
    });

    it(`${id} — B's id reads exactly like an id that was never real`, async () => {
      const foreign = (await execute(id, asAda(), input("chan-b"))).error!;
      const fiction = (await execute(id, asAda(), input("chan-nope-000"))).error!;
      expect(foreign.replace("chan-b", "REF")).toBe(fiction.replace("chan-nope-000", "REF"));
    });
  }

  /**
   * The worst consequence of the global lookup, stated as its own assertion:
   * `updateChannel` rewrites `target` and `secret`, so an unscoped resolve is a
   * single call that points another workspace's alerts — and the signature that
   * proves they are Zenith's — at an endpoint the caller controls.
   */
  it("updateChannel does not redirect B's alert deliveries", async () => {
    const targetBefore = channelB().target;
    const secretBefore = channelB().secret;

    const r = await execute("alerts.updateChannel", asAda(), REDIRECT);

    expect(r.ok).toBe(false);
    expect(channelB().target).toBe(targetBefore);
    expect(channelB().target).not.toContain("attacker.example");
    expect(channelB().secret).toBe(secretBefore);
    expect(channelB().enabled).toBe(true);
  });

  it("testChannel does not send anything to B's endpoint", async () => {
    const r = await execute("alerts.testChannel", asAda(), { channelId: "chan-b" });
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(channelB().lastDelivery).toBeUndefined();
  });

  it("deleteChannel leaves B's channel in place", async () => {
    const r = await execute("alerts.deleteChannel", asAda(), { channelId: "chan-b" });
    expect(r.ok).toBe(false);
    expect(channelTable().map((c) => c.id)).toContain("chan-b");
  });
});

/* ---------------------------- the positive controls --------------------------- */

describe("the refusal is about tenancy, not about the object being broken", () => {
  it("lets B's own admin plan every one of these on the same ids", async () => {
    for (const { id, input } of FINDING_ACTIONS) {
      const p = await plan(id, asBo(), input("find-b"));
      expect(p.blocked ?? "").not.toMatch(/was not found/);
    }
    for (const { id, input } of RULE_ACTIONS) {
      const p = await plan(id, asBo(), input("rule-b"));
      expect(p.blocked ?? "").not.toMatch(/was not found/);
    }
    for (const { id, input } of CHANNEL_ACTIONS) {
      const p = await plan(id, asBo(), input("chan-b"));
      expect(p.blocked ?? "").not.toMatch(/was not found/);
    }
    const ack = await plan("alerts.acknowledge", asBo(), { eventId: "evt-b" });
    expect(ack.blocked ?? "").not.toMatch(/was not found/);
  });

  it("lets B's own admin run the fix that A was refused", async () => {
    const r = await execute("security.resolveFinding", asBo(), { findingId: "find-b" });
    expect(r.ok).toBe(true);
    expect(db().projects.find((p) => p.id === "prj-b")!.workingManifest.routes[0].tls).toBe(true);
    expect(db().findings.find((x) => x.id === "find-b")!.status).toBe("fixed_pending_deploy");
    // A's estate is untouched by B's fix, in the other direction.
    expect(db().projects.find((p) => p.id === "prj-a")!.workingManifest.routes[0].tls).toBe(false);
  });

  it("lets B's own admin move B's channel, and A's admin move A's", async () => {
    const mine = await execute("alerts.updateChannel", asBo(), {
      channelId: "chan-b",
      target: "https://orbital.example/ops-v2",
    });
    expect(mine.ok).toBe(true);
    expect(channelB().target).toBe("https://orbital.example/ops-v2");

    const hers = await execute("alerts.updateChannel", asAda(), {
      channelId: "chan-a",
      target: "https://kepler.example/ops-v2",
    });
    expect(hers.ok).toBe(true);
    expect(channelTable().find((c) => c.id === "chan-a")!.target).toBe("https://kepler.example/ops-v2");
    // …and neither move touched the other's secret.
    expect(channelB().secret).toBe("signing-key-chan-b");
  });

  it("lets B's own admin acknowledge B's alert", async () => {
    const r = await execute("alerts.acknowledge", asBo(), { eventId: "evt-b", note: "looking" });
    expect(r.ok).toBe(true);
    expect(db().alertEvents.find((e) => e.id === "evt-b")!.acknowledgedBy?.id).toBe("u-bo");
  });
});

/* --------------------------- the wrappers themselves -------------------------- */

describe("the scoped lookups, called directly", () => {
  it("scopedRule refuses B's id transitively, through its project", () => {
    expect(() => scopedRule(wsA.id, "rule-b")).toThrow(notFound.rule("rule-b"));
    expect(() => scopedRule(wsA.id, "rule-nope")).toThrow(notFound.rule("rule-nope"));
    expect(scopedRule(wsA.id, "rule-a").id).toBe("rule-a");
  });

  it("scopedEvent refuses B's id transitively, through its project", () => {
    expect(() => scopedEvent(wsA.id, "evt-b")).toThrow(notFound.event("evt-b"));
    expect(() => scopedEvent(wsA.id, "evt-nope")).toThrow(notFound.event("evt-nope"));
    expect(scopedEvent(wsA.id, "evt-a").id).toBe("evt-a");
  });

  it("scopedChannel refuses B's id by its own workspaceId", () => {
    expect(() => scopedChannel(wsA.id, "chan-b")).toThrow(notFound.channel("chan-b"));
    expect(() => scopedChannel(wsA.id, "chan-nope")).toThrow(notFound.channel("chan-nope"));
    expect(scopedChannel(wsA.id, "chan-a").id).toBe("chan-a");
  });

  it("resolves nothing at all without a workspace in scope", () => {
    expect(() => scopedRule("", "rule-a")).toThrow(notFound.rule("rule-a"));
    expect(() => scopedEvent("", "evt-a")).toThrow(notFound.event("evt-a"));
    expect(() => scopedChannel("", "chan-a")).toThrow(notFound.channel("chan-a"));
  });
});
