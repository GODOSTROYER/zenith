/**
 * PROD-OPS-05 operational rehearsal (docs/platform/operations/KEY-CUSTODY.md) on an owned, already running lean J1 stack.
 *
 * A vault secret and a sandbox deploy exist under the installation's first keys. The operator runs the custody CLI
 * (sync, diagnose), rotates every generated key with the installation's own rotateKeys (the API and worker are recreated
 * together), diagnoses again, re-wraps the workspace's vault rows and waits for the re-wrap to complete, and deploys again
 * under the new keys. Every operator output is checked for key material. The rotation stays in place: run this rehearsal
 * last on a stack.
 *
 * Gated: ZENITH_LOCAL_OPS_REHEARSAL=1 with ZENITH_DEFAULT_STACK_DIRECTORY and ZENITH_DEFAULT_MAILPIT_URL naming the stack,
 * and ZENITH_TEMPORAL_BIN naming the Temporal CLI.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { action, browserRequest, ok, until } from "../e2e/default/support.mjs";
import { readState } from "../../scripts/acceptance/default-stack/runtime.mjs";
import { hostEnvironment } from "../../scripts/acceptance/default-stack/env.mjs";
import { openRealSession } from "../../scripts/acceptance/live/product/mix-03-driver";
import { runnerOps05Stack } from "../../scripts/acceptance/live/product/ops-05-stack";
import { ROTATED, runnerCustody } from "../../scripts/acceptance/live/product/ops-05";

const gated = process.env.ZENITH_LOCAL_OPS_REHEARSAL === "1";
const diag = (label: string, value: unknown) => { if (process.env.ZENITH_OPERATED_DIAGNOSTICS === "1") process.stderr.write(`ops05-${label} ${JSON.stringify(value).slice(0, 900)}\n`); };
interface Report { purposes: { purpose: string; currentKeyId?: string }[]; entries: { purpose: string; keyId: string; role: string }[]; violations: { severity: string; code: string; purposes: string[] }[] }

describe.skipIf(!gated)("PROD-OPS-05 operated rehearsal: rotate every key, keep old data readable, re-wrap the vault", () => {
  it("rotates the installation keys with the operator CLI and keeps vault and deploys working", async () => {
    const directory = process.env.ZENITH_DEFAULT_STACK_DIRECTORY!;
    const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "zenith-ops05-"));
    const env = { ...process.env, ...(hostEnvironment(readState(directory)) as Record<string, string>), RUNNER_TEMP: scratch };
    const { tenant, close } = await openRealSession(env);
    const stack = runnerOps05Stack(env, `ops05-${randomBytes(3).toString("hex")}`);
    const custody = runnerCustody(env);
    const operator = async (label: string, args: string[]) => {
      const result = await custody(args, stack.keys());
      const printed = [...result.out, ...result.err].join("\n");
      expect(stack.secrets().some(value => printed.includes(value)), `key-custody ${label} printed key material`).toBe(false);
      expect(result.code, `key-custody ${label} exit`).toBe(0);
      return result.out;
    };
    const diagnose = async (label: string): Promise<Report> => { await operator(`sync ${label}`, ["sync"]); return JSON.parse((await operator(`diagnose ${label}`, ["diagnose", "--json"])).join("\n")) as Report; };
    const scope = { projectId: tenant.projectId };
    const deploy = async (environmentId: string) => {
      await action(tenant.owner, "deploy.apply", { projectId: tenant.projectId, environmentId }, { ...scope, environmentId });
      const latest = await until(async () => ok(await browserRequest(tenant.owner, `/api/environments/${environmentId}/deployments?limit=1`, undefined, "GET", tenant.workspaceId)),
        (data: { deployments?: { status?: string }[] }) => ["succeeded", "failed", "rolled_back", "cancelled"].includes(data.deployments?.[0]?.status ?? ""), 600_000);
      expect(latest.deployments[0].status).toBe("succeeded");
    };
    try {
      const service = await action(tenant.owner, "system.addService", { name: "ops05", kind: "web", image: "registry.example/ops05:1" }, scope);
      const serviceId = (service.serviceId ?? service.id) as string;
      await action(tenant.owner, "system.setSecret", { serviceId, key: "OPS05_SECRET", secretValue: `zops05${randomBytes(20).toString("hex")}` }, scope);
      const environmentId = (await action(tenant.owner, "env.create", { projectId: tenant.projectId, name: "ops05", class: "sandbox", approvalRequired: false }, scope)).environmentId as string;
      await deploy(environmentId);

      const before = await diagnose("before");
      diag("before", before);
      expect(before.violations.filter(v => v.severity === "error")).toEqual([]);
      const was = Object.fromEntries(Object.keys(ROTATED).map(p => [p, before.purposes.find(s => s.purpose === p)?.currentKeyId]));
      for (const [purpose, id] of Object.entries(was)) expect(id, `${purpose} has a current key before rotation`).toBeTruthy();

      await stack.rotate();

      const after = await diagnose("after");
      diag("after", after);
      expect(after.violations.filter(v => v.severity === "error")).toEqual([]);
      expect(after.violations.filter(v => v.code === "result_key_derived_from_signing_key" || v.purposes.includes("enc:temporal-payload")), "results and Temporal payloads on their own roots").toEqual([]);
      for (const [purpose, role] of Object.entries(ROTATED)) {
        const now = after.purposes.find(s => s.purpose === purpose)?.currentKeyId;
        expect(now && now !== was[purpose], `${purpose} has a new current key`).toBe(true);
        expect(after.entries.find(e => e.purpose === purpose && e.keyId === was[purpose])?.role, `${purpose} keeps its old key`).toBe(role);
      }

      await operator("rewrap", ["rewrap", "--workspace", tenant.workspaceId, "--run"]);
      const status = await until(async () => {
        const lines = (await operator("rewrap-status", ["rewrap-status", "--workspace", tenant.workspaceId])).filter(l => l.startsWith("{"));
        return lines.length ? JSON.parse(lines[lines.length - 1]!) as { status?: string; rewrapped?: number } : {};
      }, (job: { status?: string }) => job.status === "completed" || job.status === "failed", 600_000);
      diag("rewrap", status);
      expect(status.status).toBe("completed");
      expect(status.rewrapped ?? 0).toBeGreaterThan(0);

      // A deploy of an unchanged system is refused, so the second deploy carries one more service.
      await action(tenant.owner, "system.addService", { name: "ops05-after", kind: "web", image: "registry.example/ops05:2" }, scope);
      await deploy(environmentId);
    } finally {
      await stack.close().catch(() => undefined);
      await close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 2_400_000);
});
