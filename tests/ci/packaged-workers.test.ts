/** Source and fixed-schema receipt models only. These fixtures never claim native execution. */
import fs from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { PACKAGED_WORKER_CHECKS, packagedWorkerManifest } from "../../scripts/ci/gate-manifest.mjs";
import { assertArtifactShape, assertAttemptedBuilderCapture, assertBuilderScope, assertLoadedImage, assertNativePrerequisites, assertOwnedContext, assertPublishedEvidence, assertReleaseMarker, baselinePreserved, boundBuild, builderDescriptors, executedChecks, parseHarnessOutput, parseNativeArgs, assertOwnedProcessProof, runOwnedProcess } from "../../scripts/ci/packaged-worker-native.mjs";
import { digest } from "../../src/lib/controlplane/digest";

const platform = "linux/amd64", hex = "a".repeat(64), commit = "b".repeat(40), imageId = `sha256:${hex}`;
const runId = "zenith-pkg-amd64-0123456789ab";
const read = (file: string) => fs.readFileSync(file, "utf8");
const prerequisites = () => ({ os: "linux", processArch: "x64", dockerOS: "linux", dockerArch: "amd64", endpoint: "unix:///var/run/docker.sock", node: "22.23.3",
  totalRamGiB: 15, availableRamGiB: 10, dockerRamGiB: 15, sourceFreeGiB: 20, temporaryFreeGiB: 20, dockerFreeGiB: 20 });
