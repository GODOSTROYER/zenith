/**
 * Every compute driver's fragment, assembled with `assembleWorkspace` next to
 * stub neighbours (network, log group, identity, secret, load balancer,
 * certificate) and, when `ZENITH_TEST_TOFU_NETWORK=1`, checked by a real
 * `tofu validate` against hashicorp/aws 6.66.0.
 *
 *   ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/providers/aws/drivers/compute/assemble.test.ts
 *
 * `validate` proves the JSON is a valid configuration for the pinned provider
 * (argument names, block shapes, reference types, local/data wiring). It does
 * NOT prove an apply would succeed: no AWS account and no plan against real
 * state were used.
 */
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { COMPUTE_DRIVERS } from "@/lib/providers/aws/drivers/compute";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import { buildFullFixture, CTX_TAGS, mkCompileContext, REGION, stubFragments } from "./fixtures";
import { tempDir, tofuOnPath } from "../../../../tofu/_helpers";
import path from "node:path";

function fullWorkspace(opts: Parameters<typeof buildFullFixture>[0] = {}, statePath = "terraform.tfstate") {
  const fx = buildFullFixture(opts);
  const ctx = mkCompileContext(fx.byAddress);
  const fragments = stubFragments(fx);
  const compiled: string[] = [];
  for (const node of fx.nodes) {
    const driver = COMPUTE_DRIVERS.find((d) => d.nativeType === node.nativeType);
    if (!driver) continue;
    fragments.set(node.address, driver.compile!(node, ctx));
    compiled.push(node.address);
  }
  const ws = assembleWorkspace({
    graph: fx.graph,
    fragments: fragments as Map<string, TofuFragment>,
    providerSet: "aws",
    region: REGION,
    backend: { kind: "local", path: statePath },
    tags: CTX_TAGS,
  });
  return { fx, ws, compiled, fragments };
}

describe("compute drivers assemble into one workspace", () => {
  it("compiles every compute node and the assembler accepts the merged result", () => {
    const { ws, compiled } = fullWorkspace();
    expect(compiled.sort()).toEqual(
      ["build_pipeline/docs", "build_pipeline/web", "compute_instance/bastion", "container_registry/web", "container_service/web", "function/resize", "scheduled_job/nightly", "static_site/docs"].sort()
    );
    // the assembler claims every address a fragment lists, and each compute node owns at least one
    for (const a of compiled) expect(ws.addressMap[a]?.length).toBeGreaterThan(0);
    expect(ws.addressMap["container_service/web"]).toContain("aws_ecs_service.container_service_web");
    const main = JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content);
    expect(Object.keys(main.resource)).toEqual(expect.arrayContaining(["aws_ecs_service", "aws_ecs_task_definition", "aws_cloudfront_distribution", "aws_codebuild_project", "aws_lambda_function", "aws_instance", "aws_ecr_repository", "aws_cloudwatch_event_rule"]));
  });

  it("is deterministic: the same graph assembles to byte-identical files and digest", () => {
    const a = fullWorkspace();
    const b = fullWorkspace();
    expect(b.ws.configDigest).toBe(a.ws.configDigest);
    expect(b.ws.files.map((f) => f.content)).toEqual(a.ws.files.map((f) => f.content));
  });

  it("contains no credential, no provisioner and no file-reading function", () => {
    const { ws } = fullWorkspace();
    const all = ws.files.map((f) => f.content).join("\n");
    expect(all).not.toMatch(/provisioner|"connection"|file\(|templatefile\(/);
    expect(all).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it("no reference is double-escaped: nothing in the graph carries user text with `${`, so no `$${` may appear", () => {
    const { ws } = fullWorkspace();
    const main = ws.files.find((f) => f.path === "main.tf.json")!.content;
    expect(main).not.toContain("$${");
    // and the interpolations inside JSON documents are live
    expect(main).toMatch(/\\"valueFrom\\":\\"\$\{local\./);
  });
});

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && tofuOnPath();

describe.skipIf(!enabled)("real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache)", () => {
  it(
    "accepts the whole compute graph (service, job, registry, build, static site, function, instance)",
    async () => {
      const { dir, cleanup } = tempDir();
      try {
        const { ws } = fullWorkspace({}, path.join(dir, "terraform.tfstate"));
        const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
        await runner.run(ws, {}, async (run) => {
          await run.init();
          const v = await run.validate();
          expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
          expect(v.valid).toBe(true);
        });
      } finally {
        cleanup();
      }
    },
    900_000
  );

  it(
    "negative control: `validate` rejects an unknown argument, so the passes above are not vacuous",
    async () => {
      const { dir, cleanup } = tempDir();
      try {
        const { ws, fragments, fx } = fullWorkspace({}, path.join(dir, "terraform.tfstate"));
        const broken = structuredClone(fragments.get("container_service/web")!) as TofuFragment;
        (broken.resource!.aws_ecs_service.container_service_web as Record<string, unknown>).bogus_argument = true;
        fragments.set("container_service/web", broken);
        const bad = assembleWorkspace({ graph: fx.graph, fragments, providerSet: "aws", region: REGION, backend: { kind: "local", path: path.join(dir, "terraform.tfstate") }, tags: CTX_TAGS });
        expect(bad.configDigest).not.toBe(ws.configDigest);
        const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
        await runner.run(bad, {}, async (run) => {
          await run.init();
          const v = await run.validate();
          expect(v.valid).toBe(false);
          expect(v.diagnostics.some((d) => /bogus_argument/.test(`${d.summary} ${d.detail ?? ""}`))).toBe(true);
        });
      } finally {
        cleanup();
      }
    },
    900_000
  );

  it(
    "accepts a service with a pinned public image, no secrets and no load balancer",
    async () => {
      const { dir, cleanup } = tempDir();
      try {
        const { ws } = fullWorkspace({ artifact: { type: "image", ref: "ghcr.io/acme/web:2.0.1" }, withSecret: false, withLb: false, port: null }, path.join(dir, "terraform.tfstate"));
        const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
        await runner.run(ws, {}, async (run) => {
          await run.init();
          const v = await run.validate();
          expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
          expect(v.valid).toBe(true);
        });
      } finally {
        cleanup();
      }
    },
    900_000
  );
});

