import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { DATA_KINDS, DataProofSchema, WitnessSchema, assertEqualContent, fixtureContainerName, knownData, objectWitness, pinnedFixtureImages, rowWitness } from "../../../scripts/release/drivers/export-data-plan";
import { postgresEndpoint, postgresLeg } from "../../../scripts/release/drivers/export-data-postgres";
import { DRIVER_CHECKS, OPERATED_LABEL, OwnedCleanup, validateOperatedReceipt, type OperatedReceipt } from "../../../scripts/release/drivers/protocol";

const runId = "drv4-data", sourceCommit = "a".repeat(40), sourceDigest = "b".repeat(64);
const witness = (kind: string, tenant: "a" | "b") => kind === "object_store" ? objectWitness(knownData(runId, tenant).objects) : rowWitness(knownData(runId, tenant).rows);
function receipt(): OperatedReceipt {
  return { schema: 1, evidenceLabel: OPERATED_LABEL, scenarioId: "export", runId, sourceCommit, sourceDigest,
    checks: DRIVER_CHECKS.export.map(id => ({ id, status: "passed" })), readbacks: Object.fromEntries(["source", "bundle", "portable-plan", "portable"].map(k => [k, sourceDigest])),
    dataRoundtrips: Object.fromEntries(DATA_KINDS.map(kind => [kind, { source: witness(kind, "a"), target: witness(kind, "a"), otherTenant: witness(kind, "b"),
      exportedContentDigest: sourceDigest, restoredContentDigest: sourceDigest, tenantIsolation: true, mysqlTls: kind === "mysql" ? "verified_identity" : "not_applicable" }])),
    limits: ["local_operated_rehearsal; second real cloud provider live-deferred"] };
}
const binding = { scenarioId: "export", runId, sourceCommit };
describe("DRV4 customer-data witness planners", () => {
  it("plans three deterministic SQL rows and three binary/empty/unicode objects per tenant", () => {
    const a = knownData(runId, "a"), b = knownData(runId, "b");
    expect(a.rows).toHaveLength(3); expect(a.objects).toHaveLength(3);
    expect(a).toEqual(knownData(runId, "a")); expect(a.rows).not.toEqual(b.rows);
    expect(a.objects.some(o => o.bytes.length === 0)).toBe(true);
    expect(a.objects.some(o => o.bytes.includes(255))).toBe(true);
    expect(() => knownData("../escape", "a")).toThrow();
  });
  it("produces order-independent per-row digests without conflating null, empty, delimiters or foreign data", () => {
    const rows = knownData(runId, "a").rows;
    const base = rowWitness(rows);
    expect(base.count).toBe(3); expect(base.items).toHaveLength(3);
    expect(rowWitness([...rows].reverse())).toEqual(base);
    for (const altered of [rows.slice(1), [...rows, rows[0]], rows.map((r, i) => i === 0 ? { ...r, note: "" } : r), knownData(runId, "b").rows])
      expect(() => assertEqualContent(base, rowWitness(altered))).toThrow();
    const ambiguous = [{ id: "1", tenant: "a", payload: "b|c", note: "d" }];
    expect(rowWitness(ambiguous)).not.toEqual(rowWitness([{ ...ambiguous[0], payload: "b", note: "c|d" }]));
  });
  it("object witnesses bind exact key, body, byte count and content type", () => {
    const objects = knownData(runId, "a").objects, base = objectWitness(objects);
    expect(objectWitness([...objects].reverse())).toEqual(base);
    for (const changed of [objects.slice(1), objects.map((o, i) => i === 0 ? { ...o, key: "renamed" } : o),
      objects.map((o, i) => i === 1 ? { ...o, bytes: Buffer.from([0]) } : o), objects.map((o, i) => i === 2 ? { ...o, contentType: "text/plain" } : o), knownData(runId, "b").objects])
      expect(() => assertEqualContent(base, objectWitness(changed))).toThrow();
  });
  it("rejects tampered count, item digest, duplicate identity and item ordering", () => {
    const base = rowWitness(knownData(runId, "a").rows);
    for (const bad of [{ ...base, count: 2 }, { ...base, digest: "c".repeat(64) }, { ...base, items: [...base.items].reverse() },
      { ...base, items: [base.items[0], base.items[0], base.items[2]] }]) expect(WitnessSchema.safeParse(bad).success).toBe(false);
  });
  it("requires three explicit immutable image pins and never accepts floating or missing fixtures", () => {
    const env = Object.fromEntries(["POSTGRES", "MYSQL", "MINIO"].map(kind => [`ZENITH_LOCAL_EXPORT_${kind}_IMAGE`, `local/${kind.toLowerCase()}@sha256:${sourceDigest}`]));
    expect(Object.keys(pinnedFixtureImages(env))).toEqual(DATA_KINDS);
    for (const change of [{ ZENITH_LOCAL_EXPORT_MYSQL_IMAGE: "mysql:8.4" }, { ZENITH_LOCAL_EXPORT_MINIO_IMAGE: undefined }]) expect(() => pinnedFixtureImages({ ...env, ...change })).toThrow();
  });
  it("keeps source, target and negative-TLS DNS aliases valid at the longest supported run ID", () => {
    const entropy = randomBytes(12).toString("hex");
    const names = [];
    for (const engine of ["postgres", "mysql", "minio"]) for (const role of ["source", "target"]) {
      const name = fixtureContainerName("r".repeat(20), `${engine}-${role}`, entropy);
      expect(name + "-wrong").toMatch(/^[a-z0-9-]{1,63}$/); names.push(name);
    }
    expect(new Set(names).size).toBe(6);
    expect(() => fixtureContainerName("r".repeat(21), "mysql-source", entropy)).toThrow();
    expect(() => fixtureContainerName(runId, "foreign-source", entropy)).toThrow();
  });
  it("PostgreSQL leg refuses foreign endpoints and ownership before opening a connection", async () => {
    const password = randomBytes(32).toString("hex");
    const endpoint = { url: "postgres://127.0.0.1:49152/postgres", user: "postgres", password };
    expect(new URL(postgresEndpoint(endpoint, "tenant_a")).pathname).toBe("/tenant_a");
    for (const url of ["postgres://example.test:5432/postgres", "postgres://127.0.0.1/postgres", "mysql://127.0.0.1:49152/mysql"]) expect(() => postgresEndpoint({ ...endpoint, url })).toThrow();
    await expect(postgresLeg.seedSource({ runId, tenant: "a", ownerLabel: "foreign", source: endpoint, target: endpoint })).rejects.toThrow("ownership");
  });
  it("quiesces an unsettled workflow before draining partially seeded legs and still removes every owned container", async () => {
    const order: string[] = [], root = new OwnedCleanup(), fixtures = new OwnedCleanup(), engine = new OwnedCleanup();
    root.add(async () => { order.push("stack"); });
    root.add(async () => { if (!await fixtures.settle()) throw new Error("fixture cleanup failed"); });
    fixtures.add(async () => { order.push("minio-target"); });
    fixtures.add(async () => { order.push("minio-source"); });
    fixtures.add(async () => { if (!await engine.settle()) throw new Error("leg cleanup failed"); });
    engine.add(async () => { order.push("sql-source-container"); });
    engine.add(async () => { order.push("sql-target-container"); });
    engine.add(async () => { order.push("labelled-data"); throw new Error("partial seed cleanup refused"); });
    root.add(async () => { order.push("workflow-quiescence"); });
    expect(await root.settle()).toBe(false);
    expect(order).toEqual(["workflow-quiescence", "labelled-data", "sql-target-container", "sql-source-container", "minio-source", "minio-target", "stack"]);
    expect(await root.settle()).toBe(true);
    expect(order).toHaveLength(7);
  });
});
describe("DRV4 sanitized customer-data receipts", () => {
  it("requires all three independently matched source/target and foreign witnesses", () => {
    expect(validateOperatedReceipt(receipt(), binding)).toEqual(receipt());
    for (const kind of DATA_KINDS) {
      const raw = receipt(); delete raw.dataRoundtrips![kind];
      expect(() => validateOperatedReceipt(raw, binding)).toThrow("Missing data");
    }
  });
  it("rejects digest-only, count-only, mismatched, unscoped and falsely TLS-labelled evidence", () => {
    const proof = receipt().dataRoundtrips!.mysql!;
    for (const bad of [{ ...proof, target: rowWitness([]) }, { ...proof, otherTenant: proof.source }, { ...proof, tenantIsolation: false },
      { ...proof, restoredContentDigest: "c".repeat(64) }, { ...proof, password: randomBytes(32).toString("hex") }]) expect(DataProofSchema.safeParse(bad).success).toBe(false);
    const raw = receipt(); raw.dataRoundtrips!.mysql!.mysqlTls = "not_applicable";
    expect(() => validateOperatedReceipt(raw, binding)).toThrow("TLS");
    const json = JSON.stringify(receipt()); expect(json).not.toContain(knownData(runId, "a").rows[0].payload); expect(json).not.toContain("connectionRef");
  });
  it("retains failed partial evidence without promoting a skipped data check", () => {
    const raw = receipt(); delete raw.dataRoundtrips!.object_store;
    raw.checks.find(c => c.id === "object-store-data-roundtrip")!.status = "failed";
    expect(validateOperatedReceipt(raw, binding).checks.some(c => c.status === "failed")).toBe(true);
  });
});
