/**
 * OCI migration receipts with work requests (PROD-LIFE-05): replacement-runner
 * recovery without re-execution, lost-response uncertainty, and independent
 * cleanup confirmation. The synthetic OCI API sits behind the real runner
 * serializer and allowlist; it is contract evidence, not a live tenancy.
 */
import { describe, expect, it, vi } from "vitest";
import { createReleasePorts } from "@/lib/platform/release";
import { isAllowed } from "@/lib/providers/oci/allowlist";
import type { OciHttpJobPayload } from "@/lib/providers/oci/runner-transport";
import { COMPARTMENT, ocid } from "./_support";
import { command, migrationOpts, service, world } from "./release-fixtures";

const ports = () => createReleasePorts();
const createWr = ocid("computecontainerinstanceworkrequest", "create1");
const deleteWr = ocid("computecontainerinstanceworkrequest", "delete1");
const wrBody = (id: string, status: string, op: string, resource: string) => ({ id, status, operationType: op, compartmentId: COMPARTMENT, resources: [{ identifier: resource, actionType: op.startsWith("DELETE") ? "DELETED" : "CREATED" }] });
const isWrRead = (path: string) => path.startsWith("/20210415/workRequests/");

/** A first adapter launches the one-off and then stops with the work still running. */
async function stoppedMidFlight() {
  const w = world();
  w.state.lifecycle = "ACTIVE";
  await expect(ports().migrations.runOneOffTask(w.ctx, service, command, { ...migrationOpts, timeoutMs: 25 })).rejects.toThrow("unknown");
  const key = w.jobs.find((j) => j.method === "POST")!.migrationKey!;
  const instanceId = String(w.receipts.get(key)!.instanceId);
  w.receipts.get(key)!.createWorkRequest = createWr;
  const migrationContainer = [...w.containers.values()].find((c) => String(c.id).includes("migration"))!;
  const finish = () => { migrationContainer.lifecycleState = "INACTIVE"; migrationContainer.exitCode = 0; };
  w.jobs.length = 0;
  w.ctx.log = vi.fn();
  return { w, key, instanceId, finish };
}

describe("replacement runner recovery from the journal's work-request receipt", () => {
  it("resumes reading the work request and the instance, and never launches again", async () => {
    const { w, key, instanceId, finish } = await stoppedMidFlight();
    w.state.override = (req) => isWrRead(req.path) ? { status: 200, headers: {}, body: wrBody(createWr, "SUCCEEDED", "CREATE_CONTAINER_INSTANCE", instanceId) } : undefined;
    finish();
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 0 });
    expect(w.state.launches).toBe(1);
    expect(w.jobs.filter((j) => j.method === "POST")).toHaveLength(0);
    const reads = w.jobs.filter((j) => isWrRead(j.path));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((j) => j.method === "GET" && j.migrationKey === key && j.path.endsWith(createWr))).toBe(true);
    expect(w.jobs.every((j) => isAllowed("deployment.deploy", j))).toBe(true);
  });

  it("an in-flight work request does not block observing the instance, and is reported as in flight", async () => {
    const { w, instanceId, finish } = await stoppedMidFlight();
    w.state.override = (req) => isWrRead(req.path) ? { status: 200, headers: {}, body: wrBody(createWr, "IN_PROGRESS", "CREATE_CONTAINER_INSTANCE", instanceId) } : undefined;
    finish();
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 0 });
    expect(w.ctx.log).toHaveBeenCalledWith("OCI migration create work request is in_flight.", "info");
    expect(w.state.launches).toBe(1);
  });

  it.each(["FAILED", "CANCELED"])("a %s creation work request is refused as unknown and nothing is relaunched", async (status) => {
    const { w, instanceId, finish } = await stoppedMidFlight();
    w.state.override = (req) => isWrRead(req.path) ? { status: 200, headers: {}, body: wrBody(createWr, status, "CREATE_CONTAINER_INSTANCE", instanceId) } : undefined;
    finish();
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).rejects.toThrow("creation work request did not succeed");
    expect(w.state.launches).toBe(1);
    expect(w.jobs.filter((j) => j.method === "POST" || j.method === "DELETE")).toHaveLength(0);
  });

  it("an unreadable work request falls back to instance readback and says so", async () => {
    const { w, finish } = await stoppedMidFlight();
    w.state.override = (req) => isWrRead(req.path) ? { status: 404, headers: {}, body: { code: "NotAuthorizedOrNotFound", message: "PRIVATE_PROVIDER_BODY_CANARY" } } : undefined;
    finish();
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 0 });
    expect(w.ctx.log).toHaveBeenCalledWith("OCI migration create work request could not be read; relying on instance readback.", "info");
    expect(JSON.stringify(vi.mocked(w.ctx.log).mock.calls)).not.toContain("CANARY");
  });

  it("a malformed work request body is not a conclusion", async () => {
    const { w, finish } = await stoppedMidFlight();
    w.state.override = (req) => isWrRead(req.path) ? { status: 200, headers: {}, body: { id: createWr } } : undefined;
    finish();
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 0 });
    expect(w.ctx.log).toHaveBeenCalledWith(expect.stringContaining("could not be read"), "info");
  });
});

