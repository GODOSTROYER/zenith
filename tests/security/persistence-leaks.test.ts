/**
 * PROD-OPS-06 leak suite: runtime-generated canary secrets are pushed through every path a secret can take into
 * persistence, and everything that persisted is scanned (every row of every `platform` table, the whole data
 * directory, captured log output, telemetry envelopes, workflow payloads, model-visible results).
 *
 * What it asserts, and what it does not:
 *  - A secret of ANY shape sent where sealing is the control (vault, job results, machine artifacts, Temporal
 *    payloads) never appears in plaintext outside the sealed value, and the sealed value opens again.
 *  - A secret of a RECOGNISED shape (AWS key id, token prefixes, JWT, PEM, URL password) is refused, withheld or
 *    masked by every guarded path, and is in no row afterwards.
 *  - It does NOT claim redaction catches every secret. Characterization tests pin the opposite on purpose: a
 *    secret with no recognisable shape that is sent to a write-guarded free-text store, a log line or a model
 *    result IS persisted or returned. Those stores are classified `write-guarded` (never `sealed`) in the
 *    inventory, and the primary control is that such secrets are not sent there at all.
 *
 * Contract level: real PGlite SQL, real file store, real redactors and sealers, in-process. No live Postgres,
 * Temporal, cloud or MCP-network claim. Canaries are random bytes on every run; nothing here is a real secret.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import { assertNoCanaries, deepScanForCanaries } from "../_support/security";
import { LEAK_PATHS, allShapes, dumpSchema, readTree, recognisedShapes, runtimeCanaries, type LeakPath } from "../_support/security/persistence";

const DATA = tempDataDir("zenith-persist-leak-", { fast: true });
process.env.ZENITH_SECRET_KEY = randomBytes(32).toString("hex");
process.env.ZENITH_STORE = "file";

const { putSecret, putSecretAsync, readSecretValue, readSecretValueAsync } = await import("@/lib/secrets");
const { runAction } = await import("@/lib/actions/core");
const { q, readAudit, resetDb, flushPendingAsync } = await import("@/lib/db/store");
await import("@/lib/actions/defs");
const { log } = await import("@/lib/log");

const { SecretString } = await import("@/lib/credentials/secret");
const { createAesResultSealer } = await import("@/lib/runners/seal");
const { TemporalPayloadCodec } = await import("@/lib/workflows/codec");
const { buildEnvelope, describeSession, failedProvenance } = await import("@/lib/observability/telemetry");
const { sanitizeReason } = await import("@/lib/observability/redact");
const { sanitizeForModel } = await import("@/lib/security/result-sanitizer");
const { checkActionThroughBroker } = await import("@/lib/capabilities/action-bridge");
const { atRestCensus, verifyResultEnvelope } = await import("@/lib/sensitivedata/at-rest");
const { TABLES } = await import("@/lib/sensitivedata/inventory");
const repos = await import("@/lib/controlplane/db/repos");
const { LANES, openLane, newWorkspace, seedApprovedOperation, uid } = await import("../controlplane/_support/harness");
const { closeSharedPgliteAfterAll, makeHarness } = await import("../capabilities/support");

closeSharedPgliteAfterAll();

const exercised = new Set<LeakPath>();
const KEY = "A".repeat(43);

/* ----------------------------- the vault and the API ----------------------------- */

const WS = "ws-leak-01";
const ctx = { workspaceId: WS, actor: { type: "user" as const, id: "u-leak-01", name: "Leak Tester" } };
resetDb({
  workspaces: [{ id: WS, name: "Leak", slug: "leak", createdAt: "2026-09-01T00:00:00.000Z" }],
  members: [{ id: "u-leak-01", workspaceId: WS, name: "Leak Tester", email: "leak@zenith.test", role: "admin" }],
});
const execute = (actionId: string, input: unknown, scope: Record<string, unknown> = {}) => runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" }).then((r) => r.result!);

