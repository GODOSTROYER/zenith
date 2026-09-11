/**
 * A connectionId is the sharpest bearer token in the product, and this is the
 * matrix that proves it stops at the workspace boundary.
 *
 * A cloud connection is the thing that actually reaches a customer's cloud
 * account, so three separate leaks hung off resolving one globally:
 *
 *  1. `connection.disconnect` resolved the id out of the whole store and then
 *     deleted the row. An admin of A could delete B's connection outright.
 *  2. `connection.check` returned that connection's preflight checks and its
 *     granted permissions — a read of someone else's cloud posture.
 *  3. `buildEnvironment` resolved `input.connectionId` globally, and it is
 *     reached from env.create, project.create, project.applyBlueprint and
 *     project.importCompose. A caller could create an environment in their own
 *     workspace that deploys through a stranger's cloud account: the
 *     environment looked entirely ordinary afterwards, and every deploy through
 *     it went somewhere it had no business going.
 *
 * A fourth leak needed no id at all. Project slugs were made unique across
 * every workspace in the store, so creating a project called "Acme" and getting
 * back `acme-2` told you that some other tenant holds `acme`. One project
 * creation per guess is a slow read of other people's names, so uniqueness is
 * now computed inside the caller's own workspace.
 *
 * As in workspace-isolation.test.ts, the second property matters as much as the
 * first: a foreign id must be indistinguishable from one that was never real.
 * Every refusal here is compared against the refusal for pure nonsense, and
 * they have to be the same sentence. Every case has a positive control beside
 * it, so none of these tests can pass by everything being broken.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type {
  Actor,
  CloudConnection,
  Environment,
  Manifest,
  Member,
  Project,
  Workspace,
} from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-conn-env-isolation-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const AT = "2026-09-01T10:00:00.000Z";

/* --------------------------------- fixture -------------------------------- */

const wsA: Workspace = { id: "ws-a", name: "Kepler Labs", slug: "kepler", createdAt: AT };
const wsB: Workspace = { id: "ws-b", name: "Orbital", slug: "orbital", createdAt: AT };
/** A third, empty workspace — the clean room the slug tests need. */
const wsC: Workspace = { id: "ws-c", name: "Cassini", slug: "cassini", createdAt: AT };

const ada: Actor = { type: "user", id: "u-ada", name: "Ada" };
const bo: Actor = { type: "user", id: "u-bo", name: "Bo" };
const cleo: Actor = { type: "user", id: "u-cleo", name: "Cleo" };

const member = (id: string, workspaceId: string, name: string): Member => ({
  id,
  workspaceId,
  name,
  email: `${name.toLowerCase()}@zenith.test`,
  role: "admin",
});

