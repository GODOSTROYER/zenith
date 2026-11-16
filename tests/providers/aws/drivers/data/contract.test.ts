/**
 * Cross-driver contract checks for the AWS data group: registration keys match
 * the pinned native-type table, evidence is honest, declared capabilities are
 * real, expected attributes are a subset of what observe reports, and every
 * read honours the abort signal.
 */
import { describe, expect, it } from "vitest";
import { awsDataDrivers } from "@/lib/providers/aws/drivers/data";
import { LOG_GROUP_ATTRIBUTE_NAMES } from "@/lib/providers/aws/drivers/data/cloudwatch-log-group";
import { ELASTICACHE_ATTRIBUTE_NAMES } from "@/lib/providers/aws/drivers/data/elasticache-replication-group";
import { IAM_ATTRIBUTE_NAMES } from "@/lib/providers/aws/drivers/data/iam-role";
import { RDS_ATTRIBUTE_NAMES } from "@/lib/providers/aws/drivers/data/rds-instance";
import { S3_ATTRIBUTE_NAMES } from "@/lib/providers/aws/drivers/data/s3-bucket";
import { SECRET_ATTRIBUTE_NAMES } from "@/lib/providers/aws/drivers/data/secretsmanager-secret";
import { SQS_ATTRIBUTE_NAMES } from "@/lib/providers/aws/drivers/data/sqs-queue";
import { isCapability } from "@/lib/capabilities/catalog";
import { findDriver, getDriver, registerDriver, type ResourceDriver } from "@/lib/drivers/types";
import { kindsForNativeType, nativeTypeFor } from "@/lib/resources/native-types";
import { driverCtx, mkNode, networkNodes, standardNodes } from "./_helpers";

const EXPECTED_ATTRS: Record<string, readonly string[]> = {
  "aws:rds_instance": RDS_ATTRIBUTE_NAMES,
  "aws:elasticache_replication_group": ELASTICACHE_ATTRIBUTE_NAMES,
  "aws:s3_bucket": S3_ATTRIBUTE_NAMES,
  "aws:sqs_queue": SQS_ATTRIBUTE_NAMES,
  "aws:secretsmanager_secret": SECRET_ATTRIBUTE_NAMES,
  "aws:iam_role": IAM_ATTRIBUTE_NAMES,
  "aws:cloudwatch_log_group": LOG_GROUP_ATTRIBUTE_NAMES,
};

