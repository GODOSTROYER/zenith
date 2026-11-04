/**
 * Assemble every data driver's fragment into one OpenTofu workspace.
 *
 * Default run (no network): the workspace assembler accepts the fragments
 * (unique addresses, known provider types, no forbidden constructs), the result
 * is byte-deterministic, and every `local.ref_*` a fragment reads is defined by
 * some fragment — i.e. the cross-node reference protocol closes.
 *
 * Gated (`ZENITH_TEST_TOFU_NETWORK=1`, needs the `tofu` binary and, the first
 * time, a ~160 MB provider download; no AWS account or credentials involved):
 * the real hashicorp/aws 6.66.0 schema validates the compiled JSON with
 * `tofu validate`. That is ground truth for argument names and block shapes; it
 * does NOT prove the plan would apply against a live account.
 *
 *   ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/providers/aws/drivers/data/assemble.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { TofuRunner } from "@/lib/tofu/runner";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { CTX_TAGS, graphOf, standardFragments, standardNodes } from "./_helpers";

function assemble(fragments: Map<string, TofuFragment> = standardFragments(), nodes = standardNodes()) {
  return assembleWorkspace({
    graph: graphOf(nodes),
    fragments,
    providerSet: "aws",
    region: "ap-south-1",
    backend: { kind: "local", path: "terraform.tfstate" },
    tags: CTX_TAGS,
  });
}

function tofuOnPath(): boolean {
  try {
    return spawnSync(resolveTofuBinary(), ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

describe("the data drivers assemble into one workspace", () => {
  it("is accepted by the workspace assembler and keeps each node's primary resource first", () => {
    const fragments = standardFragments();
    const ws = assemble(fragments);
    for (const [address, fragment] of fragments) {
      if (fragment.addresses.length === 0) continue;
      expect(ws.addressMap[address], address).toEqual([...fragment.addresses].sort());
    }
    const primaries = Object.fromEntries([...fragments].map(([a, f]) => [a, f.addresses[0]]));
    expect(primaries).toMatchObject({
      "postgres/db": "aws_db_instance.postgres_db",
      "redis/cache": "aws_elasticache_replication_group.redis_cache",
      "object_store/uploads": "aws_s3_bucket.object_store_uploads",
      "queue/jobs": "aws_sqs_queue.queue_jobs",
      "secret/api-key-deadbeef": "aws_secretsmanager_secret.secret_api_key_deadbeef",
      "identity/web": "aws_iam_role.identity_web",
      "log_group/web": "aws_cloudwatch_log_group.log_group_web",
    });
  });

  it("is deterministic: compiling and assembling twice gives identical digests and bytes", () => {
    const a = assemble(standardFragments());
    const b = assemble(standardFragments());
    expect(a.configDigest).toBe(b.configDigest);
    expect(a.files.map((f) => f.content)).toEqual(b.files.map((f) => f.content));
  });

  it("closes the reference protocol: every local a fragment reads is defined by some fragment", () => {
    const ws = assemble();
    const main = JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content) as { locals?: Record<string, unknown> };
    const text = ws.files.find((f) => f.path === "main.tf.json")!.content;
    const defined = new Set(Object.keys(main.locals ?? {}));
    const used = new Set([...text.matchAll(/local\.(ref_[a-z0-9_]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(defined.has(name), `local.${name} is read but never defined`).toBe(true);
  });

  it("contains no credential-shaped argument names in the compiled workspace", () => {
    const text = assemble().files.find((f) => f.path === "main.tf.json")!.content;
    // `manage_master_user_password` is the ONE password-named argument and its value is the boolean true.
    const names = [...text.matchAll(/"([a-z_]*(password|passwd|secret_string|secret_binary|auth_token|access_key|private_key)[a-z_]*)":/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(["manage_master_user_password"]));
    expect(text).not.toContain("aws_secretsmanager_secret_version");
    expect(text).not.toContain("random_password");
  });
});

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && tofuOnPath();

describe.skipIf(!enabled)("compiled data fragments validate against the real hashicorp/aws provider (network)", () => {
  it(
    "tofu validate accepts the assembled workspace",
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-data-validate-"));
      try {
        const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
        await runner.run(assemble(), {}, async (run) => {
          await run.init({ backend: false });
          const v = await run.validate();
          expect(v.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.summary}: ${d.detail ?? ""}`)).toEqual([]);
          // deprecation warnings (e.g. a case-insensitive enum value) are future breakage: none is tolerated
          expect(v.diagnostics.filter((d) => d.severity === "warning").map((d) => `${d.summary}: ${d.detail ?? ""}`)).toEqual([]);
          expect(v.valid).toBe(true);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    900_000
  );
});
