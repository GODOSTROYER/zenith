/**
 * PROD-MACH-03: the production step executor goes through the one machine entry point
 * (`executeMachineOperation`) with a broker grant per step, and settles the broker ledger.
 */
import { describe, expect, it } from "vitest";
import { MachineOperationError } from "@/lib/machines/errors";
import type { MachineDriver, MachineRequest } from "@/lib/machines/types";
import { createMachineStepExecutor, type RunbookStepContext, type StepGrant } from "@/lib/machines/runbooks";
import { MemoryEvidence, T0, grantFor, okResult, requestFor, sessions } from "./_helpers";

const ctx = (): RunbookStepContext => ({ run: {} as RunbookStepContext["run"], targetIndex: 0, stepId: "status", signal: new AbortController().signal });

function fixture(over: { ok?: boolean; throwCode?: "uncertain"; settleFailure?: boolean } = {}) {
  const seen: MachineRequest[] = [];
  const driver: MachineDriver = {
    transport: "zenithd",
    supports: ["service.status"],
    async execute(req) {
      seen.push(req);
      if (over.throwCode) throw new MachineOperationError(over.throwCode, "unknown");
      return { ...okResult(req, driver, { active: true }), ok: over.ok ?? true };
    },
  };
  const settled: { outcome: string; code?: string }[] = [];
  const evidence = new MemoryEvidence();
  const grants: StepGrant[] = [];
  const exec = createMachineStepExecutor({
    drivers: { zenithd: driver },
    evidence,
    sessionsFor: () => sessions(),
    now: () => new Date(T0),
    grantFor: async (req) => {
      const grant: StepGrant = { claims: grantFor("service.status", { op: "broker-op-9" }), jws: "jws", settle: async (outcome, detail) => { settled.push({ outcome, code: detail.code }); if (over.settleFailure) throw new Error("controlled ledger outage"); } };
      grants.push(grant);
      void req;
      return grant;
    },
  });
  return { exec, seen, settled, evidence };
}

const req = (): MachineRequest => requestFor("service.status", { unit: "nginx.service" }, { transport: "zenithd", targetId: "mach-1", operationId: "rbs_local" });

describe("createMachineStepExecutor", () => {
  it("runs under the broker operation id and settles the ledger as succeeded", async () => {
    const f = fixture();
    const result = await f.exec(req(), ctx());
    expect(result.ok).toBe(true);
    expect(f.seen[0].operationId).toBe("broker-op-9");
    expect(f.settled).toEqual([{ outcome: "succeeded", code: undefined }]);
    expect(f.evidence.records).toHaveLength(1);
  });

  it("a broker settlement outage cannot turn machine evidence into a successful run", async () => {
    const f = fixture({ settleFailure: true });
    await expect(f.exec(req(), ctx())).rejects.toMatchObject({ code: "uncertain" });
    expect(f.evidence.records).toHaveLength(1);
    expect(f.settled.map(s => s.outcome)).toEqual(["succeeded", "uncertain"]);
  });

  it("a failed machine result settles as failed", async () => {
    const f = fixture({ ok: false });
    expect((await f.exec(req(), ctx())).ok).toBe(false);
    expect(f.settled).toEqual([{ outcome: "failed", code: "step_failed" }]);
  });

  it("an uncertain outcome settles as uncertain and is rethrown", async () => {
    const f = fixture({ throwCode: "uncertain" });
    await expect(f.exec(req(), ctx())).rejects.toMatchObject({ code: "uncertain" });
    expect(f.settled.map((s) => s.outcome)).toEqual(["uncertain"]);
  });

  it("a refused grant fails the step as denied and nothing is dispatched", async () => {
    const seen: MachineRequest[] = [];
    const driver: MachineDriver = { transport: "zenithd", supports: ["service.status"], async execute(r) { seen.push(r); return okResult(r, driver); } };
    const exec = createMachineStepExecutor({ drivers: { zenithd: driver }, evidence: new MemoryEvidence(), sessionsFor: () => sessions(), grantFor: async () => { throw new Error("step_require_approval"); } });
    await expect(exec(req(), ctx())).rejects.toMatchObject({ code: "denied" });
    expect(seen).toHaveLength(0);
  });

  it("a grant for a different capability is refused by the machine layer", async () => {
    const driver: MachineDriver = { transport: "zenithd", supports: ["service.status"], async execute(r) { return okResult(r, driver); } };
    const exec = createMachineStepExecutor({
      drivers: { zenithd: driver },
      evidence: new MemoryEvidence(),
      sessionsFor: () => sessions(),
      now: () => new Date(T0),
      grantFor: async () => ({ claims: grantFor("file.read", { op: "broker-op-9" }), jws: "jws", settle: async () => undefined }),
    });
    await expect(exec(req(), ctx())).rejects.toMatchObject({ code: "grant_mismatch" });
  });
});
