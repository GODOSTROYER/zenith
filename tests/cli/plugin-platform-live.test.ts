/** Operated local API + browser MFA session + actual Docker. No modeled
 * authority/transport. Mac only; every input is a disposable local fixture. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseManifest, trustedPublishersFromEnv } from "@/lib/plugins/manifest";
import { toolDescriptor } from "@/lib/agent-access/v3/catalog";
import { launchPlugin } from "@/cli/plugins/launcher";
import { DockerRuntime } from "@/cli/plugins/runtime";
import { LauncherError, tokenDigest } from "@/cli/plugins/authority";

const enabled = process.env.ZENITH_TEST_PLUGIN_PLATFORM === "1";
const required = (key: string): string => {
  const value = process.env[key]; if (!value) throw new Error(`Missing local fixture input: ${key}`); return value;
};
describe.skipIf(!enabled)("operated local platform launcher", () => {
  it("requires real browser AAL2 consent and stops Docker after existing RFC and browser revocation paths", async () => {
    const origin = new URL(required("ZENITH_PLUGIN_PLATFORM_ORIGIN"));
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash ||
        !["localhost", "127.0.0.1", "host.docker.internal"].includes(origin.hostname)) throw new Error("Only a disposable local HTTPS API is allowed.");
    const manifest = parseManifest(JSON.parse(await readFile(required("ZENITH_PLUGIN_PLATFORM_MANIFEST_FILE"), "utf8")) as unknown);
    const cookie = (await readFile(required("ZENITH_PLUGIN_PLATFORM_BROWSER_COOKIE_FILE"), "utf8")).trim();
    if (!cookie || cookie.length > 16_384 || /[\r\n]/.test(cookie)) throw new Error("Supply a bounded disposable browser cookie header.");
    const workspaceId = required("ZENITH_PLUGIN_PLATFORM_WORKSPACE");
    const browserPost = async (path: string, data: unknown) => {
      const response = await fetch(new URL(path, origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { origin: origin.origin, cookie, "x-zenith-workspace": workspaceId, "content-type": "application/json" }, body: JSON.stringify(data) });
      if (!response.ok) throw new Error(`Local browser consent refused: HTTP ${response.status}`);
      return await response.json() as Record<string, unknown>;
    };
    const registered = await browserPost("/api/integrations/plugins", { manifest: manifest.manifest });
    const registration = registered.plugin as { id: string; status: string; manifestDigest: string };
    if (registration.status !== "pending_review") throw new Error("Supply a fresh signed local fixture plugin/version.");
    const tool = manifest.manifest.capabilities.tools.find((name) => toolDescriptor(name)?.requiredScope === "read");
    if (!tool) throw new Error("The fixture must declare a read tool and a long-running Node stdio server.");
    await browserPost("/api/integrations/plugins/review", { registrationId: registration.id, manifestDigest: registration.manifestDigest,
      decision: "approve", tools: [tool], scopes: ["read"] });
    const docker = new DockerRuntime();
    for (const revoke of ["token", "registration"] as const) {
      const issued = await browserPost("/api/integrations/plugins/launch/tokens", { registrationId: registration.id,
        manifestDigest: registration.manifestDigest, credentialId: required("ZENITH_PLUGIN_PLATFORM_PARENT_ID"),
        projectIds: [required("ZENITH_PLUGIN_PLATFORM_PROJECT")], environmentIds: [required("ZENITH_PLUGIN_PLATFORM_ENVIRONMENT")], minutes: 10 });
      if (typeof issued.token !== "string" || !/^za_[A-Za-z0-9_-]{43}$/.test(issued.token)) throw new Error("No scoped child was issued.");
      const token = issued.token; const controller = new AbortController(); let started = false; let stopped = false; let settled = false;
      const runtime = { start: async (spec: Parameters<DockerRuntime["start"]>[0]) => {
        const process = await docker.start(spec); started = true;
        return { wait: () => process.wait(), stop: async () => { await process.stop(); stopped = true; } };
      } };
      const running = launchPlugin({ manifest: manifest.manifest, reviewedDigest: registration.manifestDigest,
        registrationId: registration.id, workspaceId, apiOrigin: origin.origin, token, image: required("ZENITH_PLUGIN_SANDBOX_IMAGE"),
        server: required("ZENITH_PLUGIN_PLATFORM_SERVER"), caFile: required("ZENITH_PLUGIN_TEST_TLS_CERT_FILE") },
      { runtime, publishers: trustedPublishersFromEnv(), signal: controller.signal }).then(
        () => { settled = true; return "unexpected-exit"; },
        (error: unknown) => { settled = true; return error instanceof LauncherError ? error.code : "unexpected-failure"; });
      try {
        await expect.poll(() => started, { timeout: 30_000 }).toBe(true);
        const discovery = await fetch(new URL("/api/agent/v3/mcp", origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
        expect(discovery.status).toBe(200);
        const catalog = await discovery.json() as { result: { tools: { name: string }[] } };
        expect(catalog.result.tools.map((item) => item.name)).toEqual([tool]);
        expect(settled).toBe(false);
        if (revoke === "token") {
          const response = await fetch(new URL("/api/agent/oauth/revoke", origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
            headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
          expect(response.status).toBe(200);
        } else await browserPost("/api/integrations/plugins/revoke", { registrationId: registration.id, reason: "local launcher acceptance complete" });
        // Host and gateway both supervise authority. Either can observe the
        // withdrawal first; an unrelated runtime failure is not accepted.
        expect(["launch_authority_refused", "sandbox_gateway_stopped"]).toContain(await running); expect(stopped).toBe(true);
        const check = await fetch(new URL("/api/integrations/plugins/launch/check", origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({
            registrationId: registration.id, workspaceId, manifestDigest: registration.manifestDigest,
            credentialDigest: tokenDigest(token), audience: `${origin.origin}/api/agent/v3/mcp`,
          }) });
        expect(check.status).toBe(401);
        const denied = await fetch(new URL("/api/agent/v3/mcp", origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
        expect(denied.status).toBe(401);
      } finally { controller.abort(); await running; }
    }
  }, 180_000);
});
