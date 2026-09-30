/**
 * Real `tofu` runs, no cloud and no network: the built-in `terraform_data`
 * resource with a local backend. Skipped (with a reason in the suite name)
 * only when no `tofu` binary is on PATH / ZENITH_TOFU_BIN.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TofuBinaryError } from "@/lib/tofu/binary";
import { applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { SENSITIVE_MASK, planView } from "@/lib/tofu/plan";
import { TofuCommandError, TofuRunner } from "@/lib/tofu/runner";
import { stableJson } from "@/lib/tofu/stable";
import { EMPTY_LOCKFILE } from "@/lib/tofu/providers";
import { TofuPlanChangedError, type TofuWorkspace } from "@/lib/tofu/types";
import { configDigestOf, lockDigestOf } from "@/lib/tofu/workspace";
import { builtinWorkspace, dataFragment, tempDir, tofuOnPath } from "./_helpers";

const hasTofu = tofuOnPath();

/** Hand-built workspace (bypasses assembleWorkspace's guards) for tests that need a provisioner. */
function rawWorkspace(statePath: string, main: unknown): TofuWorkspace {
  const files = [
    { path: "backend.tf.json", content: stableJson({ terraform: { backend: { local: { path: statePath } } } }) },
    { path: "main.tf.json", content: stableJson(main) },
    { path: "versions.tf.json", content: stableJson({ terraform: { required_version: "= 1.12.5" } }) },
  ];
  return { files, lockfile: EMPTY_LOCKFILE, configDigest: configDigestOf(files), lockDigest: lockDigestOf(EMPTY_LOCKFILE), addressMap: {}, backend: "local" };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function sandbox() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return { dir: t.dir, state: path.join(t.dir, "state", "terraform.tfstate") };
}