const manifest = (serviceName: string): Manifest => ({
  version: 1,
  services: [
    {
      id: `svc-${serviceName}`,
      name: serviceName,
      kind: "web",
      source: { type: "image", image: "ghcr.io/zenith/hello-web:1" },
      size: "small",
      replicas: 1,
      port: 3000,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

/**
 * Labels carry the owning workspace's name on purpose. `revealsNothing` scans
 * every refusal for those words, so a message that reaches for `conn.label`
 * fails the test rather than quietly naming a stranger's account.
 */
const connection = (id: string, workspaceId: string, label: string): CloudConnection => ({
  id,
  workspaceId,
  provider: "sandbox",
  label,
  region: "sim-a",
  status: "healthy",
  grantedPermissions: ["No cloud access requested"],
  createdAt: AT,
});

/** Both projects are slugged "atlas": two tenants may hold the same slug. */
const project = (id: string, workspaceId: string, name: string): Project => ({
  id,
  workspaceId,
  name,
  slug: "atlas",
  workingManifest: manifest("api"),
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
  baseDomain: `${projectId}.zenith.app`,
  createdAt: AT,
});

/**
 * Each workspace gets two connections: one an environment deploys through, and
 * one spare that nothing uses. The spare is what makes the disconnect test
 * meaningful — an in-use connection is refused for being in use, so only an
 * unused one proves that tenancy alone stopped the deletion.
 */
function seedThree() {
  resetDb({
    workspaces: [wsA, wsB, wsC],
    members: [
      member("u-ada", wsA.id, "Ada"),
      member("u-bo", wsB.id, "Bo"),
      member("u-cleo", wsC.id, "Cleo"),
    ],
    connections: [
      connection("conn-a", wsA.id, "Kepler Sandbox"),
      connection("conn-a-spare", wsA.id, "Kepler Spare"),
      connection("conn-b", wsB.id, "Orbital Sandbox"),
      connection("conn-b-spare", wsB.id, "Orbital Spare"),
    ],
    projects: [project("prj-a", wsA.id, "Kepler Atlas"), project("prj-b", wsB.id, "Orbital Atlas")],
    environments: [environment("env-a", "prj-a", "conn-a"), environment("env-b", "prj-b", "conn-b")],
  });
}

/* --------------------------------- helpers -------------------------------- */

const ctx = (actor: Actor, workspaceId: string, scope: Partial<ActionContext> = {}): ActionContext => ({
  workspaceId,
  actor,
  ...scope,
});

/** Ada, acting in her own workspace — where she really is an admin. */
const asAda = (scope: Partial<ActionContext> = {}) => ctx(ada, wsA.id, scope);

const plan = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "plan" })).plan!;

const execute = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "execute" })).result!;

/** The sentence _shared.requireConnection produces. Absent and foreign share it. */
const notFoundConnection = (ref: string) =>
  `Cloud connection "${ref}" does not exist. Pick one in Settings → Connections, or connect an account there.`;

/**
 * Nothing in a refusal may hint that the object is real: no "access", no
 * workspace names, no connection labels. The id the caller already typed is
 * fine — they supplied it.
 */
function revealsNothing(message: string) {
  expect(message).not.toMatch(/access|permitt|permission|not allowed|forbidden|denied|belongs to/i);
  expect(message).not.toMatch(/another workspace|other workspace|different workspace/i);
  for (const secret of ["Orbital", "orbital", "Kepler", "kepler", "u-bo", "Bo", "Spare", "Sandbox"])
    expect(message).not.toContain(secret);
}

/** A byte-exact snapshot of B's side of the store, for "nothing moved" checks. */
const snapshotB = () =>
  JSON.stringify({
    connections: db().connections.filter((c) => c.workspaceId === wsB.id),
    projects: db().projects.filter((p) => p.workspaceId === wsB.id),
    environments: db().environments.filter((e) => ["prj-b"].includes(e.projectId)),
  });

const COMPOSE = `services:
  web:
    image: nginx:1
    ports:
      - "8080:80"
`;

/** Every entry point that reaches buildEnvironment with a caller-supplied id. */
const CONNECTION_CONSUMERS: { id: string; input: (connectionId: string) => unknown }[] = [
  {
    id: "env.create",
    input: (connectionId) => ({ projectId: "prj-a", name: "staging", class: "staging", connectionId }),
  },
  { id: "project.create", input: (connectionId) => ({ name: "Intruder", connectionId }) },
  {
    id: "project.applyBlueprint",
    input: (connectionId) => ({ blueprint: "saas-standard", name: "Intruder BP", connectionId }),
  },
  {
    id: "project.importCompose",
    input: (connectionId) => ({ composeYaml: COMPOSE, name: "Intruder Compose", connectionId }),
  },
];

const CONNECTION_ACTIONS: { id: string; input: (connectionId: string) => unknown }[] = [
  { id: "connection.check", input: (connectionId) => ({ connectionId }) },
  { id: "connection.disconnect", input: (connectionId) => ({ connectionId }) },
];

/* ------------------------------- the matrix ------------------------------- */

beforeEach(seedThree);

