/**
 * PROD-MIX-06: the reference mixed app, its traffic generator and its independent readback checker, LOCAL ENGINE level.
 * The fixture's real HTTP servers (web tier and enricher) run on loopback with the in-memory store, so the traffic, the
 * acknowledgement rules and the readback verdicts are exercised for real; no cloud, no PostgreSQL and no TLS is involved.
 * That is exactly what this proves and no more: the live deployment (GCP, Azure, AWS) is scripts/acceptance/mixed/live-run.ts,
 * gated and deferred, and a pass here is never evidence of it.
 */
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManifestV2 } from "@/lib/resources/manifest-v2";
import { referenceCostGraph } from "../../scripts/acceptance/mixed/cost-report";
import { expectedChecksum, expectedPriceCents, memoryReadback, verifyReadback, type SourceInfo, type StoredOrder } from "../../scripts/acceptance/mixed/readback";
import { nodeRequester, planOrders, runTraffic, summarize, type Requester, type TrafficLedger, type WriteRecord } from "../../scripts/acceptance/mixed/traffic";
import manifest from "../../fixtures/mixed-app/zenith.app.json";
import spec from "../../fixtures/mixed-app/spec.json";
// The fixture is plain ESM (it ships to the clouds as-is).
import { createEnricherServer } from "../../fixtures/mixed-app/enricher/server.mjs";
import { createMemoryStore, createStoreFromEnv } from "../../fixtures/mixed-app/web/stores.mjs";
import { createWebServer } from "../../fixtures/mixed-app/web/server.mjs";

const RUN = "zlive-202610071200-abcd";
const DIRECT: SourceInfo = { channel: "direct_database", kind: "memory" };
const EXPECT = { runId: RUN, expectedProviders: { web: "gcp", enricher: "aws" } };

const listen = (server: http.Server): Promise<number> => new Promise((resolve) => { server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)); });
const close = (server: http.Server): Promise<void> => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

interface Stack { store: ReturnType<typeof createMemoryStore>; entry: string; enricher: http.Server; web: http.Server; stopEnricher(): Promise<void> }
let stack: Stack;

async function startStack(): Promise<Stack> {
  const enricher = createEnricherServer({ provider: "aws" });
  const enricherPort = await listen(enricher);
  const store = createMemoryStore();
  const web = createWebServer({ store, env: { ENRICHER_URL: `http://127.0.0.1:${enricherPort}`, WEB_PROVIDER: "gcp", ENRICHER_TIMEOUT_MS: "1500" } as unknown as NodeJS.ProcessEnv });
  const webPort = await listen(web);
  return { store, entry: `http://127.0.0.1:${webPort}`, enricher, web, stopEnricher: () => close(enricher) };
}

beforeAll(async () => { stack = await startStack(); });
afterAll(async () => { await close(stack.web); await close(stack.enricher); });

const rows = (store: Stack["store"]): StoredOrder[] => store.all().map((r: StoredOrder) => ({ clientKey: r.clientKey, sku: r.sku, qty: r.qty, priceCents: r.priceCents, checksum: r.checksum, webProvider: r.webProvider, enricherProvider: r.enricherProvider }));