describe("vault: values of any shape are sealed at rest", () => {
  it("the file store and the async path hold ciphertext only, and the sealed value opens again", async () => {
    const c = runtimeCanaries();
    putSecret(WS, "vault:leak/svc/OPAQUE", c.opaque, "tester");
    putSecret(WS, "vault:leak/svc/PEM", c.pem, "tester");
    await putSecretAsync(WS, "vault:leak/svc/URL", c.url, "tester");
    const tree = readTree(DATA);
    expect(tree.some((f) => f.file === "secrets.json"), "the vault file exists").toBe(true);
    assertNoCanaries(tree, allShapes(c), "no vault value appears in plaintext anywhere in the data directory");
    expect(readSecretValue(WS, "vault:leak/svc/OPAQUE")).toBe(c.opaque);
    expect(await readSecretValueAsync(WS, "vault:leak/svc/URL")).toBe(c.url);
    expect(tree.find((f) => f.file === "secrets.json")!.text).toContain("vault:leak/svc/OPAQUE");
    exercised.add("vault");
  });
});

describe("API: actions that are handed a secret", () => {
  it("system.setSecret seals the value and masks it everywhere the action writes", async () => {
    const c = runtimeCanaries();
    const created = await execute("project.importCompose", { composeYaml: "services:\n  api:\n    image: node:22\n", name: "Holder" });
    const projectId = (created.data as { projectId: string }).projectId;
    const serviceId = q.project(projectId)!.workingManifest.services[0].id;
    const results = [
      await execute("system.setSecret", { projectId, serviceId, key: "API_KEY_A", secretValue: c.opaque }, { projectId }),
      await execute("system.setSecret", { projectId, serviceId, key: "API_KEY_B", secretValue: c.url }, { projectId }),
      // a refused write must not echo the value either
      await execute("system.setSecret", { projectId, serviceId: "svc-nope", key: "API_KEY_A", secretValue: c.pem }, { projectId }),
    ];
    expect(results[0].ok, results[0].error).toBe(true);
    await flushPendingAsync();
    assertNoCanaries([readAudit({ workspaceId: WS, limit: 500 }), results], allShapes(c), "audit rows and action results never carry the value");
    assertNoCanaries(readTree(DATA), allShapes(c), "no snapshot, log or vault file in the data directory holds the value in plaintext");
    exercised.add("api");
  });
});

/* ------------------------------------ logs ------------------------------------ */

describe("structured logs", () => {
  let out: string[];
  const spies: { mockRestore(): void }[] = [];
  beforeEach(() => {
    out = [];
    const sink = (chunk: unknown): boolean => { out.push(String(chunk)); return true; };
    spies.push(vi.spyOn(process.stdout, "write").mockImplementation(sink as never), vi.spyOn(process.stderr, "write").mockImplementation(sink as never));
  });
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

  it("recognised credential shapes in messages, errors and fields are masked before they reach the sink", () => {
    const c = runtimeCanaries();
    log.error(`upstream refused ${c.url}`, {
      err: new Error(`connect ${c.url} using ${c.aws}`),
      headers: { authorization: `Bearer ${c.opaque}` },
      token: c.jwt,
      key: c.pem,
      note: `gh=${c.github} slack=${c.slack}`,
      nested: [{ deep: { url: c.url } }],
    });
    const shown = out.join("");
    expect(shown).toContain("upstream refused");
    assertNoCanaries(out, [...recognisedShapes(c), c.opaque], "no recognised credential shape, and no bearer value, is written to the log");
    exercised.add("logs");
  });

  it("still logs what operators need: dates, request ids, circular references and SecretString stay intact or masked, never thrown", () => {
    const c = runtimeCanaries();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    log.info("shape check", { at: new Date("2026-10-07T00:00:00.000Z"), cyclic, wrapped: new SecretString(c.opaque), count: 3 });
    const line = JSON.parse(out.join("").split("\n").find((l) => l.includes("shape check"))!) as Record<string, unknown>;
    expect(line.at).toBe("2026-10-07T00:00:00.000Z");
    expect(line.count).toBe(3);
    expect((line.cyclic as { self: unknown }).self).toBe("[Circular]");
    assertNoCanaries(out, [c.opaque], "a SecretString never prints its value");
  });

  it("LIMIT (characterization): a secret with no recognisable shape in a plain field is written as given", () => {
    const c = runtimeCanaries();
    log.info("free text", { detail: `the value was ${c.opaque}` });
    expect(deepScanForCanaries(out, [c.opaque]).length, "best-effort masking cannot see a secret with no shape; callers must not log it").toBeGreaterThan(0);
  });
});

