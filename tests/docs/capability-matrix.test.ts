/**
 * The capability matrix (`docs/platform/CAPABILITY-MATRIX.md`) is generated from
 * the driver registry, the observability evidence table and the capability
 * catalog. These tests are the gate that keeps it honest:
 *
 *  - the committed file is what `scripts/docs/capability-matrix.ts --check` would
 *    write (run as the real CLI, in a fresh process, so it proves the script and
 *    not only the functions behind it);
 *  - **nothing claims `real`**. No live-account acceptance run has been recorded
 *    for any driver or source, so a `real` label anywhere fails here until a
 *    person links the run and changes this assertion on purpose;
 *  - no driver declaration is wrong in a way that misstates evidence (an invalid
 *    level, an unknown capability); other inconsistencies are listed in the file and
 *    ratcheted below, so a NEW one fails here while the known ones are tracked;
 *  - the generator itself behaves: absent providers are tolerated and reported,
 *    a broken drivers index fails loudly, output does not depend on input order,
 *    and each inconsistency it is supposed to catch is caught (negative controls).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITIES, type CapabilityDef } from "@/lib/capabilities/catalog";
import type { ResourceDriver } from "@/lib/drivers/types";
import { SOURCE_EVIDENCE } from "@/lib/observability/evidence";
import {
  MATRIX_RELATIVE_PATH,
  buildMatrix,
  collectMatrix,
  loadProviderDrivers,
  providerSupport,
  renderMatrix,
  type BuildMatrixInput,
} from "../../scripts/docs/capability-matrix";
import { REPO_ROOT, read } from "./markdown";

const FIXTURES = path.join(__dirname, "fixtures");
const catalog = CAPABILITIES as Record<string, CapabilityDef>;

type RegistryGlobal = typeof globalThis & { __zenithDrivers?: Map<string, ResourceDriver> };
const registry = (): Map<string, ResourceDriver> => {
  const g = globalThis as RegistryGlobal;
  g.__zenithDrivers ??= new Map();
  return g.__zenithDrivers;
};

afterEach(() => {
  // collecting the matrix registers real drivers into the process-wide registry; start every test empty
  registry().clear();
});

type DriverOverrides = Omit<Partial<ResourceDriver>, "capabilities"> & { capabilities?: Partial<ResourceDriver["capabilities"]> };

function driver(overrides: DriverOverrides = {}): ResourceDriver {
  const { capabilities, ...rest } = overrides;
  return {
    id: "aws.ecs_service@1",
    provider: "aws",
    kind: "container_service",
    nativeType: "aws:ecs_service",
    capabilities: { compile: true, observe: true, runtime: false, verify: false, discover: false, operations: [], evidence: { compile: "contract", observe: "contract" }, ...capabilities },
    compile: () => ({ addresses: [] }),
    observe: async () => {
      throw new Error("not callable");
    },
    ...rest,
  };
}

const input = (drivers: ResourceDriver[]): BuildMatrixInput => ({
  drivers,
  providers: ["aws", "gcp"],
  discovery: [
    { provider: "aws", status: "loaded", registrars: ["registerAwsDrivers"], skippedRegistrars: [], groups: [], groupDrivers: [] },
    { provider: "gcp", status: "absent", registrars: [], skippedRegistrars: [], groups: [], groupDrivers: [] },
  ],
  sourceEvidence: SOURCE_EVIDENCE,
  capabilities: catalog,
});

describe("the committed capability matrix", () => {
  it("is exactly what `scripts/docs/capability-matrix.ts --check` accepts (run as the real CLI)", () => {
    const tsx = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(process.execPath, [tsx, path.join("scripts", "docs", "capability-matrix.ts"), "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    // driver inconsistencies are reported on stderr as `problem:` lines and do not fail `--check`
    const unexpected = result.stderr.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("problem: "));
    expect({ status: result.status, unexpected }).toEqual({ status: 0, unexpected: [] });
    expect(result.stdout).toContain("is up to date");
  }, 150_000);

  it("equals the in-process render of the live registry, byte for byte", async () => {
    const data = await collectMatrix({ repoRoot: REPO_ROOT });
    expect(read(path.join(REPO_ROOT, MATRIX_RELATIVE_PATH))).toBe(renderMatrix(data));
  });

  it("claims `real` for nothing: no driver operation and no observability source", async () => {
    const data = await collectMatrix({ repoRoot: REPO_ROOT });
    expect(data.realClaims).toEqual([]);
    for (const row of data.rows) {
      for (const cell of Object.values(row.core)) expect(cell.evidence).not.toBe("real");
      for (const op of row.operations) expect(op.evidence).not.toBe("real");
    }
    for (const source of data.sources) expect(source.level).not.toBe("real");
    expect(read(path.join(REPO_ROOT, MATRIX_RELATIVE_PATH))).toContain("No entry claims `real`");
  });

  it("has no driver declaration that misstates evidence, and no NEW inconsistency (a ratchet)", async () => {
    const data = await collectMatrix({ repoRoot: REPO_ROOT });
    const line = (p: { driver: string; message: string }): string => `${p.driver} ${p.message}`;
    // severe: these change what the matrix claims
    expect(data.problems.filter((p) => /invalid evidence level|not in the capability catalog|declares the operation .* but no evidence level|supports .* but declares no evidence/.test(p.message)).map(line)).toEqual([]);
    // everything else must already be known; fix the driver, then delete the line here
    const KNOWN: string[] = [];
    expect(data.problems.map(line).filter((l) => !KNOWN.includes(l))).toEqual([]);
  });

  it("the platform registers all six cloud providers, and every driver has `contract` evidence", async () => {
    const data = await collectMatrix({ repoRoot: REPO_ROOT });
    expect(data.rows.length).toBeGreaterThan(90);
    for (const provider of ["aws", "gcp", "azure", "oci", "kubernetes", "zenith"]) {
      const rows = data.rows.filter((r) => r.provider === provider);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.registration === "registered"), provider).toBe(true);
    }
    for (const row of data.rows) {
      for (const cell of Object.values(row.core)) if (cell.supported) expect(cell.evidence, row.driverId).toBe("contract");
      for (const op of [...row.operations, ...row.refuses]) expect(op.evidence, `${row.driverId} ${op.capability}`).toBe("contract");
    }
  });

  it("the file lists exactly the problems the generator finds", async () => {
    const data = await collectMatrix({ repoRoot: REPO_ROOT });
    const text = read(path.join(REPO_ROOT, MATRIX_RELATIVE_PATH));
    expect(text.includes("None: every merged driver's declaration")).toBe(data.problems.length === 0);
    for (const p of data.problems) expect(text).toContain(`- \`${p.driver}\` ${p.message}.`);
  });

  it("names every provider that has no driver on this branch, and says so", async () => {
    const data = await collectMatrix({ repoRoot: REPO_ROOT });
    const text = read(path.join(REPO_ROOT, MATRIX_RELATIVE_PATH));
    const without = data.providers.filter((p) => !data.rows.some((r) => r.provider === p));
    for (const provider of without) {
      const row = new RegExp(`^\\| ${provider} \\| none \\| none \\| none \\| none \\| none \\| none \\|$`, "m");
      expect(text, `provider ${provider}`).toMatch(row);
    }
    if (without.length > 0) expect(text).toContain("**No resource drivers are merged yet for:**");
  });

  it("lists every observability source and every capability in the catalog", async () => {
    const text = read(path.join(REPO_ROOT, MATRIX_RELATIVE_PATH));
    for (const id of Object.keys(SOURCE_EVIDENCE)) expect(text).toContain(`\`${id}\``);
    for (const name of Object.keys(catalog)) expect(text).toContain(`\`${name}\``);
  });
});

describe("generator: discovery", () => {
  it("imports a provider drivers index that exists and calls its register function", async () => {
    const discovery = await loadProviderDrivers({ repoRoot: path.join(FIXTURES, "fake-repo"), providers: ["aws", "gcp"] });
    expect(discovery.map(({ groupDrivers, ...rest }) => ({ ...rest, groupDrivers: groupDrivers.map((d) => d.id) }))).toEqual([
      { provider: "aws", status: "loaded", registrars: ["registerAwsDrivers"], skippedRegistrars: [], groups: [], groupDrivers: [] },
      { provider: "gcp", status: "absent", registrars: [], skippedRegistrars: [], groups: [], groupDrivers: [] },
    ]);
    expect([...registry().keys()].filter((k) => k.startsWith("aws|")).sort()).toEqual(["aws|aws:ecs_service", "aws|aws:rds_instance"]);
  });

  it("finds driver group modules that no provider index registers, skips `shared`, and registers nothing", async () => {
    const before = registry().size;
    const discovery = await loadProviderDrivers({ repoRoot: path.join(FIXTURES, "fake-repo"), providers: ["kubernetes"] });
    expect(registry().size).toBe(before);
    expect(discovery).toHaveLength(1);
    expect(discovery[0].status).toBe("groups");
    expect(discovery[0].groups).toEqual(["workloads"]);
    expect(discovery[0].groupDrivers.map((d) => d.id)).toEqual(["kubernetes.deployment@1"]);

    const data = buildMatrix({
      ...input(discovery[0].groupDrivers),
      providers: ["kubernetes", "gcp"],
      registration: () => "module only",
      discovery: [discovery[0], { provider: "gcp", status: "absent", registrars: [], skippedRegistrars: [], groups: [], groupDrivers: [] }],
    });
    const text = renderMatrix(data);
    expect(data.rows.map((r) => [r.driverId, r.registration])).toEqual([["kubernetes.deployment@1", "module only"]]);
    expect(text).toContain("| kubernetes | none | `workloads` | 1 | 0 | 0 | 1 |");
    expect(text).toContain("**1 of 1 merged drivers are not registered by the application:** 1 are modules only");
    expect(text).toContain("| `k8s:Deployment` | `container_service` | `kubernetes.deployment@1` | no | `contract` | `contract` | — | — | — | — |");
  });

  it("says whether the APPLICATION registers a provider's drivers: registered, registrable, or module only", async () => {
    // fake-repo: application code (src/lib/boot.ts) calls registerAwsDrivers; kubernetes is a group module only
    const booted = await collectMatrix({ repoRoot: path.join(FIXTURES, "fake-repo") });
    expect(booted.rows.filter((r) => r.provider === "aws").map((r) => r.registration)).toEqual(["registered", "registered"]);
    expect(booted.rows.filter((r) => r.provider === "kubernetes").map((r) => r.registration)).toEqual(["module only"]);
    // registrable-repo: the index and its function exist, but no application code calls it
    const idle = await collectMatrix({ repoRoot: path.join(FIXTURES, "registrable-repo") });
    expect(idle.rows.map((r) => [r.driverId, r.registration])).toEqual([
      ["aws.ecs_service@1", "registrable"],
      ["aws.rds_instance@1", "registrable"],
    ]);
    expect(renderMatrix(idle)).toContain("| aws | `src/lib/providers/aws/drivers/index.ts` | none | 2 | 0 | 2 | 0 |");
    expect(renderMatrix(idle)).toContain("2 are registrable");
  });

  it("calls only the provider's own zero-argument registrar, and reports one that needs arguments it cannot supply", async () => {
    const discovery = await loadProviderDrivers({ repoRoot: path.join(FIXTURES, "args-repo"), providers: ["oci"] });
    expect(discovery[0].registrars).toEqual([]);
    expect(discovery[0].skippedRegistrars).toEqual(["registerOciDrivers", "registerOciOtherDrivers"]);
    const data = buildMatrix({ ...input([]), providers: ["oci"], discovery });
    expect(data.problems.map((p) => p.driver)).toEqual(["oci:registerOciDrivers"]);
  });

  it("tolerates a repository with no provider drivers at all", async () => {
    const discovery = await loadProviderDrivers({ repoRoot: path.join(FIXTURES, "does-not-exist"), providers: ["aws", "kubernetes"] });
    expect(discovery.map((d) => d.status)).toEqual(["absent", "absent"]);
  });

  it("fails loudly when a drivers index exists but cannot be imported", async () => {
    await expect(loadProviderDrivers({ repoRoot: path.join(FIXTURES, "broken-repo"), providers: ["gcp"] })).rejects.toThrow(/fixture drivers index failed to load/);
  });

  it("renders the discovered drivers: provider × native type × operation", async () => {
    const root = path.join(FIXTURES, "fake-repo");
    const discovery = await loadProviderDrivers({ repoRoot: root, providers: ["aws", "gcp"] });
    const drivers = [...registry().values()].filter((d) => d.provider === "aws");
    const data = buildMatrix({ ...input(drivers), discovery });
    const text = renderMatrix(data);
    expect(data.problems).toEqual([]);
    expect(data.realClaims).toEqual([]);
    expect(text).toContain("### aws");
    expect(text).toContain("| `aws:ecs_service` | `container_service` | `aws.ecs_service@1` | yes | `contract` | `contract` | `contract` | — | — | `service.restart`: `contract`<br>`service.scale`: `emulated` |");
    expect(text).toContain("| `aws:rds_instance` | `postgres` | `aws.rds_instance@1` | yes | `contract` | `contract` | — | — | — | `database.snapshot`: `contract`<br>`service.restart`: `simulated` |");
    expect(text).toContain("| aws | `src/lib/providers/aws/drivers/index.ts` | none | 2 | 2 | 0 | 0 |");
    expect(text).toContain("| gcp | none | none | none | none | none | none |");
    // the capability table reports the weakest level among a provider's drivers
    expect(providerSupport(data.rows, "service.restart")).toEqual([{ provider: "aws", weakest: "simulated", drivers: 2 }]);
    expect(providerSupport(data.rows, "service.scale")).toEqual([{ provider: "aws", weakest: "emulated", drivers: 1 }]);
    expect(providerSupport(data.rows, "service.status")).toEqual([]);
  });
});

describe("generator: output", () => {
  it("does not depend on the order drivers were registered in", () => {
    const a = driver({ id: "aws.ecs_service@1", nativeType: "aws:ecs_service" });
    const b = driver({ id: "aws.sqs_queue@1", nativeType: "aws:sqs_queue", kind: "queue" });
    expect(renderMatrix(buildMatrix(input([a, b])))).toBe(renderMatrix(buildMatrix(input([b, a]))));
  });

  it("contains no timestamp, commit id or absolute path, so two runs are byte-identical", () => {
    const text = renderMatrix(buildMatrix(input([driver()])));
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d[T ]\d\d:\d\d/);
    expect(text).not.toMatch(/\b[0-9a-f]{40}\b/);
    expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });

  it("escapes table separators in free text", () => {
    const data = buildMatrix({ ...input([]), sourceEvidence: { "x.y": { level: "contract", basis: "a | b\nc" } } });
    expect(renderMatrix(data)).toContain("| `x.y` | `contract` | a \\| b c |");
  });
});

describe("generator: negative controls (what it must catch)", () => {
  it("renders experimental metadata and refusal evidence without advertising execution", () => {
    const data = buildMatrix(input([driver({
      capabilities: { experimental: true, refuses: ["database.delete"], evidence: { compile: "contract", observe: "contract", "database.delete": "contract" } },
      operations: { "database.delete": async () => ({ ok: false, summary: "refused", simulated: false }) },
    })]));
    expect(data.problems).toEqual([]);
    expect(data.rows[0].operations).toEqual([]);
    expect(data.rows[0].refuses).toEqual([{ capability: "database.delete", known: true, evidence: "contract" }]);
    expect(providerSupport(data.rows, "database.delete")).toEqual([]);
    expect(renderMatrix(data)).toContain("`aws.ecs_service@1` (experimental)");
    expect(renderMatrix(data)).toContain("| `aws.ecs_service@1` | `database.delete` | `contract` |");
  });

  it("validates refusal declarations: catalog, evidence, implementation and disjointness", () => {
    const data = buildMatrix(input([driver({ capabilities: { refuses: ["service.teleport", "database.delete"] } })]));
    expect(data.problems.map((p) => p.message)).toEqual(expect.arrayContaining([
      "declares the operation `service.teleport`, which is not in the capability catalog",
      "declares the operation `database.delete` but no evidence level for it",
      "declares the operation `database.delete` but has no implementation for it",
    ]));
    const overlap = buildMatrix(input([driver({
      capabilities: { operations: ["database.delete"], refuses: ["database.delete"], evidence: { compile: "contract", observe: "contract", "database.delete": "real" } },
      operations: { "database.delete": async () => ({ ok: false, summary: "refused", simulated: false }) },
    })]));
    expect(overlap.problems.map((p) => p.message)).toContain("declares the operation `database.delete` as both executable and refusal-only");
    expect(overlap.realClaims).toContain("aws.ecs_service@1 database.delete");
  });

  it("records a `real` claim and prints the warning, so the gate above would fail", () => {
    const data = buildMatrix(input([driver({ capabilities: { evidence: { compile: "real", observe: "contract" } } })]));
    expect(data.realClaims).toEqual(["aws.ecs_service@1 compile"]);
    expect(renderMatrix(data)).toContain("claims `real`");
  });

  it("records a `real` observability source", () => {
    const data = buildMatrix({ ...input([]), sourceEvidence: { kubernetes: { level: "real", basis: "x" } } });
    expect(data.realClaims).toEqual(["observability:kubernetes"]);
  });

  it("reports an operation a driver supports but declares no evidence for", () => {
    const data = buildMatrix(input([driver({ capabilities: { evidence: { compile: "contract" } } })]));
    expect(data.problems.map((p) => p.message)).toEqual(["supports `observe` but declares no evidence level for it"]);
    expect(renderMatrix(data)).toContain("**undeclared**");
  });

  it("reports an invalid evidence level", () => {
    const data = buildMatrix(input([driver({ capabilities: { evidence: { compile: "verified", observe: "contract" } } as unknown as DriverOverrides["capabilities"] })]));
    expect(data.problems.map((p) => p.message)).toEqual(['declares the invalid evidence level "verified" for `compile`']);
  });

  it("reports evidence for an operation the driver does not support, and unknown evidence keys", () => {
    const data = buildMatrix(input([driver({ capabilities: { evidence: { compile: "contract", observe: "contract", verify: "contract", bogus: "contract" } } })]));
    expect(data.problems.map((p) => p.message).sort()).toEqual([
      "declares evidence for `bogus`, which is neither a core operation nor a declared operation",
      "declares evidence for `verify` but does not support it",
    ]);
  });

  it("reports a flag with no implementation and an implementation with no flag", () => {
    const noImpl = buildMatrix(input([driver({ observe: undefined })]));
    expect(noImpl.problems.map((p) => p.message)).toEqual(["declares `observe` but has no `observe` implementation"]);
    const noFlag = buildMatrix(input([driver({ capabilities: { verify: false }, verify: async () => { throw new Error("x"); } })]));
    expect(noFlag.problems.map((p) => p.message)).toEqual(["has a `verify` implementation but declares `verify: false`"]);
  });

  it("reports operations the catalog does not know, that lack evidence, or that have no implementation", () => {
    const data = buildMatrix(
      input([
        driver({
          capabilities: { operations: ["service.restart", "service.teleport", "service.scale"], evidence: { compile: "contract", observe: "contract", "service.restart": "contract", "service.teleport": "contract" } },
          operations: { "service.restart": async () => ({ ok: true, summary: "", simulated: false }), "service.status": async () => ({ ok: true, summary: "", simulated: false }) },
        }),
      ])
    );
    expect(data.problems.map((p) => p.message).sort()).toEqual([
      "declares the operation `service.scale` but has no implementation for it",
      "declares the operation `service.scale` but no evidence level for it",
      "declares the operation `service.teleport` but has no implementation for it",
      "declares the operation `service.teleport`, which is not in the capability catalog",
      "implements the operation `service.status` but does not declare it in capabilities.operations",
    ]);
  });

  it("a consistent driver produces no problems", () => {
    expect(buildMatrix(input([driver()])).problems).toEqual([]);
  });
});

describe("the script file itself", () => {
  it("lives where the docs say it does", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "docs", "capability-matrix.ts"))).toBe(true);
    expect(MATRIX_RELATIVE_PATH).toBe("docs/platform/CAPABILITY-MATRIX.md");
  });
});