describe.skipIf(!hasTofu)("tofu lifecycle on terraform_data (real tofu 1.12.5, local backend)", () => {
  const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });

  it(
    "plans, applies, re-plans empty, updates, replaces and deletes — every step digest-verified",
    async () => {
      const { state } = sandbox();
      const frag = (input: unknown, extra: Record<string, unknown> = {}) => ({
        "resource/a": dataFragment("a", input, { output: { a_id: { value: "${terraform_data.a.id}" }, a_secret: { value: "${terraform_data.a.output}", sensitive: true } } }),
        ...extra,
      });
      const ws1 = builtinWorkspace(state, frag("v1"));

      // create
      const p1 = await planWorkspace(ws1, undefined, { runner });
      expect(p1.plan.summary).toMatchObject({ create: 1, update: 0, delete: 0, replace: 0 });
      expect(p1.plan.empty).toBe(false);
      expect(p1.plan.resourceChanges[0]).toMatchObject({ address: "terraform_data.a", nodeAddress: "resource/a", action: "create", providerName: "terraform.io/builtin/terraform" });
      expect(p1.plan.outputChanges.map((o) => [o.name, o.sensitive])).toEqual([["a_id", false], ["a_secret", true]]);
      expect(p1.plan.configDigest).toBe(ws1.configDigest);
      expect(p1.plan.lockDigest).toBe(ws1.lockDigest);
      expect(p1.planFile.length).toBeGreaterThan(100);
      expect(existsSync(state)).toBe(false); // planning writes nothing

      const a1 = await applyVerifiedPlan(ws1, { approvedDigest: p1.plan.planDigest, runner });
      expect(a1.apply.exitCode).toBe(0);
      expect(a1.apply.output).toMatch(/Apply complete! Resources: 1 added/);
      expect(a1.outputs.a_id.value).toMatch(/^[0-9a-f-]{36}$/);
      expect(a1.outputs.a_secret).toEqual({ sensitive: true, type: "string" }); // value dropped
      expect(existsSync(state)).toBe(true);

      // idempotent: nothing to do, and the digest is stable across independent runs
      const p2 = await planWorkspace(ws1, undefined, { runner });
      const p2b = await planWorkspace(ws1, undefined, { runner });
      expect(p2.plan.empty).toBe(true);
      expect(p2.plan.summary).toMatchObject({ create: 0, noop: 1 });
      expect(p2b.plan.planDigest).toBe(p2.plan.planDigest);
      expect(p2b.plan.createdAt).not.toBe("");

      // update in place
      const ws2 = builtinWorkspace(state, frag("v2"));
      const p3 = await planWorkspace(ws2, undefined, { runner });
      expect(p3.plan.summary).toMatchObject({ update: 1, replace: 0 });
      const inputChange = p3.plan.resourceChanges[0].changes.find((c) => c.path === "input");
      expect(inputChange).toMatchObject({ before: "v1", after: "v2", sensitive: false, forcesReplacement: false });
      await applyVerifiedPlan(ws2, { approvedDigest: p3.plan.planDigest, runner });

      // replace (triggers_replace forces it)
      const ws3 = builtinWorkspace(state, { "resource/a": dataFragment("a", "v2", { output: { a_id: { value: "${terraform_data.a.id}" } } }) });
      const ws3r = builtinWorkspace(state, {
        "resource/a": {
          resource: { terraform_data: { a: { input: "v2", triggers_replace: ["t1"] } } },
          output: { a_id: { value: "${terraform_data.a.id}" } },
          addresses: ["terraform_data.a"],
        },
      });
      expect(ws3.configDigest).not.toBe(ws3r.configDigest);
      const p4 = await planWorkspace(ws3r, undefined, { runner });
      expect(p4.plan.summary.replace).toBe(1);
      expect(p4.plan.resourceChanges[0].changes.find((c) => c.path === "triggers_replace[0]")?.forcesReplacement).toBe(true);
      await applyVerifiedPlan(ws3r, { approvedDigest: p4.plan.planDigest, runner });

      // delete
      const ws4 = builtinWorkspace(state, {});
      const p5 = await planWorkspace(ws4, undefined, { runner });
      expect(p5.plan.summary).toMatchObject({ delete: 1 });
      const a5 = await applyVerifiedPlan(ws4, { approvedDigest: p5.plan.planDigest, runner });
      expect(a5.apply.output).toMatch(/1 destroyed/);
      expect((await planWorkspace(ws4, undefined, { runner })).plan.empty).toBe(true);
    },
    240_000
  );

  it(
    "refuses to apply when the configuration changed between approval and apply, and applies nothing",
    async () => {
      const { state } = sandbox();
      const approvedWs = builtinWorkspace(state, { "resource/a": dataFragment("a", "approved") });
      const approved = await planWorkspace(approvedWs, undefined, { runner });

      const changedWs = builtinWorkspace(state, { "resource/a": dataFragment("a", "sneaked-in") });
      await expect(applyVerifiedPlan(changedWs, { approvedDigest: approved.plan.planDigest, runner })).rejects.toBeInstanceOf(TofuPlanChangedError);
      expect(existsSync(state)).toBe(false);

      try {
        await applyVerifiedPlan(changedWs, { approvedDigest: approved.plan.planDigest, runner });
      } catch (e) {
        expect(e).toMatchObject({ code: "plan_changed", approvedDigest: approved.plan.planDigest });
        expect((e as TofuPlanChangedError).currentDigest).not.toBe(approved.plan.planDigest);
        expect((e as Error).message).toMatch(/new approval is required/);
      }
    },
    120_000
  );

  it(
    "refuses to apply when only the state moved (same config, someone applied in between)",
    async () => {
      const { state } = sandbox();
      const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
      const approved = await planWorkspace(ws, undefined, { runner });
      // out-of-band apply of the very same config
      await applyVerifiedPlan(ws, { approvedDigest: approved.plan.planDigest, runner });
      // the approved digest describes "create", the world now says "no changes"
      await expect(applyVerifiedPlan(ws, { approvedDigest: approved.plan.planDigest, runner })).rejects.toBeInstanceOf(TofuPlanChangedError);
    },
    120_000
  );

  it(
    "keeps sensitive values out of the normalized plan and view, including a provider echo of them",
    async () => {
      const { state } = sandbox();
      const mk = (secret: string) => builtinWorkspace(state, { "resource/s": dataFragment("s", `\${sensitive("${secret}")}`) });
      const ws1 = mk("CANARY-REAL-SECRET-ONE-1111");
      const p1 = await planWorkspace(ws1, undefined, { runner });
      await applyVerifiedPlan(ws1, { approvedDigest: p1.plan.planDigest, runner });

      const ws2 = mk("CANARY-REAL-SECRET-TWO-2222");
      const p2 = await planWorkspace(ws2, undefined, { runner });
      const change = p2.plan.resourceChanges[0];
      expect(change.action).toBe("update");
      // the sensitive input itself
      expect(change.changes.find((c) => c.path === "input")).toMatchObject({ before: SENSITIVE_MASK, after: SENSITIVE_MASK, sensitive: true });
      // terraform_data.output echoes the old input UNMARKED in `before`: the scrub must catch it
      expect(change.changes.find((c) => c.path === "output")).toMatchObject({ sensitive: true, before: SENSITIVE_MASK });
      for (const text of [JSON.stringify(p1.plan), JSON.stringify(p2.plan), JSON.stringify(planView(p2.plan))]) {
        expect(text).not.toContain("CANARY-REAL-SECRET");
      }

      // and a rotation of the secret alone still moves the digest
      const p3 = await planWorkspace(mk("CANARY-REAL-SECRET-THREE-3333"), undefined, { runner });
      expect(p3.plan.planDigest).not.toBe(p2.plan.planDigest);
      expect(JSON.stringify(p3.plan)).not.toContain("CANARY-REAL-SECRET");
    },
    240_000
  );

  it(
    "keeps the plan file only where the caller says, mode 0600, and never in the result text",
    async () => {
      const { dir, state } = sandbox();
      const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
      const planDir = path.join(dir, "plans");
      const res = await planWorkspace(ws, undefined, { runner, planDir });
      expect(res.planFilePath).toBe(path.join(planDir, `${res.plan.planDigest}.tfplan`));
      expect(readFileSync(res.planFilePath!).equals(res.planFile)).toBe(true);
      if (process.platform !== "win32") expect(statSync(res.planFilePath!).mode & 0o777).toBe(0o600);
    },
    120_000
  );

  it(
    "runs validate, reporting an invalid configuration as a result",
    async () => {
      const { state } = sandbox();
      const good = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
      const bad = rawWorkspace(state, { resource: { terraform_data: { a: { input: "${terraform_data.nope.id}" } } } });
      await runner.run(good, {}, async (run) => {
        await run.init({ backend: false });
        expect(await run.validate()).toMatchObject({ valid: true, diagnostics: [] });
      });
      await runner.run(bad, {}, async (run) => {
        await run.init({ backend: false });
        const v = await run.validate();
        expect(v.valid).toBe(false);
        expect(v.diagnostics[0].severity).toBe("error");
        expect(v.diagnostics[0].summary).toMatch(/Reference to undeclared resource/);
      });
    },
    120_000
  );

  it(
    "surfaces a failing command as TofuCommandError with redacted output",
    async () => {
      const { state } = sandbox();
      const bad = rawWorkspace(state, { resource: { terraform_data: { a: { input: "${terraform_data.nope.id}" } } } });
      await runner.run(bad, {}, async (run) => {
        await run.init({ backend: false });
        await expect(run.plan()).rejects.toMatchObject({ code: "tofu_command_failed", result: { command: "plan", exitCode: 1 } });
      });
    },
    120_000
  );

  it(
    "removes the run directory on dispose",
    async () => {
      const { state } = sandbox();
      const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
      const run = await runner.open(ws);
      const dir = run.workDir;
      expect(existsSync(path.join(dir, "main.tf.json"))).toBe(true);
      expect(existsSync(path.join(dir, ".terraform.lock.hcl"))).toBe(true);
      await run.dispose();
      expect(existsSync(dir)).toBe(false);
      await expect(run.init()).rejects.toThrow(/disposed/);
    },
    60_000
  );

  it("refuses a workspace whose bytes do not match its digests, before touching disk", async () => {
    const { state } = sandbox();
    const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
    const tampered = { ...ws, files: ws.files.map((f) => (f.path === "main.tf.json" ? { ...f, content: f.content.replace('"x"', '"y"') } : f)) };
    await expect(runner.open(tampered)).rejects.toThrow(/configDigest/);
  });
});

