/** Runs the actual tsx entry in a child with an allowlisted fixture environment.
 * No parent cloud/database credentials are inherited by the child process. */
import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN, fixture, operation, reply } from "./support";

const servers: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
function childEnv(url?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  if (url) { env.ZENITH_URL = url; env.ZENITH_TOKEN = TOKEN; }
  return env;
}
const entry = [resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/cli/bin.ts")];

describe("executable entry", () => {
  it("runs help without a credential or a server", async () => {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => execFile(process.execPath, [...entry, "--help"],
      { env: childEnv(), windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
    expect(result.stderr).toBe(""); expect(result.stdout).toContain("zenith execute");
  });

  it("propagates HTTP exit status from the actual process without echoing the token", async () => {
    const server = await fixture((_req, res) => reply(res, { error: { code: "unauthorized", message: TOKEN } }, 401)); servers.push(server);
    const result = await new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, [...entry, "ops", "show", "op-cli", "--json"],
      { env: childEnv(server.url), windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr })));
    expect(result.code).toBe(3); expect(JSON.parse(result.stderr).error.code).toBe("unauthorized");
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it.skipIf(process.platform === "win32")("POSIX SIGINT terminates the real follow process (Windows signal emulation skipped)", async () => {
    let requested: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { requested = resolve; });
    const server = await fixture((req, res) => {
      if (req.url.includes("/events")) reply(res, { events: [] });
      else { reply(res, { operation: { ...operation, status: "running" }, approvals: [] }); requested?.(); }
    }); servers.push(server);
    const child = spawn(process.execPath, [...entry, "ops", "events", "op-cli", "--follow", "--json"], { env: childEnv(server.url), windowsHide: true });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      await ready; child.kill("SIGINT");
      expect(await closed).toBe(130); expect(JSON.parse(stderr).error.code).toBe("interrupted");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
  });
});