describe("the AWS data drivers", () => {
  it("are exactly the seven native types this group owns, each registered under the pinned table's string", () => {
    expect(awsDataDrivers.map((d) => d.nativeType).sort()).toEqual(Object.keys(EXPECTED_ATTRS).sort());
    for (const d of awsDataDrivers) {
      expect(d.provider).toBe("aws");
      expect(d.id).toBe(`aws.${d.nativeType.slice("aws:".length)}@1`);
      // the portable kind this driver declares realizes its native type in the shared table
      expect(kindsForNativeType("aws", d.nativeType)).toContain(d.kind);
      expect(nativeTypeFor("aws", d.kind as Parameters<typeof nativeTypeFor>[1])).toBe(d.nativeType);
    }
    // one driver serves both engines
    expect(kindsForNativeType("aws", "aws:rds_instance")).toEqual(["mysql", "postgres"]);
  });

  it("register idempotently in the driver registry", () => {
    for (const d of awsDataDrivers) {
      registerDriver(d as unknown as ResourceDriver);
      registerDriver(d as unknown as ResourceDriver);
      expect(getDriver("aws", d.nativeType)).toBe(d);
    }
    expect(findDriver("aws", "aws:ecs_service")?.nativeType).not.toBe("aws:rds_instance");
  });

  it("claim only contract evidence: nothing here has touched a real account", () => {
    for (const d of awsDataDrivers) {
      for (const [op, level] of Object.entries(d.capabilities.evidence)) expect(level, `${d.id} ${op}`).toBe("contract");
    }
  });

  it("declare exactly the operations they implement, with evidence for each, all in the capability catalog", () => {
    for (const d of awsDataDrivers) {
      const c = d.capabilities;
      expect(c.compile).toBe(typeof d.compile === "function");
      expect(c.observe).toBe(typeof d.observe === "function");
      expect(c.runtime).toBe(typeof d.runtime === "function");
      expect(c.verify).toBe(typeof d.verify === "function");
      expect(c.discover).toBe(typeof d.discover === "function");
      expect(typeof d.expectedAttributes).toBe("function");
      const claimed = [c.compile && "compile", c.observe && "observe", c.runtime && "runtime", c.verify && "verify", c.discover && "discover", ...c.operations].filter(Boolean).sort();
      const refusals = d.nativeType === "aws:rds_instance" ? ["database.delete", "database.restore"] : [];
      expect(Object.keys(c.evidence).sort(), d.id).toEqual([...claimed, ...refusals].sort());
      for (const op of c.operations) {
        expect(isCapability(op), op).toBe(true);
        expect(typeof d.operations?.[op], op).toBe("function");
      }
    }
  });

  it("report expectedAttributes that observe also reports, by name", () => {
    const graph = standardNodes();
    for (const d of awsDataDrivers) {
      const node = graph.find((n) => n.nativeType === d.nativeType)!;
      const expected = d.expectedAttributes!(node);
      expect(Object.keys(expected).length, d.id).toBeGreaterThan(0);
      for (const name of Object.keys(expected)) expect(EXPECTED_ATTRS[d.nativeType], `${d.id} ${name}`).toContain(name);
    }
  });

  it("compile to nothing for referenced and external nodes (never a resource block)", () => {
    for (const ownership of ["referenced", "external"] as const) {
      for (const n of standardNodes().filter((x) => awsDataDrivers.some((d) => d.nativeType === x.nativeType))) {
        const d = awsDataDrivers.find((x) => x.nativeType === n.nativeType)!;
        const node = { ...n, ownership };
        const all = [...networkNodes(), node];
        const f = d.compile!(node, { environmentId: "e", namePrefix: "zen-prod", region: "ap-south-1", tags: {}, ref: (a, x) => `\${local.${a}.${x}}`, node: (a) => all.find((m) => m.address === a) });
        expect(f, `${d.id} ${ownership}`).toEqual({ addresses: [] });
      }
    }
  });

  it("stop at once when the signal has already fired: no read, observe and runtime and discover throw AbortError", async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = driverCtx({ signal: ac.signal });
    for (const d of awsDataDrivers) {
      const node = standardNodes().find((n) => n.nativeType === d.nativeType)!;
      await expect(d.observe!(ctx, node, undefined), `${d.id} observe`).rejects.toMatchObject({ name: "AbortError" });
      if (d.runtime) await expect(d.runtime(ctx, node, undefined), `${d.id} runtime`).rejects.toMatchObject({ name: "AbortError" });
      await expect(d.discover!(ctx), `${d.id} discover`).rejects.toMatchObject({ name: "AbortError" });
    }
  });

  it("read nothing for a node with an externalId that is another service's identifier", async () => {
    const ctx = driverCtx();
    for (const d of awsDataDrivers) {
      const node = standardNodes().find((n) => n.nativeType === d.nativeType)!;
      const obs = await d.observe!(ctx, node, "arn:aws:ec2:ap-south-1:123456789012:instance/i-0123456789abcdef0");
      expect(obs.presence, d.id).toBe("unknown");
      expect(obs.simulated).toBe(false);
    }
  });

  it("never throw from expectedAttributes: a referenced node or an unreadable spec expects nothing, so drift stays computable", () => {
    for (const d of awsDataDrivers) {
      const base = standardNodes().find((n) => n.nativeType === d.nativeType)!;
      const referenced = { ...base, ownership: "referenced" as const };
      expect(d.expectedAttributes!(referenced), `${d.id} referenced`).toEqual({});
      const broken = { ...base, spec: {} };
      expect(() => d.expectedAttributes!(broken), `${d.id} empty spec`).not.toThrow();
      const garbage = { ...base, spec: { size: { nested: true }, grants: 7, retentionDays: "x", deletionPolicy: 1 } };
      expect(() => d.expectedAttributes!(garbage), `${d.id} garbage spec`).not.toThrow();
    }
  });

  it("verify does not report a referenced node unknown merely because Zenith has no desired state for it", async () => {
    const base = standardNodes().find((n) => n.nativeType === "aws:s3_bucket")!;
    const node = { ...base, ownership: "referenced" as const, externalRef: "arn:aws:s3:::legacy-bucket" };
    const at = "2026-09-30T12:00:00.000Z";
    const known = (value: unknown) => ({ state: "known" as const, value, observedAt: at });
    const driver = awsDataDrivers.find((d) => d.nativeType === "aws:s3_bucket")!;
    const r = await driver.verify!(driverCtx(), node, {
      address: node.address,
      presence: "present",
      attributes: { publicAccessAllowed: known(false), encryption: known("AES256"), objectOwnership: known("BucketOwnerEnforced"), denyInsecureTransport: known(true) },
      observedAt: at,
      source: driver.id,
      simulated: false,
    });
    expect(r.status).toBe("passed");
    expect(r.checks.map((c) => c.id)).not.toContain("configuration_matches");
  });

  it("build nodes with mkNode the way expansion names them (sanity of the fixtures themselves)", () => {
    const n = mkNode("postgres/db", "postgres", {});
    expect(n.nativeType).toBe("aws:rds_instance");
  });
});
