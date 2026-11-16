/**
 * PROD-OPS-06 operational rehearsal (docs/platform/operations/SENSITIVE-DATA.md) on an owned, already running lean J1 stack.
 *
 * Real browser identities plant random runtime canaries through the product's own secret path (system.setSecret into
 * Zenith's vault) and run a sandbox deploy that reads the secret reference, so the API, worker and Temporal all handle it.
 * Then the operated persistence is scanned byte for byte (every owned volume, every owned container's logs, the stack
 * directory) with a control that proves the scan sees the canary, and the at-rest census runs over both databases.
 *
 * The stack is borrowed, never torn down, so the next rehearsal can run on it. Gated: ZENITH_LOCAL_OPS_REHEARSAL=1 with
 * ZENITH_DEFAULT_STACK_DIRECTORY and ZENITH_DEFAULT_MAILPIT_URL naming the stack.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { action, ok, browserRequest, until } from "../e2e/default/support.mjs";
import { readState } from "../../scripts/acceptance/default-stack/runtime.mjs";
import { hostEnvironment } from "../../scripts/acceptance/default-stack/env.mjs";
import { openRealSession } from "../../scripts/acceptance/live/product/mix-03-driver";
import { scanStackForCanary } from "../../scripts/release/drivers/canary-local";

const gated = process.env.ZENITH_LOCAL_OPS_REHEARSAL === "1";

/** The census over one database of the stack, as an operator runs it; exit 0 means no plain-looking value in a sealed column. */
function census(db: "platform" | "product", environment: Record<string, string>): number {
  const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/sensitive-data-census.ts", "--db", db, "--sample", "10000"],
    { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "ignore"], timeout: 300_000 });
  return result.status ?? 1;
}

describe.skipIf(!gated)("PROD-OPS-06 operated rehearsal: persistence leak scan with runtime canaries", () => {
  it("plants canaries through the product, finds none in operated stores, logs or history, and the census is clean", async () => {
    const directory = process.env.ZENITH_DEFAULT_STACK_DIRECTORY!;
    const state = readState(directory) as { installationId: string; applicationInstallationId?: string; projectId: string };
    const { tenant, close } = await openRealSession(process.env);
    const canaries = [0, 1].map(() => `zops06${randomBytes(20).toString("hex")}`);
    try {
      const scope = { projectId: tenant.projectId };
      const service = await action(tenant.owner, "system.addService", { name: "ops06", kind: "web", image: "registry.example/ops06:1" }, scope);
      const serviceId = (service.serviceId ?? service.id) as string;
      expect(serviceId).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
      // Two secrets: one stored, one moved from a plaintext env value (the "Move to the secret store" fix).
      await action(tenant.owner, "system.setSecret", { serviceId, key: "OPS06_STORED", secretValue: canaries[0] }, scope);
      await action(tenant.owner, "system.setEnvVar", { serviceId, key: "OPS06_MOVED", value: canaries[1] }, scope);
      await action(tenant.owner, "system.setSecret", { serviceId, key: "OPS06_MOVED", moveExistingValue: true }, scope);
      // The working manifest names only references now.
      const project = ok(await browserRequest(tenant.owner, `/api/projects/${tenant.projectId}`, undefined, "GET", tenant.workspaceId));
      for (const canary of canaries) expect(JSON.stringify(project)).not.toContain(canary);
      // A sandbox deploy carries the references through the API, the worker and Temporal.
      const environment = await action(tenant.owner, "env.create", { projectId: tenant.projectId, name: "ops06", class: "sandbox", approvalRequired: false }, scope);
      const environmentId = environment.environmentId as string;
      // A sandbox environment deploys through the simulated provider: its deployment record settles (as mix-03-driver's deployAndWait reads it).
      await action(tenant.owner, "deploy.apply", { projectId: tenant.projectId, environmentId }, { projectId: tenant.projectId, environmentId });
      const latest = await until(async () => ok(await browserRequest(tenant.owner, `/api/environments/${environmentId}/deployments?limit=1`, undefined, "GET", tenant.workspaceId)),
        (data: { deployments?: { status?: string }[] }) => ["succeeded", "failed", "rolled_back", "cancelled"].includes(data.deployments?.[0]?.status ?? ""), 600_000);
      expect(latest.deployments[0].status).toBe("succeeded");

      for (const [index, canary] of canaries.entries()) {
        const scan = await scanStackForCanary(canary, { directory, state });
        if (process.env.ZENITH_OPERATED_DIAGNOSTICS === "1") process.stderr.write(`ops06-scan canary=${index} ${JSON.stringify({ leaks: scan.leaks, volumes: scan.leakingVolumes })}\n`);
        expect(scan.control, "the scan must see a control copy of the canary").toBe(true);
        expect(scan.scanned.volumes).toBeGreaterThan(0);
        expect(scan.scanned["container logs"]).toBeGreaterThan(0);
        if (index === 0) expect(scan.leaks, "a value sent only through the secret path is never stored in plain text").toEqual({});
        else {
          // A value an operator first stored in plain text stays in the database's own files (dead row versions, WAL) after the
          // move, until vacuum and WAL recycling, and in any backup taken meanwhile. SENSITIVE-DATA.md says to rotate it. It must
          // still never reach logs, the stack directory or any other store.
          expect(Object.keys(scan.leaks).filter(place => place !== "docker volumes")).toEqual([]);
          expect(scan.leakingVolumes.every(volume => volume === `supabase_db_${state.projectId}`)).toBe(true);
        }
      }
      // The stack's own host-side database environment (TLS to the pooler with the stack CA), as an operator's shell has it.
      const host = hostEnvironment(readState(directory)) as Record<string, string>;
      expect(census("platform", host)).toBe(0);
      expect(census("product", host)).toBe(0);
    } finally {
      await close();
    }
  }, 1_800_000);
});
