import { readFile, access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchPlugin } from "@/cli/plugins/launcher";
import { assertLease, httpAuthority } from "@/cli/plugins/authority";
import { containerArgs } from "@/cli/plugins/runtime";
import { runPluginCli } from "@/cli/plugins/main";
import { FakeContainerRuntime, launchFixture } from "../plugins/launcher-support";
import { signManifest } from "../plugins/support";

afterEach(() => vi.unstubAllEnvs());

function setup() {
  const f = launchFixture(); const runtime = new FakeContainerRuntime();
  const authority = { check: vi.fn(async () => f.lease as unknown) };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(f.bytes)));
  const deps = { publishers: f.publisher.publishers, runtime, authority, fetch: fetcher, pollMs: 10 };
  return { ...f, runtime, authority, fetcher, deps };
}

describe("plugin launcher [modeled container and authority contracts]", () => {
  it("verifies, fetches without credentials, checks live authority, and removes owned scratch", async () => {
    const f = setup();
    const run = launchPlugin(f.input, f.deps);
    await vi.waitFor(() => expect(f.runtime.specs).toHaveLength(1));
    const spec = f.runtime.specs[0];
    expect(await readFile(`${spec.scratch}/artifact.tgz`)).toEqual(f.bytes);
    expect(f.fetcher).toHaveBeenCalledWith(new URL(f.manifest.artifact.url!), expect.objectContaining({ redirect: "error", credentials: "omit" }));
    expect(f.fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(f.authority.check.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(spec.bootstrap.token).toBe(f.input.token);
    f.runtime.exit(7);
    await expect(run).resolves.toEqual({ exitCode: 7 });
    expect(f.runtime.stops).toBe(1);
    await expect(access(spec.scratch)).rejects.toThrow();
  });

  it.each(["unsigned", "tampered", "untrusted", "review mismatch", "zp", "image tag", "zip", "entry traversal", "loader env"])("refuses %s before fetching or starting a container", async (reason) => {
    const f = setup();
    const changed = structuredClone(f.manifest);
    if (reason === "unsigned") delete (changed as Partial<typeof changed>).signature;
    if (reason === "tampered") changed.version = "9.0.0";
    if (reason === "untrusted") f.deps.publishers = new Map();
    if (reason === "review mismatch") f.input.reviewedDigest = "0".repeat(64);
    if (reason === "zp") f.input.token = f.input.token.replace("za_", "zp_");
    if (reason === "image tag") f.input.image = "node:22";
    if (reason === "zip") changed.artifact.format = "zip";
    if (reason === "entry traversal") changed.components!.mcpServers![0].args = ["${CLAUDE_PLUGIN_ROOT}/../outside.mjs"];
    if (reason === "loader env") changed.components!.mcpServers![0].env = { NODE_OPTIONS: "--import=/outside.mjs" };
    if (["zip", "entry traversal", "loader env"].includes(reason)) {
      const { signature: _signature, ...unsigned } = changed;
      f.input.manifest = signManifest(unsigned, f.publisher.privateKey);
      const { manifestDigestOf } = await import("@/lib/plugins/manifest");
      f.input.reviewedDigest = manifestDigestOf(f.input.manifest as typeof changed);
    } else f.input.manifest = changed;
    await expect(launchPlugin(f.input, f.deps)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.runtime.specs).toHaveLength(0);
  });

  it.each(["digest", "redirect", "oversize", "status"])("refuses an artifact %s failure before execution", async (reason) => {
    const f = setup();
    f.fetcher.mockImplementation(async () => {
      if (reason === "redirect") throw new TypeError("redirect blocked");
      return new Response(reason === "digest" ? "wrong bytes" : new Uint8Array(f.bytes), { status: reason === "status" ? 404 : 200,
        headers: reason === "oversize" ? { "content-length": String(17 * 1024 * 1024) } : {} });
    });
    await expect(launchPlugin(f.input, f.deps)).rejects.toThrow();
    expect(f.runtime.specs).toHaveLength(0);
  });

  it("refuses disabled TLS verification before any authority or fetch request", async () => {
    const f = setup(); vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    await expect(launchPlugin(f.input, f.deps)).rejects.toThrow("tls_verification_required");
    expect(f.authority.check).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("refuses a private credential file presented as a public CA, without exposing it to the container", async () => {
    const f = setup(); const directory = await mkdtemp(join(tmpdir(), "zenith-plugin-ca-test-"));
    try {
      const file = join(directory, "invalid-ca.pem"); await writeFile(file, f.input.token, { mode: 0o600 });
      await expect(launchPlugin({ ...f.input, caFile: file }, f.deps)).rejects.toThrow("public_ca_required");
      expect(f.runtime.specs).toHaveLength(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["parent", "wrong digest", "expired", "unbounded projects", "broader tool", "bad scope", "wrong audience"])("refuses %s authority", async (reason) => {
    const f = setup(); const lease = structuredClone(f.lease) as Record<string, unknown>;
    if (reason === "parent") lease.credentialKind = "parent_za";
    if (reason === "wrong digest") lease.credentialDigest = "0".repeat(64);
    if (reason === "expired") lease.expiresAt = new Date(Date.now() - 1).toISOString();
    if (reason === "unbounded projects") lease.projectIds = [];
    if (reason === "broader tool") lease.tools = ["zenith_restart_service"];
    if (reason === "bad scope") lease.scopes = ["read", "write"];
    if (reason === "wrong audience") lease.audience = "https://other.test/api/agent/v3/mcp";
    f.authority.check.mockResolvedValue(lease);
    await expect(launchPlugin(f.input, f.deps)).rejects.toThrow("launch_authority_refused");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.runtime.specs).toHaveLength(0);
  });

  it("rechecks revocation after download, before any container starts", async () => {
    const f = setup(); f.authority.check.mockResolvedValueOnce(f.lease).mockResolvedValue({ status: "revoked" });
    await expect(launchPlugin(f.input, f.deps)).rejects.toThrow("launch_authority_refused");
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.runtime.specs).toHaveLength(0);
  });

  it.each(["revoked", "outage", "narrowed"])("kills an active process on %s", async (reason) => {
    const f = setup();
    const run = launchPlugin(f.input, f.deps); const refused = expect(run).rejects.toThrow();
    await vi.waitFor(() => expect(f.runtime.specs).toHaveLength(1));
    if (reason === "outage") f.authority.check.mockRejectedValue(new Error("modeled outage"));
    else f.authority.check.mockResolvedValue(reason === "revoked" ? { status: "revoked" } : { ...f.lease, tools: [] });
    await refused; expect(f.runtime.stops).toBe(1);
    await expect(access(f.runtime.specs[0].scratch)).rejects.toThrow();
  });

  it("cancellation stops the running container and suppresses plugin output", async () => {
    const f = setup(); const abort = new AbortController();
    const run = launchPlugin(f.input, { ...f.deps, signal: abort.signal }); const refused = expect(run).rejects.toThrow("launch_cancelled");
    await vi.waitFor(() => expect(f.runtime.specs).toHaveLength(1)); abort.abort();
    await refused; expect(f.runtime.stops).toBe(1);
  });

  it("does not report success or delete evidence when forced removal fails", async () => {
    const f = setup(); f.runtime.failStop = true;
    const run = launchPlugin(f.input, f.deps); const refused = expect(run).rejects.toThrow("modeled removal failure");
    await vi.waitFor(() => expect(f.runtime.specs).toHaveLength(1)); f.runtime.exit();
    await refused; const scratch = f.runtime.specs[0].scratch;
    await expect(access(scratch)).resolves.toBeUndefined(); await rm(scratch, { recursive: true, force: true });
  });

  it("container plans fix isolation and never carry token or user-controlled flags", async () => {
    const f = setup(); const run = launchPlugin(f.input, f.deps);
    await vi.waitFor(() => expect(f.runtime.specs).toHaveLength(1));
    const spec = f.runtime.specs[0]; const args = containerArgs(spec, "owned-process", "owned-channel", false);
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--pids-limit", "32", "--memory", "128m", "--network", "none", "--pull", "never", "--log-driver", "none"]));
    expect(args.filter((arg) => arg.startsWith("type=bind"))).toEqual([`type=bind,src=${spec.scratch},dst=/zenith,readonly`]);
    expect(args).toContain("type=volume,src=owned-channel,dst=/channel,readonly");
    expect(args.join(" ")).not.toContain(f.input.token); expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|--publish|network host/);
    f.runtime.exit(); await run;
  });
});

describe("launcher authority and executable", () => {
  it("uses only the exact check endpoint and refuses an absent integration seam", async () => {
    const f = setup(); const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    await expect(httpAuthority(new URL(f.input.apiOrigin), fetcher).check(f.binding, f.input.token)).rejects.toThrow("launch_authority_unavailable");
    expect(fetcher).toHaveBeenCalledWith(new URL(`${f.input.apiOrigin}/api/integrations/plugins/launch/check`), expect.objectContaining({ redirect: "error", method: "POST", body: JSON.stringify(f.binding) }));
  });
  it("rejects a changed valid lease rather than retaining old permissions", () => {
    const f = setup(); expect(() => assertLease({ ...f.lease, projectIds: ["proj-b"] }, f.binding, f.manifest, f.lease)).toThrow("launch_authority_changed");
  });
  it("has a real help entry and never echoes a supplied secret in diagnostics", async () => {
    const f = setup(); const stdout = vi.fn(); const stderr = vi.fn();
    expect(await runPluginCli(["--help"], { stdout, stderr })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("plugin run"));
    expect(await runPluginCli(["plugin", "run", "--token", f.input.token], { stdout, stderr })).toBe(1);
    expect(stderr.mock.calls.flat().join()).not.toContain(f.input.token);
  });
});