const github = { GITHUB_ACTIONS: "true", ZENITH_PACKAGED_REPOSITORY_VISIBILITY: "public", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", GITHUB_SHA: commit, ZENITH_PACKAGED_RUNNER_LABEL: "ubuntu-24.04" };
const observation = () => ({ scheduleOwned: true, encryptedInput: true, paused: false, status: "completed", current: true, runId: "01234567-0123-4123-8123-0123456789ab", completedAt: 1_791_000_000_000 });
const activity = () => ({ scheduleOwned: true, encryptedInput: true, paused: false, workflowId: "zenith-reconcile-sweep-v1-2026-10-04T08:00:00Z",
  runId: "01234567-0123-4123-8123-0123456789ab", activityId: "1", activityType: "sweepReconcilePass", workerIdentity: runId, attempt: 1, maximumAttempts: 1,
  workflowStatus: "running", activityState: "started" });
const waiter = () => ({ observerPid: 10, waiterPid: 11, blockerPid: 12 });
const dependencies = { "@temporalio/worker": "1.17.1", "@temporalio/client": "1.17.1", postgres: "3.4.7", jose: "6.1.2" };
const operationIdentity = () => ({ id: `op_${"1".repeat(32)}`, workspaceId: "packaged-workspace", projectId: "packaged-project",
  environmentId: "packaged-environment", resourceId: null, capability: "infrastructure.observe", principalKind: "user", subjectId: "packaged-member",
  idempotencyKey: `idem_${digest({ k: "user", p: "packaged-member", c: "infrastructure.observe", key: "packaged-read-refusal" })}` });
const refusals = ["missing-schema", "invalid-secret", "invalid-signer", "plaintext-temporal", "missing-namespace", "wrong-queue"];
function harness() {
  const fresh = observation(), entered = activity();
  return { status: "passed", platform, runId, commit, dirty: false, sourceInputSha256: hex, acceptanceHarnessSha256: hex,
    environment: { dockerServerOS: "linux", dockerServerArch: "amd64", emulated: false },
    sourceBinding: { inventoryComplete: true, unchangedAcrossBuild: true, immutableBuildContext: false },
    image: { id: imageId, platform, user: "zenith", acceptanceDerivative: true, entrypoint: ["/usr/bin/tini", "--", "node", "dist/execution/worker.cjs"] },
    lockedDependencies: dependencies,
    refusalExits: Object.fromEntries(refusals.map(key => [key, { status: "exited", running: false, oomKilled: false, exitCode: 1, failureCategory: key === "missing-schema" ? "platform-store" : "configuration" }])),
    checks: {
      tlsCustody: { generatedPrivateFiles: true, caPrivateKeysHostOnly: true, privateDirectories: true, privateLeafFiles: true, workerUid: 10001, serverUid: 1000, hostMounts: false,
        certificateSha256: { ca: hex, server: hex, client: hex, "rogue-client": hex } },
      temporalAuthentication: { validClientAccepted: true, noClientRefused: true, untrustedClientRefused: true, incorrectServerNameRefused: true, realServerTls: true, namespaceAuthorizationProven: false },
      namespace: { namespaceConfirmed: true, ownershipAttribute: "Keyword" },
      ...Object.fromEntries(refusals.map(key => [key, "refused-without-secret-output"])),
      readiness: { ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation: "ok" } }, liveness: { alive: true }, ownedSchedule: fresh,
      sqlPrerequisiteOutage: { actualPgWaiter: waiter(), deferred: { ...fresh, status: "deferred", current: false }, readinessRevoked: true, automaticPause: false }, sqlPrerequisiteRecovery: fresh,
      "store-readiness-outage": { readyStatus: 503, liveStatus: 200 }, "store-readiness-outage-recovery": { ...fresh, freshRunConfirmed: true },
      "temporal-readiness-outage": { readyStatus: 503, liveStatus: 200 }, "temporal-readiness-outage-recovery": { ...fresh, freshRunConfirmed: true },
      temporalRestart: { sameOwnedDatabase: true, ownedScheduleRetained: true, freshPass: fresh },
      operatorPause: { readinessRevoked: true, livenessRetained: true, resumedOnlyByOperator: true, freshPass: fresh },
      inFlightShutdown: { signal: "SIGTERM", exitCode: 0, drained: true, inFlightActivity: true, entered, afterSignal: entered,
        retainedHistory: { ...entered, workflowStatus: "completed", result: "deferred", reason: "prerequisites_unavailable", scheduledEventId: 1, startedEventId: 2, completedEventId: 3, startedByOriginalWorker: true, completedByOriginalWorker: true },
        actualPgWaiter: waiter(), waiterDuringDrain: waiter(), freshWorkerIdentity: `${runId}-recovery`, freshPass: fresh, authorityReadback: { existingReadRefusalUnchanged: true },
        sqlActivityAttributionProven: false, providerMutationAccepted: false, consumedApprovalPreservationProven: false, receiptRecoveryProven: false },
      shutdown: { signal: "SIGTERM", exitCode: 0, drained: true, inFlightActivity: false },
    },
    operations: { reconcile: { status: "observed", drift: 0, unknown: 0 }, operation: { workflowStatus: "failed", ledgerStatus: "failed", outcome: "expected no-target refusal", signedReadGrantVerified: true,
      policyDecisions: 2, activityTypes: ["acquireLease", "evaluatePolicy", "executeCapability", "markOperation", "releaseLease"], identity: operationIdentity() }, cloudWritesProven: false, browserApprovalPerformed: false },
    assets: { uid: 10001, arch: "x64", node: "v22.23.3", tofu: ["OpenTofu v1.12.5", "on linux_amd64"], policySha256: hex,
      ssmDocuments: { count: 1, sha256: hex }, dependencies,
      plans: { logicallyExpired: true, ciphertextRetained: true, terminalRetained: true, encryptedLifecycleFixture: true, activeRetained: true, unownedRetained: true, sentinelFiles: true } },
    cleanup: { privateFilesRemoved: true, allCreatedResourcesRemoved: true, resources: [{ removed: true }] } };
}
const expected = { platform, commit, sourceInputSha256: hex, acceptanceHarnessSha256: hex, wrapperSha256: hex, manifestSha256: hex, workflowSha256: hex };
function published() {
  return { schemaVersion: 1, lane: "packaged-worker", kind: "native-packaged-worker", status: "passed", ...expected,
    environment: assertNativePrerequisites(platform, prerequisites(), {}), startedAt: "2026-10-04T08:00:00.000Z", finishedAt: "2026-10-04T08:01:00.000Z",
    childExitCode: 0, minimumObservedFreeGiB: 12, checks: Object.fromEntries(PACKAGED_WORKER_CHECKS.map(key => [key, "passed"])),
    cleanup: { builderAbsent: true, builderContainerAbsent: true, cacheVolumeAbsent: true, baselinePreserved: true, wrapperPrivateFilesRemoved: true, ownedContextAbsent: true }, limitations: packagedWorkerManifest(platform).limitations };
}

interface Workflow { on: Record<string, unknown>; permissions: Record<string, unknown>; concurrency: Record<string, unknown>; jobs: Record<string, { "runs-on": string; "timeout-minutes": number; strategy: { "fail-fast": boolean; matrix: { include: { arch: string; runner: string }[] } }; steps: { uses?: string; run?: string; if?: unknown; with?: Record<string, unknown>; "continue-on-error"?: unknown }[]; if?: unknown; "continue-on-error"?: unknown; services?: unknown; environment?: unknown }> }

