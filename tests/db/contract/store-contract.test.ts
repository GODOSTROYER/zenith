/**
 * The store contract, as one ordered scenario every implementation must pass.
 *
 * This is the harness that makes "swap the store" a checkable claim rather
 * than a hope: the same table of steps runs against every factory in
 * `./factories.ts`, so a second implementation is one row there and zero lines
 * here. It deliberately exercises the behaviour the file store's own unit test
 * (`tests/db/store.test.ts`) does not — the *contract*: the shape of a write,
 * what `readEvents(afterSeq)` promises, that a manifest is reachable but never
 * serialised, and that a save announces the project it touched.
 */
import { afterAll, describe, expect, it } from "vitest";
import type {
  Deployment,
  DeploymentEvent,
  Environment,
  Manifest,
  Member,
  Project,
  Revision,
  Workspace,
} from "@/lib/domain/types";
import type { Store } from "@/lib/db/types";
import { tempDataDir } from "../../_support/data-dir";
import { CONTRACT_PREFIX, cleanupPostgresContract, loadStores } from "./factories";

// MUST precede every application import: the file store pins ZENITH_DATA the
// moment it is loaded.
tempDataDir("zenith-store-contract-");

const stores = await loadStores();

// Every row this suite writes is filed under one prefixed workspace id, so the
// Postgres factory can delete exactly what the run created — it runs against a
// real project, and "delete the test data" has to mean something narrower than
// "delete the data".
const WS = `${CONTRACT_PREFIX}-ws`;
const PROJ = "proj-contract";
const ENV = "env-contract";
const REV = "rev-contract";
const DEP = "dep-contract";