describe.skipIf(!hasTofu)("tofu environment isolation (real tofu)", () => {
  const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });
  const printEnv = process.platform === "win32" ? "set" : "env";

  it(
    "a control-plane canary never reaches tofu or its provisioners; session credentials do, but are redacted from output",
    async () => {
      const { state } = sandbox();
      process.env.ZENITH_TEST_CANARY = "control-plane-canary-9931";
      process.env.DATABASE_URL = "postgres://zenith:db-canary-pw-77@db.internal/zenith";
      process.env.ZENITH_CONTROL_SIGNING_JWK = "signing-key-canary-55";
      try {
        const ws = rawWorkspace(state, { resource: { terraform_data: { probe: { provisioner: [{ "local-exec": { command: printEnv } }] } } } });
        const session = { childProcessEnv: () => ({ AWS_ACCESS_KEY_ID: "AKIAABCDEFGHIJKLMNOP", AWS_SECRET_ACCESS_KEY: "session-secret-value-777", AWS_SESSION_TOKEN: "session-token-value-888", AWS_REGION: "ap-south-1" }) };
        const out = await runner.run(ws, { session }, async (run) => {
          await run.init();
          await run.plan();
          const plan = await run.normalizedPlan();
          const { result } = await run.apply({ expectedPlanDigest: plan.planDigest });
          return result.output;
        });
        // the provisioner inherits tofu's environment and printed it
        expect(out).toContain("AWS_REGION=ap-south-1");
        expect(out).toContain("TF_IN_AUTOMATION=1");
        expect(out).toContain("CHECKPOINT_DISABLE=1");
        // …so anything in the child env is visible to it, and none of the control plane's is there
        for (const canary of ["control-plane-canary-9931", "db-canary-pw-77", "signing-key-canary-55", "ZENITH_TEST_CANARY", "ZENITH_CONTROL_SIGNING_JWK", "DATABASE_URL"]) {
          expect(out, canary).not.toContain(canary);
        }
        // session credentials are passed to the child but redacted from what we return
        for (const secret of ["session-secret-value-777", "session-token-value-888", "AKIAABCDEFGHIJKLMNOP"]) expect(out, secret).not.toContain(secret);
        expect(out).toContain("[REDACTED]");
      } finally {
        delete process.env.ZENITH_TEST_CANARY;
        delete process.env.DATABASE_URL;
        delete process.env.ZENITH_CONTROL_SIGNING_JWK;
      }
    },
    180_000
  );

  it(
    "refuses a session that tries to inject tofu arguments or override runner settings",
    async () => {
      const { state } = sandbox();
      const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
      const evil = { childProcessEnv: () => ({ TF_CLI_ARGS: "-auto-approve", AWS_REGION: "x" }) };
      await runner.run(ws, { session: evil }, async (run) => {
        await expect(run.init()).rejects.toThrow(/TF_CLI_ARGS/);
      });
    },
    60_000
  );
});