describe("native packaged worker canonical source contract", () => {
  const workflow = load(read(".github/workflows/packaged-workers.yml")) as Workflow;
  it("uses exactly the two standard public native VM labels with pinned existing actions and read-only permissions", () => {
    const job = workflow.jobs["packaged-worker"];
    expect(job.strategy.matrix.include).toEqual([{ arch: "amd64", runner: "ubuntu-24.04" }, { arch: "arm64", runner: "ubuntu-24.04-arm" }]);
    expect(job["runs-on"]).toBe("${{ matrix.runner }}");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job.if).toBeUndefined(); expect(job["continue-on-error"]).toBeUndefined(); expect(job.services).toBeUndefined(); expect(job.environment).toBeUndefined();
    expect(job.steps.map(step => step.uses).filter(Boolean)).toEqual(["actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5", "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"]);
    expect(job.steps[0].with).toEqual({ "persist-credentials": false }); expect(job.steps[1].with).toEqual({ "node-version": "22.23.3" });
    expect(job.steps.every(step => step["continue-on-error"] === undefined)).toBe(true);
    expect(read(".github/workflows/packaged-workers.yml")).not.toMatch(/setup-qemu|secrets\.|id-token|docker login|prune|sudo/);
  });
  it("executes and validates the one manifest command and uploads one exact sanitized file with absence failure", () => {
    const job = workflow.jobs["packaged-worker"], run = job.steps.find(step => step.run?.includes("--run")), validate = job.steps.find(step => step.run?.includes("--validate")), upload = job.steps.at(-1)!;
    expect(packagedWorkerManifest(platform).command).toEqual(["node", "scripts/ci/packaged-worker-native.mjs", "--run", "--platform", platform, "--evidence", "{outside-source-evidence}/sanitized.json"]);
    expect(run?.run).toContain('node scripts/ci/packaged-worker-native.mjs --run --platform "linux/${{ matrix.arch }}" --evidence "$RUNNER_TEMP/packaged-worker-${{ matrix.arch }}/sanitized.json"');
    expect(run?.if).toBeUndefined(); expect(validate?.if).toBe("always()"); expect(validate?.run).toContain("--validate");
    expect(upload.if).toBe("always() && steps.artifact-schema.outcome == 'success'"); expect(upload.with?.path).toBe("${{ runner.temp }}/packaged-worker-${{ matrix.arch }}/sanitized.json"); expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.["retention-days"]).toBeUndefined();
    expect(upload.with?.["include-hidden-files"]).toBeUndefined(); expect(String(upload.with?.path)).not.toMatch(/\*|private|stdout|stderr|cert|\.key/);
  });
  it("retains the existing acceptance engine and release-before-runtime boundary without a second worker engine", () => {
    const source = read("scripts/ci/packaged-worker-native.mjs");
    expect(source).toContain('["scripts/acceptance/packaged-worker.mjs", "--platform", config.platform]');
    expect(source).toContain('if (code !== 0) return code'); expect(source).toContain('await releaseBuilder(config.docker, config.scope)');
    expect(source.indexOf('await releaseBuilder(config.docker, config.scope)')).toBeLessThan(source.indexOf('flag: "wx" });\n  for (let attempt'));
    expect(source).toContain('"--bootstrap"'); expect(source).toContain('minimum < 8'); expect(source).not.toContain('"prune"'); expect(source).not.toContain('"--keep-state"');
    expect(source).not.toContain('"buildx", "inspect", "--format"');
    expect(source).toContain('"private-stdout"'); expect(source).toContain('"private-stderr"');
  });
  it("cleans only the fresh build-stage npm cache in the same locked install instruction", () => {
    const dockerfile = read("docker/worker.Dockerfile");
    const buildStage = dockerfile.split(/^FROM \$\{NODE_IMAGE\} AS build\r?$/m)[1]?.split(/^FROM /m)[0];
    if (typeof buildStage !== "string") throw new Error("The worker build stage is unavailable.");
    const instructions = buildStage.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/)
      .map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith("#"));
    const install = "RUN npm ci --ignore-scripts && npm cache clean --force";
    expect(instructions.filter(line => line.startsWith("RUN npm"))).toEqual([install]);
    expect(instructions).toContain("WORKDIR /app");
    expect(instructions).toContain("COPY package.json package-lock.json ./");
    expect(instructions).toContain("COPY src/lib ./src/lib");
    expect(instructions.indexOf("WORKDIR /app")).toBeLessThan(instructions.indexOf(install));
    expect(instructions.indexOf("COPY package.json package-lock.json ./")).toBeLessThan(instructions.indexOf(install));
    expect(instructions.indexOf(install)).toBeLessThan(instructions.indexOf("COPY src/lib ./src/lib"));
    expect(instructions.filter(line => line.includes("cache clean"))).toEqual([install]);
    expect(read("scripts/ci/packaged-worker-native.mjs")).toContain("const MIN_DISK = 12, MIN_TOTAL_RAM = 12, MIN_AVAILABLE_RAM = 8;");
    expect(boundBuild(build(), { scope, platform, commit, sourceInputSha256: hex }).image).toBe(`${runId}:acceptance`);
  });
});

