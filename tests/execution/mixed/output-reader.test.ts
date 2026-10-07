/**
 * The producer output reader (PROD-MIX follow-up), at contract level.
 *
 * What runs: the reader over an in-memory record store, an in-memory vault and a labelled contract reading source. The
 * production sources (the platform record table, the producer's own observation rows) are exercised against the real SQL
 * store in tests/controlplane/mixed-follow-up.test.ts. No cloud API is called.
 *
 * Proven here: what the reader returns is accepted by the run orchestration's own validation (contract, scope, provenance,
 * the producer's recorded success); plain values are reduced to digests; secrets become vault references only; unreadable
 * or wrongly typed readings refuse the batch; recorded outputs win on a retry; a disagreeing re-read is a conflict.
 */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import type { MixedOutputRecord } from "@/lib/controlplane/db/repos/mixed-output-records";
import type { DeclaredReference } from "@/lib/execution/mixed/parent-plan";
import { MIXED_RECEIPT_FORMAT, type ChildReceipt, type MixedParentPlan } from "@/lib/execution/mixed/types";
import {
  createProducerOutputReader, ProducerOutputError, secretOutputRef, type OutputRecordStore, type ProducerReading, type ProducerReadingSource, type VaultPort,
} from "@/lib/execution/mixed/output-reader";
import { parentViewOfPlan, recordChildStart, syncChildOutcome, type JoinDeps } from "@/lib/execution/mixed/orchestration-join";
import type { MixedWorld } from "@/lib/execution/mixed/world";
import { MixedOrchestrationError, openMixedRun, readMixedRun, refusingParentReviewPort, validateOutput, type MixedRunDeps } from "@/lib/execution/mixed-orchestration";
import { MemoryPreauthorizationStore } from "@/lib/execution/mixed-orchestration/preauthorization";
import { MemoryMixedRunStore } from "@/lib/execution/mixed-orchestration/run-store";
import { DB, WEB, WS, plan } from "./_fixtures";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const PARENT = "op-parent-reader";
const HOST = { id: "db-host", producer: { address: DB, output: "endpoint", type: "endpoint" as const }, consumer: { address: WEB, input: "endpoint_db", type: "endpoint" as const } };
const SECRET = { id: "db-secret", producer: { address: DB, output: "password", type: "secret_ref" as const }, consumer: { address: WEB, input: "db_password", type: "secret_ref" as const } };

class MemoryRecords implements OutputRecordStore {
  rows = new Map<string, MixedOutputRecord>();
  private key = (ws: string, plan: string, ref: string, receipt: string) => `${ws}|${plan}|${ref}|${receipt}`;
  async get(ws: string, planId: string, ref: string, receipt: string) { return this.rows.get(this.key(ws, planId, ref, receipt)) ?? null; }
  async record(input: Omit<MixedOutputRecord, "recordedAt">) {
    const key = this.key(input.workspaceId, input.planId, input.referenceId, input.receiptDigest);
    const existing = this.rows.get(key);
    if (existing) {
      if (existing.valueDigest !== input.valueDigest || existing.secretRef !== input.secretRef) throw Object.assign(new Error("conflict"), { code: "conflict" });
      return { record: existing, created: false };
    }
    const record = { ...input, recordedAt: NOW.toISOString() };
    this.rows.set(key, record);
    return { record, created: true };
  }
}

class MemoryVault implements VaultPort {
  entries = new Map<string, { value: string; version: number }>();
  async status(ws: string, ref: string) { const e = this.entries.get(`${ws}|${ref}`); return e ? { exists: true, version: e.version } : { exists: false }; }
  async put(ws: string, ref: string, value: string, _by?: string) {
    const key = `${ws}|${ref}`;
    const version = (this.entries.get(key)?.version ?? 0) + 1;
    this.entries.set(key, { value, version });
    return { version };
  }
}

