/** Actual Node exec probe against an owned loopback HTTP fixture, not worker/PG/Temporal evidence. */
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface Probe { exec: { command: string[] }; periodSeconds: number; failureThreshold: number }
const deployment = load(fs.readFileSync("deploy/k8s/zenith-execution-worker.yaml", "utf8").split(/^---\s*$/m)[0]) as { spec: { template: { spec: { terminationGracePeriodSeconds: number; containers: Array<{ readinessProbe: Probe; startupProbe: Probe }> } } } };
const pod = deployment.spec.template.spec, worker = pod.containers[0];
const probe = worker.readinessProbe.exec.command;
function run(port: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, probe.slice(1), { env: { ...process.env, ZENITH_WORKER_HEALTH_PORT: port }, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("close", code => resolve(code));
  });
}

describe("Kubernetes worker loopback readiness contract", () => {
  it("startup and readiness use the packaged Node runtime with unchanged drain and probe thresholds", () => {
    expect(probe.slice(0, 2)).toEqual(["node", "-e"]);
    expect(worker.startupProbe.exec.command).toEqual(probe);
    expect(worker.readinessProbe).toMatchObject({ periodSeconds: 15, failureThreshold: 4 });
    expect(worker.startupProbe).toMatchObject({ periodSeconds: 5, failureThreshold: 24 });
    expect(pod.terminationGracePeriodSeconds).toBe(660);
    expect(probe[2]).toContain("http://127.0.0.1:");
    expect(probe[2]).not.toContain("0.0.0.0");
  });
  it("executes against loopback, refuses nonready/redirect/unreachable responses and malformed port input", async () => {
    let status = 200, calls = 0, redirectHits = 0;
    const server = http.createServer((request, response) => {
      calls++;
      if (request.url === "/redirect-target") { redirectHits++; response.writeHead(200); response.end(); return; }
      expect(request.url).toBe("/readyz"); response.writeHead(status, status === 302 ? { location: "/redirect-target" } : {}); response.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owned probe fixture did not bind");
    const port = String(address.port);
    try {
      expect(await run(port)).toBe(0); expect(calls).toBe(1);
      for (const failure of [503, 404, 302]) { status = failure; expect(await run(port)).toBe(1); }
      expect(redirectHits).toBe(0);
      const before = calls;
      expect(await run(`${port}@invalid.example`)).toBe(1);
      expect(calls).toBe(before);
    } finally { await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); }
    expect(await run(port)).toBe(1);
  });
});