describe("native packaged worker fixed evidence models", () => {
  it("requires explicit opt-in and exact canonical arguments", () => {
    expect(parseNativeArgs(["--run", "--platform", platform, "--evidence", "/tmp/owned/sanitized.json"], { ZENITH_PACKAGED_WORKER_ACCEPTANCE: "1" }).platform).toBe(platform);
    for (const args of [[], ["--run", "--platform", "linux/riscv64", "--evidence", "/tmp/sanitized.json"], ["--run", "--platform", platform, "--evidence", "/tmp/sanitized.json", "--skip"]]) expect(() => parseNativeArgs(args, {})).toThrow();
  });
  it.each(["os", "processArch", "dockerOS", "dockerArch", "endpoint", "node", "totalRamGiB", "availableRamGiB", "dockerRamGiB", "sourceFreeGiB", "temporaryFreeGiB", "dockerFreeGiB"])("refuses missing, foreign or insufficient %s before IO", key => {
    expect(() => assertNativePrerequisites(platform, { ...prerequisites(), [key]: key.endsWith("GiB") ? 1 : "unsupported" }, github)).toThrow();
    expect(() => assertNativePrerequisites(platform, Object.fromEntries(Object.entries(prerequisites()).filter(([name]) => name !== key)), github)).toThrow();
  });
  it.each(["ZENITH_PACKAGED_REPOSITORY_VISIBILITY", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_ARCH", "GITHUB_SHA", "ZENITH_PACKAGED_RUNNER_LABEL"])("refuses private, paid, emulated or unrecognized hosted %s", key => {
    expect(() => assertNativePrerequisites(platform, prerequisites(), { ...github, [key]: "unsupported" })).toThrow();
  });
  it("requires native ARM64 independently and refuses AMD64 emulation", () => {
    expect(assertNativePrerequisites("linux/arm64", { ...prerequisites(), processArch: "arm64", dockerArch: "arm64" }, {}).emulated).toBe(false);
    expect(() => assertNativePrerequisites(platform, { ...prerequisites(), processArch: "arm64", dockerArch: "arm64" }, {})).toThrow();
  });
  it("requires actual successful child completion and complete engine checks without claiming mutation permission", () => {
    expect(Object.keys(executedChecks(harness(), platform, 0))).toEqual(PACKAGED_WORKER_CHECKS.filter(key => !["owned-builder-cache-cleanup", "owned-context-cleanup", "baseline-preserved"].includes(key)));
    for (const code of [1, null, undefined]) expect(() => executedChecks(harness(), platform, code)).toThrow();
    for (const status of ["failed", "skipped", "pending", "unknown"]) expect(() => executedChecks({ ...harness(), status }, platform, 0)).toThrow();
    expect(() => executedChecks({ ...harness(), operations: { ...harness().operations, cloudWritesProven: true } }, platform, 0)).toThrow();
  });
  it.each(["missing identity", "missing operation ID", "foreign ID shape", "foreign workspace", "foreign project", "foreign environment", "resource present",
    "missing resource absence", "foreign capability", "foreign principal kind", "foreign subject", "raw key", "different scoped key", "SQL injection ID"] as const)("refuses packaged child operation identity %s", fault => {
    const original = harness(), value: Record<string, unknown> = { ...operationIdentity() };
    let identity: unknown = value;
    switch (fault) {
      case "missing identity": identity = undefined; break;
      case "missing operation ID": delete value.id; break;
      case "foreign ID shape": value.id = `dep_${"1".repeat(32)}`; break;
      case "foreign workspace": value.workspaceId = "foreign-workspace"; break;
      case "foreign project": value.projectId = "foreign-project"; break;
      case "foreign environment": value.environmentId = "foreign-environment"; break;
      case "resource present": value.resourceId = "foreign-resource"; break;
      case "missing resource absence": delete value.resourceId; break;
      case "foreign capability": value.capability = "infrastructure.apply"; break;
      case "foreign principal kind": value.principalKind = "integration"; break;
      case "foreign subject": value.subjectId = "foreign-member"; break;
      case "raw key": value.idempotencyKey = "packaged-read-refusal"; break;
      case "different scoped key": value.idempotencyKey = `idem_${digest({ k: "user", p: "foreign-member", c: "infrastructure.observe", key: "packaged-read-refusal" })}`; break;
      case "SQL injection ID": value.id = "op_'; select 1; --"; break;
    }
    expect(() => executedChecks({ ...original, operations: { ...original.operations, operation: { ...original.operations.operation, identity } } }, platform, 0)).toThrow();
  });
  it.each(Object.keys(harness().checks))("refuses absent engine check %s", key => {
    expect(() => executedChecks({ ...harness(), checks: Object.fromEntries(Object.entries(harness().checks).filter(([name]) => name !== key)) }, platform, 0)).toThrow();
  });
  it("refuses missing, duplicate and malformed raw result records", () => {
    const raw = JSON.stringify(harness()); expect(parseHarnessOutput(`progress\n${raw}\n`)).toEqual(harness());
    for (const stream of ["", "progress\n", "{invalid}\n", `${raw}\n${raw}\n`]) expect(() => parseHarnessOutput(stream)).toThrow();
  });
  it.each(PACKAGED_WORKER_CHECKS)("rejects every absent, failed or skipped published check %s", key => {
    for (const status of ["failed", "skipped", "pending", "unknown", null]) expect(() => assertPublishedEvidence({ ...published(), checks: { ...published().checks, [key]: status } }, expected)).toThrow();
    expect(() => assertPublishedEvidence({ ...published(), checks: Object.fromEntries(Object.entries(published().checks).filter(([name]) => name !== key)) }, expected)).toThrow();
  });
  it("admits a sanitized failed artifact without changing the failed execution verdict", () => {
    const failed = { ...published(), status: "failed", failurePhase: "native-prerequisites", childExitCode: null, checks: {} };
    expect(assertArtifactShape(failed, platform)).toBe(true);
    expect(() => assertPublishedEvidence(failed, expected)).toThrow();
    expect(() => assertArtifactShape({ ...failed, rawCertificate: "private-canary" }, platform)).toThrow();
  });
  it("binds source/environment/cleanup and rejects arbitrary private fields in artifacts", () => {
    expect(assertPublishedEvidence(published(), expected)).toBe(true);
    for (const key of ["commit", "sourceInputSha256", "acceptanceHarnessSha256", "wrapperSha256", "manifestSha256", "workflowSha256"]) expect(() => assertPublishedEvidence({ ...published(), [key]: "c".repeat(64) }, expected)).toThrow();
    expect(() => assertPublishedEvidence({ ...published(), privateCertificate: "private-canary" }, expected)).toThrow();
    expect(() => assertPublishedEvidence({ ...published(), environment: { ...published().environment, rawLogs: "private-canary" } }, expected)).toThrow();
    for (const key of Object.keys(published().cleanup)) expect(() => assertPublishedEvidence({ ...published(), cleanup: { ...published().cleanup, [key]: false } }, expected)).toThrow();
  });
});