describe("the reference app serves real traffic and the independent checker agrees", () => {
  it("acknowledges every write, stores each exactly once and proves both tiers took part", async () => {
    const ledger = await runTraffic(stack.entry, { runId: RUN, seed: 7, count: 30, concurrency: 4, replay: 3 });
    expect(ledger.counts).toEqual({ acknowledged: 33, rejected: 0, uncertain: 0 });
    expect(ledger.records.filter((r) => r.replay).every((r) => r.status === 200)).toBe(true);
    expect(ledger.records.filter((r) => !r.replay).every((r) => r.status === 201)).toBe(true);
    const verdict = verifyReadback(ledger, rows(stack.store), DIRECT, EXPECT);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.counts).toMatchObject({ acknowledged: 30, foundAcknowledged: 30, phantoms: 0, rows: 30 });
    expect(verdict.providersSeen).toEqual({ web: ["gcp"], enricher: ["aws"] });
  });

  it("is idempotent: the same client key is acknowledged again and never stored twice", async () => {
    const send = nodeRequester();
    const body = JSON.stringify({ clientKey: `${RUN}-idem-1`, sku: "widget", qty: 2 });
    const first = await send({ method: "POST", url: new URL("/orders", stack.entry), body, timeoutMs: 3000 });
    const second = await send({ method: "POST", url: new URL("/orders", stack.entry), body, timeoutMs: 3000 });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(JSON.parse(second.body)).toMatchObject({ clientKey: `${RUN}-idem-1`, replay: true, priceCents: 500 });
    expect(stack.store.all().filter((r: StoredOrder) => r.clientKey === `${RUN}-idem-1`)).toHaveLength(1);
  });

  it("rejects invalid input definitively and stores nothing for it", async () => {
    const send = nodeRequester();
    for (const body of [{ clientKey: `${RUN}-bad-1`, sku: "widget", qty: 999 }, { clientKey: `${RUN}-bad-2`, sku: "widget", qty: 0 }, { clientKey: "has space", sku: "widget", qty: 1 }, { clientKey: `${RUN}-bad-3`, qty: 1 }]) {
      expect((await send({ method: "POST", url: new URL("/orders", stack.entry), body: JSON.stringify(body), timeoutMs: 3000 })).status).toBe(400);
    }
    expect((await send({ method: "POST", url: new URL("/orders", stack.entry), body: JSON.stringify({ clientKey: `${RUN}-bad-4`, sku: "nonexistent", qty: 1 }), timeoutMs: 3000 })).status).toBe(422);
    expect(stack.store.all().some((r: StoredOrder) => r.clientKey.startsWith(`${RUN}-bad-`))).toBe(false);
    expect((await send({ method: "POST", url: new URL("/orders", stack.entry), body: "{not json", timeoutMs: 3000 })).status).toBe(400);
    expect((await send({ method: "GET", url: new URL("/orders/zlive-nope-1", stack.entry), timeoutMs: 3000 })).status).toBe(404);
  });

  it("reads a stored order back through the app too (a second channel the checker deliberately does not use)", async () => {
    const send = nodeRequester();
    const got = await send({ method: "GET", url: new URL(`/orders/${RUN}-idem-1`, stack.entry), timeoutMs: 3000 });
    expect(got.status).toBe(200);
    const count = await send({ method: "GET", url: new URL(`/orders?prefix=${RUN}-`, stack.entry), timeoutMs: 3000 });
    expect(JSON.parse(count.body).count).toBeGreaterThanOrEqual(31);
    expect((await send({ method: "GET", url: new URL("/health", stack.entry), timeoutMs: 3000 })).status).toBe(200);
  });

  it("an unreachable enricher is never an acknowledgement and nothing is stored", async () => {
    const local = await startStack();
    await local.stopEnricher();
    const ledger = await runTraffic(local.entry, { runId: "zlive-202610071300-down", seed: 1, count: 3, timeoutMs: 3000 });
    expect(ledger.counts).toEqual({ acknowledged: 0, rejected: 0, uncertain: 3 });
    expect(ledger.records.every((r) => r.status === 502)).toBe(true);
    expect(local.store.all()).toEqual([]);
    const verdict = verifyReadback(ledger, [], DIRECT, { ...EXPECT, runId: "zlive-202610071300-down" });
    expect(verdict.counts.uncertainAbsent).toBe(3);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("No acknowledged writes");
    await close(local.web);
  });

  it("refuses to fall back to the in-memory store unless STORE=memory is explicit", async () => {
    await expect(createStoreFromEnv({} as unknown as NodeJS.ProcessEnv)).rejects.toThrow("DATABASE_URL_FILE");
    expect((await createStoreFromEnv({ STORE: "memory" } as unknown as NodeJS.ProcessEnv)).kind).toBe("memory");
  });
});

