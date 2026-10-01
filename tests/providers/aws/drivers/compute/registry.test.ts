/**
 * The compute group as a whole: ids, native types and capabilities line up
 * with the shared vocabulary (native-types table, capability catalog), every
 * observation names its provider identifier, and no driver reaches outside
 * its files.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { NATIVE_TYPE_TABLE } from "@/lib/resources/native-types";
import { COMPUTE_DRIVERS } from "@/lib/providers/aws/drivers/compute";

describe("COMPUTE_DRIVERS", () => {
  it("covers exactly the seven compute native types, each once, with the right kind", () => {
    const aws = NATIVE_TYPE_TABLE.aws;
    const expected: Record<string, string> = {
      "aws:ecs_service": "container_service",
      "aws:ecr_repository": "container_registry",
      "aws:codebuild_project": "build_pipeline",
      "aws:ecs_scheduled_task": "scheduled_job",
      "aws:s3_static_site": "static_site",
      "aws:lambda_function": "function",
      "aws:ec2_instance": "compute_instance",
    };
    expect(COMPUTE_DRIVERS.map((d) => d.nativeType).sort()).toEqual(Object.keys(expected).sort());
    for (const d of COMPUTE_DRIVERS) {
      expect(d.kind).toBe(expected[d.nativeType]);
      expect(aws[d.kind as keyof typeof aws]).toBe(d.nativeType); // the same string expansion writes into nodes
      expect(d.provider).toBe("aws");
      expect(d.id).toBe(`aws.${d.nativeType.slice("aws:".length)}@1`);
    }
  });

  it("declares only catalog capabilities as operations, with evidence for each, and nothing above `contract`", () => {
    for (const d of COMPUTE_DRIVERS) {
      for (const op of d.capabilities.operations) {
        expect(op in CAPABILITIES, `${d.id}: ${op}`).toBe(true);
        expect(d.capabilities.evidence[op], `${d.id}: ${op}`).toBe("contract");
        expect(d.operations?.[op], `${d.id}: ${op}`).toBeTypeOf("function");
      }
      expect(Object.keys(d.operations ?? {}).sort()).toEqual([...d.capabilities.operations].sort());
      for (const [k, level] of Object.entries(d.capabilities.evidence)) expect(level, `${d.id}.${k}`).toBe("contract");
    }
  });

  it("has each declared capability backed by an implementation, and none claimed without one", () => {
    for (const d of COMPUTE_DRIVERS) {
      const c = d.capabilities;
      expect(!!d.compile).toBe(c.compile);
      expect(!!d.observe).toBe(c.observe);
      expect(!!d.runtime).toBe(c.runtime);
      expect(!!d.verify).toBe(c.verify);
      expect(!!d.discover).toBe(c.discover);
      for (const key of ["compile", "observe", "runtime", "verify", "discover"] as const) {
        if (c[key]) expect(c.evidence[key], `${d.id}.${key} needs an evidence entry`).toBeDefined();
      }
      expect(d.expectedAttributes).toBeTypeOf("function");
    }
  });

  it("marks the two experimental drivers and only those", () => {
    expect(COMPUTE_DRIVERS.filter((d) => "experimental" in d.capabilities.evidence).map((d) => d.nativeType).sort()).toEqual(["aws:ec2_instance", "aws:lambda_function"]);
  });
});

describe("hygiene", () => {
  const root = path.resolve(__dirname, "../../../../../src/lib/providers/aws/drivers/compute");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  const own = files(root).filter((f) => !f.includes(`${path.sep}aws-shared${path.sep}`));

  it("never reads process.env, imports the app layer, or builds shell commands from data", () => {
    for (const f of own) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/process\.env/);
      expect(text, f).not.toMatch(/from "@\/app/);
      expect(text, f).not.toMatch(/child_process|execSync|spawn\(/);
      expect(text, f).not.toMatch(/\beval\(|new Function\(/);
    }
  });

  it("no non-hook helper is named use*", () => {
    for (const f of own) expect(readFileSync(f, "utf8"), f).not.toMatch(/export (async )?(function|const) use[A-Z]/);
  });

  it("keeps every file under ~600 lines", () => {
    for (const f of own) expect(readFileSync(f, "utf8").split("\n").length, f).toBeLessThanOrEqual(600);
  });
});
