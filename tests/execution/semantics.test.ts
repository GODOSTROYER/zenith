/**
 * PROD-DUR-03: the canonical executable semantics digest. Pure properties first (every input the
 * requirement lists moves the digest and names itself; ordering and unrelated data do not), then the
 * collector over the real execution runtime and the isolated fakes: migration classification,
 * ownership transfers, runbook references, backend and lock digests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { loadExecContext, resolveConnection } from "@/lib/execution/context";
import { requireExecutable } from "@/lib/execution/desired";
import { buildDeployWorkspace } from "@/lib/execution/plan";
import { createRuntime } from "@/lib/execution/runtime";
import { collectExecutableSemantics, collectSemanticsInputs, runbookOf } from "@/lib/execution/semantics/collect";
import {
  SEMANTIC_COMPONENTS,
  SEMANTICS_FORMAT,
  computeExecutableSemantics,
  diffSemantics,
  normalizedComponent,
  readExecutableSemantics,
  type ExecutableSemanticsInputs,
  type SemanticComponentName,
} from "@/lib/execution/semantics/digest";
import { SemanticsChangedError, assertSemanticsMatch } from "@/lib/execution/semantics/errors";
import { MemorySemanticsStore, SemanticsStoreError } from "@/lib/execution/semantics/store";
import { FAILURE_TYPES } from "@/lib/workflows/types";
import { OP, WS, migratingManifest } from "./fakes/fixtures";
import { createWorld, type World } from "./fakes/world";

const h = (c: string): string => c.repeat(64);

function base(): ExecutableSemanticsInputs {
  return {
    revision: { id: "rev_1", deployedRevisionId: "rev_0", manifestDigest: h("1") },
    recipe: {
      executableSourceDigest: h("2"),
      sources: [
        { service: "container_service/api", commit: "a".repeat(40), dockerfileDigest: h("3"), recipeDigest: h("4"), archiveDigest: h("5") },
        { service: "container_service/web", commit: "b".repeat(40), dockerfileDigest: h("6"), recipeDigest: h("7"), archiveDigest: h("8") },
      ],
    },
    scripts: { release: { service: "web", commandDigest: h("9"), timeoutSec: 600 } },
    migrations: { declaredClass: "expand", effectiveClass: "expand", sqlDigest: null },
    targets: { graphDigest: h("a"), provider: "aws", region: "us-east-1", environmentId: "env_1", connectionId: "conn_1", connectionConfigDigest: h("b") },
    configuration: { configDigest: h("c") },
    providerLocks: { lockDigest: h("d"), tofuVersion: "1.12.5" },
    backend: { kind: "s3", configDigest: h("e") },
    savedPlan: { planDigest: h("f") },
    provenance: {
      pipelines: [
        { service: "build_pipeline/api", contextDir: "services/api", contextDigest: h("0") },
        { service: "build_pipeline/web", contextDir: null, contextDigest: null },
      ],
    },
    ownership: { transfers: [{ address: "container_service/web", path: "desired_count", from: "iac", to: "autoscaler", digest: h("1") }] },
    runbook: { runbookId: "rb_1", version: 3, definitionDigest: h("2") },
  };
}

const clone = (v: ExecutableSemanticsInputs): ExecutableSemanticsInputs => structuredClone(v);

describe("canonical executable semantics digest", () => {
  it("is deterministic and covers exactly the documented components", () => {
    const a = computeExecutableSemantics(base());
    const b = computeExecutableSemantics(clone(base()));
    expect(a).toEqual(b);
    expect(a.format).toBe(SEMANTICS_FORMAT);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(a.components).sort()).toEqual([...SEMANTIC_COMPONENTS].sort());
    expect([...SEMANTIC_COMPONENTS]).toEqual(["revision", "recipe", "scripts", "migrations", "targets", "configuration", "providerLocks", "backend", "savedPlan", "provenance", "ownership", "runbook"]);
  });

  // Every input the requirement names, and each one's own component must be the only one that moves.
  const mutations: [string, SemanticComponentName, (i: ExecutableSemanticsInputs) => void][] = [
    ["the revision id", "revision", (i) => { i.revision.id = "rev_2"; }],
    ["the deployed revision", "revision", (i) => { i.revision.deployedRevisionId = "rev_x"; }],
    ["the manifest content", "revision", (i) => { i.revision.manifestDigest = h("9"); }],
    ["the approved source set", "recipe", (i) => { i.recipe.executableSourceDigest = h("9"); }],
    ["a source commit", "recipe", (i) => { i.recipe.sources[0].commit = "c".repeat(40); }],
    ["a Dockerfile", "recipe", (i) => { i.recipe.sources[1].dockerfileDigest = h("9"); }],
    ["a build recipe", "recipe", (i) => { i.recipe.sources[0].recipeDigest = h("9"); }],
    ["a source archive", "recipe", (i) => { i.recipe.sources[0].archiveDigest = h("9"); }],
    ["a removed source", "recipe", (i) => { i.recipe.sources.pop(); }],
    ["the release script", "scripts", (i) => { i.scripts.release!.commandDigest = h("0"); }],
    ["the release script target service", "scripts", (i) => { i.scripts.release!.service = "api"; }],
    ["the release script timeout", "scripts", (i) => { i.scripts.release!.timeoutSec = 601; }],
    ["a removed release script", "scripts", (i) => { i.scripts.release = null; }],
    ["the declared migration class", "migrations", (i) => { i.migrations!.declaredClass = "contract"; i.migrations!.effectiveClass = "contract"; }],
    ["the effective migration class raised by SQL", "migrations", (i) => { i.migrations!.effectiveClass = "data"; }],
    ["the migration SQL", "migrations", (i) => { i.migrations!.sqlDigest = h("3"); }],
    ["a removed migration", "migrations", (i) => { i.migrations = null; }],
    ["the graph", "targets", (i) => { i.targets.graphDigest = h("0"); }],
    ["the provider", "targets", (i) => { i.targets.provider = "gcp"; }],
    ["the region", "targets", (i) => { i.targets.region = "eu-west-1"; }],
    ["the environment", "targets", (i) => { i.targets.environmentId = "env_2"; }],
    ["the connection", "targets", (i) => { i.targets.connectionId = "conn_2"; }],
    ["the connection configuration", "targets", (i) => { i.targets.connectionConfigDigest = h("0"); }],
    ["the rendered configuration", "configuration", (i) => { i.configuration.configDigest = h("0"); }],
    ["the provider lock file", "providerLocks", (i) => { i.providerLocks.lockDigest = h("0"); }],
    ["the OpenTofu version", "providerLocks", (i) => { i.providerLocks.tofuVersion = "1.13.0"; }],
    ["the backend kind", "backend", (i) => { i.backend.kind = "gcs"; }],
    ["the backend configuration", "backend", (i) => { i.backend.configDigest = h("0"); }],
    ["the saved plan", "savedPlan", (i) => { i.savedPlan.planDigest = h("0"); }],
    ["a build context directory", "provenance", (i) => { i.provenance.pipelines[0].contextDir = "services/other"; }],
    ["a build context digest (LIFE-08 inspection)", "provenance", (i) => { i.provenance.pipelines[0].contextDigest = h("9"); }],
    ["a new ownership transfer (LIFE-12)", "ownership", (i) => { i.ownership.transfers.push({ address: "container_service/api", path: "image", from: "iac", to: "release", digest: h("4") }); }],
    ["an ownership transfer's destination", "ownership", (i) => { i.ownership.transfers[0].to = "provider"; }],
    ["a revoked ownership transfer", "ownership", (i) => { i.ownership.transfers = []; }],
    ["the runbook version (MACH-03)", "runbook", (i) => { i.runbook!.version = 4; }],
    ["the runbook definition", "runbook", (i) => { i.runbook!.definitionDigest = h("3"); }],
    ["a runbook appearing", "runbook", (i) => { i.runbook = null; }],
  ];

  it.each(mutations)("a changed %s invalidates the approval and names %s", (_label, component, mutate) => {
    const approved = computeExecutableSemantics(base());
    const changed = clone(base());
    mutate(changed);
    const current = computeExecutableSemantics(changed);
    expect(current.digest).not.toBe(approved.digest);
    expect(diffSemantics(approved, current)).toEqual([component]);
    expect(() => assertSemanticsMatch(approved, current, "test")).toThrow(SemanticsChangedError);
  });

  it("covers every component with at least one mutation", () => {
    const covered = new Set(mutations.map(([, c]) => c));
    expect([...covered].sort()).toEqual([...SEMANTIC_COMPONENTS].sort());
  });

  it("ignores ordering of unordered inputs", () => {
    const a = computeExecutableSemantics(base());
    const shuffled = clone(base());
    shuffled.recipe.sources.reverse();
    shuffled.provenance.pipelines.reverse();
    shuffled.ownership.transfers = [...shuffled.ownership.transfers].reverse();
    expect(computeExecutableSemantics(shuffled).digest).toBe(a.digest);
  });

  it("does not let one component's value masquerade as another's", () => {
    const i = base();
    const digests = SEMANTIC_COMPONENTS.map((c) => computeExecutableSemantics(i).components[c]);
    expect(new Set(digests).size).toBe(SEMANTIC_COMPONENTS.length);
    expect(normalizedComponent("savedPlan", i)).toEqual({ planDigest: h("f") });
  });

  it("round-trips a stored document and rejects tampering", () => {
    const sem = computeExecutableSemantics(base());
    expect(readExecutableSemantics(JSON.parse(JSON.stringify(sem)))).toEqual(sem);
    expect(readExecutableSemantics({ ...sem, digest: h("0") })).toBeUndefined();
    expect(readExecutableSemantics({ ...sem, components: { ...sem.components, savedPlan: h("0") } })).toBeUndefined();
    expect(readExecutableSemantics({ ...sem, components: { revision: sem.components.revision } })).toBeUndefined();
    expect(readExecutableSemantics({ ...sem, format: "other" })).toBeUndefined();
    expect(readExecutableSemantics("nope")).toBeUndefined();
  });

  it("refuses with the plan_changed failure type, names components, and carries no value", () => {
    const approved = computeExecutableSemantics(base());
    const changed = clone(base());
    changed.migrations!.effectiveClass = "contract";
    changed.savedPlan.planDigest = h("0");
    let error: unknown;
    try {
      assertSemanticsMatch(approved, computeExecutableSemantics(changed), "apply dispatch");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SemanticsChangedError);
    const failure = error as SemanticsChangedError;
    expect(failure.type).toBe(FAILURE_TYPES.planChanged);
    expect(failure.nonRetryable).toBe(true);
    expect(failure.changed).toEqual(["migrations", "savedPlan"]);
    expect(failure.message).toContain("migrations, savedPlan");
    expect(failure.message).toContain("apply dispatch");
    expect(failure.message).toMatch(/Plan again and have the new plan approved/);
    expect(failure.message).not.toContain(h("0"));
  });
});

describe("the write-once approved semantics store", () => {
  it("records once, is idempotent for the same digest and refuses a different one", async () => {
    const store = new MemorySemanticsStore();
    const sem = computeExecutableSemantics(base());
    const first = await store.record({ workspaceId: "ws", operationId: "op", planDigest: h("f"), semantics: sem });
    expect(first.semantics).toEqual(sem);
    expect(await store.record({ workspaceId: "ws", operationId: "op", planDigest: h("f"), semantics: sem })).toEqual(first);
    const other = clone(base());
    other.configuration.configDigest = h("0");
    await expect(store.record({ workspaceId: "ws", operationId: "op", planDigest: h("f"), semantics: computeExecutableSemantics(other) })).rejects.toMatchObject({ code: "conflict" });
    expect((await store.get("ws", "op", h("f")))?.semantics.digest).toBe(sem.digest);
  });

  it("is tenant scoped and validates what it stores", async () => {
    const store = new MemorySemanticsStore();
    const sem = computeExecutableSemantics(base());
    await store.record({ workspaceId: "ws", operationId: "op", planDigest: h("f"), semantics: sem });
    expect(await store.get("other", "op", h("f"))).toBeNull();
    expect(await store.get("ws", "op", h("0"))).toBeNull();
    await expect(store.record({ workspaceId: "ws", operationId: "op", planDigest: "short", semantics: sem })).rejects.toBeInstanceOf(SemanticsStoreError);
    await expect(store.record({ workspaceId: "ws", operationId: "op2", planDigest: h("f"), semantics: { ...sem, digest: h("0") } })).rejects.toBeInstanceOf(SemanticsStoreError);
  });
});

describe("runbook references in operation input (MACH-03)", () => {
  it("accepts the strict reference, treats absence as none and never drops a malformed claim", () => {
    expect(runbookOf({ runbook: { runbookId: "rb", version: 2, definitionDigest: h("a") } })).toEqual({ runbookId: "rb", version: 2, definitionDigest: h("a") });
    expect(runbookOf({})).toBeNull();
    expect(runbookOf(null)).toBeNull();
    const bad1 = runbookOf({ runbook: { runbookId: "rb", version: 2 } });
    const bad2 = runbookOf({ runbook: { runbookId: "rb", version: 3 } });
    expect(bad1).not.toBeNull();
    expect(bad1).not.toEqual(bad2);
    expect(bad1?.version).toBe(0);
  });
});

describe("the collector over the real execution runtime", () => {
  const worlds: World[] = [];
  afterEach(() => {
    while (worlds.length) worlds.pop()!.dispose();
  });

  async function collect(w: World, planDigest = h("f")) {
    const rt = createRuntime(w.deps);
    const ec = await loadExecContext(rt, OP);
    const { graph } = requireExecutable(rt, ec);
    const connection = await resolveConnection(rt, ec);
    const { ws } = await buildDeployWorkspace(rt, ec, graph, connection);
    const args = { graph, connection, ws, planDigest };
    return { rt, ec, args, inputs: await collectSemanticsInputs(rt, ec, args), semantics: await collectExecutableSemantics(rt, ec, args), ws, graph };
  }

  function world(declared?: "expand" | "data" | "contract", command?: string[]): World {
    const w = createWorld();
    const m = migratingManifest(command);
    if (declared) m.release = { migrate: { ...m.release!.migrate!, class: declared } };
    w.product.setManifest(m);
    worlds.push(w);
    return w;
  }

  it("reads the LIFE-10 classification, script, targets, locks, backend and plan from trusted authorities", async () => {
    const w = world("expand");
    const { inputs, ws, graph } = await collect(w);
    expect(inputs.migrations).toEqual({ declaredClass: "expand", effectiveClass: "expand", sqlDigest: null });
    expect(inputs.scripts.release).toMatchObject({ service: "web", commandDigest: digest(["node", "migrate.js", "--up"]) });
    expect(inputs.targets).toMatchObject({ graphDigest: graph.graphDigest, environmentId: expect.any(String) });
    expect(inputs.configuration.configDigest).toBe(ws.configDigest);
    expect(inputs.providerLocks.lockDigest).toBe(ws.lockDigest);
    expect(inputs.backend.kind).toBe(ws.backend);
    expect(inputs.savedPlan.planDigest).toBe(h("f"));
    expect(inputs.revision.id).not.toBeNull();
    expect(inputs.revision.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an unclassified migration is treated as the strictest class and a class change invalidates", async () => {
    const unclassified = await collect(world());
    expect(unclassified.inputs.migrations).toEqual({ declaredClass: null, effectiveClass: "unclassified", sqlDigest: null });
    const expand = await collect(world("expand"));
    const contract = await collect(world("contract"));
    expect(diffSemantics(expand.semantics, contract.semantics)).toContain("migrations");
    expect(diffSemantics(expand.semantics, unclassified.semantics)).toContain("migrations");
  });

  it("a changed release command changes the scripts component", async () => {
    const a = await collect(world("expand", ["node", "migrate.js", "--up"]));
    const b = await collect(world("expand", ["node", "migrate.js", "--down"]));
    expect(diffSemantics(a.semantics, b.semantics)).toContain("scripts");
  });

  it("only ownership transfers for resources of this graph count (LIFE-12)", async () => {
    const w = world("expand");
    const before = await collect(w);
    const transfer = (address: string) => ({ address, resourceType: "aws_ecs_service", path: "desired_count", from: "iac" as const, to: "autoscaler" as const, approvalId: "apr_1", approvedAt: "2026-09-30T00:00:00.000Z", digest: h("7") });
    (w.resources as unknown as { activeOwnershipTransfers?: () => Promise<unknown[]> }).activeOwnershipTransfers = async () => [transfer("container_service/not-in-this-graph")];
    expect((await collect(w)).semantics.digest).toBe(before.semantics.digest);
    (w.resources as unknown as { activeOwnershipTransfers?: () => Promise<unknown[]> }).activeOwnershipTransfers = async () => [transfer(before.graph.nodes[0].address)];
    const withTransfer = await collect(w);
    expect(diffSemantics(before.semantics, withTransfer.semantics)).toEqual(["ownership"]);
  });

  it("a different saved plan digest changes only the savedPlan component", async () => {
    const w = world("expand");
    const a = await collect(w, h("a"));
    const b = await collect(w, h("b"));
    expect(diffSemantics(a.semantics, b.semantics)).toEqual(["savedPlan"]);
  });

  it("is stable across repeated collection of unchanged authorities", async () => {
    const w = world("expand");
    expect((await collect(w)).semantics.digest).toBe((await collect(w)).semantics.digest);
  });

  it("belongs to the workspace of the operation", async () => {
    const w = world("expand");
    const { ec } = await collect(w);
    expect(ec.workspaceId).toBe(WS);
  });
});