/** A labelled contract source: returns exactly the readings the test hands it, once per call. */
class ContractSource implements ProducerReadingSource {
  calls = 0;
  constructor(public readings: Record<string, ProducerReading | { unreadable: string }>) {}
  async read(input: Parameters<ProducerReadingSource["read"]>[0]) {
    this.calls += 1;
    return new Map(input.references.map((ref) => [ref.referenceId, this.readings[ref.referenceId] ?? { unreadable: "absent" }]));
  }
}

const reading = (value: unknown, over: Partial<ProducerReading> = {}): ProducerReading => ({ value, sensitive: false, source: "observation", sourceDigest: digest(`src-${String(value)}`), observedAt: NOW.toISOString(), ...over });

function receiptOf(parent: MixedParentPlan, partitionId: string, over: Partial<ChildReceipt> = {}): ChildReceipt {
  return {
    format: MIXED_RECEIPT_FORMAT, receiptId: `rcpt-${partitionId.slice(-6)}`, workspaceId: WS, parentPlanId: parent.parentPlanId, partitionId, ordinal: 0, childOperationId: "op-child-db",
    outcome: "succeeded", childStatus: "succeeded", receiptDigest: digest(`receipt-${partitionId}`), recordedAt: NOW.toISOString(), ...over,
  };
}

async function openedRun(parent: MixedParentPlan) {
  const run: MixedRunDeps = {
    runs: new MemoryMixedRunStore(), preauthorizations: new MemoryPreauthorizationStore(), roles: {} as MixedRunDeps["roles"],
    teardownApprovals: { lookup: async () => null }, parentReview: refusingParentReviewPort, now: () => NOW,
  };
  const deps: JoinDeps = { sql: undefined as never, world: {} as MixedWorld, run, now: () => NOW };
  await openMixedRun(run, { workspaceId: WS, parentOperationId: PARENT, view: parentViewOfPlan(parent), expiresAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(), childTimeoutMs: 3_600_000 });
  return { run, deps };
}

function setup(references: readonly DeclaredReference[] = [HOST], readings: Record<string, ProducerReading | { unreadable: string }> = { "db-host": reading("db.internal.example") }) {
  const parent = plan({ references });
  const producer = parent.children.find((child) => child.nodes.some((node) => node.address === DB))!;
  const consumer = parent.children.find((child) => child.nodes.some((node) => node.address === WEB))!;
  const records = new MemoryRecords();
  const vault = new MemoryVault();
  const source = new ContractSource(readings);
  const read = createProducerOutputReader({ records, source, vault, now: () => NOW });
  const receipt = receiptOf(parent, producer.partitionId);
  const refs = parent.references.map((ref) => ({ referenceId: ref.referenceId, consumerChildId: ref.consumerPartitionId, producerAddress: ref.producerAddress!, producerOutput: ref.producerOutput! }));
  const call = (over: { receipt?: ChildReceipt; effectDigest?: string; references?: typeof refs } = {}) =>
    read(WS, { partitionId: producer.partitionId, childOperationId: "op-child-db", receiptDigest: (over.receipt ?? receipt).receiptDigest, receipt: over.receipt ?? receipt, plan: parent, effectDigest: over.effectDigest ?? producer.effectDigest }, over.references ?? refs);
  return { parent, producer, consumer, records, vault, source, receipt, refs, call };
}