/* --------------------------- telemetry and model results --------------------------- */

describe("telemetry envelopes", () => {
  it("carry a session fingerprint and fixed provenance, never credentials, and sanitised provider text", () => {
    const c = runtimeCanaries();
    const observedAt = "2026-10-07T00:00:00.000Z";
    const session = { provider: "aws", accountId: "111122223333", region: "us-east-1", accessKeyId: c.aws, secretAccessKey: c.opaque, sessionToken: c.jwt, expiresAt: "2026-10-08T00:00:00.000Z" };
    const envelope = buildEnvelope({
      signal: "log",
      scope: { workspaceId: "ws-leak", environmentId: "env-leak" },
      observedAt,
      session: describeSession(session as never),
      provenance: [failedProvenance({ source: "cloudwatch-logs", provider: "aws", observedAt, reason: sanitizeReason(`access denied for ${c.url} with ${c.aws} and Bearer ${c.opaque}`) })],
    });
    expect(envelope.session?.ref).toMatch(/^[0-9a-f]{16}$/);
    assertNoCanaries(envelope, [...recognisedShapes(c), c.opaque], "no credential, token or connection secret reaches a telemetry envelope");
    exercised.add("telemetry");
  });
});

describe("model-visible results", () => {
  it("recognised shapes and secret-named members are removed, the report never claims completeness, and a known secret is removed wherever it is", () => {
    const c = runtimeCanaries();
    const payload = { stdout: `connect ${c.url}`, nested: [{ note: `key ${c.aws}`, jwt: c.jwt, pem: c.pem, password: c.opaque }] };
    const sanitized = sanitizeForModel(payload);
    const shapes = [c.aws, c.jwt, c.pem, c.url, c.urlPassword, ...c.pem.split("\n").filter((l) => !l.startsWith("-----"))];
    assertNoCanaries(sanitized.value, [...shapes, c.opaque], "recognised shapes and the password member are removed");
    expect(sanitized.report).toMatchObject({ applied: true, completeness: "best_effort" });
    expect(sanitized.report.redactions).toBeGreaterThan(0);
    const exact = sanitizeForModel({ free: `the value was ${c.opaque}` }, { knownSecrets: [c.opaque] });
    assertNoCanaries(exact.value, [c.opaque], "a secret the caller holds is removed by exact value");
    exercised.add("model-visible");
  });

  it("LIMIT (characterization): an unknown secret with no shape in a neutral field is returned to the model", () => {
    const c = runtimeCanaries();
    const sanitized = sanitizeForModel({ free: `the value was ${c.opaque}` });
    expect(deepScanForCanaries(sanitized.value, [c.opaque]).length).toBeGreaterThan(0);
    expect(sanitized.report.completeness).toBe("best_effort");
  });
});

/* ------------------------------- workflow history ------------------------------- */

describe("Temporal payloads", () => {
  it("are AES-GCM envelopes: only the encoding and the key id are visible, and nothing of the payload appears", async () => {
    const c = runtimeCanaries();
    const codec = new TemporalPayloadCodec(randomBytes(32).toString("hex"));
    const payload = { metadata: { encoding: Buffer.from("json/plain") }, data: Buffer.from(JSON.stringify({ shapes: allShapes(c), note: "input" })) };
    const [encoded] = await codec.encode([payload]);
    expect(Object.keys(encoded.metadata ?? {}).sort()).toEqual(["encoding", "zenith.temporal.key-id"]);
    assertNoCanaries([encoded.metadata, encoded.data], allShapes(c), "no payload content appears outside the ciphertext");
    const [decoded] = await codec.decode([encoded]);
    expect(Buffer.from(decoded.data ?? new Uint8Array()).toString("utf8")).toContain(c.opaque);
    exercised.add("temporal");
  });
});

