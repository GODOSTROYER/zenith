/**
 * PROD-MAN-01 front door: the Zenith-managed platform as a provider and a connection. Pure contract tests: no cluster,
 * database or cloud is contacted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderId } from "@/lib/domain/types";
import { applyRotationPatch, CreateRunnerInput, CreateZenithInput, LIFECYCLE_PROVIDERS, LifecycleInputError, RUNNER_CONNECTION_PROVIDERS } from "@/lib/connections/schemas";
import { zenithProvider } from "@/lib/providers/zenith/adapter";
import { isRealProvider } from "@/lib/bridge/readiness";
import type { CloudConnection } from "@/lib/domain/types";

afterEach(() => { vi.unstubAllEnvs(); });

const conn = (): CloudConnection => ({ id: "c1", workspaceId: "w1", provider: "zenith", label: "managed", region: "zenith-managed", status: "connecting", grantedPermissions: [], createdAt: "2026-01-01T00:00:00.000Z" });

describe("zenith as a provider id", () => {
  it("is a ProviderId, a lifecycle provider and a real (workflow-routed) provider", () => {
    expect(ProviderId.safeParse("zenith").success).toBe(true);
    expect(LIFECYCLE_PROVIDERS).toContain("zenith");
    expect(isRealProvider("zenith")).toBe(true);
  });

  it("takes only an optional label: anything credential-shaped is refused", () => {
    expect(CreateZenithInput.safeParse({}).success).toBe(true);
    expect(CreateZenithInput.safeParse({ label: "Managed" }).success).toBe(true);
    expect(CreateZenithInput.safeParse({ kubeconfig: "x" }).success).toBe(false);
    expect(CreateZenithInput.safeParse({ token: "x" }).success).toBe(false);
  });

  it("has nothing to rotate", () => {
    expect(() => applyRotationPatch({ provider: "zenith", mode: "managed", region: "r" }, {})).toThrow(LifecycleInputError);
  });

  it("refuses to treat the managed platform as a customer runner", () => {
    expect(RUNNER_CONNECTION_PROVIDERS).not.toContain("zenith");
    expect(CreateRunnerInput.safeParse({ provider: "zenith", mode: "runner", runnerId: "run_registered" }).success).toBe(false);
  });
});

describe("zenith adapter", () => {
  it("is available, asks for nothing, and refuses to run in the in-process engine", () => {
    expect(zenithProvider.id).toBe("zenith");
    expect(zenithProvider.availability).toBe("available");
    expect(zenithProvider.accessExplanation().permissions.join(" ")).toMatch(/Nothing of yours/);
    expect(() => zenithProvider.planSteps({} as never, {} as never)).toThrow(/execution plane/);
    return expect(zenithProvider.executeStep({} as never)).rejects.toThrow(/execution plane/);
  });

  it("fails preflight, naming what to set, when the managed substrate is not configured", async () => {
    for (const key of Object.keys(process.env)) if (key.startsWith("ZENITH_MANAGED_")) vi.stubEnv(key, "");
    const report = await zenithProvider.preflight(conn());
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: "zenith.substrate", status: "fail" });
    expect(report.checks[0].fix).toMatch(/ZENITH_MANAGED_/);
  });
});
