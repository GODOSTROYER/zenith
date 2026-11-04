/**
 * PROD-OPS-03: the rolling-upgrade / rollback runbook script (scripts/ops/rolling-upgrade.mjs).
 * Plan construction, ordering and refusals are tested purely; the dry-run path of `main`
 * is exercised end to end with the previous images supplied so that no docker, kubectl or
 * temporal command runs. A real execution needs docker or a cluster and is the operational
 * rehearsal in docs/platform/operations/ROLLING-UPGRADES.md.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATE_SUITES, UsageError, buildPlan, main, parseArgs } from "../../scripts/ops/rolling-upgrade.mjs";

const digest = (c: string) => `registry.example/zenith/app@sha256:${c.repeat(64)}`;
const base = ["--topology", "compose", "--api-image", digest("a"), "--worker-image", digest("b"), "--migration-image", digest("c")];
const plan = (args: string[], command = "upgrade", ctx = {}) => buildPlan(parseArgs([command, ...args]), ctx) as Array<{ id: string; mutates: boolean; argv?: string[]; env?: Record<string, string>; note?: string }>;
const ids = (args: string[], command?: string) => plan(args, command).map((s) => s.id);

describe("upgrade plan", () => {
  it("expands the schema first, then rolls the worker, then the API, then verifies", () => {
    expect(ids(base)).toEqual(["gates", "images", "discover-api", "discover-worker", "migrate-dry-run", "migrate", "worker", "worker-ready", "api", "api-ready", "verify-schema", "verify-workflows"]);
  });

  it("runs the replay, versioning, schema-compat and protocol gates before anything changes", () => {
    const gates = plan(base)[0]!;
    expect(gates.argv).toEqual(["npx", "vitest", "run", ...GATE_SUITES]);
    expect(GATE_SUITES).toEqual(expect.arrayContaining(["tests/workflows/history-replay.test.ts", "tests/controlplane/migration-compat.test.ts", "tests/runners/protocol-window.test.ts"]));
    for (const step of plan(base)) if (step.mutates) expect(ids(base).indexOf(step.id)).toBeGreaterThan(ids(base).indexOf("gates"));
  });

  it("skipping the gates is explicit and recorded as skipped, never as a pass", () => {
    const gates = plan([...base, "--gates", "skip"])[0]!;
    expect(gates).toMatchObject({ id: "gates", note: "SKIPPED" });
    expect(gates.argv).toBeUndefined();
  });

  it("refuses mutable image references", () => {
    for (const tag of ["registry.example/zenith/app:latest", "registry.example/zenith/app@sha256:abc", "app"]) {
      expect(() => plan(["--topology", "compose", "--api-image", tag, "--worker-image", digest("b"), "--migration-image", digest("c")])).toThrow(UsageError);
    }
  });

  it("promotes the new worker version only after the worker is ready and before the API is replaced", () => {
    const withVersioning = ids([...base, "--versioning", "auto_upgrade", "--worker-build-id", "build-2"]);
    expect(withVersioning.indexOf("worker-ready")).toBeLessThan(withVersioning.indexOf("promote-version"));
    expect(withVersioning.indexOf("promote-version")).toBeLessThan(withVersioning.indexOf("api"));
    const promote = plan([...base, "--versioning", "pinned", "--worker-build-id", "build-2", "--deployment-name", "zenith-exec"]).find((s) => s.id === "promote-version")!;
    expect(promote.argv).toEqual(["temporal", "worker", "deployment", "set-current-version", "--deployment-name", "zenith-exec", "--build-id", "build-2", "--yes"]);
    expect(ids(base)).not.toContain("promote-version");
  });

  it("requires a worker build id whenever versioning is on", () => {
    expect(() => plan([...base, "--versioning", "auto_upgrade"])).toThrow(/worker-build-id/);
  });

  it("passes the contract-migration confirmation to the migration step only when given", () => {
    expect(plan(base).find((s) => s.id === "migrate")!.env).not.toHaveProperty("ZENITH_ALLOW_CONTRACT_MIGRATIONS");
    expect(plan([...base, "--confirm-contract", "46"]).find((s) => s.id === "migrate")!.env).toMatchObject({ ZENITH_ALLOW_CONTRACT_MIGRATIONS: "46" });
  });

  it("drives docker compose with the installation compose file and passes images through the environment", () => {
    const migrate = plan([...base, "--env-file", "/etc/zenith/install.env"]).find((s) => s.id === "migrate")!;
    expect(migrate.argv).toEqual(["docker", "compose", "-f", "deploy/self-hosted/compose.yml", "--env-file", "/etc/zenith/install.env", "--profile", "maintenance", "run", "--rm", "platform-migrate"]);
    expect(migrate.env).toMatchObject({ ZENITH_MIGRATION_IMAGE: digest("c"), ZENITH_API_IMAGE: digest("a"), ZENITH_WORKER_IMAGE: digest("b") });
    const worker = plan(base).find((s) => s.id === "worker")!;
    expect(worker.argv).toContain("--no-deps");
    expect(worker.argv!.slice(-1)).toEqual(["execution-worker"]);
  });

  it("drives kubectl for the k8s topology and needs the namespace; the migration Job defaults to the checked-in manifest", () => {
    const k8s = ["--topology", "k8s", "--api-image", digest("a"), "--worker-image", digest("b"), "--migration-image", digest("c")];
    expect(() => plan(k8s)).toThrow(/namespace/);
    const steps = plan([...k8s, "--namespace", "zenith", "--migration-job", "migrate.yaml", "--context", "prod"]);
    expect(steps.find((s) => s.id === "worker")!.argv).toEqual(["kubectl", "--context", "prod", "-n", "zenith", "set", "image", "deployment/zenith-execution-worker", `execution-worker=${digest("b")}`]);
    expect(steps.map((s) => s.id).indexOf("migrate")).toBeLessThan(steps.map((s) => s.id).indexOf("worker"));
    expect(steps.find((s) => s.id === "migrate")!.argv).toEqual(["kubectl", "--context", "prod", "-n", "zenith", "apply", "-f", "-"]);
    expect(steps.find((s) => s.id === "migrate")).toMatchObject({ stdin: { file: "migrate.yaml", image: digest("c") } });
    expect(plan([...k8s, "--namespace", "zenith"]).find((s) => s.id === "migrate")).toMatchObject({ stdin: { file: "deploy/k8s/platform-migrate-job.yaml" } });
  });

  it("rejects unknown options and topologies", () => {
    expect(() => parseArgs(["upgrade", "--nope", "1"])).toThrow(UsageError);
    expect(() => plan(["--topology", "swarm", "--api-image", digest("a"), "--worker-image", digest("b"), "--migration-image", digest("c")])).toThrow(/topology/);
  });
});

describe("rollback plan", () => {
  const state = { previousApiImage: digest("1"), previousWorkerImage: digest("2"), versioning: "off", contractMigrationApplied: false };
  const rollback = (extra: string[] = [], overrides: Record<string, unknown> = {}) => plan(["--topology", "compose", "--state", "state.json", ...extra], "rollback", { readState: () => ({ ...state, ...overrides }) });

  it("restores the recorded images API first then worker, and never touches the database", () => {
    const steps = rollback();
    expect(steps.map((s) => s.id)).toEqual(["api", "worker", "verify-workflows"]);
    expect(steps[0]!.env).toMatchObject({ ZENITH_API_IMAGE: digest("1"), ZENITH_WORKER_IMAGE: digest("2") });
    expect(JSON.stringify(steps)).not.toMatch(/migrate/);
  });

  it("re-promotes the previous worker version when versioning was on", () => {
    const steps = rollback(["--versioning", "auto_upgrade"], { versioning: "auto_upgrade", previousWorkerBuildId: "build-1", deploymentName: "zenith-execution" });
    expect(steps.find((s) => s.id === "promote-version")!.argv).toContain("build-1");
    expect(() => rollback(["--versioning", "auto_upgrade"], { versioning: "auto_upgrade" })).toThrow(/previous worker build id/);
  });

  it("refuses an image rollback after an approved contract migration", () => {
    expect(() => rollback([], { contractMigrationApplied: true })).toThrow(/contract migration/);
  });

  it("refuses to roll back to a mutable or missing image", () => {
    expect(() => rollback([], { previousApiImage: "app:latest" })).toThrow(/immutable/);
    expect(() => rollback([], { previousWorkerImage: undefined })).toThrow(/immutable/);
  });
});

describe("dry run end to end", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints the plan and runs nothing that changes state (previous images supplied, so no tool is invoked)", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    const code = await main(["plan", ...base, "--previous-api-image", digest("1"), "--previous-worker-image", digest("2")]);
    const output = written.join("");
    expect(code).toBe(0);
    expect(output).toContain("dry run");
    expect(output).toContain("would run: docker compose");
    expect(output).not.toMatch(/\bFAILED\b/);
    expect(output).toContain("0 failed");
  });

  it("upgrade without --execute is also a dry run", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    expect(await main(["upgrade", ...base, "--previous-api-image", digest("1"), "--previous-worker-image", digest("2")])).toBe(0);
    expect(written.join("")).toContain("dry run");
  });
});