describe("the traffic generator", () => {
  const ack = (order: { clientKey: string; sku: string; qty: number }) => {
    const priceCents = expectedPriceCents(order.sku, order.qty)!;
    return JSON.stringify({ ...order, priceCents, checksum: expectedChecksum({ ...order, priceCents }), webProvider: "gcp", enricherProvider: "aws" });
  };
  const requester = (status: number | "throw" | "timeout" | "garbage" | "other-key"): Requester => async (request) => {
    const order = JSON.parse(request.body!) as { clientKey: string; sku: string; qty: number };
    if (status === "throw") throw new Error("connection refused");
    if (status === "timeout") throw new Error("timeout");
    if (status === "garbage") return { status: 201, body: "<html>" };
    if (status === "other-key") return { status: 201, body: ack({ ...order, clientKey: "someone-else" }) };
    return { status, body: status === 200 || status === 201 ? ack(order) : "{}" };
  };

  it("is deterministic and produces unique, valid orders", () => {
    const a = planOrders(RUN, 42, 50);
    expect(planOrders(RUN, 42, 50)).toEqual(a);
    expect(planOrders(RUN, 43, 50)).not.toEqual(a);
    expect(new Set(a.map((o) => o.clientKey)).size).toBe(50);
    expect(a.every((o) => o.clientKey.startsWith(`${RUN}-`) && o.sku in spec.catalogCents && o.qty >= 1 && o.qty <= spec.maxQty)).toBe(true);
    expect(() => planOrders("x", 1, 1)).toThrow();
    expect(() => planOrders(RUN, 1, 0)).toThrow();
  });

  it.each([[200, "acknowledged"], [201, "acknowledged"], [400, "rejected"], [422, "rejected"], [500, "uncertain"], [502, "uncertain"], [503, "uncertain"], ["throw", "uncertain"], ["timeout", "uncertain"], ["garbage", "uncertain"], ["other-key", "uncertain"]] as const)("classifies %s as %s", async (status, outcome) => {
    const ledger = await runTraffic("http://127.0.0.1:1", { runId: RUN, seed: 1, count: 2 }, { requester: requester(status) });
    expect(ledger.records.map((r) => r.outcome)).toEqual([outcome, outcome]);
  });

  it("records a timeout as a timeout and a refused connection as no response", async () => {
    expect((await runTraffic("http://127.0.0.1:1", { runId: RUN, seed: 1, count: 1 }, { requester: requester("timeout") })).records[0]!.error).toBe("timeout");
    expect((await runTraffic("http://127.0.0.1:1", { runId: RUN, seed: 1, count: 1 }, { requester: requester("throw") })).records[0]!.error).toBe("no_response");
  });

  it("digests the facts, not the timing, so equal runs compare equal", async () => {
    let clock = 0;
    const a = await runTraffic("http://127.0.0.1:1", { runId: RUN, seed: 5, count: 6 }, { requester: requester(201), now: () => (clock += 7) });
    const b = await runTraffic("http://127.0.0.1:1", { runId: RUN, seed: 5, count: 6 }, { requester: requester(201), now: () => (clock += 13) });
    expect(a.digest).toBe(b.digest);
    expect(a.records.map((r) => r.durationMs)).not.toEqual(b.records.map((r) => r.durationMs));
    expect((await runTraffic("http://127.0.0.1:1", { runId: RUN, seed: 6, count: 6 }, { requester: requester(201) })).digest).not.toBe(a.digest);
  });

  it("refuses a non-https entry that is not a local development host", async () => {
    await expect(runTraffic("http://app.example.com", { runId: RUN, seed: 1, count: 1 })).rejects.toThrow("https");
    await expect(runTraffic("https://app.example.com", { runId: RUN, seed: 1, count: 1 }, { requester: requester(201) })).resolves.toBeDefined();
  });
});