describe.skipIf(!hasTofu)("tofu process limits (real tofu)", () => {
  const slow = process.platform === "win32" ? "ping -n 1337 127.0.0.1" : "sleep 1337";

  function stillRunning(marker: string): boolean {
    if (process.platform === "win32") {
      // filter by image name so the query's own command line cannot match
      const r = spawnSync("powershell", ["-NoProfile", "-Command", `@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`], { encoding: "utf8" });
      return Number(r.stdout.trim()) > 0;
    }
    return spawnSync("pgrep", ["-f", `sleep ${marker}`]).status === 0;
  }

  it(
    "kills the whole process tree when a command times out",
    async () => {
      const { state } = sandbox();
      const ws = rawWorkspace(state, { resource: { terraform_data: { slow: { provisioner: [{ "local-exec": { command: slow } }] } } } });
      const runner = new TofuRunner({ limits: { timeoutMs: 8_000 }, graceMs: 500 });
      const t0 = Date.now();
      await runner.run(ws, {}, async (run) => {
        await run.init();
        await run.plan();
        const plan = await run.normalizedPlan();
        await expect(run.apply({ expectedPlanDigest: plan.planDigest })).rejects.toMatchObject({ code: "tofu_timeout", result: { command: "apply" } });
      });
      expect(Date.now() - t0).toBeLessThan(60_000);
      // give the OS a moment to reap, then no provisioner may be left behind
      await new Promise((r) => setTimeout(r, 1500));
      expect(stillRunning("1337")).toBe(false);
    },
    120_000
  );

  it(
    "stops a command on AbortSignal",
    async () => {
      const { state } = sandbox();
      const ws = rawWorkspace(state, { resource: { terraform_data: { slow: { provisioner: [{ "local-exec": { command: slow } }] } } } });
      const ac = new AbortController();
      const runner = new TofuRunner({ limits: { timeoutMs: 120_000 }, graceMs: 500 });
      await runner.run(ws, { signal: ac.signal }, async (run) => {
        await run.init();
        await run.plan();
        const plan = await run.normalizedPlan();
        setTimeout(() => ac.abort(), 4000);
        await expect(run.apply({ expectedPlanDigest: plan.planDigest })).rejects.toMatchObject({ code: "tofu_aborted" });
      });
    },
    120_000
  );

  it(
    "caps and flags oversized output",
    async () => {
      const { state } = sandbox();
      const noisy = process.platform === "win32" ? "for /L %i in (1,1,4000) do @echo line-%i-padpadpadpadpadpadpadpadpadpadpadpadpadpadpadpad" : "i=0; while [ $i -lt 4000 ]; do echo line-$i-padpadpadpadpadpadpadpadpadpadpadpadpad; i=$((i+1)); done";
      const ws = rawWorkspace(state, { resource: { terraform_data: { noisy: { provisioner: [{ "local-exec": { command: noisy } }] } } } });
      const runner = new TofuRunner({ limits: { timeoutMs: 120_000, maxOutputBytes: 8192 } });
      const result = await runner.run(ws, {}, async (run) => {
        await run.init();
        await run.plan();
        const plan = await run.normalizedPlan();
        return (await run.apply({ expectedPlanDigest: plan.planDigest })).result;
      });
      expect(result.truncated).toBe(true);
      expect(result.output.length).toBeLessThan(12_000);
      expect(result.output).toMatch(/bytes of output truncated/);
      expect(result.output).toMatch(/Apply complete/); // the tail survives
    },
    180_000
  );
});

