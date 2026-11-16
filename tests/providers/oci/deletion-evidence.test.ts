/**
 * Independent OCI deletion-completion evidence per resource family (PROD-LIFE-05).
 * Contract level: scripted OCI responses prove how the reader classifies them,
 * never that OCI answers that way. OCI MySQL must stay refused.
 */
import { describe, expect, it } from "vitest";
import { isAllowed } from "@/lib/providers/oci/allowlist";
import { DELETION_FAMILIES, MYSQL_NATIVE_TYPE, presenceOfDeletion, readDeletionEvidence } from "@/lib/providers/oci/deletion-evidence";
import { ociDrivers } from "@/lib/providers/oci/drivers";
import { WORK_REQUEST_APIS } from "@/lib/providers/oci/work-requests";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { COMPARTMENT, driverContext, err, FakeOci, json, ocid } from "./_support";

const nodeFor = (nativeType: string): ResourceNode => ({ address: `${nativeType.replace(/\W/g, "_")}/x`, kind: "volume", provider: "oci", region: "us-ashburn-1", nativeType, ownership: "managed", spec: {}, specDigest: "a".repeat(64), origin: [], dependsOn: [], labels: {} });
const withGet = Object.entries(DELETION_FAMILIES).filter(([, f]) => f.get);
const observeOnly = Object.entries(DELETION_FAMILIES).filter(([, f]) => f.observeOnly);
const idFor = (nativeType: string) => ocid(nativeType.replace(/^oci:/, "").replace(/_/g, ""), "res1");
const obs = (nativeType: string, presence: Observation["presence"], extra: Partial<Observation> = {}): Observation => ({ address: nodeFor(nativeType).address, presence, attributes: {}, observedAt: "2026-09-30T12:00:00.000Z", source: "test", simulated: false, ...extra });

describe("family table is consistent with the drivers and the allowlist", () => {
  it("covers every registered OCI driver native type, MySQL excepted", () => {
    const registered = new Set(ociDrivers.map((d) => d.nativeType));
    for (const nativeType of registered) {
      if (nativeType === MYSQL_NATIVE_TYPE) { expect(DELETION_FAMILIES[nativeType]).toBeUndefined(); continue; }
      expect(DELETION_FAMILIES[nativeType], nativeType).toBeDefined();
    }
  });

  it.each(withGet)("%s GET and listing are inside the infrastructure.observe allowlist", (nativeType, family) => {
    const get = family.get!(idFor(nativeType));
    expect(isAllowed("infrastructure.observe", { service: get.service, method: "GET", path: get.path })).toBe(true);
    expect(isAllowed("infrastructure.observe", { service: family.list!.service, method: "GET", path: family.list!.path })).toBe(true);
  });

  it("only names a work-request API that exists", () => {
    for (const [nativeType, family] of Object.entries(DELETION_FAMILIES)) {
      if (family.workRequests) expect(WORK_REQUEST_APIS[family.workRequests], nativeType).toBeDefined();
    }
  });
});