describe("producer outputs the run orchestration accepts", () => {
  it("returns a typed output with provenance that passes the run's own validation after the producer succeeded", async () => {
    const s = setup();
    const { run, deps } = await openedRun(s.parent);
    await recordChildStart(deps, { workspaceId: WS, parentOperationId: PARENT, plan: s.parent, partitionId: s.producer.partitionId });
    await syncChildOutcome(deps, { workspaceId: WS, parentOperationId: PARENT, plan: s.parent, partitionId: s.producer.partitionId, state: "succeeded", receipt: s.receipt });
    const state = (await readMixedRun(run, WS, PARENT))!.state;
    const outputs = await s.call({ effectDigest: state.children[s.producer.partitionId].effectDigest });
    expect(outputs).toHaveLength(1);
    const output = validateOutput(outputs[0], state, parentViewOfPlan(s.parent));
    expect(output).toMatchObject({
      referenceId: "db-host", type: "endpoint", valueDigest: digest({ type: "endpoint", value: "db.internal.example" }),
      scope: { workspaceId: WS, environmentId: s.parent.parentEnvironmentId, consumerChildId: s.consumer.partitionId, consumerConnectionId: s.consumer.authority.connectionId },
      provenance: { producerChildId: s.producer.partitionId, producerAddress: DB, producerOutput: "endpoint", producerSubplanDigest: s.producer.subplanDigest, receiptDigest: s.receipt.receiptDigest },
    });
    expect(JSON.stringify(outputs)).not.toContain("db.internal.example");
  });

  it("is refused by the run when the producer never succeeded in it (the reader does not decide that)", async () => {
    const s = setup();
    const { run } = await openedRun(s.parent);
    const state = (await readMixedRun(run, WS, PARENT))!.state;
    const outputs = await s.call();
    let failure: unknown;
    try { validateOutput(outputs[0], state, parentViewOfPlan(s.parent)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MixedOrchestrationError);
    expect((failure as MixedOrchestrationError).code).toBe("producer_not_succeeded");
  });
});

describe("recording with provenance", () => {
  it("records one row per reference and receipt: digest, producer operation, address, output, source digest and observation time, no value", async () => {
    const s = setup();
    await s.call();
    const row = await s.records.get(WS, s.parent.parentPlanId, "db-host", s.receipt.receiptDigest);
    expect(row).toMatchObject({
      producerPartitionId: s.producer.partitionId, consumerPartitionId: s.consumer.partitionId, producerOperationId: "op-child-db", producerAddress: DB, producerOutput: "endpoint",
      valueType: "endpoint", valueDigest: digest({ type: "endpoint", value: "db.internal.example" }), source: "observation", observedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(row)).not.toContain("db.internal.example");
  });

  it("returns the recorded output on a retry and never reads the source again", async () => {
    const s = setup();
    const first = await s.call();
    const second = await s.call();
    expect(second).toEqual(first);
    expect(s.source.calls).toBe(1);
  });

  it("a source that now disagrees with the record is a conflict, not an overwrite (a changed value needs a new receipt and review)", async () => {
    const s = setup();
    await s.call();
    const other = new Map([...s.records.rows]);
    // Simulate the record store seeing a different value digest for the same receipt, as a concurrent reader would.
    const changed = createProducerOutputReader({ records: { get: async () => null, record: async (input) => s.records.record({ ...input, valueDigest: digest("different") }) }, source: new ContractSource({ "db-host": reading("db.other.example") }), vault: s.vault });
    await expect(changed(WS, { partitionId: s.producer.partitionId, childOperationId: "op-child-db", receiptDigest: s.receipt.receiptDigest, receipt: s.receipt, plan: s.parent, effectDigest: s.producer.effectDigest }, s.refs)).rejects.toMatchObject({ code: "conflict" });
    expect([...s.records.rows]).toEqual([...other]);
  });
});

describe("what the reader refuses", () => {
  it("an unreadable reference refuses the whole batch and records nothing", async () => {
    const s = setup([HOST, SECRET], { "db-host": reading("db.internal.example") });
    await expect(s.call()).rejects.toMatchObject({ code: "not_readable", detail: ["db-secret"] });
    expect(s.records.rows.size).toBe(0);
  });

  it("a value of the wrong declared type is refused", async () => {
    for (const bad of [42, true, "", "x".repeat(3000), "line\nbreak", null]) {
      const s = setup([HOST], { "db-host": reading(bad) });
      await expect(s.call()).rejects.toBeInstanceOf(ProducerOutputError);
    }
  });

  it("a sensitive reading is never accepted as a plain output", async () => {
    const s = setup([HOST], { "db-host": reading("hunter2", { sensitive: true }) });
    await expect(s.call()).rejects.toMatchObject({ code: "secret_refused" });
  });

  it("a receipt that is not this plan's succeeded producer receipt is refused before anything is read", async () => {
    const s = setup();
    for (const receipt of [
      { ...s.receipt, outcome: "failed" as const }, { ...s.receipt, workspaceId: "ws-other" }, { ...s.receipt, parentPlanId: "other-plan" },
      { ...s.receipt, partitionId: s.consumer.partitionId }, { ...s.receipt, childOperationId: "op-other" },
    ]) await expect(s.call({ receipt })).rejects.toMatchObject({ code: "receipt_mismatch" });
    expect(s.source.calls).toBe(0);
  });

  it("a reference the stored plan does not declare for this producer is refused", async () => {
    const s = setup();
    await expect(s.call({ references: [{ ...s.refs[0], referenceId: "invented" }] })).rejects.toMatchObject({ code: "invalid_plan" });
    await expect(s.call({ references: [{ ...s.refs[0], producerOutput: "other" }] })).rejects.toMatchObject({ code: "invalid_plan" });
    await expect(s.call({ references: [{ ...s.refs[0], consumerChildId: s.producer.partitionId }] })).rejects.toMatchObject({ code: "invalid_plan" });
  });
});

describe("secrets are vault references only", () => {
  const secretSetup = (readings: Record<string, ProducerReading | { unreadable: string }>) => setup([SECRET], readings);

  it("seals secret material into the workspace vault and returns only the reference and its version digest", async () => {
    const material = ["s3cr3t", "-value-", String(Date.now())].join("");
    const s = secretSetup({ "db-secret": reading(material, { sensitive: true, source: "tofu_output" }) });
    const [output] = (await s.call()) as { secret: { ref: string; versionDigest: string }; valueDigest: string; type: string }[];
    const ref = secretOutputRef(s.parent, s.producer.partitionId, "db-secret");
    expect(output.type).toBe("secret_ref");
    expect(output.secret).toEqual({ ref, versionDigest: digest({ ref, version: 1 }) });
    expect(output.valueDigest).toBe(digest({ ref, versionDigest: output.secret.versionDigest }));
    expect(s.vault.entries.get(`${WS}|${ref}`)?.value).toBe(material);
    const stored = JSON.stringify([...s.records.rows.values()]) + JSON.stringify(output);
    expect(stored).not.toContain(material);
    // The digest of a secret never confirms a guess of its value.
    expect(stored).not.toContain(digest(material));
  });

  it("accepts a named existing vault entry of this workspace and refuses one that does not exist", async () => {
    const ref = "vault:proj/svc/DB_PASSWORD";
    const present = secretSetup({ "db-secret": reading(ref) });
    await present.vault.put(WS, ref, "x", "test");
    const [output] = (await present.call()) as { secret: { ref: string } }[];
    expect(output.secret.ref).toBe(ref);
    const absent = secretSetup({ "db-secret": reading(ref) });
    await expect(absent.call()).rejects.toMatchObject({ code: "secret_refused" });
    // another workspace's vault entry is not visible
    const foreign = secretSetup({ "db-secret": reading(ref) });
    await foreign.vault.put("ws-other", ref, "x", "test");
    await expect(foreign.call()).rejects.toMatchObject({ code: "secret_refused" });
  });

  it("refuses a plain (non-vault) value as a secret output and an empty one", async () => {
    for (const value of ["not-a-ref", "", 12]) {
      const s = secretSetup({ "db-secret": reading(value) });
      await expect(s.call()).rejects.toMatchObject({ code: "secret_refused" });
    }
  });

  it("the sealed reference is derived only from plan, producer and reference ids and is a valid vault reference", () => {
    const parent = plan({ references: [SECRET] });
    const a = secretOutputRef(parent, "p1", "db-secret");
    expect(a).toMatch(/^vault:[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/);
    expect(secretOutputRef(parent, "p1", "db-secret")).toBe(a);
    expect(secretOutputRef(parent, "p2", "db-secret")).not.toBe(a);
    expect(secretOutputRef(parent, "p1", "other")).not.toBe(a);
  });
});