describe("tofu binary pinning", () => {
  it.skipIf(!hasTofu)("refuses a binary whose version is not the pin", async () => {
    const { state } = sandbox();
    const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
    const runner = new TofuRunner({ expectedVersion: "0.0.1" });
    await expect(runner.open(ws)).rejects.toMatchObject({ code: "tofu_version_mismatch" });
    await expect(runner.open(ws)).rejects.toBeInstanceOf(TofuBinaryError);
  });

  it("refuses something that is not tofu (`version -json` fails or is not JSON)", async () => {
    const { state } = sandbox();
    const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
    const runner = new TofuRunner({ bin: process.execPath });
    await expect(runner.open(ws)).rejects.toMatchObject({ code: "tofu_version_mismatch" });
  });

  it("requires an absolute, existing ZENITH_TOFU_BIN and reports a missing binary", async () => {
    const { state } = sandbox();
    const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
    await expect(new TofuRunner({ hostEnv: { ZENITH_TOFU_BIN: "tofu" } }).open(ws)).rejects.toMatchObject({ code: "tofu_binary_missing" });
    await expect(new TofuRunner({ hostEnv: { ZENITH_TOFU_BIN: path.join(process.cwd(), "no-such-tofu") } }).open(ws)).rejects.toMatchObject({ code: "tofu_binary_missing" });
    await expect(new TofuRunner({ hostEnv: { PATH: "" } }).open(ws)).rejects.toMatchObject({ code: "tofu_binary_missing" });
  });

  it.skipIf(!hasTofu)("honors ZENITH_TOFU_BIN and ZENITH_TOFU_PLUGIN_CACHE from the host environment", async () => {
    const { dir, state } = sandbox();
    const ws = builtinWorkspace(state, { "resource/a": dataFragment("a", "x") });
    const { resolveTofuBinary } = await import("@/lib/tofu/binary");
    const bin = resolveTofuBinary();
    const cache = path.join(dir, "plugin-cache");
    const runner = new TofuRunner({ hostEnv: { ZENITH_TOFU_BIN: bin, ZENITH_TOFU_PLUGIN_CACHE: cache, PATH: "" } });
    const run = await runner.open(ws);
    await run.dispose();
    expect(existsSync(cache)).toBe(true);
    expect(() => new TofuRunner({ pluginCacheDir: "relative/cache" })).toThrow(/absolute/);
  });
});

describe("TofuCommandError shape", () => {
  it("carries the redacted result", () => {
    const err = new TofuCommandError("tofu_command_failed", "boom", { command: "plan", exitCode: 1, output: "x", truncated: false, durationMs: 1 });
    expect(err.result.exitCode).toBe(1);
    expect(err.code).toBe("tofu_command_failed");
  });
});