const scope = { builder: "zenith-owned-0123456789ab", context: "default", endpoint: "default", containerName: "buildx_buildkit_zenith-owned-0123456789ab0", volumeName: "buildx_buildkit_zenith-owned-0123456789ab0_state", containerId: hex,
  image: "moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea", imageId, memory: 4 * 1024 ** 3, volumeDriver: "local", volumeScope: "local", volumeFingerprint: hex };
const config = { ...expected, nonce: "c".repeat(32), scope };
const build = () => ["build", "--builder", scope.builder, "--pull", "--no-cache", "--target", "acceptance", "--platform", platform, "--label", `org.opencontainers.image.revision=${commit}`, "--label", `io.zenith.acceptance.run=${runId}`, "--label", `io.zenith.acceptance.source-sha256=${hex}`, "-f", "docker/worker.Dockerfile", "-t", `${runId}:acceptance`, "."];
const loaded = () => ({ Id: imageId, Os: "linux", Architecture: "amd64", Config: { User: "zenith", Entrypoint: ["/usr/bin/tini", "--", "node", "dist/execution/worker.cjs"], Labels: { "org.opencontainers.image.revision": commit, "io.zenith.acceptance.run": runId, "io.zenith.acceptance.source-sha256": hex } } });
const marker = () => ({ endpoint: scope.endpoint, nonce: config.nonce, builder: scope.builder, buildkitImageId: scope.imageId, containerId: scope.containerId, volumeFingerprint: scope.volumeFingerprint, commit, platform, sourceInputSha256: hex, runId, imageId, cacheVolumeAbsent: true });