describe("an admin of A cannot reach B's cloud connection by id", () => {
  for (const { id, input } of CONNECTION_ACTIONS) {
    // conn-b-spare is the sharp case: nothing uses it, so only tenancy can
    // stop the action. conn-b is checked too, so an in-use connection is not
    // refused with a sentence that names the environments using it.
    for (const foreign of ["conn-b-spare", "conn-b"]) {
      it(`${id} — plan on ${foreign} is blocked with the not-found sentence`, async () => {
        const p = await plan(id, asAda(), input(foreign));
        expect(p.blocked).toBe(notFoundConnection(foreign));
        expect(p.details[0]).toBe(p.blocked);
        revealsNothing(p.blocked!);
      });

      it(`${id} — execute on ${foreign} refuses and leaves B byte-identical`, async () => {
        const before = snapshotB();
        const r = await execute(id, asAda(), input(foreign));
        expect(r.ok).toBe(false);
        expect(r.error).toBe(notFoundConnection(foreign));
        revealsNothing(r.error!);
        // The row is still there, and no field of it moved: connection.check
        // would have rewritten status, lastCheckedAt and grantedPermissions.
        expect(db().connections.map((c) => c.id)).toContain(foreign);
        expect(snapshotB()).toBe(before);
      });

      it(`${id} — ${foreign} reads exactly like an id that was never real`, async () => {
        const real = (await execute(id, asAda(), input(foreign))).error!;
        const fiction = (await execute(id, asAda(), input("conn-nope-000"))).error!;
        expect(real.replace(foreign, "REF")).toBe(fiction.replace("conn-nope-000", "REF"));
      });
    }
  }

  it("plan mode refuses too, not just execute", async () => {
    for (const { id, input } of CONNECTION_ACTIONS) {
      const p = await plan(id, asAda(), input("conn-b-spare"));
      expect(p.blocked).toBeDefined();
      expect(p.summary).not.toContain("Orbital");
    }
  });
});

describe("the connection refusal is about tenancy, not a broken action", () => {
  it("lets A check her own connection", async () => {
    const r = await execute("connection.check", asAda(), { connectionId: "conn-a" });
    expect(r.ok).toBe(true);
    expect((r.data as { connectionId: string }).connectionId).toBe("conn-a");
  });

  it("lets A disconnect her own unused connection, and B keeps hers", async () => {
    const before = snapshotB();
    const r = await execute("connection.disconnect", asAda(), { connectionId: "conn-a-spare" });
    expect(r.ok).toBe(true);
    expect(db().connections.map((c) => c.id)).not.toContain("conn-a-spare");
    expect(db().connections.map((c) => c.id)).toEqual(
      expect.arrayContaining(["conn-b", "conn-b-spare"])
    );
    expect(snapshotB()).toBe(before);
  });

  it("lets B's own admin act on the very ids A was refused", async () => {
    const check = await execute("connection.check", ctx(bo, wsB.id), { connectionId: "conn-b" });
    expect(check.ok).toBe(true);
    const gone = await execute("connection.disconnect", ctx(bo, wsB.id), {
      connectionId: "conn-b-spare",
    });
    expect(gone.ok).toBe(true);
    expect(db().connections.map((c) => c.id)).not.toContain("conn-b-spare");
  });

  it("refuses an in-use connection for being in use, in the owner's own workspace", async () => {
    const p = await plan("connection.disconnect", ctx(bo, wsB.id), { connectionId: "conn-b" });
    // The blocked: plan UX is preserved where it already existed — and the
    // reason is only ever shown to the tenant who owns the connection.
    expect(p.blocked).toContain("still deploy through");
    expect(p.blocked).not.toContain("does not exist");
  });
});

