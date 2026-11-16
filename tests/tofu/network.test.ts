/**
 * Runs that download real providers from registry.opentofu.org. Gated behind
 * ZENITH_TEST_TOFU_NETWORK=1 (and a tofu binary): they need internet access
 * and, for the AWS provider, a ~160 MB download the first time (later runs
 * reuse the shared plugin cache). No cloud account or credentials are used;
 * nothing here calls a cloud API.
 *
 *   ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/tofu/network.test.ts
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { splitLockBlocks } from "@/lib/tofu/lockfile";
import { LOCKFILES } from "@/lib/tofu/locks.generated";
import { TofuRunner } from "@/lib/tofu/runner";
import { PROVIDER_PINS, lockfileSource } from "@/lib/tofu/providers";
import type { TofuFragment } from "@/lib/drivers/types";
import { configDigestOf, lockDigestOf, assembleWorkspace } from "@/lib/tofu/workspace";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { graphOf, node, tempDir, tofuOnPath } from "./_helpers";

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && tofuOnPath();

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function sandbox() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return { dir: t.dir, state: path.join(t.dir, "state", "terraform.tfstate") };
}

describe.skipIf(!enabled)("real provider install through the committed lockfile (network)", () => {
  const randomFragment: TofuFragment = {
    resource: { random_id: { suffix: { byte_length: 4 } } },
    output: { suffix: { value: "${random_id.suffix.hex}" } },
    addresses: ["random_id.suffix"],
  };

  it(
    "installs hashicorp/random into an empty plugin cache with -lockfile=readonly, then plans and applies a digest-verified plan",
    async () => {
      const { dir, state } = sandbox();
      const runner = new TofuRunner({ pluginCacheDir: path.join(dir, "fresh-cache"), limits: { timeoutMs: 300_000 } });
      const ws = assembleWorkspace({
        graph: graphOf([node("resource/suffix")]),
        fragments: new Map([["resource/suffix", randomFragment]]),
        providerSet: "random",
        region: "ap-south-1",
        backend: { kind: "local", path: state },
        tags: {},
      });
      const planned = await planWorkspace(ws, undefined, { runner });
      expect(planned.plan.resourceChanges[0]).toMatchObject({ address: "random_id.suffix", nodeAddress: "resource/suffix", action: "create", providerName: "registry.opentofu.org/hashicorp/random" });
      expect(existsSync(path.join(dir, "fresh-cache", "registry.opentofu.org", "hashicorp", "random", PROVIDER_PINS.random.version))).toBe(true);

      const applied = await applyVerifiedPlan(ws, { approvedDigest: planned.plan.planDigest, runner });
      expect(applied.outputs.suffix.value).toMatch(/^[0-9a-f]{8}$/);
      // the random value only exists after apply; a re-plan is empty and stable
      expect((await planWorkspace(ws, undefined, { runner })).plan.empty).toBe(true);
    },
    600_000
  );

  it(
    "refuses to init when the lockfile does not cover the required provider or carries the wrong hashes",
    async () => {
      const { dir, state } = sandbox();
      const runner = new TofuRunner({ pluginCacheDir: path.join(dir, "cache"), limits: { timeoutMs: 300_000 } });
      const good = assembleWorkspace({
        graph: graphOf([node("resource/suffix")]),
        fragments: new Map([["resource/suffix", randomFragment]]),
        providerSet: "random",
        region: "ap-south-1",
        backend: { kind: "local", path: state },
        tags: {},
      });
      const withLock = (lockfile: string): TofuWorkspace => ({ ...good, lockfile, lockDigest: lockDigestOf(lockfile) });

      // no entry for the provider the config requires
      const empty = LOCKFILES.builtin;
      await runner.run(withLock(empty), {}, async (run) => {
        await expect(run.init()).rejects.toMatchObject({ code: "tofu_command_failed", result: { command: "init" } });
      });

      // right version, checksums that match no real build
      const forged = LOCKFILES.random.replace(/"h1:[^"]+"/g, '"h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="').replace(/"zh:[0-9a-f]{64}"/g, `"zh:${"0".repeat(64)}"`);
      expect(forged).not.toBe(LOCKFILES.random);
      await runner.run(withLock(forged), {}, async (run) => {
        await expect(run.init()).rejects.toMatchObject({ code: "tofu_command_failed" });
      });

      // a config edited to a different provider version than the lock
      const bumped = good.files.map((f) => (f.path === "versions.tf.json" ? { ...f, content: f.content.replace(`= ${PROVIDER_PINS.random.version}`, "= 3.7.2") } : f));
      const drifted: TofuWorkspace = { ...good, files: bumped, configDigest: configDigestOf(bumped) };
      await runner.run(drifted, {}, async (run) => {
        await expect(run.init()).rejects.toMatchObject({ code: "tofu_command_failed" });
      });
    },
    600_000
  );

  it(
    "reproduces the committed lock block for hashicorp/random with `tofu providers lock`",
    async () => {
      const runner = new TofuRunner();
      const { lockfile, result } = await runner.providersLock(["random"]);
      expect(result).toMatchObject({ command: "providers-lock", exitCode: 0 });
      const fresh = splitLockBlocks(lockfile)[0];
      const committed = splitLockBlocks(LOCKFILES.random).find((b) => b.source === lockfileSource("random"))!;
      expect(fresh.version).toBe(committed.version);
      expect([...fresh.hashes].sort()).toEqual([...committed.hashes].sort());
    },
    600_000
  );
});

describe.skipIf(!enabled)("AWS provider blocks validate against the real provider schema (network, ~160 MB first run)", () => {
  it(
    "accepts providers.tf.json (region + default_tags), the s3 backend block shape, and typical resource JSON",
    async () => {
      const fragments = new Map<string, TofuFragment>([
        [
          "resource/assets",
          {
            resource: {
              random_id: { assets_suffix: { byte_length: 3 } },
              aws_s3_bucket: { assets: { bucket: "zenith-acme-${random_id.assets_suffix.hex}", force_destroy: false, tags: { "zenith:resource": "resource/assets" } } },
              aws_s3_bucket_public_access_block: { assets: { bucket: "${aws_s3_bucket.assets.id}", block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true } },
            },
            output: { assets_arn: { value: "${aws_s3_bucket.assets.arn}" } },
            addresses: ["aws_s3_bucket.assets", "aws_s3_bucket_public_access_block.assets", "random_id.assets_suffix"],
          },
        ],
      ]);
      const ws = assembleWorkspace({
        graph: graphOf([node("resource/assets")]),
        fragments,
        providerSet: "aws",
        region: "ap-south-1",
        backend: { kind: "s3", bucket: "acme-zenith-state" },
        stateKey: "zenith/ws1/env1/terraform.tfstate",
        tags: { "zenith:workspace": "ws1", "zenith:environment": "env1", "zenith:managed": "true" },
      });
      // the assembled workspace carries an s3 backend; validate without initializing it
      expect(ws.files.find((f) => f.path === "backend.tf.json")!.content).toContain("use_lockfile");
      const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
      await runner.run(ws, {}, async (run) => {
        await run.init({ backend: false });
        const v = await run.validate();
        expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        expect(v.valid).toBe(true);
      });
    },
    900_000
  );
});