describe("native builder release ownership models", () => {
  it("deduplicates identical Buildx header/node tuples and refuses divergent duplicates", () => {
    const tuple = `${scope.builder}\tdocker-container\t${scope.builder}0\tdefault `;
    expect(builderDescriptors(`${tuple}\n${tuple}\n`)).toEqual([{ name: scope.builder, driver: "docker-container", nodes: [`${scope.builder}0`], endpoint: "default" }]);
    expect(() => builderDescriptors(`${tuple}\n${scope.builder}\tdocker-container\tforeign0\tdefault\n`)).toThrow();
    expect(() => builderDescriptors("invalid\n")).toThrow();
    expect(() => builderDescriptors(`${tuple}\n${scope.builder}\tdocker-container\t${scope.builder}0\tforeign-context\n`)).toThrow();
  });
  it("requires parent-owned native identity and the exact original build command", () => {
    expect(assertBuilderScope(scope, scope)).toEqual(scope); expect(boundBuild(build(), config)).toEqual({ runId, image: `${runId}:acceptance`, sourceInputSha256: hex });
    for (let index = 0; index < build().length; index++) {
      const args = build(); args[index] = "foreign"; expect(() => boundBuild(args, config)).toThrow();
    }
    expect(() => boundBuild([...build(), "--load"], config)).toThrow();
  });
  it.each(Object.keys(scope))("refuses substituted builder/cache %s", key => {
    expect(() => assertBuilderScope({ ...scope, [key]: "foreign" }, scope)).toThrow();
  });
  it.each(["nonzero", "timeout"])("admits only exact native cleanup capture after %s bootstrap without completed config", failure => {
    const failedBootstrap = { result: failure, config: undefined };
    const ownScope = { ...scope, context: "zenith-owned-context-0123456789ab", endpoint: "zenith-owned-context-0123456789ab" };
    const attempt = { createAttempted: true, absentBefore: true, scope: ownScope, ownedContext: { name: ownScope.context, fingerprint: hex } };
    const baseline = { builders: ["default"], containers: ["d".repeat(64)], volumes: ["unrelated"], contexts: ["default"] };
    expect(failedBootstrap.config).toBeUndefined();
    expect(assertAttemptedBuilderCapture(ownScope, attempt, baseline)).toEqual(ownScope);
    for (const key of ["containerId", "image", "memory", "volumeFingerprint", "endpoint"]) {
      expect(() => assertAttemptedBuilderCapture({ ...ownScope, [key]: "foreign" }, attempt, baseline)).toThrow();
    }
    expect(() => assertAttemptedBuilderCapture(undefined, attempt, baseline)).toThrow();
    expect(() => assertAttemptedBuilderCapture(ownScope, { ...attempt, createAttempted: false }, baseline)).toThrow();
    expect(() => assertAttemptedBuilderCapture(ownScope, { ...attempt, absentBefore: false }, baseline)).toThrow();
    for (const [kind, identity] of [["builders", ownScope.builder], ["containers", ownScope.containerId], ["volumes", ownScope.volumeName], ["contexts", ownScope.context]]) {
      expect(() => assertAttemptedBuilderCapture(ownScope, attempt, { ...baseline, [kind]: [identity] })).toThrow();
    }
  });
  it("records attempted native ownership before bootstrap and retains an unconfirmed scope before context removal", () => {
    const source = read("scripts/ci/packaged-worker-native.mjs");
    const main = source.slice(source.indexOf("export async function nativeMain"));
    expect(main.indexOf("builderAttempt = { scope")).toBeLessThan(main.indexOf('["buildx", "create"'));
    const final = main.slice(main.indexOf("finally {"));
    expect(final).toContain("if (builderAttempt && docker)");
    expect(final).not.toContain("if (config && docker)");
    expect(final.indexOf("assertAttemptedBuilderCapture(await captureBuilder")).toBeLessThan(final.indexOf("await releaseBuilder(docker, capturedScope)"));
    expect(final.indexOf("await releaseBuilder(docker, capturedScope)")).toBeLessThan(final.indexOf("await removeContext(docker, contextCapture)"));
    expect(final).toContain('catch { status = "failed"; }');
  });
  it("requires the exact loaded native image and refuses replacement after release", () => {
    const binding = boundBuild(build(), config); expect(assertLoadedImage(loaded(), binding, config, imageId)).toBe(imageId);
    expect(() => assertLoadedImage({ ...loaded(), Architecture: "arm64" }, binding, config, imageId)).toThrow();
    expect(() => assertLoadedImage({ ...loaded(), Id: `sha256:${"c".repeat(64)}` }, binding, config, imageId)).toThrow();
    expect(() => assertLoadedImage({ ...loaded(), Config: { ...loaded().Config, User: "root" } }, binding, config, imageId)).toThrow();
    for (const key of Object.keys(loaded().Config.Labels)) expect(() => assertLoadedImage({ ...loaded(), Config: { ...loaded().Config, Labels: { ...loaded().Config.Labels, [key]: "foreign" } } }, binding, config, imageId)).toThrow();
  });
  it.each(Object.keys(marker()))("refuses unbound early-release marker %s", key => {
    expect(assertReleaseMarker(marker(), config)).toEqual(marker());
    expect(() => assertReleaseMarker({ ...marker(), [key]: "foreign" }, config)).toThrow();
  });
  it("refuses extra marker payloads and preserves every unrelated baseline resource/selected builder", () => {
    expect(() => assertReleaseMarker({ ...marker(), rawLogs: "private-canary" }, config)).toThrow();
    const baseline = { containers: [hex], images: [imageId], networks: [hex], contexts: ["default"], volumes: ["unrelated-data"], builders: ["default"], builderDescriptors: ['default-docker-native'], selectedBuilder: "default" };
    expect(baselinePreserved(baseline, baseline)).toBe(true);
    for (const kind of ["containers", "images", "networks", "contexts", "volumes", "builders", "builderDescriptors"]) expect(baselinePreserved(baseline, { ...baseline, [kind]: [] })).toBe(false);
    expect(baselinePreserved(baseline, { ...baseline, selectedBuilder: scope.builder })).toBe(false);
  });
});

