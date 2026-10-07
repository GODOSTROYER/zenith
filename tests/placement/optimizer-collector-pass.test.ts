/** Composed input seam contract. Real SQL/Temporal/metrics journeys are separate gated lanes. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as passes from "@/lib/platform/optimizer-pass";
import type { OptimizerPassPorts } from "@/lib/platform/optimizer-pass";
import type { Sql } from "@/lib/controlplane/types";
import { runMeasuredOptimizerPass } from "@/lib/cost/optimizer/optimizer-collector-pass";

afterEach(() => vi.restoreAllMocks());
describe("measured optimizer durable-pass join", () => {
  it("uses one scope-specific adapter per opted-in target and preserves counters", async () => {
    const targets = [{ workspaceId: "workspace-a", environmentId: "env-a" }, { workspaceId: "workspace-b", environmentId: "env-b" }];
    const listOptedIn = vi.fn(async () => targets);
    const ports = { listOptedIn, now: () => new Date("2026-10-08T00:00:00Z") } as unknown as OptimizerPassPorts;
    const run = vi.spyOn(passes, "runOptimizerPass").mockImplementation(async scoped => {
      const [target] = await scoped.listOptedIn(25);
      expect(scoped.measurements).not.toBe(ports.measurements);
      expect(scoped.ownership).not.toBe(ports.ownership);
      expect(target).toBeDefined();
      return { environments: 1, proposed: 1, refused: 0, skipped: 0, noMeasurements: 0, busy: 0, failed: 0 };
    });
    const result = await runMeasuredOptimizerPass({} as Sql, ports, { read: vi.fn(), constraints: vi.fn(), now: ports.now });
    expect(result).toMatchObject({ environments: 2, proposed: 2, failed: 0 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0].ownership).not.toBe(run.mock.calls[1]![0].ownership);
  });
  it("has no reads or proposals without human opt-in and propagates cancellation", async () => {
    const ports = { listOptedIn: async () => [], now: () => new Date() } as unknown as OptimizerPassPorts;
    const read = vi.fn();
    const result = await runMeasuredOptimizerPass({} as Sql, ports, { read, constraints: vi.fn(), now: ports.now });
    expect(result).toMatchObject({ environments: 0, proposed: 0 }); expect(read).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(runMeasuredOptimizerPass({} as Sql, { ...ports, listOptedIn: async () => [{ workspaceId: "workspace-a", environmentId: "env-a" }] }, { read, constraints: vi.fn(), now: ports.now }, { signal: controller.signal })).rejects.toThrow();
  });
});
