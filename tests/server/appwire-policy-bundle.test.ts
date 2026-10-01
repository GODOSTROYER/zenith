/**
 * Source packaging assertions and real wasm loads from copied deployment
 * layouts. No Docker/Next production image is built by these tests.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import { loadPolicyEngine, policyWasmPath, resetPolicyEngineCache } from "@/lib/policy/engine";
import { policyInput } from "../policy/support";

const repository = process.cwd();
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "zenith-appwire-policy-"));
  vi.stubEnv("ZENITH_POLICY_WASM", "");
  resetPolicyEngineCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPolicyEngineCache();
  // The recursive cleanup target is the unique directory we created in Temp.
  expect(path.dirname(path.resolve(scratch))).toBe(path.resolve(tmpdir()));
  rmSync(scratch, { recursive: true, force: true });
});

function copyBundle(root: string): string {
  const bundle = path.join(root, "policy", "dist");
  mkdirSync(bundle, { recursive: true });
  for (const name of ["policy.wasm", "manifest.json"]) copyFileSync(path.join(repository, "policy", "dist", name), path.join(bundle, name));
  return path.join(bundle, "policy.wasm");
}

describe("policy deployment packaging", () => {
  it("traces the committed bundle for REST, MCP v3 and every product API that can call the broker", () => {
    expect(nextConfig.output).toBe("standalone");
    for (const route of ["/api/platform/v1/**", "/api/agent/v3/**", "/api/**"]) {
      expect(nextConfig.outputFileTracingIncludes?.[route]).toContain("./policy/dist/**");
    }
  });

  it("copies wasm and its manifest into the final worker stage at the cwd-relative engine path", () => {
    const dockerfile = readFileSync(path.join(repository, "docker", "worker.Dockerfile"), "utf8");
    const runtime = dockerfile.split(/^FROM .* AS runtime\r?$/m)[1];
    expect(runtime).toBeDefined();
    expect(runtime).toMatch(/^WORKDIR \/app\r?$/m);
    expect(runtime).toMatch(/^COPY --chown=zenith:zenith policy\/dist \.\/policy\/dist\r?$/m);
    expect(runtime.indexOf("COPY --chown=zenith:zenith policy/dist")).toBeLessThan(runtime.indexOf("USER zenith"));
  });

  it.each(["standalone", "worker"])("loads and evaluates the actual policy in the %s runtime layout", async (layout) => {
    const root = path.join(scratch, ...(layout === "standalone" ? [".next", "standalone"] : ["app"]));
    const wasm = copyBundle(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect(policyWasmPath()).toBe(wasm);
    const engine = await loadPolicyEngine();
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(wasm), "manifest.json"), "utf8")) as { wasmSha256: string };
    expect(engine.version).toBe(manifest.wasmSha256);
    const result = await engine.evaluate(policyInput("infrastructure.observe"));
    expect(result.decision.outcome).toBe("allow");
    expect(result.policyVersion).toBe(manifest.wasmSha256);
  });

  it("supports an explicit mounted policy path while keeping manifest verification", async () => {
    const wasm = copyBundle(path.join(scratch, "mounted"));
    vi.stubEnv("ZENITH_POLICY_WASM", wasm);
    expect(policyWasmPath()).toBe(wasm);
    expect((await loadPolicyEngine()).version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a deployed bundle whose wasm disagrees with its manifest", async () => {
    const wasm = copyBundle(path.join(scratch, "app"));
    writeFileSync(wasm, Buffer.from("corrupt synthetic wasm"));
    await expect(loadPolicyEngine({ wasmPath: wasm })).rejects.toThrow("does not match its manifest");
  });
});