describe("named local Docker context ownership models", () => {
  const expectedContext = { name: "zenith-owned-context-0123456789ab", description: "Zenith disposable native 0123456789abcdef", endpoint: "unix:///var/run/docker.sock" };
  const nativeContext = () => ({ Name: expectedContext.name, Metadata: { Description: expectedContext.description }, Endpoints: { docker: { Host: expectedContext.endpoint, SkipTLSVerify: false } }, TLSMaterial: {}, Storage: { MetadataPath: "native-owned-metadata", TLSPath: "native-owned-tls" } });
  it("binds a genuine named context to the original verified local socket and stable metadata", () => {
    const captured = assertOwnedContext(nativeContext(), expectedContext);
    expect(captured.name).toBe(expectedContext.name); expect(captured.endpoint).toBe(expectedContext.endpoint);
    expect(assertOwnedContext(nativeContext(), captured)).toEqual(captured);
    expect(() => assertOwnedContext({ ...nativeContext(), Metadata: { Description: "foreign" } }, captured)).toThrow();
    expect(() => assertOwnedContext({ ...nativeContext(), Storage: { MetadataPath: "replacement", TLSPath: "native-owned-tls" } }, captured)).toThrow();
  });
  it("refuses remote/TLS/foreign contexts and keeps the existing scalar harness endpoint guard", () => {
    for (const endpoint of ["tcp://foreign:2376", "ssh://credential@foreign", "unix:///foreign.sock"]) expect(() => assertOwnedContext({ ...nativeContext(), Endpoints: { docker: { Host: endpoint, SkipTLSVerify: false } } }, expectedContext)).toThrow();
    expect(() => assertOwnedContext({ ...nativeContext(), TLSMaterial: { docker: ["private-canary"] } }, expectedContext)).toThrow();
    expect(() => assertOwnedContext({ ...nativeContext(), Name: "default" }, expectedContext)).toThrow();
    const source = read("scripts/ci/packaged-worker-native.mjs");
    expect(source).toContain('DOCKER_CONTEXT: config.ownedContext.name'); expect(source).toContain('process.env.DOCKER_CONTEXT = contextName');
    expect(source).toContain('await assertOriginalContext(docker, originalContext)'); expect(source).toContain('"context", "rm", expected.name');
    expect(source).not.toContain('["context", "use"'); expect(source).not.toContain('"--force"');
  });
});