describe("no entry point will build an environment bound to a foreign connection", () => {
  for (const { id, input } of CONNECTION_CONSUMERS) {
    it(`${id} — plan is blocked with the not-found sentence`, async () => {
      const p = await plan(id, asAda(), input("conn-b"));
      expect(p.blocked).toBe(notFoundConnection("conn-b"));
      revealsNothing(p.blocked!);
    });

    it(`${id} — execute refuses, and binds nothing to B's connection`, async () => {
      const projectsBefore = db().projects.length;
      const before = snapshotB();
      const r = await execute(id, asAda(), input("conn-b"));
      expect(r.ok).toBe(false);
      expect(r.error).toBe(notFoundConnection("conn-b"));
      revealsNothing(r.error!);

      // The silent-success shape this closes: an ordinary-looking environment
      // in A that points at B's cloud account.
      expect(db().environments.filter((e) => e.connectionId === "conn-b")).toHaveLength(1);
      expect(db().environments.find((e) => e.connectionId === "conn-b")!.id).toBe("env-b");
      // …and no half-created project left behind by a refusal mid-write.
      expect(db().projects).toHaveLength(projectsBefore);
      expect(snapshotB()).toBe(before);
    });

    it(`${id} — B's connection reads exactly like one that was never real`, async () => {
      const real = (await execute(id, asAda(), input("conn-b"))).error!;
      const fiction = (await execute(id, asAda(), input("conn-nope-000"))).error!;
      expect(real.replace("conn-b", "REF")).toBe(fiction.replace("conn-nope-000", "REF"));
    });

    it(`${id} — succeeds with A's own connection, and binds to it`, async () => {
      const r = await execute(id, asAda(), input("conn-a-spare"));
      expect(r.ok).toBe(true);
      const mine = db().environments.filter((e) => e.connectionId === "conn-a-spare");
      expect(mine).toHaveLength(1);
      // The environment landed in A: its project is one of A's.
      const owner = db().projects.find((p) => p.id === mine[0].projectId)!;
      expect(owner.workspaceId).toBe(wsA.id);
    });
  }
});

describe("project slugs are unique per workspace, not across the store", () => {
  /**
   * The oracle: A and B both hold "atlas". Cleo's workspace is empty, so the
   * slug she gets must be plain "atlas" — an `atlas-2` would be the allocator
   * telling her that somebody, somewhere, already has that name.
   */
  it("gives a third workspace the slug two others already hold", async () => {
    const r = await execute("project.create", ctx(cleo, wsC.id), {
      name: "Atlas",
      withEnvironment: false,
    });
    expect(r.ok).toBe(true);
    expect((r.data as { slug: string }).slug).toBe("atlas");
  });

  it("says the same thing in plan mode, before anything is created", async () => {
    const p = await plan("project.create", ctx(cleo, wsC.id), {
      name: "Atlas",
      withEnvironment: false,
    });
    expect(p.details[0]).toBe("URL slug: /p/atlas.");
  });

  it("lets all three workspaces own a project slugged atlas at once", async () => {
    await execute("project.create", ctx(cleo, wsC.id), { name: "Atlas", withEnvironment: false });
    const atlases = db().projects.filter((p) => p.slug === "atlas");
    expect(atlases).toHaveLength(3);
    expect(atlases.map((p) => p.workspaceId).sort()).toEqual(["ws-a", "ws-b", "ws-c"]);
  });

  /**
   * The control that stops this passing by uniqueness simply being switched
   * off: inside ONE workspace the suffix still appears, exactly as before.
   */
  it("still suffixes a slug that is taken inside the caller's own workspace", async () => {
    const first = await execute("project.create", ctx(cleo, wsC.id), {
      name: "Atlas",
      withEnvironment: false,
    });
    const second = await execute("project.create", ctx(cleo, wsC.id), {
      name: "Atlas",
      withEnvironment: false,
    });
    expect((first.data as { slug: string }).slug).toBe("atlas");
    expect((second.data as { slug: string }).slug).toBe("atlas-2");
  });

  it("renumbers nothing that already exists", async () => {
    const before = db().projects.map((p) => `${p.id}:${p.slug}`);
    await execute("project.create", ctx(cleo, wsC.id), { name: "Atlas", withEnvironment: false });
    for (const row of before) expect(db().projects.map((p) => `${p.id}:${p.slug}`)).toContain(row);
    expect(db().projects.find((p) => p.id === "prj-a")!.slug).toBe("atlas");
    expect(db().projects.find((p) => p.id === "prj-b")!.slug).toBe("atlas");
  });
});