describe.each(withGet)("%s deletion evidence", (nativeType, family) => {
  const node = nodeFor(nativeType);
  const id = idFor(nativeType);
  const get = family.get!(id);
  const list = family.list!;
  const world = (getRes: ReturnType<typeof json>, listRes: ReturnType<typeof json> | undefined = json({ items: [] })) => {
    const t = new FakeOci().route("GET", get.path, getRes);
    if (listRes) t.route("GET", list.path, listRes);
    return t;
  };

  it("proves deletion from a TERMINATED/DELETED lifecycle state without needing the listing", async () => {
    const t = world(json({ id, lifecycleState: "TERMINATED" }), undefined);
    const e = await readDeletionEvidence(driverContext(t), node, id);
    expect(e).toMatchObject({ state: "deleted" });
    expect(e.basis).toContain("get:TERMINATED");
    expect(presenceOfDeletion(e)).toBe("missing");
  });

  it("proves deletion from a 404 only when the complete listing lacks the id", async () => {
    const t = world(err(404, "NotAuthorizedOrNotFound"));
    const e = await readDeletionEvidence(driverContext(t), node, id);
    expect(e.state).toBe("deleted");
    expect(e.basis).toEqual(expect.arrayContaining(["get:404", "list:absent"]));
  });

  it("does not accept a 404 while the listing still shows the object", async () => {
    const t = world(err(404, "NotAuthorizedOrNotFound"), json({ items: [{ id, lifecycleState: "ACTIVE" }] }));
    expect((await readDeletionEvidence(driverContext(t), node, id)).state).toBe("present");
  });

  it.each([
    ["listing is truncated", json({ items: [] }, { "opc-next-page": "more" }), "unknown"],
    ["listing is denied", err(403, "NotAuthenticated"), "inaccessible"],
    ["listing is throttled", err(429, "TooManyRequests"), "unknown"],
    ["listing is malformed", json({ items: "x" }), "unknown"],
  ])("a 404 is not absence when the %s", async (_name, listRes, state) => {
    const t = world(err(404, "NotAuthorizedOrNotFound"), listRes);
    expect((await readDeletionEvidence(driverContext(t), node, id)).state).toBe(state);
  });

  it.each([["denied", err(403, "NotAuthenticated"), "inaccessible"], ["throttled", err(429, "TooManyRequests"), "unknown"], ["unavailable", err(503, "ServiceUnavailable"), "unknown"], ["malformed", json("not an object"), "unknown"]])("an unreadable GET (%s) never proves deletion", async (_name, getRes, state) => {
    const e = await readDeletionEvidence(driverContext(world(getRes)), node, id);
    expect(e.state).toBe(state);
    expect(presenceOfDeletion(e)).not.toBe("missing");
  });

  it("reports an object in a deleting lifecycle as not yet deleted", async () => {
    const lifecycle = nativeType === "oci:vault_secret" ? "PENDING_DELETION" : "DELETING";
    const e = await readDeletionEvidence(driverContext(world(json({ id, lifecycleState: lifecycle }))), node, id);
    expect(e.state).toBe("deleting");
    expect(presenceOfDeletion(e)).toBe("present");
  });

  it("reports an active object as present", async () => {
    expect((await readDeletionEvidence(driverContext(world(json({ id, lifecycleState: "ACTIVE" }))), node, id)).state).toBe("present");
  });

  it("does not let a failed probe override a present observation", async () => {
    const e = await readDeletionEvidence(driverContext(world(err(503, "ServiceUnavailable"))), node, id, { observation: obs(nativeType, "present") });
    expect(e.state).toBe("present");
  });

  it("refuses a simulated observation", async () => {
    const e = await readDeletionEvidence(driverContext(world(json({ id, lifecycleState: "TERMINATED" }))), node, id, { observation: obs(nativeType, "missing", { simulated: true }) });
    expect(e.state).toBe("unknown");
  });
});

describe("work requests corroborate but never replace readback", () => {
  const nativeType = "oci:postgresql_db_system";
  const node = nodeFor(nativeType);
  const id = idFor(nativeType);
  const getPath = DELETION_FAMILIES[nativeType].get!(id).path;
  const listPath = DELETION_FAMILIES[nativeType].list!.path;
  const wrPath = WORK_REQUEST_APIS.postgresql!.list;
  const wrow = (status: string, over: Record<string, unknown> = {}) => ({ id: ocid("postgresqlworkrequest", "wr1"), status, operationType: "DELETE_DB_SYSTEM", compartmentId: COMPARTMENT, timeAccepted: "2026-09-30T11:00:00.000Z", resources: [{ identifier: id, actionType: "DELETED" }], ...over });
  const run = async (getRes: ReturnType<typeof json>, wrs: unknown) => {
    const t = new FakeOci().route("GET", getPath, getRes).route("GET", listPath, json({ items: [] })).route("GET", wrPath, wrs as ReturnType<typeof json>);
    return readDeletionEvidence(driverContext(t), node, id);
  };

  it("a SUCCEEDED delete work request with the object still ACTIVE is not deletion", async () => {
    expect((await run(json({ id, lifecycleState: "ACTIVE" }), json({ items: [wrow("SUCCEEDED")] }))).state).toBe("present");
  });

  it("a SUCCEEDED delete work request plus independent absence is deletion, and the basis records both", async () => {
    const e = await run(json({ id, lifecycleState: "DELETED" }), json({ items: [wrow("SUCCEEDED")] }));
    expect(e.state).toBe("deleted");
    expect(e.basis).toEqual(expect.arrayContaining(["get:DELETED", "work_request:SUCCEEDED"]));
  });

  it("an in-flight delete work request means not done even when the object reads absent", async () => {
    const e = await run(json({ id, lifecycleState: "DELETED" }), json({ items: [wrow("IN_PROGRESS")] }));
    expect(e.state).toBe("deleting");
    expect(presenceOfDeletion(e)).toBe("present");
  });

  it("a FAILED delete work request with the object still present is a failed deletion", async () => {
    expect((await run(json({ id, lifecycleState: "ACTIVE" }), json({ items: [wrow("FAILED")] }))).state).toBe("failed");
  });

  it("an unreadable work-request listing falls back to readback alone and says so", async () => {
    const e = await run(json({ id, lifecycleState: "DELETED" }), err(403, "NotAuthenticated"));
    expect(e.state).toBe("deleted");
    expect(e.basis).toContain("work_request:denied");
  });

  it("uses the newest delete work request when several exist", async () => {
    const rows = [wrow("FAILED", { id: ocid("postgresqlworkrequest", "old"), timeAccepted: "2026-09-30T08:00:00.000Z" }), wrow("IN_PROGRESS", { id: ocid("postgresqlworkrequest", "new"), timeAccepted: "2026-09-30T11:59:00.000Z" })];
    expect((await run(json({ id, lifecycleState: "ACTIVE" }), json({ items: rows }))).state).toBe("deleting");
  });
});

