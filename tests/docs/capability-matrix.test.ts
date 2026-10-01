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
 *  - every registered driver's declaration is consistent with its shape;
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
  for (const key of [...registry().keys()]) if (key.startsWith("aws|aws:")) registry().delete(key);
});

function driver(overrides: Partial<ResourceDriver> & { capabilities?: Partial<ResourceDriver["capabilities"]> } = {}): ResourceDriver {
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
    { provider: "aws", status: "loaded", registrars: ["registerAwsDrivers"] },
    { provider: "gcp", status: "absent", registrars: [] },
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
    expect({ status: result.status, stderr: result.stderr.trim() }).toEqual({ status: 0, stderr: "" });
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

  it("has no inconsistent driver declarations", async () => {
    const data = await collectMatrix({ repoRoot: REPO_ROOT });
    expect(data.problems).toEqual([]);
  });

  it("names every provider that has no driver on this branch, and says so", async () => {
    const data = await collectMatrix({ repoRoot: REPO_ROOT });
    const text = read(path.join(REPO_ROOT, MATRIX_RELATIVE_PATH));
    const without = data.providers.filter((p) => !data.rows.some((r) => r.provider === p));
    for (const provider of without) {
      const row = new RegExp(`^\\| ${provider} \\| none merged \\| none \\|$`, "m");
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
    expect(discovery).toEqual([
      { provider: "aws", status: "loaded", registrars: ["registerAwsDrivers"] },
      { provider: "gcp", status: "absent", registrars: [] },
    ]);
    expect([...registry().keys()].filter((k) => k.startsWith("aws|")).sort()).toEqual(["aws|aws:ecs_service", "aws|aws:rds_instance"]);
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
    expect(text).toContain("| `aws:ecs_service` | `container_service` | `aws.ecs_service@1` | `contract` | `contract` | `contract` | — | — | `service.restart`: `contract`<br>`service.scale`: `emulated` |");
    expect(text).toContain("| `aws:rds_instance` | `postgres` | `aws.rds_instance@1` | `contract` | `contract` | — | — | — | `database.snapshot`: `contract`<br>`service.restart`: `simulated` |");
    expect(text).toContain("| aws | `src/lib/providers/aws/drivers/index.ts` | 2 |");
    expect(text).toContain("| gcp | none merged | none |");
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
  it("records a `real` claim and prints the warning, so the gate above would fail", () => {
    const data = buildMatrix(input([driver({ capabilities: { evidence: { compile: "real", observe: "contract" } } as ResourceDriver["capabilities"] })]));
    expect(data.realClaims).toEqual(["aws.ecs_service@1 compile"]);
    expect(renderMatrix(data)).toContain("claims `real`");
  });

  it("records a `real` observability source", () => {
    const data = buildMatrix({ ...input([]), sourceEvidence: { kubernetes: { level: "real", basis: "x" } } });
    expect(data.realClaims).toEqual(["observability:kubernetes"]);
  });

  it("reports an operation a driver supports but declares no evidence for", () => {
    const data = buildMatrix(input([driver({ capabilities: { evidence: { compile: "contract" } } as ResourceDriver["capabilities"] })]));
    expect(data.problems.map((p) => p.message)).toEqual(["supports `observe` but declares no evidence level for it"]);
    expect(renderMatrix(data)).toContain("**undeclared**");
  });

  it("reports an invalid evidence level", () => {
    const data = buildMatrix(input([driver({ capabilities: { evidence: { compile: "verified", observe: "contract" } } as unknown as ResourceDriver["capabilities"] })]));
    expect(data.problems.map((p) => p.message)).toEqual(['declares the invalid evidence level "verified" for `compile`']);
  });

  it("reports evidence for an operation the driver does not support, and unknown evidence keys", () => {
    const data = buildMatrix(input([driver({ capabilities: { evidence: { compile: "contract", observe: "contract", verify: "contract", bogus: "contract" } } as unknown as ResourceDriver["capabilities"] })]));
    expect(data.problems.map((p) => p.message).sort()).toEqual([
      "declares evidence for `bogus`, which is neither a core operation nor a declared operation",
      "declares evidence for `verify` but does not support it",
    ]);
  });

  it("reports a flag with no implementation and an implementation with no flag", () => {
    const noImpl = buildMatrix(input([driver({ observe: undefined })]));
    expect(noImpl.problems.map((p) => p.message)).toEqual(["declares `observe` but has no `observe` implementation"]);
    const noFlag = buildMatrix(input([driver({ capabilities: { verify: false } as ResourceDriver["capabilities"], verify: async () => { throw new Error("x"); } })]));
    expect(noFlag.problems.map((p) => p.message)).toEqual(["has a `verify` implementation but declares `verify: false`"]);
  });

  it("reports operations the catalog does not know, that lack evidence, or that have no implementation", () => {
    const data = buildMatrix(
      input([
        driver({
          capabilities: { operations: ["service.restart", "service.teleport", "service.scale"], evidence: { compile: "contract", observe: "contract", "service.restart": "contract", "service.teleport": "contract" } } as ResourceDriver["capabilities"],
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