describe("the independent readback verdict", () => {
  const sent = (n: number, outcomes: Partial<Record<number, WriteRecord["outcome"]>> = {}): TrafficLedger => {
    const records: WriteRecord[] = planOrders(RUN, 3, n).map((o, i) => {
      const priceCents = expectedPriceCents(o.sku, o.qty)!;
      const outcome = outcomes[i] ?? "acknowledged";
      return { ...o, outcome, durationMs: 1, ...(outcome === "acknowledged" ? { status: 201, ack: { ...o, priceCents, checksum: expectedChecksum({ ...o, priceCents }), webProvider: "gcp", enricherProvider: "aws" } } : {}) };
    });
    return summarize(RUN, 3, records);
  };
  const stored = (ledger: TrafficLedger, skip: number[] = []): StoredOrder[] => ledger.records.flatMap((r, i) => (skip.includes(i) || r.outcome !== "acknowledged" ? [] : [{ clientKey: r.clientKey, sku: r.sku, qty: r.qty, priceCents: r.ack!.priceCents, checksum: r.ack!.checksum, webProvider: "gcp", enricherProvider: "aws" }]));
  const check = (ledger: TrafficLedger, data: StoredOrder[], info: SourceInfo = DIRECT, over: Partial<typeof EXPECT & { databaseHostSuffix: string }> = {}) => verifyReadback(ledger, data, info, { ...EXPECT, ...over });

  it("passes only when every acknowledged write is present and correct", () => {
    const ledger = sent(5);
    expect(check(ledger, stored(ledger)).ok).toBe(true);
  });

  it("fails on an acknowledged write that is missing, wrong, duplicated or served by the wrong cloud", () => {
    const ledger = sent(5);
    expect(check(ledger, stored(ledger, [2])).problems.join("|")).toContain("is not in the database");
    const wrongPrice = stored(ledger); wrongPrice[0] = { ...wrongPrice[0]!, priceCents: wrongPrice[0]!.priceCents + 1 };
    expect(check(ledger, wrongPrice).problems.join("|")).toContain("has price");
    const wrongSum = stored(ledger); wrongSum[1] = { ...wrongSum[1]!, checksum: "0".repeat(64) };
    expect(check(ledger, wrongSum).problems.join("|")).toContain("wrong checksum");
    const wrongQty = stored(ledger); wrongQty[2] = { ...wrongQty[2]!, qty: wrongQty[2]!.qty === 1 ? 2 : 1 };
    expect(check(ledger, wrongQty).ok).toBe(false);
    expect(check(ledger, [...stored(ledger), stored(ledger)[0]!]).problems.join("|")).toContain("stored 2 times");
    const wrongCloud = stored(ledger).map((r) => ({ ...r, webProvider: "aws" }));
    expect(check(ledger, wrongCloud).problems.join("|")).toContain('expected "gcp"');
    const wrongEnricher = stored(ledger).map((r) => ({ ...r, enricherProvider: "gcp" }));
    expect(check(ledger, wrongEnricher).problems.join("|")).toContain('expected "aws"');
  });

  it("fails on a phantom row of this run and on a rejected write that exists, and ignores other runs", () => {
    const ledger = sent(4, { 1: "rejected" });
    const good = stored(ledger);
    expect(check(ledger, good).ok).toBe(true);
    expect(check(ledger, [...good, { clientKey: `${RUN}-999`, sku: "widget", qty: 1, priceCents: 250, checksum: expectedChecksum({ clientKey: `${RUN}-999`, sku: "widget", qty: 1, priceCents: 250 }), webProvider: "gcp", enricherProvider: "aws" }]).counts.phantoms).toBe(1);
    const rejected = ledger.records[1]!;
    const withRejected = [...good, { clientKey: rejected.clientKey, sku: rejected.sku, qty: rejected.qty, priceCents: 1, checksum: "0".repeat(64), webProvider: "gcp", enricherProvider: "aws" }];
    expect(check(ledger, withRejected).problems.join("|")).toContain("Rejected write");
    expect(check(ledger, [...good, { clientKey: "other-run-1", sku: "widget", qty: 1, priceCents: 1, checksum: "x", webProvider: "z", enricherProvider: "z" }]).ok).toBe(true);
  });

  it("reports uncertain writes either way and never as a pass or a fail", () => {
    const ledger = sent(5, { 0: "uncertain", 3: "uncertain" });
    const present = [...stored(ledger), { clientKey: ledger.records[0]!.clientKey, sku: ledger.records[0]!.sku, qty: ledger.records[0]!.qty, priceCents: expectedPriceCents(ledger.records[0]!.sku, ledger.records[0]!.qty)!, checksum: expectedChecksum({ clientKey: ledger.records[0]!.clientKey, sku: ledger.records[0]!.sku, qty: ledger.records[0]!.qty, priceCents: expectedPriceCents(ledger.records[0]!.sku, ledger.records[0]!.qty)! }), webProvider: "gcp", enricherProvider: "aws" }];
    const verdict = check(ledger, present);
    expect(verdict.ok).toBe(true);
    expect(verdict.counts).toMatchObject({ uncertainPresent: 1, uncertainAbsent: 1 });
  });

  it("is not independent when it reads through the app or from memory, and a postgres source must carry the expected host", () => {
    const ledger = sent(3);
    const data = stored(ledger);
    expect(check(ledger, data, { channel: "application", kind: "postgres", host: "x.postgres.database.azure.com" }, { databaseHostSuffix: ".postgres.database.azure.com" }).problems.join("|")).toContain("not independent");
    expect(verifyReadback(ledger, data, memoryReadback(data).describe(), EXPECT).problems.join("|")).toContain("not independent");
    const pg = (host?: string): SourceInfo => ({ channel: "direct_database", kind: "postgres", ...(host ? { host } : {}) });
    expect(check(ledger, data, pg("zenith-mixed.postgres.database.azure.com"), { databaseHostSuffix: ".postgres.database.azure.com" }).ok).toBe(true);
    expect(check(ledger, data, pg("db.internal.example.com"), { databaseHostSuffix: ".postgres.database.azure.com" }).problems.join("|")).toContain("expected provider suffix");
    expect(check(ledger, data, pg("zenith-mixed.postgres.database.azure.com")).problems.join("|")).toContain("expected database host suffix");
    expect(check(ledger, data, pg(undefined), { databaseHostSuffix: ".postgres.database.azure.com" }).ok).toBe(false);
  });

  it("proves nothing from a run that acknowledged nothing, and refuses another run's ledger", () => {
    const none = sent(3, { 0: "uncertain", 1: "uncertain", 2: "uncertain" });
    expect(check(none, []).problems.join("|")).toContain("No acknowledged writes");
    expect(check(sent(2), [], DIRECT, { runId: "other-run" }).problems.join("|")).toContain("different run");
  });

  it("a replay that was not an idempotent 200 is a problem", () => {
    const ledger = sent(2);
    const replay: WriteRecord = { ...ledger.records[0]!, replay: true, status: 201 };
    expect(check(summarize(RUN, 3, [...ledger.records, replay]), stored(ledger)).problems.join("|")).toContain("idempotent 200");
  });
});