describe("journal-owned work request (migration cleanup) is read by id with the selector", () => {
  it("reads the delete work request through the receipt selector, never the listing", async () => {
    const nativeType = "oci:container_instance";
    const node = nodeFor(nativeType);
    const id = ocid("computecontainerinstance", "mig1");
    const wrId = ocid("computecontainerinstanceworkrequest", "del1");
    const key = "c".repeat(48);
    const t = new FakeOci()
      .route("GET", `/20210415/containerInstances/${id}`, json({ id, lifecycleState: "DELETED" }))
      .route("GET", `/20210415/workRequests/${wrId}`, json({ id: wrId, status: "SUCCEEDED", operationType: "DELETE_CONTAINER_INSTANCE", compartmentId: COMPARTMENT, resources: [{ identifier: id, actionType: "DELETED" }] }));
    const e = await readDeletionEvidence(driverContext(t), node, id, { migrationKey: key, workRequestId: wrId });
    expect(e.state).toBe("deleted");
    expect(e.basis).toEqual(expect.arrayContaining(["get:DELETED", "work_request:SUCCEEDED"]));
    expect(t.calls.every((c) => c.migrationKey === key || c.path.includes("workRequests") === false)).toBe(true);
    expect(t.calls.some((c) => c.path === "/20210415/workRequests")).toBe(false);
  });
});

describe("observe-only families", () => {
  it.each(observeOnly)("%s relies on the driver observation and never a guess", async (nativeType) => {
    const node = nodeFor(nativeType);
    const t = new FakeOci();
    expect((await readDeletionEvidence(driverContext(t), node, undefined)).state).toBe("unknown");
    expect((await readDeletionEvidence(driverContext(t), node, undefined, { observation: obs(nativeType, "missing") })).state).toBe("deleted");
    expect((await readDeletionEvidence(driverContext(t), node, undefined, { observation: obs(nativeType, "present") })).state).toBe("present");
    expect((await readDeletionEvidence(driverContext(t), node, undefined, { observation: obs(nativeType, "inaccessible") })).state).toBe("inaccessible");
    expect(t.calls).toHaveLength(0);
  });
});

describe("explicit refusals", () => {
  it("never claims deletion of OCI MySQL, even for a missing observation", async () => {
    const t = new FakeOci();
    const e = await readDeletionEvidence(driverContext(t), nodeFor(MYSQL_NATIVE_TYPE), idFor(MYSQL_NATIVE_TYPE), { observation: obs(MYSQL_NATIVE_TYPE, "missing") });
    expect(e).toMatchObject({ state: "unsupported", basis: ["family:mysql_refused"] });
    expect(e.detail).toMatch(/MySQL is unsupported/);
    expect(presenceOfDeletion(e)).toBe("unknown");
    expect(t.calls).toHaveLength(0);
  });

  it("never claims deletion of an unregistered resource type", async () => {
    const e = await readDeletionEvidence(driverContext(new FakeOci()), nodeFor("oci:made_up"), idFor("oci:made_up"), { observation: obs("oci:made_up", "missing") });
    expect(e.state).toBe("unsupported");
  });

  it("returns unknown (never throws) on a transport failure", async () => {
    const t = new FakeOci();
    t.failWith = new Error("PRIVATE_PROVIDER_CANARY");
    const e = await readDeletionEvidence(driverContext(t), nodeFor("oci:vcn"), idFor("oci:vcn"));
    expect(e.state).toBe("unknown");
    expect(JSON.stringify(e)).not.toContain("PRIVATE_PROVIDER_CANARY");
  });

  it("returns unknown when no identifier and no observation exist", async () => {
    expect((await readDeletionEvidence(driverContext(new FakeOci()), nodeFor("oci:vcn"), undefined)).state).toBe("unknown");
  });
});