describe("lost-response uncertainty is preserved", () => {
  it("a launch whose response was lost has no work request id, stays unknown and never consults a work request", async () => {
    const w = world();
    w.state.throwAfterLaunch = true;
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).rejects.toThrow("unknown");
    w.state.throwAfterLaunch = false;
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).rejects.toThrow("unknown");
    expect(w.state.launches).toBe(1);
    expect(w.jobs.some((j) => isWrRead(j.path))).toBe(false);
    expect(w.jobs.filter((j) => j.method === "POST")).toHaveLength(1);
  });
});

describe("cleanup completion is independently confirmed", () => {
  // Three independent probes include two one-second waits before the final verdict.
  const multiProbeOpts = { ...migrationOpts, timeoutMs: 5000 };
  const goneAfterDelete = (w: ReturnType<typeof world>) => (req: { method: string; path: string }) => {
    if (req.method === "GET" && req.path.startsWith("/20210415/containerInstances/") && String(req.path.split("/").at(-1)).includes("migration") && !w.objects.has(req.path.split("/").at(-1)!)) {
      return { status: 404, headers: {}, body: { code: "NotAuthorizedOrNotFound", message: "x" } };
    }
    return undefined;
  };

  it("logs confirmation only when GET is 404 and the complete listing no longer contains the one-off", async () => {
    const w = world();
    w.state.override = goneAfterDelete(w);
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 0 });
    expect(w.ctx.log).toHaveBeenCalledWith("OCI migration cleanup confirmed by independent readback.", "info");
    expect(w.jobs.filter((j) => j.method === "DELETE")).toHaveLength(1);
  });

  it("does not claim cleanup when the one-off is still present after the delete request", async () => {
    const w = world();
    w.state.override = (req) => {
      if (req.method === "GET" && req.path.startsWith("/20210415/containerInstances/") && String(req.path.split("/").at(-1)).includes("migration") && !w.objects.has(req.path.split("/").at(-1)!)) {
        return { status: 200, headers: {}, body: { id: req.path.split("/").at(-1), lifecycleState: "ACTIVE" } };
      }
      return undefined;
    };
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, multiProbeOpts)).toEqual({ exitCode: 0 });
    const logged = JSON.stringify(vi.mocked(w.ctx.log).mock.calls);
    expect(logged).toContain("cleanup is not confirmed (present)");
    expect(logged).not.toContain("confirmed by independent readback");
    expect(w.jobs.filter((j) => j.method === "DELETE")).toHaveLength(1);
    const afterDelete = w.jobs.slice(w.jobs.findIndex((j) => j.method === "DELETE") + 1);
    expect(afterDelete.filter((j) => j.method === "GET" && j.path.startsWith("/20210415/containerInstances/"))).toHaveLength(3);
  }, 20_000);

  it("a delete work request still in flight keeps cleanup unconfirmed even when the instance reads gone", async () => {
    const w = world();
    const gone = goneAfterDelete(w);
    w.state.override = (req) => {
      if (isWrRead(req.path)) return { status: 200, headers: {}, body: wrBody(deleteWr, "IN_PROGRESS", "DELETE_CONTAINER_INSTANCE", "x") };
      return gone(req);
    };
    // The journal reports the delete work request once the runner has recorded it.
    const originalDispatch = w.dispatch.getMockImplementation()!;
    w.dispatch.mockImplementation(async (p: OciHttpJobPayload) => {
      const result = await originalDispatch(p);
      if (p.method === "DELETE" && p.migrationKey) w.receipts.get(p.migrationKey)!.deleteWorkRequest = deleteWr;
      return result;
    });
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, multiProbeOpts)).toEqual({ exitCode: 0 });
    expect(JSON.stringify(vi.mocked(w.ctx.log).mock.calls)).toContain("cleanup is not confirmed (deleting)");
    expect(w.jobs.filter((j) => j.method === "DELETE")).toHaveLength(1);
    const afterDelete = w.jobs.slice(w.jobs.findIndex((j) => j.method === "DELETE") + 1);
    expect(afterDelete.filter((j) => j.method === "GET" && j.path.startsWith("/20210415/containerInstances/"))).toHaveLength(3);
    expect(JSON.stringify(vi.mocked(w.ctx.log).mock.calls)).not.toContain("confirmed by independent readback");
  }, 20_000);

  it("never changes the observed exit code when confirmation itself fails", async () => {
    const w = world();
    w.state.exitCode = 7;
    w.state.override = (req) => req.method === "GET" && req.path.startsWith("/20210415/containerInstances/") && String(req.path.split("/").at(-1)).includes("migration") && !w.objects.has(req.path.split("/").at(-1)!)
      ? { status: 503, headers: {}, body: { message: "PRIVATE_PROVIDER_BODY_CANARY" } } : undefined;
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 7 });
    expect(JSON.stringify(vi.mocked(w.ctx.log).mock.calls)).not.toContain("CANARY");
  });
});