describe("the reference app's manifest and placement", () => {
  it("is a valid v2 manifest placing web on GCP, the enricher on AWS and PostgreSQL on Azure", () => {
    const parsed = ManifestV2.safeParse(manifest);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues.slice(0, 3))).toBe(true);
    expect(manifest.nodePlacement).toMatchObject({ web: { provider: "gcp" }, enricher: { provider: "aws" }, db: { provider: "azure" } });
    expect(spec.providers).toEqual({ web: "gcp", enricher: "aws", database: "azure" });
    expect(manifest.services.find((s) => s.id === "web")!.env.find((e) => e.key === "WEB_PROVIDER")!.value).toBe(spec.providers.web);
    expect(manifest.services.find((s) => s.id === "enricher")!.env.find((e) => e.key === "ENRICHER_PROVIDER")!.value).toBe(spec.providers.enricher);
  });

  it("keeps secrets out of the manifest and the database URL out of the environment", () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    expect(text).not.toMatch(/password|api[_-]?key|BEGIN [A-Z ]*KEY/i);
    expect(manifest.services.flatMap((s) => s.env).some((e) => e.key === "DATABASE_URL")).toBe(false);
  });

  it("derives a cost graph whose placements match the manifest and whose edges cross clouds", () => {
    const graph = referenceCostGraph();
    expect(graph.nodes.map((n) => `${n.address}@${n.provider}/${n.region}`).sort()).toEqual(["resource/db@azure/eastus", "service/enricher@aws/us-east-1", "service/web@gcp/us-central1"]);
    expect(graph.edges!.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["service/web->resource/db", "service/web->service/enricher"]);
  });
});
