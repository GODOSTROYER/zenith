/**
 * OCI work-request receipts (PROD-LIFE-05). Contract level: the fake transport
 * returns the documented WorkRequest shapes; nothing proves a live OCI answer.
 */
import { describe, expect, it } from "vitest";
import { isAllowed } from "@/lib/providers/oci/allowlist";
import { createRunnerOciTransport, type OciHttpJobPayload } from "@/lib/providers/oci/runner-transport";
import { awaitWorkRequest, listWorkRequestsFor, parseWorkRequest, readWorkRequest, receiptWorkRequestIds, stateOfStatus, WORK_REQUEST_APIS } from "@/lib/providers/oci/work-requests";
import { ociPath } from "@/lib/providers/oci/services";
import { COMPARTMENT, driverContext, err, FakeOci, json, ocid } from "./_support";

const wrId = ocid("computecontainerinstanceworkrequest", "wr1");
const instanceId = ocid("computecontainerinstance", "inst1");
const api = WORK_REQUEST_APIS.containerinstances!;
const wr = (over: Record<string, unknown> = {}) => ({ id: wrId, status: "IN_PROGRESS", operationType: "CREATE_CONTAINER_INSTANCE", compartmentId: COMPARTMENT, percentComplete: 40, timeAccepted: "2026-09-30T11:00:00.000Z", resources: [{ entityType: "containerInstance", actionType: "CREATED", identifier: instanceId }], ...over });
const session = { compartmentOcid: COMPARTMENT };

describe("parseWorkRequest", () => {
  it.each([["ACCEPTED", "in_flight"], ["IN_PROGRESS", "in_flight"], ["CANCELING", "in_flight"], ["SUCCEEDED", "succeeded"], ["FAILED", "failed"], ["CANCELED", "canceled"], ["NEEDS_ATTENTION", "unknown"], ["weird", "unknown"]])("maps %s to %s", (status, state) => {
    expect(stateOfStatus(status)).toBe(state);
    expect(parseWorkRequest(wr({ status }), session, wrId)?.state).toBe(state);
  });

  it("extracts the named resources and action types", () => {
    const parsed = parseWorkRequest(wr({ status: "SUCCEEDED" }), session, wrId)!;
    expect(parsed).toMatchObject({ id: wrId, resourceIds: [instanceId], actionTypes: ["CREATED"], operationType: "CREATE_CONTAINER_INSTANCE", percentComplete: 40 });
  });

  it.each([
    ["not an object", "x"],
    ["no id", wr({ id: undefined })],
    ["id is not an OCID", wr({ id: "wr-1" })],
    ["different id", wr({ id: ocid("computecontainerinstanceworkrequest", "other") })],
    ["foreign compartment", wr({ compartmentId: "ocid1.compartment.oc1..foreigncompartment" })],
    ["no status", wr({ status: undefined })],
    ["malformed resources", wr({ resources: ["x"] })],
    ["bad operation type", wr({ operationType: "x y" })],
  ])("rejects %s", (_name, value) => {
    expect(parseWorkRequest(value, session, wrId)).toBeUndefined();
  });
});

describe("readWorkRequest and awaitWorkRequest (resumable, read only)", () => {
  it("reads by id and never issues a write", async () => {
    const t = new FakeOci().route("GET", ociPath("containerinstances", "workRequests", wrId), json(wr({ status: "SUCCEEDED" })));
    const read = await readWorkRequest(driverContext(t), api, wrId);
    expect(read).toMatchObject({ ok: true, receipt: { state: "succeeded" } });
    expect(t.methods).toEqual(["GET"]);
  });

  it("forwards the runner receipt selector so a replacement runner can resume from the journal", async () => {
    const t = new FakeOci().route("GET", ociPath("containerinstances", "workRequests", wrId), json(wr()));
    await readWorkRequest(driverContext(t), api, wrId, { migrationKey: "a".repeat(48) });
    expect(t.calls[0].migrationKey).toBe("a".repeat(48));
  });

  it("classifies not found, denied, unavailable and malformed bodies without concluding anything", async () => {
    const reason = async (res: ReturnType<typeof json>) => {
      const t = new FakeOci().route("GET", ociPath("containerinstances", "workRequests", wrId), res);
      const read = await readWorkRequest(driverContext(t), api, wrId);
      return read.ok ? "ok" : read.reason;
    };
    expect(await reason(err(404, "NotAuthorizedOrNotFound"))).toBe("not_found");
    expect(await reason(err(403, "NotAuthenticated"))).toBe("denied");
    expect(await reason(err(500, "InternalServerError"))).toBe("unavailable");
    expect(await reason(json({ id: wrId }))).toBe("malformed");
  });

  it("refuses an id the family cannot read by id (not in a runner journal) without a call", async () => {
    const t = new FakeOci();
    const read = await readWorkRequest(driverContext(t), WORK_REQUEST_APIS.postgresql!, wrId);
    expect(read).toMatchObject({ ok: false, reason: "not_readable" });
    expect(t.calls).toHaveLength(0);
  });

  it("resumes an in-flight work request until it is terminal, with an injected clock", async () => {
    let polls = 0;
    const t = new FakeOci().route("GET", ociPath("containerinstances", "workRequests", wrId), () => json(wr({ status: ++polls < 3 ? "IN_PROGRESS" : "SUCCEEDED" })));
    const slept: number[] = [];
    const read = await awaitWorkRequest(driverContext(t), api, wrId, { sleep: async (ms) => { slept.push(ms); }, intervalMs: 5 });
    expect(read).toMatchObject({ ok: true, receipt: { state: "succeeded" } });
    expect(polls).toBe(3);
    expect(slept).toEqual([5, 5]);
    expect(t.methods.every((m) => m === "GET")).toBe(true);
  });

  it("leaves the work request in flight when the bound is exhausted or the wait is cancelled", async () => {
    const t = new FakeOci().route("GET", ociPath("containerinstances", "workRequests", wrId), () => json(wr()));
    const bounded = await awaitWorkRequest(driverContext(t), api, wrId, { sleep: async () => undefined, maxPolls: 2 });
    expect(bounded).toMatchObject({ ok: true, receipt: { state: "in_flight" } });
    expect(t.calls).toHaveLength(2);
    const cancelled = await awaitWorkRequest(driverContext(new FakeOci().route("GET", /workRequests/, json(wr()))), api, wrId, { sleep: async () => { throw new Error("cancelled"); } });
    expect(cancelled).toMatchObject({ ok: true, receipt: { state: "in_flight" } });
  });
});

