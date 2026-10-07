/**
 * LIFE09 environment admission through the actual composition and release activities.
 * Provider replies and persistence are isolated models; Ed25519 provenance is real.
 * No activity constructor, policy checker or provenance verifier is mocked.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/lib/controlplane/types";
import type { BuildIsolationPolicy } from "@/lib/execution/build-isolation";
import type { World } from "./fakes/world";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-egress-composition-", { fast: true });
const { composeExecutionActivities } = await import("@/lib/platform/execution");
const { createWorld } = await import("./fakes/world");
const { awsAttestation } = await import("./fakes/provenance");
const { builtManifest, ENV, OP } = await import("./fakes/fixtures");
const worlds: World[] = [];
const secrets = new WeakMap<World, string>();
const unexpectedQuery = vi.fn(async () => { throw new Error("Egress composition must not enter default SQL ports."); });
const unexpectedTransaction = vi.fn(async () => { throw new Error("Egress composition must not enter default SQL transactions."); });
const db: Sql = { query: unexpectedQuery, tx: unexpectedTransaction };

afterEach(() => {
  try {
    while (worlds.length) worlds.pop()!.dispose();
    expect(unexpectedQuery).not.toHaveBeenCalled();
    expect(unexpectedTransaction).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

function compose(w: World, policy?: BuildIsolationPolicy) {
  const ports = { ...w.deps, releaseSafety: undefined };
  // Omitting this field is essential: createWorld supplies a closed test policy.
  // The actual constructor must derive the default from the operator environment.
  delete ports.buildIsolation;
  if (policy) ports.buildIsolation = policy;
  let secretKey = secrets.get(w);
  if (!secretKey) { secretKey = randomBytes(32).toString("hex"); secrets.set(w, secretKey); }
  return composeExecutionActivities({ db, secretKey, workerIdentity: "egress-composition", planDir: w.planDir, ports });
}

async function prepared(environment: string | undefined, policy?: BuildIsolationPolicy, open = true) {
  vi.stubEnv("ZENITH_BUILD_ALLOW_OPEN_EGRESS", environment);
  const w = createWorld(); worlds.push(w);
  w.product.setManifest(builtManifest());
  if (open) w.build.result = { ...w.build.result, attestation: awsAttestation({
    network: { egress: "unrestricted", mechanism: "none" }, dependencies: { downloads: "direct" },
  }) };
  const activities = compose(w, policy);
  await activities.markOperation({ operationId: OP, status: "running" });
  const lease = await activities.acquireLease({ operationId: OP, scope: `env:${ENV}`, ttlMs: 300_000 });
  await activities.planInfrastructure({ operationId: OP, lease });
  w.broker.approval = { approved: true, rejected: false, approvalId: "egress-composition-review" };
  return { w, activities, lease };
}
const provenance = (w: World) => w.evidence.ofKind("build").filter(row => row.summary.kind === "build.provenance");

async function refusesBuild(fixture: Awaited<ReturnType<typeof prepared>>) {
  const { w, activities, lease } = fixture;
  await expect(activities.buildArtifacts({ operationId: OP, lease })).rejects.toThrow(/egress was not restricted/);
  expect(provenance(w)).toHaveLength(0);
  expect(w.workloads.deployed).toHaveLength(0);
}
async function admitsBuild(fixture: Awaited<ReturnType<typeof prepared>>, exceptions: string[]) {
  const { w, activities, lease } = fixture;
  const result = await activities.buildArtifacts({ operationId: OP, lease });
  expect(provenance(w)).toHaveLength(1);
  expect(provenance(w)[0].summary.exceptions).toEqual(exceptions);
  expect(provenance(w)[0].summary.jwsParts).toHaveLength(3);
  await expect(activities.deployWorkloads({ operationId: OP, lease, images: result.images })).resolves.toEqual({ services: 1 });
  expect(w.workloads.deployed).toHaveLength(1);
}

describe("build egress operator environment in actual execution composition", () => {
  it.each([
    ["absent", undefined], ["empty", ""], ["zero", "0"], ["word true", "true"],
    ["leading zero", "01"], ["trailing whitespace", "1 "],
  ])("refuses unrestricted build egress when the environment is %s", async (_label, environment) => {
    await refusesBuild(await prepared(environment));
  });

  it("admits an allowlisted build with no operator exception and records no exception", async () => {
    await admitsBuild(await prepared(undefined, undefined, false), []);
  });

  it("admits literal one and retains the signed open_egress exception before release", async () => {
    await admitsBuild(await prepared("1"), ["open_egress"]);
  });

  it("captures the default when composed rather than accepting a later environment enable", async () => {
    const fixture = await prepared(undefined);
    vi.stubEnv("ZENITH_BUILD_ALLOW_OPEN_EGRESS", "1");
    await refusesBuild(fixture);
  });

  it("a freshly composed closed worker refuses the signed artifact from an earlier open worker", async () => {
    const { w, activities, lease } = await prepared("1");
    const result = await activities.buildArtifacts({ operationId: OP, lease });
    expect(provenance(w)[0].summary.exceptions).toEqual(["open_egress"]);
    vi.stubEnv("ZENITH_BUILD_ALLOW_OPEN_EGRESS", "0");
    const closed = compose(w);
    await expect(closed.deployWorkloads({ operationId: OP, lease, images: result.images })).rejects.toThrow(/egress was not restricted|will not be released/);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it("an explicit closed dependency overrides literal one", async () => {
    await refusesBuild(await prepared("1", { allowOpenEgress: false }));
  });

  it("an explicit open dependency overrides the absent environment and its revocation refuses release", async () => {
    const policy = { allowOpenEgress: true };
    const { w, activities, lease } = await prepared(undefined, policy);
    const result = await activities.buildArtifacts({ operationId: OP, lease });
    expect(provenance(w)[0].summary.exceptions).toEqual(["open_egress"]);
    policy.allowOpenEgress = false;
    await expect(activities.deployWorkloads({ operationId: OP, lease, images: result.images })).rejects.toThrow(/egress was not restricted|will not be released/);
    expect(w.workloads.deployed).toHaveLength(0);
  });
});
