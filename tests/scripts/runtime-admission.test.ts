import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_NODE, nodeIsSupported, SUPPORTED_NODE_RANGE } from "@/lib/node-runtime";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 1, stdout: "" })) }));
vi.mock("../../src/lib/supabase/env", () => ({ isSupabaseConfigured: () => false, SUPABASE_URL: "" }));
vi.mock("../../src/lib/env", () => ({
  decodeSecretKey: () => null,
  SECRET_KEY_FIX: "Set a valid key.",
  SMTP_FIX: "Set SMTP variables.",
  env: () => ({ ZENITH_LOCALSTACK_ENDPOINT: "http://localhost:4566", ZENITH_DATA: ".data" }),
}));

const nodeDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
afterEach(() => {
  Object.defineProperty(process.versions, "node", nodeDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("supported Node admission", () => {
  it("matches the package and lock engines, including the patch floor", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    expect(SUPPORTED_NODE_RANGE).toBe(pkg.engines.node);
    expect(SUPPORTED_NODE_RANGE).toBe(lock.packages[""].engines.node);
    expect(MIN_NODE).toEqual({ major: 22, minor: 22, patch: 2 });
  });

  it.each(["22.22.2", "22.22.3", "22.23.3", "22.100.0"])("accepts %s", (version) => {
    expect(nodeIsSupported(version)).toBe(true);
  });

  it.each(["20.19.0", "22.16.0", "22.22.1", "23.0.0", "24.19.0", "", "22", "22.22", "22.22.2-rc.1", "22.22.2junk", "22.22.2.3", "022.22.2", "22.9007199254740992.0"])("rejects %s", (version) => {
    expect(nodeIsSupported(version)).toBe(false);
  });

  for (const script of ["setup", "doctor"] as const) {
    it.each(["20.19.0", "22.22.1", "23.0.0", "22.23.3"])(`${script} reports the same policy for %s without changing its reporting behavior`, async (version) => {
      vi.resetModules();
      Object.defineProperty(process.versions, "node", { ...nodeDescriptor, value: version });
      // Existing files prevent setup seeding; Docker and health checks are
      // controlled here so testing an admission message has no external effects.
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ services: { s3: "available", sqs: "available" } }))));
      for (const key of ["ZENITH_SECRET_KEY", "ZENITH_SMTP_URL", "ZENITH_ALERT_FROM"]) vi.stubEnv(key, "");
      const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      if (script === "setup") await import("../../scripts/setup");
      else await import("../../scripts/doctor");
      await vi.waitFor(() => {
        if (script === "setup") expect(output.mock.calls.flat().join("\n")).toContain("Full instructions");
        else expect(exit).toHaveBeenCalledWith(nodeIsSupported(version) ? 0 : 1);
      });
      const lines = output.mock.calls.flat().join("\n");
      if (nodeIsSupported(version)) expect(lines).toMatch(/✓ Node/);
      else {
        expect(lines).toMatch(/✗ Node/);
        expect(lines).toContain(SUPPORTED_NODE_RANGE);
        expect(lines).toContain("nvm install 22.23.3");
      }
      expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spawnSync).mock.calls[0][0]).toBe("docker");
    });
  }
});