describe("listWorkRequestsFor", () => {
  const listPath = ociPath("containerinstances", "workRequests");
  const other = ocid("computecontainerinstance", "other1");

  it("returns only work requests naming the resource, newest first", async () => {
    const rows = [
      wr({ id: ocid("computecontainerinstanceworkrequest", "old1"), status: "SUCCEEDED", timeAccepted: "2026-09-30T09:00:00.000Z" }),
      wr({ id: ocid("computecontainerinstanceworkrequest", "new1"), status: "IN_PROGRESS", operationType: "DELETE_CONTAINER_INSTANCE", timeAccepted: "2026-09-30T11:30:00.000Z" }),
      wr({ id: ocid("computecontainerinstanceworkrequest", "oth1"), resources: [{ identifier: other }] }),
    ];
    const t = new FakeOci().route("GET", listPath, json({ items: rows }));
    const listed = await listWorkRequestsFor(driverContext(t), api, instanceId);
    expect(listed.ok && listed.receipts.map((r) => r.operationType)).toEqual(["DELETE_CONTAINER_INSTANCE", "CREATE_CONTAINER_INSTANCE"]);
    expect(t.calls[0].query).toMatchObject({ compartmentId: COMPARTMENT });
  });

  it("fails the whole listing on one malformed row, a bad collection or an HTTP failure", async () => {
    for (const res of [json({ items: [wr(), "junk"] }), json({ nope: true }), err(403, "NotAuthenticated")]) {
      const t = new FakeOci().route("GET", listPath, res);
      expect((await listWorkRequestsFor(driverContext(t), api, instanceId)).ok).toBe(false);
    }
  });

  it("reports truncation instead of hiding it", async () => {
    const t = new FakeOci().route("GET", listPath, json({ items: [] }, { "opc-next-page": "more" }));
    const listed = await listWorkRequestsFor(driverContext(t), api, instanceId);
    expect(listed).toMatchObject({ ok: true, truncated: true });
  });
});

describe("runner receipt query", () => {
  it("accepts only OCID-shaped work request ids", () => {
    expect(receiptWorkRequestIds({ state: "running", createWorkRequest: wrId, deleteWorkRequest: "not-an-ocid" })).toEqual({ create: wrId });
    expect(receiptWorkRequestIds("x")).toEqual({});
  });
});

describe("allowlist for work requests", () => {
  const dispatchRecorder = (cap: string) => {
    const seen: OciHttpJobPayload[] = [];
    const transport = createRunnerOciTransport(async (p) => { seen.push(p); return { status: 200, headers: {}, bodyB64: Buffer.from(JSON.stringify(wr())).toString("base64") }; }, { capability: cap });
    return { seen, transport };
  };

  it("permits compartment listings only for infrastructure.observe and incident.investigate, and by-id reads only for deployment.deploy", () => {
    for (const [service, wrApi] of Object.entries(WORK_REQUEST_APIS)) {
      const list = { service: service as never, method: "GET" as const, path: wrApi!.list };
      for (const cap of ["infrastructure.observe", "incident.investigate"]) expect(isAllowed(cap, list), `${cap} ${service}`).toBe(true);
      for (const cap of ["topology.read", "infrastructure.plan", "service.restart", "deployment.deploy"]) expect(isAllowed(cap, list), `${cap} ${service}`).toBe(false);
    }
    const byId = { service: "containerinstances" as const, method: "GET" as const, path: api.byId!(wrId) };
    expect(isAllowed("deployment.deploy", byId)).toBe(true);
    expect(isAllowed("infrastructure.observe", byId)).toBe(false);
  });

  it("serializes a by-id receipt read with its selector only on deployment.deploy", async () => {
    const { seen, transport } = dispatchRecorder("deployment.deploy");
    await transport.request({ service: "containerinstances", region: "us-ashburn-1", method: "GET", path: api.byId!(wrId), migrationKey: "b".repeat(48) });
    expect(seen[0]).toMatchObject({ method: "GET", path: api.byId!(wrId), migrationKey: "b".repeat(48) });
    const observe = dispatchRecorder("infrastructure.observe");
    await expect(observe.transport.request({ service: "containerinstances", region: "us-ashburn-1", method: "GET", path: api.byId!(wrId), migrationKey: "b".repeat(48) })).rejects.toThrow();
  });

  it("never allows a work-request write", () => {
    for (const cap of ["infrastructure.observe", "deployment.deploy"]) {
      for (const method of ["POST", "PUT", "DELETE"] as const) expect(isAllowed(cap, { service: "containerinstances", method, path: api.byId!(wrId) })).toBe(false);
    }
  });
});