const manifest = (serviceName: string): Manifest => ({
  version: 1,
  services: [
    {
      id: "svc-1",
      name: serviceName,
      kind: "web",
      source: { type: "image", image: "nginx:1.27" },
      size: "small",
      replicas: 1,
      port: 80,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

const event = (seq: number): DeploymentEvent => ({
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  deploymentId: DEP,
  seq,
  type: "log",
  stepId: "s0",
  line: `line ${seq}`,
  stream: "info",
});

/**
 * One step of the scenario. They share the store and run in declaration order
 * — this is a story about one install, not a set of independent cases.
 */
interface Step {
  name: string;
  run: (store: Store) => void;
}

const SCENARIO: Step[] = [
  {
    name: "reset gives an empty database",
    run: (store) => {
      const d = store.reset();
      expect(d.workspaces).toEqual([]);
      expect(d.projects).toEqual([]);
      expect(store.db()).toBe(d); // the live object, not a copy
    },
  },
  {
    name: "creates a workspace and a member",
    run: (store) => {
      const workspace: Workspace = {
        id: WS,
        name: "Contract",
        slug: "contract",
        createdAt: new Date().toISOString(),
      };
      const member: Member = {
        id: "mem-contract",
        workspaceId: WS,
        name: "You",
        email: "you@example.test",
        role: "admin",
      };
      store.db().workspaces.push(workspace);
      store.db().members.push(member);
      store.save(); // no project: broadcast
      store.flush();
      expect(store.db().workspaces.map((w) => w.id)).toEqual([WS]);
      expect(store.db().members[0].role).toBe("admin");
    },
  },
  {
    name: "creates a project and an environment",
    run: (store) => {
      const project: Project = {
        id: PROJ,
        workspaceId: WS,
        name: "Atlas",
        slug: "atlas",
        workingManifest: manifest("web"),
        createdAt: new Date().toISOString(),
        origin: { type: "blank" },
      };
      const environment: Environment = {
        id: ENV,
        projectId: PROJ,
        name: "sandbox",
        class: "sandbox",
        connectionId: "conn-contract",
        region: "us-east-1",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "atlas.zenith.test",
        createdAt: new Date().toISOString(),
      };
      store.db().projects.push(project);
      store.db().environments.push(environment);
      store.save(PROJ);
      store.flush();
      expect(store.db().projects).toHaveLength(1);
      expect(store.db().environments[0].projectId).toBe(PROJ);
    },
  },
  {
    name: "records a revision whose manifest survives a write",
    run: (store) => {
      const revision: Revision = {
        id: REV,
        projectId: PROJ,
        number: 1,
        manifest: manifest("web"),
        message: "first",
        author: { type: "user", id: "mem-contract", name: "You" },
        createdAt: new Date().toISOString(),
      };
      store.db().revisions.push(revision);
      store.save(PROJ);
      store.flush();

      expect(store.revisionManifest(REV)?.services[0].name).toBe("web");
      // The property still reads, through the accessor, off the record itself.
      expect(store.db().revisions[0].manifest.services[0].name).toBe("web");
    },
  },
  {
    name: "keeps the manifest accessor non-enumerable and out of serialisation",
    run: (store) => {
      const revision = store.db().revisions[0];
      const desc = Object.getOwnPropertyDescriptor(revision, "manifest");
      expect(desc).toBeDefined();
      expect(desc?.enumerable).toBe(false);
      expect(typeof desc?.get).toBe("function");
      expect(Object.keys(revision)).not.toContain("manifest");

      const serialised = JSON.stringify(store.db());
      expect(serialised).not.toContain('"manifest"');
      // The project's *working* manifest is hot state and must still be there,
      // so "no manifest key at all" is not what is being asserted.
      expect(serialised).toContain('"workingManifest"');
      expect(JSON.parse(serialised).revisions[0].manifest).toBeUndefined();
    },
  },
  {
    name: "assigning a manifest writes it through",
    run: (store) => {
      store.db().revisions[0].manifest = manifest("web-2");
      expect(store.revisionManifest(REV)?.services[0].name).toBe("web-2");
      store.db().revisions[0].manifest = manifest("web");
    },
  },
  {
    name: "records a deployment",
    run: (store) => {
      const deployment: Deployment = {
        id: DEP,
        projectId: PROJ,
        environmentId: ENV,
        revisionId: REV,
        status: "succeeded",
        steps: [],
        outputs: [],
        changeSummary: "1 service created",
        estCostDeltaUsd: 0,
        actor: { type: "user", id: "mem-contract", name: "You" },
        createdAt: new Date().toISOString(),
      };
      store.db().deployments.push(deployment);
      store.save(PROJ);
      store.flush();
      expect(store.db().deployments[0].revisionId).toBe(REV);
    },
  },
  {
    name: "appendEvent / readEvents honours afterSeq",
    run: (store) => {
      for (let i = 0; i < 4; i++) store.appendEvent(event(i));
      expect(store.readEvents(DEP).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
      expect(store.readEvents(DEP, 1).map((e) => e.seq)).toEqual([2, 3]);
      expect(store.readEvents(DEP, 3)).toEqual([]);
      expect(store.readEvents("dep-nobody")).toEqual([]);

      // Incremental: a later append is visible without re-reading the log.
      store.appendEvent(event(4));
      expect(store.readEvents(DEP, 3).map((e) => e.seq)).toEqual([4]);
    },
  },
  {
    name: "appendAudit / readAuditPage / countAudit",
    run: (store) => {
      for (let i = 0; i < 5; i++)
        store.appendAudit({
          ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
          id: `${CONTRACT_PREFIX}-aud-${i}`,
          workspaceId: WS,
          projectId: i % 2 === 0 ? PROJ : "proj-other",
          actor: { type: "user", id: "mem-contract", name: "You" },
          actionId: i === 0 ? "deploy.start" : "system.addService",
          input: { n: i },
          result: "ok",
          summary: `step ${i}`,
        });

      // Newest first.
      expect(store.readAudit().map((e) => e.id)).toEqual([
        `${CONTRACT_PREFIX}-aud-4`,
        `${CONTRACT_PREFIX}-aud-3`,
        `${CONTRACT_PREFIX}-aud-2`,
        `${CONTRACT_PREFIX}-aud-1`,
        `${CONTRACT_PREFIX}-aud-0`,
      ]);
      expect(store.readAudit({ projectId: PROJ }).map((e) => e.id)).toEqual([
        `${CONTRACT_PREFIX}-aud-4`,
        `${CONTRACT_PREFIX}-aud-2`,
        `${CONTRACT_PREFIX}-aud-0`,
      ]);
      expect(store.readAudit({ actionId: "deploy." }).map((e) => e.id)).toEqual([`${CONTRACT_PREFIX}-aud-0`]);

      const page = store.readAuditPage({ limit: 2 });
      expect(page.events.map((e) => e.id)).toEqual([`${CONTRACT_PREFIX}-aud-4`, `${CONTRACT_PREFIX}-aud-3`]);
      expect(page.nextCursor).toBeDefined();
      const next = store.readAuditPage({ limit: 2, cursor: page.nextCursor });
      expect(next.events.map((e) => e.id)).toEqual([`${CONTRACT_PREFIX}-aud-2`, `${CONTRACT_PREFIX}-aud-1`]);

      expect(store.countAudit()).toEqual({ total: 5, exact: true });
      expect(store.countAudit({ projectId: PROJ })).toEqual({ total: 3, exact: true });
      // Cached counts stay honest when the log grows.
      store.appendAudit({
        ts: new Date(1_700_000_010_000).toISOString(),
        id: `${CONTRACT_PREFIX}-aud-5`,
        workspaceId: WS,
        projectId: PROJ,
        actor: { type: "system", id: "sys", name: "Zenith" },
        actionId: "system.addService",
        input: {},
        result: "ok",
        summary: "step 5",
      });
      expect(store.countAudit({ projectId: PROJ })).toEqual({ total: 4, exact: true });
    },
  },
  {
    name: "onChange fires once per write, naming the project",
    run: (store) => {
      const seen: string[][] = [];
      const off = store.onChange((c) => seen.push(c.projectIds));
      try {
        store.db().projects[0].name = "Atlas 2";
        store.save(PROJ);
        store.flush();
        expect(seen).toEqual([[PROJ]]);
        expect(store.changed({ projectIds: [PROJ] }, PROJ)).toBe(true);
        expect(store.changed({ projectIds: [PROJ] }, "proj-other")).toBe(false);
        // Empty means "unknown, assume any" — never "nothing changed".
        expect(store.changed({ projectIds: [] }, "proj-other")).toBe(true);

        // A save with no project id broadcasts.
        store.save();
        store.flush();
        expect(seen[1]).toEqual([]);
      } finally {
        off();
      }
      // Unsubscribed: no further events.
      const before = seen.length;
      store.save(PROJ);
      store.flush();
      expect(seen).toHaveLength(before);
    },
  },
  {
    name: "flushPending reports whether a save was scheduled",
    run: (store) => {
      expect(store.flushPending()).toBe(false);
      store.save(PROJ);
      expect(store.flushPending()).toBe(true);
      expect(store.flushPending()).toBe(false);
    },
  },
  {
    name: "reset clears state, logs and manifests",
    run: (store) => {
      store.reset();
      expect(store.db().projects).toEqual([]);
      expect(store.db().revisions).toEqual([]);
      expect(store.readEvents(DEP)).toEqual([]);
      expect(store.readAudit()).toEqual([]);
      expect(store.countAudit()).toEqual({ total: 0, exact: true });
      expect(store.revisionManifest(REV)).toBeUndefined();
    },
  },
  {
    name: "reset seeds from the data it is given",
    run: (store) => {
      const d = store.reset({
        workspaces: [{ id: WS, name: "Seeded", slug: "seeded", createdAt: "2026-01-01T00:00:00Z" }],
      });
      expect(d.workspaces).toHaveLength(1);
      expect(d.projects).toEqual([]); // untouched collections come back empty
      expect(store.db().workspaces[0].name).toBe("Seeded");
      store.reset();
    },
  },
];

afterAll(cleanupPostgresContract);

describe.each(stores)("store contract — $name", ({ store }) => {
  for (const step of SCENARIO)
    it(step.name, async () => {
      step.run(store);
      // The file store's writes are already on disk; the Postgres store's are a
      // round trip, and the next step must not start before they land.
      await (store as { flushAsync?: () => Promise<boolean> }).flushAsync?.();
    });
});