/* ------------------------- the platform control store ------------------------- */

describe.each(LANES)("platform control store [$name]", (lane) => {
  let lease: Awaited<ReturnType<typeof openLane>>;
  beforeEach(async () => { lease = await openLane(lane); }, 60_000);
  afterEach(async () => { await lease.close(); });
  const db = () => lease.db;

  async function claimedJob(ws: string) {
    const { tokenHash } = repos.runners.generateRegistrationToken("runner");
    await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
    const runner = await repos.runners.registerRunner(db(), { tokenHash, name: "leak-runner", publicKey: KEY, capabilities: ["tofu.run"] });
    const { operation } = await seedApprovedOperation(db(), ws);
    const jobId = uid("job");
    await repos.jobs.enqueue(db(), { id: jobId, workspaceId: ws, runnerId: runner.id, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
    expect(await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id, max: 1 })).toHaveLength(1);
    return { runnerId: runner.id, jobId };
  }
  const scan = async (needles: string[], invariant: string): Promise<void> => {
    assertNoCanaries(await dumpSchema(db(), "platform"), needles, invariant);
  };

  it("events and evidence refuse every recognised shape, and nothing of it is in any row", async () => {
    const ws = newWorkspace();
    const c = runtimeCanaries();
    for (const [name, value] of Object.entries({ aws: c.aws, github: c.github, slack: c.slack, jwt: c.jwt, pem: c.pem, url: c.url })) {
      await expect(repos.events.append(db(), { workspaceId: ws, type: "operation.started", correlationId: `leak-${name}`, data: { diagnostic: value } }), `events ${name}`).rejects.toMatchObject({ code: "secret_material" });
      await expect(repos.evidence.insert(db(), { workspaceId: ws, kind: "http_probe", digest: "a".repeat(64), simulated: false, summary: { diagnostic: value } }), `evidence ${name}`).rejects.toMatchObject({ code: "secret_material" });
    }
    await scan(recognisedShapes(c), "refused values are not persisted");
    exercised.add("events");
    exercised.add("evidence");
  });

  it("a secret-named configuration member is refused outright, whatever its value", async () => {
    const ws = newWorkspace();
    const c = runtimeCanaries();
    await expect(repos.connections.create(db(), { workspaceId: ws, config: { provider: "aws", mode: "assume_role", secretAccessKey: c.opaque } as never, createdBy: "leak-test" })).rejects.toMatchObject({ code: "secret_material" });
    await scan([c.opaque], "a refused connection config leaves no row");
    exercised.add("connections");
  });

  it("job logs withhold recognised shapes, and a refused result error stores nothing", async () => {
    const ws = newWorkspace();
    const c = runtimeCanaries();
    const { runnerId, jobId } = await claimedJob(ws);
    const lines = [c.aws, c.github, c.slack, c.jwt, c.url, c.pem].map((line) => ({ ts: new Date().toISOString(), stream: "stdout" as const, line }));
    expect(await repos.jobs.appendLogs(db(), { workspaceId: ws, runnerId, jobId, batchSeq: 0, lines })).toBe(lines.length);
    const stored = await repos.jobs.listLogs(db(), { workspaceId: ws, jobId });
    expect(JSON.stringify(stored)).toContain("line withheld");
    await expect(repos.jobs.settle(db(), { workspaceId: ws, runnerId, jobId, status: "failed", error: c.aws })).rejects.toMatchObject({ code: "secret_material" });
    assertNoCanaries(stored, recognisedShapes(c), "listed log lines carry no recognised shape");
    await scan(recognisedShapes(c), "no job log or job row holds a recognised shape");
    exercised.add("job-logs");
  });

  it("LIMIT (characterization): an unknown secret with no shape in a write-guarded free-text store IS persisted, and the inventory says so", async () => {
    const ws = newWorkspace();
    const c = runtimeCanaries();
    await repos.events.append(db(), { workspaceId: ws, type: "operation.started", correlationId: "leak-opaque", data: { diagnostic: c.opaque } });
    const { runnerId, jobId } = await claimedJob(ws);
    await repos.jobs.appendLogs(db(), { workspaceId: ws, runnerId, jobId, batchSeq: 0, lines: [{ ts: new Date().toISOString(), stream: "stdout", line: `value ${c.opaque}` }] });
    expect(deepScanForCanaries(await dumpSchema(db(), "platform"), [c.opaque]).length, "guards recognise shapes, not secrets").toBeGreaterThan(0);
    expect(TABLES["platform.events"].columns.data.protection.kind).toBe("write-guarded");
    expect(TABLES["platform.runner_job_logs"].columns.line.protection.kind).toBe("write-guarded");
    for (const sink of [TABLES["platform.events"].columns.data, TABLES["platform.runner_job_logs"].columns.line]) expect(sink.protection.kind).not.toBe("sealed");
  });

  it("job results and machine artifacts accept secrets of ANY shape, hold only sealed boxes, and the boxes open again", async () => {
    const ws = newWorkspace();
    const c = runtimeCanaries();
    const sealer = createAesResultSealer(randomBytes(32), { keyId: "leak-key" });
    const { runnerId, jobId } = await claimedJob(ws);
    const body = { everything: allShapes(c) };
    const box = sealer.seal(`${ws}|${jobId}`, body);
    const result = { sealed: box, exitCode: 0, startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:00:01.000Z" };
    expect(await repos.jobs.settle(db(), { workspaceId: ws, runnerId, jobId, status: "succeeded", result })).toBe(true);
    // the machine artifact cache holds a sealed box in the same way
    await db().query("insert into platform.idempotency_keys (workspace_id, key, request_hash, response, expires_at) values ($1, $2, $3, $4::text::jsonb, clock_timestamp() + interval '1 hour')",
      [ws, "machine-output:leak", "0".repeat(64), JSON.stringify(sealer.seal(`${ws}|artifact`, { stdout: c.opaque }))]);

    await scan(allShapes(c), "a sealed result never exposes the secrets inside it");
    const [row] = await db().query<{ result: unknown }>("select result from platform.runner_jobs where id = $1", [jobId]);
    expect(verifyResultEnvelope(row.result)).toEqual({ ok: true });
    expect(sealer.open(`${ws}|${jobId}`, (row.result as { sealed: unknown }).sealed)).toEqual(body);
    // The Postgres lane shares one schema with other suites whose rows are deliberately plain; only the private PGlite lane is censused.
    if (lane.name === "pglite") {
      const census = await atRestCensus(db());
      expect(census.filter((r) => !r.absent && r.violations > 0), "every sealed column holds ciphertext-shaped values").toEqual([]);
    }
    exercised.add("job-logs");
  });
});

/* ------------------------------ the agent (MCP) path ------------------------------ */

describe("agent proposals through the capability broker", () => {
  it("a secret handed to an agent action is never forwarded into a proposal, an operation or any row", async () => {
    const h = await makeHarness({ kind: "pglite" });
    const c = runtimeCanaries();
    const actionCtx = { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, actor: { type: "navigator" as const, id: "navigator", name: "Navigator" } };
    const result = await checkActionThroughBroker(h.deps, actionCtx, "system.setSecret", { serviceId: h.ids.resAWebProd, key: "DATABASE_URL", secretValue: c.url, moveExistingValue: true }, { persist: true });
    expect((await h.store.listOperations(h.ids.wsA)).items.length, "the proposal was persisted, so the scan is meaningful").toBeGreaterThan(0);
    assertNoCanaries(result, [c.url, c.urlPassword], "the broker result never carries the secret");
    assertNoCanaries(await dumpSchema(h.db!, "platform"), [c.url, c.urlPassword], "no platform row holds the agent-supplied secret");
    exercised.add("broker");
  }, 60_000);
});

/* --------------------------------- coverage guard --------------------------------- */

describe("coverage of the inventory's leak paths", () => {
  it("every leak path the inventory names was exercised by a test above", () => {
    expect([...exercised].sort()).toEqual([...LEAK_PATHS].sort());
  });
});
