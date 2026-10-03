/** Safety unit evidence only; this suite never starts Docker or Temporal. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertOwnedPackagedBuilder, assertPackagedSourceUnchanged, cleanupOwnedImage, cleanupOwnedResource, command, createPrivateScratch, packagedSourceDigest, packagedTemporalControlSource, PackagedCommandError, parsePackagedArgs, prepareTemporalTls, privateTemporaryBase, redactDiagnosticLogs, refusalFailureCategory, renderTemporalServerConfiguration, sanitizeClientEvidence, sanitizeContainerState, sanitizeImageId, sanitizeLockedDependencies, sanitizePackagedCommandFailure, sanitizePackagedReadiness, sanitizePgWaiterEvidence, sanitizeTemporalControlEvidence, schemaOutageObserverSql, TEMPORAL_ADMIN_IMAGE, TEMPORAL_CONFIG_DIR, TEMPORAL_IMAGE, waitForRefusalExit, workerFailureCategory } from "../../scripts/acceptance/packaged-worker.mjs";
import { assertPackagedAcceptanceTarget } from "../../workers/execution/packaged-target";
import { EXECUTION_FAILURE_CATEGORIES } from "../../workers/execution/startup";

const env = { ZENITH_PACKAGED_ACCEPTANCE: "1", ZENITH_STORE: "file", ZENITH_DATA: "/var/lib/zenith",
  ZENITH_WORKER_PLAN_DIR: "/var/lib/zenith/platform-plans", ZENITH_TEMPORAL_ADDRESS: "temporal:7233",
  ZENITH_PLATFORM_DB_URL: "postgresql://postgres:private-fixture-password@postgres:5432/zenith_packaged" };

describe("packaged real-server admission contracts [source and scalar models]", () => {
  const template = readFileSync(new URL("../../deploy/acceptance/temporal-worker-test.yaml", import.meta.url), "utf8");
  const builder = "zenith-owned-0123456789ab";
  const buildImage = "moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
  const inspected = `Name: ${builder}\nDriver: docker-container\nNodes:\nName: ${builder}0\nEndpoint: desktop-linux\nDriver Options: image="${buildImage}" memory="4g" default-load="true"\n`;
  it("admits the exact external bounded builder observation, without treating it as a creation receipt", () => {
    expect(assertOwnedPackagedBuilder(builder, inspected, "desktop-linux")).toBe(builder);
  });
  it.each([
    { name: "default", observed: inspected }, { name: builder, observed: inspected.replace(builder, "foreign") },
    { name: builder, observed: inspected.replace("docker-container", "docker") },
    { name: builder, observed: inspected.replace('memory="4g"', 'memory="8g"') },
    { name: builder, observed: inspected.replace(buildImage, "moby/buildkit:latest") },
    { name: builder, observed: inspected.replace("Endpoint: desktop-linux", "Endpoint: remote") },
  ])("refuses an unconfirmed or unbounded builder ($name)", ({ name, observed }) => {
    expect(() => assertOwnedPackagedBuilder(name, observed, "desktop-linux")).toThrow("externally owned bounded builder");
  });
  it("renders only bounded hex credentials, retaining real mutual TLS and disabled HTTP", () => {
    const rendered = renderTemporalServerConfiguration(template, "a".repeat(64));
    const config = loadYaml(rendered) as {
      persistence: { datastores: Record<string, { sql: { databaseName: string; connectAddr: string; password: string } }> };
      global: { tls: Record<"frontend" | "internode", { server: { requireClientAuth: boolean; certFile: string; keyFile: string; clientCaFiles: string[] }; client: { serverName: string; rootCaFiles: string[]; disableHostVerification?: boolean } }> };
      services: { frontend: { rpc: { httpPort: number } } };
    };
    expect(config.persistence.datastores.default.sql).toMatchObject({ databaseName: "temporal", connectAddr: "postgres:5432", password: "a".repeat(64) });
    expect(config.persistence.datastores.visibility.sql).toMatchObject({ databaseName: "temporal_visibility", connectAddr: "postgres:5432", password: "a".repeat(64) });
    for (const role of ["frontend", "internode"] as const) {
      expect(config.global.tls[role].server).toEqual({ requireClientAuth: true, certFile: "/etc/zenith-temporal/server.crt", keyFile: "/etc/zenith-temporal/server.key", clientCaFiles: ["/etc/zenith-temporal/ca.crt"] });
      expect(config.global.tls[role].client).toEqual({ serverName: "temporal", rootCaFiles: ["/etc/zenith-temporal/ca.crt"] });
    }
    expect(config.services.frontend.rpc.httpPort).toBe(0);
    expect(rendered).not.toContain("__OWNED_POSTGRES_PASSWORD__");
  });
  it.each(["", "a".repeat(63), "a".repeat(65), "a\npermissions: admin", "private-canary"])("refuses malformed password data before YAML insertion", password => {
    expect(() => renderTemporalServerConfiguration(template, password)).toThrow("configuration is invalid");
  });
  it("refuses missing or additional template authority rather than substituting a partial config", () => {
    expect(() => renderTemporalServerConfiguration(template.replaceAll("__OWNED_POSTGRES_PASSWORD__", "unbound"), "a".repeat(64))).toThrow();
    expect(() => renderTemporalServerConfiguration(template + "\n__OWNED_POSTGRES_PASSWORD__", "a".repeat(64))).toThrow();
  });
  it("refuses nonprivate TLS scratch before invoking any certificate command", async () => {
    const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), "zenith-tls-mode-contract-"));
    let calls = 0;
    try {
      await chmod(temporary, 0o755);
      await expect(prepareTemporalTls(temporary, async () => { calls++; throw new Error("Unexpected certificate command."); })).rejects.toThrow("Private TLS custody");
      expect(calls).toBe(0);
      expect(await readdir(temporary)).toEqual([]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  it("requires the fifth current observation check and exports no arbitrary readiness payload", () => {
    expect(sanitizePackagedReadiness({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation: "ok" }, privatePayload: "private-canary" }))
      .toEqual({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation: "ok" } });
  });
  it.each([undefined, "unavailable", "unknown", true])("refuses absent or unsuccessful current observation (%s)", reconciliation => {
    expect(() => sanitizePackagedReadiness({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation } })).toThrow("incomplete");
  });
  it("bounds returned schedule metadata and never promotes the old operation to a cloud write", () => {
    const result = { scheduleOwned: true, encryptedInput: true, paused: false, status: "completed", runId: "01234567-0123-4123-8123-0123456789ab", completedAt: 1_791_000_000_000, current: true };
    expect(sanitizeTemporalControlEvidence("observe", { ...result, password: "private-canary", cloudWritesProven: true })).toEqual(result);
    expect(JSON.stringify(sanitizeTemporalControlEvidence("observe", { ...result, privatePayload: "private-canary" }))).not.toContain("private-canary");
  });
  it.each([
    { scheduleOwned: false }, { encryptedInput: false }, { runId: "private-canary" }, { completedAt: "private-canary" },
    { status: "deferred", current: true }, { paused: true, current: true }, { status: "unconfirmed" },
  ])("refuses damaged schedule evidence (%j)", change => {
    expect(() => sanitizeTemporalControlEvidence("observe", { scheduleOwned: true, encryptedInput: true, paused: false, status: "completed", runId: "01234567-0123-4123-8123-0123456789ab", completedAt: 1_791_000_000_000, current: true, ...change })).toThrow("unconfirmed");
  });
  it("requires distinct actual observer, claimant and blocker PIDs", () => {
    expect(sanitizePgWaiterEvidence([{ observerPid: 11, waiterPid: 12, blockerPid: 13, query: "private-canary" }])).toEqual({ observerPid: 11, waiterPid: 12, blockerPid: 13 });
  });
  it.each([
    { value: [] }, { value: [{ observerPid: 11, waiterPid: 11, blockerPid: 13 }] },
    { value: [{ observerPid: 11, waiterPid: 12, blockerPid: 12 }] },
    { value: [{ observerPid: 0, waiterPid: 12, blockerPid: 13 }] },
    { value: [{ observerPid: 11, waiterPid: "private-canary", blockerPid: 13 }] },
  ])("refuses missing or ambiguous waiter observations (%j)", ({ value }) => {
    expect(() => sanitizePgWaiterEvidence(value)).toThrow("not confirmed");
  });
  it("scopes the real wait query to its exact disposable database, blocker and schema read", () => {
    const query = schemaOutageObserverSql("zenith-pkg-arm64-0123456789ab");
    expect(query).toContain("b.pid=any(pg_blocking_pids(a.pid))");
    expect(query).toContain("a.pid<>pg_backend_pid()");
    expect(query).toContain("a.datname='zenith_packaged'");
    expect(query).toContain("select version, name, applied_at, checksum from platform.schema_migrations%");
    expect(query).toContain("b.application_name='zenith-pkg-arm64-0123456789ab-schema-outage'");
    expect(() => schemaOutageObserverSql("foreign'; select 1; --")).toThrow("identity is invalid");
  });
  it("uses only image-local authenticated control with a read-only production codec and pinned targets", () => {
    const source = packagedTemporalControlSource();
    expect(source).toContain("process.env.NODE_ENV!=='production'");
    expect(source).toContain("process.env.ZENITH_TEMPORAL_ADDRESS!=='temporal:7233'");
    expect(source).toContain("encode:async()=>{throw new Error();}");
    expect(source).toContain("clientCertPair");
    expect(source).toContain("serverNameOverride:auth==='wrong-server-name'?'unowned.acceptance.invalid':'temporal'");
    expect(source).toContain("getHandle('zenith-reconcile-sweep-v1')");
    expect(source).not.toContain("workflow.start(");
    expect(source).not.toContain("Worker.create(");
  });
  it("prepares actual server client-auth and SAN negatives, current-result recovery and owned cleanup without a TLS bypass", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    expect(harness).toContain('for (const auth of ["none", "rogue", "wrong-server-name"])');
    expect(harness).toContain('NODE_ENV: "production"');
    expect(harness).toContain('ZENITH_TEMPORAL_NAMESPACE: runId');
    expect(harness).toContain('ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: "provision"');
    expect(harness).toContain('await observation("completed", previous.runId)');
    expect(harness).toContain('await observation("completed", beforeRestart.runId)');
    expect(harness).toContain('schemaOutageObserverSql(runId)');
    expect(harness).toContain('for (const name of ["ca.crt", "server.crt", "server.key", "server.yaml"])');
    expect(harness).not.toContain('"--tls-disable-host-verification"');
    expect(harness).not.toContain('"--allow-no-auth"');
    expect(harness).not.toContain('"--privileged"');
    expect(harness).not.toContain('type=bind');
    expect(harness).not.toMatch(/docker\s+system\s+prune|builder\s+prune/);
  });
});

async function sourceFixture(run: (source: string, base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "zenith-packaged-source-fixture-"));
  const source = path.join(base, "source");
  try {
    for (const relative of ["docker", "src/lib", "workers/execution", "deploy/aws/ssm-documents", "policy/dist"]) {
      await mkdir(path.join(source, relative), { recursive: true });
    }
    for (const relative of ["package.json", "package-lock.json", "tsconfig.json"]) await writeFile(path.join(source, relative), "{}\n");
    await writeFile(path.join(source, ".dockerignore"), ".git\n.env*\n");
    await writeFile(path.join(source, "docker/worker.Dockerfile"), [
      "FROM fixture AS build", "COPY package.json package-lock.json ./", "COPY tsconfig.json ./",
      "COPY src/lib ./src/lib", "COPY workers/execution ./workers/execution",
      "COPY deploy/aws/ssm-documents ./deploy/aws/ssm-documents", "FROM fixture AS runtime",
      "COPY --from=build /app/dist/execution ./dist/execution", "COPY --chown=zenith:zenith policy/dist ./policy/dist", "",
    ].join("\n"));
    await run(source, base);
  } finally { await rm(base, { recursive: true, force: true }); }
}

describe("private packaged acceptance storage", () => {
  it("admits canonical outside-source storage with private permissions", async () => {
    await sourceFixture(async (source, base) => {
      const scratch = await createPrivateScratch(source, base, "private-scratch-");
      expect(path.dirname(scratch)).toBe(await realpath(base));
      expect((await lstat(scratch)).mode & 0o777).toBe(0o700);
      expect(await readdir(scratch)).toEqual([]);
    });
  });
  it.each(["source", "descendant", "source-alias", "descendant-alias"])("refuses %s temp placement before creating a secret directory", async (kind) => {
    await sourceFixture(async (source, base) => {
      const nested = path.join(source, "src/lib/tmp");
      await mkdir(nested);
      const direct = kind.startsWith("source") ? source : nested;
      const location = kind.endsWith("alias") ? path.join(base, "temporary-alias") : direct;
      if (kind.endsWith("alias")) await symlink(direct, location);
      const before = await readdir(direct);
      await expect(createPrivateScratch(source, location, "secret-scratch-")).rejects.toThrow("outside the source tree");
      expect(await readdir(direct)).toEqual(before);
    });
  });
  it("resolves a source alias before deciding whether a temporary base is external", async () => {
    await sourceFixture(async (source, base) => {
      const alias = path.join(base, "source-alias");
      await symlink(source, alias);
      await expect(privateTemporaryBase(alias, path.join(source, "src/lib"))).rejects.toThrow("outside the source tree");
    });
  });
  it("uses the same guard for runtime secrets and private diagnostics before generating keys or calling Docker", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    const main = harness.slice(harness.indexOf("export async function packagedWorkerMain("));
    const guard = main.indexOf("const scratch = await createPrivateScratch(");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(main.indexOf('generateKeyPairSync("ed25519")'));
    expect(guard).toBeLessThan(main.indexOf('await writeFile(envFile'));
    expect(guard).toBeLessThan(main.indexOf('await docker(["build"'));
    expect(main).toContain('directory = await createPrivateScratch(process.cwd(), os.tmpdir(), `${runId}-diagnostics-`)');
  });
});

describe("actual packaged COPY input binding", () => {
  it("includes a Git-ignored imported module copied by Docker", async () => {
    await sourceFixture(async (source) => {
      await writeFile(path.join(source, ".gitignore"), "src/lib/ignored-module.ts\n");
      await writeFile(path.join(source, "workers/execution/entrypoint.ts"), 'import "../../src/lib/ignored-module";\n');
      const ignored = path.join(source, "src/lib/ignored-module.ts");
      await writeFile(ignored, "export const observed = 1;\n");
      const before = await packagedSourceDigest(source);
      await writeFile(ignored, "export const observed = 2;\n");
      expect(await packagedSourceDigest(source)).not.toBe(before);
    });
  });
  it.each([".dockerignore", "docker/worker.Dockerfile.dockerignore", "docker/worker.Dockerfile"])("binds changes to %s", async (relative) => {
    await sourceFixture(async (source) => {
      const before = await packagedSourceDigest(source);
      const filename = path.join(source, relative);
      const content = relative.endsWith("Dockerfile") ? readFileSync(filename, "utf8") + "# changed context recipe\n" : "src/lib/ignored-module.ts\n";
      await writeFile(filename, content);
      expect(await packagedSourceDigest(source)).not.toBe(before);
    });
  });
  it("rejects new COPY authority outside the bound root inventory", async () => {
    await sourceFixture(async (source) => {
      const filename = path.join(source, "docker/worker.Dockerfile");
      await writeFile(filename, readFileSync(filename, "utf8") + "COPY additional-source ./extra\n");
      await expect(packagedSourceDigest(source)).rejects.toThrow("COPY inventory differs");
    });
  });
  it("rejects ADD authority absent from the bound inventory", async () => {
    await sourceFixture(async (source) => {
      const filename = path.join(source, "docker/worker.Dockerfile");
      await writeFile(filename, readFileSync(filename, "utf8") + "ADD additional-source ./extra\n");
      await expect(packagedSourceDigest(source)).rejects.toThrow("ADD inputs are not bound");
    });
  });
  it.each(["file", "directory", "ancestor", "context-control"])("rejects a copied %s symlink rather than claiming full source binding", async (kind) => {
    await sourceFixture(async (source, base) => {
      const outside = path.join(base, "outside-input");
      await mkdir(outside);
      await writeFile(path.join(outside, "module.ts"), "export const observed = 1;\n");
      const link = kind === "file" ? path.join(source, "src/lib/module.ts")
        : kind === "directory" ? path.join(source, "src/lib/alias")
          : kind === "ancestor" ? path.join(source, "src") : path.join(source, ".dockerignore");
      if (kind === "ancestor" || kind === "context-control") await rm(link, { recursive: true, force: true });
      await symlink(kind === "file" || kind === "context-control" ? path.join(outside, "module.ts") : outside, link);
      await expect(packagedSourceDigest(source)).rejects.toThrow("cannot contain symlinks");
    });
  });
  it("rejects missing inputs and directory-shaped package controls", async () => {
    await sourceFixture(async (source) => {
      const filename = path.join(source, "package-lock.json");
      await rm(filename);
      await expect(packagedSourceDigest(source)).rejects.toThrow();
      await mkdir(filename);
      await expect(packagedSourceDigest(source)).rejects.toThrow("controls must be regular files");
    });
  });
  it("binds copied file permissions as well as content", async () => {
    await sourceFixture(async (source) => {
      const filename = path.join(source, "src/lib/helper.sh");
      await writeFile(filename, "exit 0\n", { mode: 0o600 });
      const before = await packagedSourceDigest(source);
      await chmod(filename, 0o700);
      expect(await packagedSourceDigest(source)).not.toBe(before);
    });
  });
  it("fails changed build inputs and accepts an unchanged capture", async () => {
    await sourceFixture(async (source) => {
      const before = await packagedSourceDigest(source);
      expect(() => assertPackagedSourceUnchanged(before, before)).not.toThrow();
      await writeFile(path.join(source, "src/lib/during-build.ts"), "export const changed = true;\n");
      const after = await packagedSourceDigest(source);
      expect(() => assertPackagedSourceUnchanged(before, after)).toThrow("changed during the fresh image build");
    });
  });
  it("checks live context binding after build and before services without claiming an immutable snapshot", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    const main = harness.slice(harness.indexOf("export async function packagedWorkerMain("));
    const before = main.indexOf("evidence.sourceInputSha256 = await packagedSourceDigest(");
    const build = main.indexOf('await docker(["build"');
    const after = main.indexOf("assertPackagedSourceUnchanged(evidence.sourceInputSha256, await packagedSourceDigest(");
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(build);
    expect(build).toBeLessThan(after);
    expect(after).toBeLessThan(main.indexOf('phase = "isolated-services"'));
    expect(main).toContain("immutableBuildContext: false");
  });
});

describe("packaged worker acceptance safety", () => {
  const lockedFixture = (): { packages: Record<string, { version: string; privatePayload: string }>; privatePayload: string } => ({ packages: Object.fromEntries(["@temporalio/worker", "@temporalio/client", "postgres", "jose"].map((name) => [
    `node_modules/${name}`, { version: "1.2.3", privatePayload: "private-canary" },
  ])), privatePayload: "private-canary" });
  it("exports only the fixed admitted locked versions, dropping all extra payloads", () => {
    const lock = lockedFixture();
    lock.packages["node_modules/untrusted-extra"] = { version: "private-canary", privatePayload: "private-canary" };
    const evidence = sanitizeLockedDependencies(lock);
    expect(evidence).toEqual({ "@temporalio/worker": "1.2.3", "@temporalio/client": "1.2.3", postgres: "1.2.3", jose: "1.2.3" });
    expect(JSON.stringify(evidence)).not.toContain("private-canary");
  });
  const taintedVersions: { tainted: unknown }[] = ["private-canary", "1.2.3\nprivate-canary", "1.2.3\n", { privatePayload: "private-canary" }, ["private-canary"], null].map((tainted) => ({ tainted }));
  it.each(taintedVersions)("rejects a tainted locked version without publishing a partial result ($tainted)", ({ tainted }) => {
    const lock = lockedFixture();
    const packages: Record<string, unknown> = { ...lock.packages, "node_modules/jose": { version: tainted } };
    const evidence: { lockedDependencies?: Record<string, string> } = {};
    expect(() => { evidence.lockedDependencies = sanitizeLockedDependencies({ ...lock, packages }); }).toThrow("trusted schema");
    expect(evidence).toEqual({});
    try { sanitizeLockedDependencies({ ...lock, packages }); }
    catch (error) { expect(String(error)).not.toContain("private-canary"); }
  });
  it.each([{}, { packages: null }, { packages: [] }, { packages: {} }])("rejects malformed or incomplete locked dependency evidence (%j)", (lock) => {
    expect(() => sanitizeLockedDependencies(lock)).toThrow("trusted schema");
  });
  it("admits only a fixed SHA-256 Docker image identifier", () => {
    const id = `sha256:${"a".repeat(64)}`;
    expect(sanitizeImageId(id)).toBe(id);
  });
  const taintedImageIds: { id: unknown }[] = ["private-canary", `sha256:${"a".repeat(63)}`, `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(64)}\nprivate-canary`, `sha256:${"a".repeat(64)}\n`, { Id: "private-canary" }, null].map((id) => ({ id }));
  it.each(taintedImageIds)("rejects tainted image identifiers before evidence assignment ($id)", ({ id }) => {
    const evidence: { image?: { id: string } } = {};
    expect(() => { evidence.image = { id: sanitizeImageId(id) }; }).toThrow("trusted schema");
    expect(evidence).toEqual({});
    try { sanitizeImageId(id); }
    catch (error) { expect(String(error)).not.toContain("private-canary"); }
  });
  it("requires explicit opt-in before parsing a platform or starting resources", () => {
    expect(() => parsePackagedArgs(["--platform", "linux/arm64"], {})).toThrow("Explicit");
  });
  it.each(["linux/amd64", "linux/arm64"])("accepts the explicit supported architecture %s", (platform) => {
    expect(parsePackagedArgs(["--platform", platform], { ZENITH_PACKAGED_WORKER_ACCEPTANCE: "1" })).toEqual({ platform });
  });
  it.each([{ args: [] }, { args: ["--platform", "linux/386"] }, { args: ["--platform", "linux/arm64", "--reuse"] }, { args: ["--host", "localhost"] }])(
    "refuses unsupported or ambiguous arguments ($args)", ({ args }) => {
      expect(() => parsePackagedArgs(args, { ZENITH_PACKAGED_WORKER_ACCEPTANCE: "1" })).toThrow("Usage");
    }
  );
  it("accepts only the disclosed disposable target configuration", () => {
    expect(() => assertPackagedAcceptanceTarget(env)).not.toThrow();
  });
  it.each([
    { ZENITH_PACKAGED_ACCEPTANCE: "0" }, { ZENITH_STORE: "postgres" }, { ZENITH_DATA: "/existing-user-data" },
    { ZENITH_WORKER_PLAN_DIR: "/existing-plan-files" }, { ZENITH_TEMPORAL_ADDRESS: "localhost:7233" },
    { ZENITH_PLATFORM_DB_URL: "postgresql://postgres:private-fixture-password@db.example.test:5432/zenith_packaged" },
    { ZENITH_PLATFORM_DB_URL: "postgresql://postgres:private-fixture-password@postgres:5432/existing" },
    { ZENITH_PLATFORM_DB_URL: "postgresql://postgres:private-fixture-password@postgres:5432/zenith_packaged?host=db.example.test" },
    { ZENITH_PLATFORM_DB_URL: "private-fixture-password-invalid-url" },
  ])("refuses shared/wrong targets without echoing their values (%j)", (changed) => {
    try { assertPackagedAcceptanceTarget({ ...env, ...changed }); throw new Error("Expected refusal"); }
    catch (error) {
      expect((error as Error).message).toContain("isolated disposable");
      expect((error as Error).message).not.toContain("private-fixture-password");
      expect((error as Error).message).not.toContain("db.example.test");
    }
  });
  it("drops unrecognized client evidence fields instead of emitting them", () => {
    expect(sanitizeClientEvidence("prepare", { prepared: true, appliedVersions: [1, 2], productStore: "isolated-file-fixture",
      platformStore: "postgres", password: "do-not-log", sql: "do-not-log" })).toEqual({ prepared: true, appliedVersions: [1, 2],
      productStore: "isolated-file-fixture", platformStore: "postgres" });
  });
  it("rejects arbitrary strings disguised as validated evidence", () => {
    expect(() => sanitizeClientEvidence("prepare", { prepared: true, appliedVersions: ["private-password"],
      productStore: "isolated-file-fixture", platformStore: "postgres" })).toThrow("trusted schema");
    expect(() => sanitizeClientEvidence("assets", { uid: 10001, arch: "arm64", node: "private-password" })).toThrow("trusted schema");
  });
  it("never promotes cloud-write or successful-operation claims from the scoped read fixture", () => {
    expect(() => sanitizeClientEvidence("operations", { reconcile: { status: "observed", drift: 0, unknown: 0 },
      operation: { workflowStatus: "succeeded" }, cloudWritesProven: true })).toThrow("trusted schema");
  });
  it("suppresses raw child-process errors", async () => {
    await expect(command(process.execPath, ["-e", "console.error('private-password private-sql'); process.exit(1)"], "fixture-phase"))
      .rejects.toThrow("Packaged acceptance phase failed: fixture-phase");
  });
  it.each(["private-tls-tool", "private-tls-ca", "private-tls-leaf", "private-tls-sign", "private-tls-verify"])("exports the fixed private TLS subphase (%s) without raw diagnostic data", phase => {
    const error = new PackagedCommandError(phase, "command-exit", 1);
    Object.assign(error.diagnostic, { output: "private-canary", path: "/private-canary", certificate: "private-canary" });
    Object.assign(error, { message: "private-canary" });
    expect(sanitizePackagedCommandFailure(error)).toEqual({ category: "command-exit", exitCode: 1, signal: null, phase });
    expect(JSON.stringify(sanitizePackagedCommandFailure(error))).not.toContain("private-canary");
  });
  it.each(["missing-schema", "invalid-secret", "invalid-signer", "plaintext-temporal", "missing-namespace", "wrong-queue"])("retains all three fixed refusal command subphases (%s)", kind => {
    for (const step of ["launch", "exit", "logs"]) {
      const phase = `refusal-${step}-${kind}`;
      expect(sanitizePackagedCommandFailure(new PackagedCommandError(phase, "command-exit", 1)))
        .toEqual({ category: "command-exit", exitCode: 1, signal: null, phase });
    }
  });
  it.each(["private-tls-tool-private-canary", "/private-canary", "private-tls-copy"])("omits every unrecognized command phase (%s)", phase => {
    expect(sanitizePackagedCommandFailure(new PackagedCommandError(phase, "command-exit", 23)))
      .toEqual({ category: "command-exit", exitCode: 23, signal: null });
  });
  it.each(["command-launch", "command-timeout", "command-output-limit", "command-exit", "command-signal"] as const)("retains a fixed command category (%s)", category => {
    expect(sanitizePackagedCommandFailure(new PackagedCommandError("private-tls-tool", category, null, "SIGKILL")))
      .toEqual({ category, exitCode: null, signal: "SIGKILL", phase: "private-tls-tool" });
  });
  it("refuses a generic error or a damaged command category instead of exporting its payload", () => {
    expect(sanitizePackagedCommandFailure(new Error("private-canary"))).toBeUndefined();
    const error = new PackagedCommandError("private-tls-tool", "command-exit", 1);
    Object.assign(error.diagnostic, { category: "private-canary", output: "private-canary" });
    expect(sanitizePackagedCommandFailure(error)).toBeUndefined();
  });
  it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "private-canary"])("drops damaged command scalar data (%s)", exitCode => {
    const error = new PackagedCommandError("private-tls-tool", "command-exit", 1);
    Object.assign(error.diagnostic, { exitCode, signal: "private-canary" });
    expect(sanitizePackagedCommandFailure(error))
      .toEqual({ category: "command-exit", exitCode: null, signal: null, phase: "private-tls-tool" });
  });
  it("preserves a failed TLS tool admission and exports only its fixed phase", async () => {
    const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), "zenith-tls-diagnostic-contract-"));
    let calls = 0;
    try {
      await chmod(temporary, 0o700);
      try {
        await prepareTemporalTls(temporary, async (_binary, _args, phase) => {
          calls++;
          expect(phase).toBe("private-tls-tool");
          throw new PackagedCommandError(phase, "command-exit", 1);
        });
        throw new Error("Expected TLS tool failure.");
      } catch (error) {
        expect(sanitizePackagedCommandFailure(error))
          .toEqual({ category: "command-exit", exitCode: 1, signal: null, phase: "private-tls-tool" });
      }
      expect(calls).toBe(1);
      expect(await readdir(temporary)).toEqual([]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  it("uses a pinned real server and private read-only config, requiring authenticated health before worker startup", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    expect(TEMPORAL_CONFIG_DIR).toBe("/etc/zenith-temporal");
    expect(TEMPORAL_IMAGE).toMatch(/^temporalio\/server:1\.32\.0@sha256:[a-f0-9]{64}$/);
    expect(TEMPORAL_ADMIN_IMAGE).toMatch(/^temporalio\/admin-tools:1\.32\.0@sha256:[a-f0-9]{64}$/);
    expect(harness).toContain("target=${TEMPORAL_CONFIG_DIR},readonly");
    expect(harness).toContain('"--config-file", `${TEMPORAL_CONFIG_DIR}/server.yaml`, "start"');
    expect(harness).not.toContain('"start-dev"');
    expect(harness).toContain('await control("health", "client", true)');
    expect(harness.indexOf('phase = "temporal-ready"')).toBeLessThan(harness.indexOf('phase = "actual-worker-entrypoint"'));
  });
  it("exports only fixed container state without arbitrary daemon errors or config", () => {
    const value = { Status: "exited", Running: false, ExitCode: 137, OOMKilled: true,
      Error: "private-password", Config: { Env: ["private-key"] } };
    expect(sanitizeContainerState(value)).toEqual({ status: "exited", running: false, exitCode: 137, oomKilled: true });
    expect(sanitizeContainerState({ ...value, Status: "private-password" })).toBeUndefined();
    expect(sanitizeContainerState({ ...value, ExitCode: "private-key" })).toBeUndefined();
    expect(sanitizeContainerState({ ...value, ExitCode: -1 })).toBeUndefined();
  });
  it("identifies only worker-owned, allowlisted startup categories", () => {
    for (const category of EXECUTION_FAILURE_CATEGORIES) {
      const record = { component: "execution-worker", msg: "execution worker failed", failureCategory: category, error: "private-password" };
      expect(workerFailureCategory(`native private-key\n${JSON.stringify(record)}\n`)).toBe(category);
    }
    expect(workerFailureCategory(JSON.stringify({ component: "untrusted", msg: "execution worker failed", failureCategory: "policy-assets" }))).toBe("unavailable");
    expect(workerFailureCategory(JSON.stringify({ component: "execution-worker", msg: "execution worker failed", failureCategory: "private-password" }))).toBe("unavailable");
  });
  it("scrubs every generated credential including overlapping URL/JWK values from private diagnostics", () => {
    const secrets = ["password-canary", "secret-canary", "private-d-canary", "postgresql://user:password-canary@postgres/db", '{"d":"private-d-canary"}'];
    const logs = secrets.join("\n") + "\npermission denied\n";
    const redacted = redactDiagnosticLogs(logs, [...secrets, ""]);
    for (const secret of secrets) expect(redacted).not.toContain(secret);
    expect(redacted).toContain("permission denied");
    expect(redacted).toContain("[REDACTED]");
  });
  it("records a failed command's exact exit with no arbitrary output", async () => {
    try {
      await command(process.execPath, ["-e", "console.error('private-password'); process.exit(23)"], "fixture-phase");
      throw new Error("Expected command failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PackagedCommandError);
      if (!(error instanceof PackagedCommandError)) throw error;
      expect(error.diagnostic).toEqual({ category: "command-exit", exitCode: 23, signal: null });
      expect(JSON.stringify(error.diagnostic)).not.toContain("private-password");
    }
  });
  it("never treats a timeout as an allowed failure result", async () => {
    await expect(command(process.execPath, ["-e", "setInterval(()=>{},1000)"], "fixture-timeout", { timeout: 20, allowFailure: true }))
      .rejects.toMatchObject({ diagnostic: { category: "command-timeout", exitCode: null, signal: "SIGKILL" } });
  });
  it("bounds captured output and fails instead of accumulating a large Docker log", async () => {
    await expect(command(process.execPath, ["-e", "process.stdout.write('x'.repeat(3*1024*1024))"], "output-limit"))
      .rejects.toThrow("Packaged acceptance phase failed: output-limit");
  });
  it("reports incomplete cleanup when a failed build leaves an image but inspection fails before any container exists", async () => {
    const commands: string[][] = [];
    const runId = "zenith-pkg-arm64-fixture";
    const image = `${runId}:acceptance`;
    // Simulate a build that writes its tag before failing; no container/volume
    // cleanup results exist to prevent the former empty-array success claim.
    const runDocker = async (args: string[]) => {
      commands.push(args);
      if (args[0] === "build") throw new Error("Build failed after tagging");
      if (args[1] === "inspect") return { code: 1, out: "" };
      return { code: 0, out: `${image}\n` };
    };
    await expect(runDocker(["build", "--tag", image])).rejects.toThrow("Build failed");
    const cleanup = [await cleanupOwnedImage(image, runId, runDocker)];
    expect(cleanup.every(Boolean)).toBe(false);
    expect(commands.some((args) => args[1] === "rm")).toBe(false);
  });
  it.each(["nonzero", "throw"])("does not report absence when the image inspector and daemon listing fail (%s)", async (failure) => {
    const runDocker = async () => {
      if (failure === "throw") throw new Error("Private daemon details");
      return { code: 1, out: "" };
    };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(false);
  });
  it("establishes absence through a successful empty listing when no image was produced", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      return { code: args[1] === "inspect" ? 1 : 0, out: "" };
    };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(true);
    expect(commands).toEqual([
      ["image", "inspect", "--format", '{{index .Config.Labels "io.zenith.acceptance.run"}}', "fixture:acceptance"],
      ["image", "ls", "--filter", "reference=fixture:acceptance", "--format", "{{.Repository}}:{{.Tag}}"],
      ["image", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label=io.zenith.acceptance.run=fixture"],
    ]);
  });
  it("does not claim cleanup when the tag disappears but an owned dangling image remains", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      if (args[1] === "inspect") return { code: 1, out: "" };
      return { code: 0, out: args.includes("--all") ? "sha256:owned-dangling-image\n" : "" };
    };
    expect(await cleanupOwnedResource("image", "fixture:acceptance", "fixture", runDocker))
      .toEqual({ removed: false, outcome: "ownership-unconfirmed", attempts: 0 });
    expect(commands.some((args) => args[1] === "rm")).toBe(false);
    expect(commands.filter((args) => args.includes("--all"))).toHaveLength(2);
  });
  it.each(["nonzero", "throw"])("requires a successful owned image inventory after tag removal (%s)", async (failure) => {
    const runDocker = async (args: string[]) => {
      if (args[1] === "inspect") return { code: 0, out: "fixture\n" };
      if (args.includes("--all")) {
        if (failure === "throw") throw new Error("Private daemon details");
        return { code: 1, out: "" };
      }
      return { code: 0, out: "" };
    };
    expect(await cleanupOwnedResource("image", "fixture:acceptance", "fixture", runDocker))
      .toEqual({ removed: false, outcome: "absence-unconfirmed", attempts: 2 });
  });
  it("only removes its exact labeled tag and independently verifies absence", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      return { code: 0, out: args[1] === "inspect" ? "fixture\n" : "" };
    };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(true);
    expect(commands.filter((args) => args[1] === "rm")).toEqual([["image", "rm", "fixture:acceptance"]]);
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["image", "ls"]);
  });
  it("leaves an image with another run's label untouched and reports incomplete cleanup", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => { commands.push(args); return { code: 0, out: "another-run\n" }; };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(false);
    expect(commands).toHaveLength(1);
  });
  it.each(["delete-failed", "still-listed", "list-failed"])("does not report removed images without complete evidence (%s)", async (failure) => {
    const runDocker = async (args: string[]) => {
      if (args[1] === "inspect") return { code: 0, out: "fixture\n" };
      if (args[1] === "rm") return { code: failure === "delete-failed" ? 1 : 0, out: "" };
      return { code: failure === "list-failed" ? 1 : 0, out: failure === "list-failed" ? "" : "fixture:acceptance\n" };
    };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(false);
  });
});

describe("packaged refusal exit proof", () => {
  const runId = "zenith-pkg-amd64-fixture";
  const name = `${runId}-missing-schema`;
  const state = (Status = "exited", ExitCode = 1, OOMKilled = false, owner = runId) => ({
    Config: { Labels: { "io.zenith.acceptance.run": owner } }, State: { Status, Running: Status === "running", ExitCode, OOMKilled },
  });
  const failureLog = (failureCategory: string, component = "execution-worker") => JSON.stringify({ component, msg: "execution worker failed", failureCategory });

  it("waits through created/running state for the actual owned worker exit", async () => {
    const snapshots = [state("created", 0), state("running", 0), state()];
    const commands: string[][] = []; let elapsed = 0;
    const runDocker = async (args: string[]) => { commands.push(args); return { code: 0, out: JSON.stringify(snapshots.shift()) }; };
    expect(await waitForRefusalExit(name, runId, runDocker, { now: () => elapsed, wait: async (ms: number) => { elapsed += ms; } }))
      .toEqual({ status: "exited", running: false, exitCode: 1, oomKilled: false });
    expect(commands).toHaveLength(3);
    expect(commands.every((args) => args[0] === "inspect" && args.at(-1) === name)).toBe(true);
    expect(elapsed).toBe(500);
  });
  it.each([{ code: 0, oom: false }, { code: 137, oom: false }, { code: 1, oom: true }])(
    "rejects the wrong exit or an OOM ($code/$oom)", async ({ code, oom }) => {
      const runDocker = async () => ({ code: 0, out: JSON.stringify(state("exited", code, oom)) });
      await expect(waitForRefusalExit(name, runId, runDocker)).rejects.toThrow("required worker exit");
    }
  );
  it("refuses another run's container before interpreting its exit", async () => {
    const runDocker = async () => ({ code: 0, out: JSON.stringify(state("exited", 1, false, "another-run")) });
    await expect(waitForRefusalExit(name, runId, runDocker)).rejects.toThrow("ownership did not match");
  });
  it.each(["inspect-failed", "malformed-state", "dead"])("does not invent refusal proof from %s", async (failure) => {
    const runDocker = async () => ({ code: failure === "inspect-failed" ? 1 : 0,
      out: JSON.stringify(failure === "malformed-state" ? { ...state(), State: { Status: "private-canary" } } : state("dead", 1)) });
    await expect(waitForRefusalExit(name, runId, runDocker)).rejects.toThrow(/could not be inspected|state was unavailable|without a verified worker exit/);
  });
  it("fails the bounded observation window without claiming a worker signal or exit", async () => {
    let elapsed = 0;
    const runDocker = async () => ({ code: 0, out: JSON.stringify(state("created", 0)) });
    await expect(waitForRefusalExit(name, runId, runDocker, { timeout: 500, now: () => elapsed, wait: async (ms: number) => { elapsed += ms; }, phase: "refusal-exit-missing-schema" }))
      .rejects.toMatchObject({ diagnostic: { category: "command-timeout", exitCode: null, signal: null } });
    expect(elapsed).toBe(500);
  });
  it("does not accept an exit observation returned after its deadline", async () => {
    let elapsed = 0;
    const runDocker = async () => { elapsed = 501; return { code: 0, out: JSON.stringify(state()) }; };
    await expect(waitForRefusalExit(name, runId, runDocker, { timeout: 500, now: () => elapsed }))
      .rejects.toMatchObject({ diagnostic: { category: "command-timeout", exitCode: null, signal: null } });
  });
  it.each(["command-timeout", "command-signal", "command-output-limit"] as const)("never accepts a Docker %s as the worker refusal", async (category) => {
    const runDocker = async () => { throw new PackagedCommandError("refusal-exit-missing-schema", category, null, category === "command-signal" ? "SIGTERM" : null); };
    await expect(waitForRefusalExit(name, runId, runDocker)).rejects.toMatchObject({ diagnostic: { category } });
  });
  it.each(["missing-schema", "invalid-secret", "invalid-signer"])("accepts only the expected worker-owned category and secret-free output (%s)", (kind) => {
    const category = kind === "missing-schema" ? "platform-store" : "configuration";
    expect(refusalFailureCategory(kind, failureLog(category), ["private-canary"])).toBe(category);
    expect(() => refusalFailureCategory(kind, failureLog("module-load"), [])).toThrow("category did not match");
    expect(() => refusalFailureCategory(kind, failureLog(category, "untrusted"), [])).toThrow("category did not match");
    expect(() => refusalFailureCategory(kind, failureLog(category) + "\nprivate-canary", ["private-canary"])).toThrow("secret material");
  });
});

describe("owned resource cleanup proof", () => {
  const runId = "zenith-pkg-amd64-fixture";
  const name = `${runId}-missing-schema`;
  it("confirms absence after the removal CLI times out, without another removal", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      if (args[0] === "inspect") return { code: 0, out: runId };
      if (args[0] === "rm") throw new PackagedCommandError("cleanup", "command-timeout", null, "SIGKILL");
      return { code: 0, out: "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: true, outcome: "absent-after-timeout", attempts: 1 });
    expect(commands.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", name]]);
    expect(commands.at(-1)).toEqual(["ps", "-aq", "--filter", `name=^/${name}$`]);
  });
  it("rechecks ownership before the second bounded removal attempt", async () => {
    let removes = 0; let inspections = 0;
    const runDocker = async (args: string[]) => {
      if (args[0] === "inspect") { inspections++; return { code: 0, out: runId }; }
      if (args[0] === "rm") { removes++; return { code: removes === 1 ? 1 : 0, out: "" }; }
      return { code: 0, out: args[0] === "ps" && removes === 1 ? "owned-id" : "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: true, outcome: "removed", attempts: 2 });
    expect(removes).toBe(2); expect(inspections).toBe(2);
  });
  it("distinguishes a failed removal response from a verified successful removal response", async () => {
    const runDocker = async (args: string[]) => ({ code: args[0] === "rm" ? 1 : 0, out: args[0] === "inspect" ? runId : "" });
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: true, outcome: "absent-after-error", attempts: 1 });
  });
  it("records a persistent removal timeout and does not exceed two attempts", async () => {
    let removes = 0;
    const runDocker = async (args: string[]) => {
      if (args[0] === "inspect") return { code: 0, out: runId };
      if (args[0] === "rm") { removes++; throw new PackagedCommandError("cleanup", "command-timeout"); }
      return { code: 0, out: args[0] === "ps" ? "still-present-id" : "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: false, outcome: "remove-timeout", attempts: 2 });
    expect(removes).toBe(2);
  });
  it("stops if ownership changes between attempts", async () => {
    let inspections = 0; let removes = 0;
    const runDocker = async (args: string[]) => {
      if (args[0] === "inspect") return { code: 0, out: ++inspections === 1 ? runId : "different-run" };
      if (args[0] === "rm") removes++;
      return { code: 0, out: args[0] === "ps" ? "present-id" : "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: false, outcome: "label-mismatch", attempts: 1 });
    expect(removes).toBe(1);
  });
  it.each(["container", "volume", "network", "image"] as const)("never removes a %s whose ownership cannot be inspected", async (kind) => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      return { code: args.includes("inspect") ? 1 : 0, out: args.includes("inspect") ? "" : "present-owned-name" };
    };
    expect(await cleanupOwnedResource(kind, name, runId, runDocker)).toEqual({ removed: false, outcome: "ownership-unconfirmed", attempts: 0 });
    expect(commands.some((args) => args.includes("rm"))).toBe(false);
  });
  it("records incomplete cleanup after exactly two attempts if the resource remains", async () => {
    let removes = 0;
    const runDocker = async (args: string[]) => {
      if (args[0] === "inspect") return { code: 0, out: runId };
      if (args[0] === "rm") removes++;
      return { code: 0, out: args[0] === "ps" ? "still-present-id" : "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: false, outcome: "still-present", attempts: 2 });
    expect(removes).toBe(2);
  });
  it("does not accept failed absence listings after removal", async () => {
    const runDocker = async (args: string[]) => ({ code: args[0] === "ps" ? 1 : 0, out: args[0] === "inspect" ? runId : "" });
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: false, outcome: "absence-unconfirmed", attempts: 2 });
  });
});