describe("native process supervisor fixed ownership models", () => {
  const owner = { nonce: "c".repeat(32), pid: 12345, group: 12345, session: 12345, start: "123456" };
  const proof = { state: "settled", ...owner, code: 0, interrupted: false };
  it("binds settlement to the live reserved leader nonce PID session group and start time", () => {
    expect(assertOwnedProcessProof(proof, owner, "settled")).toEqual(proof);
    for (const key of ["nonce", "pid", "group", "session", "start", "state", "code", "interrupted"]) {
      expect(() => assertOwnedProcessProof({ ...proof, [key]: "foreign" }, owner, "settled")).toThrow();
    }
    expect(() => assertOwnedProcessProof({ ...proof, privatePayload: "private-canary" }, owner, "settled")).toThrow();
    expect(() => assertOwnedProcessProof({ ...proof, interrupted: true }, owner, "settled")).toThrow();
    expect(() => assertOwnedProcessProof(proof, { ...owner, pid: undefined }, "settled")).toThrow();
  });
  it("settles every Docker command and the unchanged acceptance program before absence promotion", () => {
    const source = read("scripts/ci/packaged-worker-native.mjs");
    expect(source).toContain('detached: true'); expect(source).toContain('process.kill(-process.pid, signal)');
    expect(source).not.toContain('process.kill(-supervisor.pid');
    expect(source).toContain('if (processSettlementUnconfirmed) fail()');
    expect(source).toContain('const proof = assertOwnedProcessProof(message, owner, "settled")');
    expect(source).toContain('if ((await groupMembers(owner)).length) fail()');
    expect(source).toContain('runOwnedProcess(process.execPath, ["scripts/acceptance/packaged-worker.mjs"');
    expect(source).toContain('timeout: 75 * 60_000, grace: 10 * 60_000');
    expect(source).toContain('await ownedLeader(config.supervisorOwner)');
    expect(source).toContain('current.group !== config.supervisorOwner.pid');
    expect(source).not.toContain('child.kill("SIGKILL")');
  });
});

const requiredSupervisor = process.env.ZENITH_TEST_NATIVE_SUPERVISOR_REQUIRED === "1";
if (requiredSupervisor && process.platform !== "linux") throw new Error("Native process settlement acceptance requires Linux /proc and an owned stock Node process group.");
/** Actual Linux Node children, no Docker/cloud and no model substituted for settlement. */
describe.skipIf(process.platform !== "linux")("native process supervisor [actual Linux Node; no Docker]", () => {
  const nested = (exitParent: boolean) => `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>process.exit(0));console.log('OWNED_DESCENDANT '+process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
    child.stdout.once('data',b=>{process.stdout.write(b);${exitParent ? "process.exit(0)" : "setInterval(()=>{},1000)"}});
  `;
  it("keeps a successful reserved group passing only after actual child settlement", async () => {
    const result = await runOwnedProcess(process.execPath, ["-e", "process.stdout.write('OWNED_COMPLETE\\n')"], { timeout: 5000, grace: 2000 });
    expect(result).toEqual({ code: 0, out: "OWNED_COMPLETE\n", err: "", interrupted: false, settled: true });
  }, 15_000);
  it("retains exact nonzero completion with verified settlement", async () => {
    const result = await runOwnedProcess(process.execPath, ["-e", "process.exit(17)"], { timeout: 5000, grace: 2000 });
    expect(result).toEqual({ code: 17, out: "", err: "", interrupted: false, settled: true });
  }, 15_000);
  it("refuses a zero-exit parent with a surviving inherited child and settles that descendant before returning", async () => {
    const result = await runOwnedProcess(process.execPath, ["-e", nested(true)], { timeout: 5000, grace: 2000 });
    expect(result.out).toMatch(/^OWNED_DESCENDANT [1-9][0-9]*\n$/);
    expect(result).toMatchObject({ code: 1, interrupted: true, settled: true });
  }, 15_000);
  it("timeout settles actual inherited children before permitting failed-result cleanup", async () => {
    const result = await runOwnedProcess(process.execPath, ["-e", nested(false)], { timeout: 1500, grace: 2000 });
    expect(result.out).toMatch(/^OWNED_DESCENDANT [1-9][0-9]*\n$/);
    expect(result).toMatchObject({ code: 1, interrupted: true, settled: true });
  }, 15_000);
  it("external cancellation settles actual inherited children before permitting failed-result cleanup", async () => {
    const cancel = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await runOwnedProcess(process.execPath, ["-e", nested(false)], { signal: cancel.signal, timeout: 10_000, grace: 2000,
        onReserved: async () => { timer = setTimeout(() => cancel.abort(), 1500); } });
      expect(result.out).toMatch(/^OWNED_DESCENDANT [1-9][0-9]*\n$/);
      expect(result).toMatchObject({ code: 1, interrupted: true, settled: true });
    } finally { clearTimeout(timer); }
  }, 15_000);
  it("a TERM-resistant owned group cannot manufacture a settled receipt or enable cleanup", async () => {
    await expect(runOwnedProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { timeout: 1000, grace: 300 }))
      .rejects.toMatchObject({ code: "native_process_unsettled" });
  }, 15_000);
});
