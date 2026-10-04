/**
 * Cost engine v2: the lines V1 never modeled (NAT, IPv4, load balancer,
 * egress, backups, cross-boundary transfer), arithmetic checked by hand against
 * catalog literals, and the failure modes (bad input, unknown region).
 */
import { describe, expect, it } from "vitest";
import {
  CostInputError,
  MissingPriceError,
  buildPriceBook,
  diffCost,
  estimateGraphCost,
  loadDefaultCatalog,
  round2,
} from "@/lib/placement";
import type { CostNode } from "@/lib/placement";
import { STACK_EDGES, node, stackNodes } from "./fixtures";

const catalog = loadDefaultCatalog();
const book = buildPriceBook(catalog);

function find(est: ReturnType<typeof estimateGraphCost>, sku: string, address?: string) {
  const hits = est.lines.filter((l) => l.sku === sku && (address === undefined || l.address === address));
  expect(hits.length, `line ${sku} ${address ?? ""}`).toBeGreaterThan(0);
  return hits;
}

describe("hand-computed fixture (aws us-east-1)", () => {
  // Literals below are transcribed from the catalog (verified against the AWS Price List on 2026-09-30).
  const P = {
    vcpu: 0.04048,
    gb: 0.004445,
    db: 0.032, // db.t4g.small
    dbStorage: 0.115,
    dbBackup: 0.095,
    s3: 0.023,
    get: 0.4,
    put: 5,
    alb: 0.0225,
    lcu: 0.008,
    nat: 0.045,
    natGb: 0.045,
    ipv4: 0.005,
    egress: 0.09,
    logs: 0.5,
  };
  const nodes = stackNodes("aws", "us-east-1", {
    web: { size: "small", replicas: 2 },
    db: { size: "small", ha: true, storageGb: 20 },
    network: { natGateways: "single", azCount: 2 },
  });
  const est = estimateGraphCost({ nodes, edges: STACK_EDGES }, { catalog });

  it("catalog literals match what the test assumes", () => {
    expect(book.price("aws", "us-east-1", "aws.fargate.vcpu_hour")).toBe(P.vcpu);
    expect(book.price("aws", "us-east-1", "aws.fargate.gb_hour")).toBe(P.gb);
    expect(book.price("aws", "us-east-1", "aws.rds_postgres.small_hour")).toBe(P.db);
    expect(book.price("aws", "us-east-1", "aws.rds_postgres.storage_gb_month")).toBe(P.dbStorage);
    expect(book.price("aws", "us-east-1", "aws.rds_postgres.backup_gb_month")).toBe(P.dbBackup);
    expect(book.price("aws", "us-east-1", "aws.s3.storage_gb_month")).toBe(P.s3);
    expect(book.price("aws", "us-east-1", "aws.alb.hour")).toBe(P.alb);
    expect(book.price("aws", "us-east-1", "aws.alb.lcu_hour")).toBe(P.lcu);
    expect(book.price("aws", "us-east-1", "aws.nat_gateway.hour")).toBe(P.nat);
    expect(book.price("aws", "us-east-1", "aws.nat_gateway.gb")).toBe(P.natGb);
    expect(book.price("aws", "us-east-1", "aws.data_transfer.internet_gb")).toBe(P.egress);
    expect(book.price("aws", "us-east-1", "aws.cloudwatch.logs_ingest_gb")).toBe(P.logs);
  });

  it("prices each line with the documented arithmetic", () => {
    // 2 replicas x 0.5 vCPU x 730 h; memory raised to 1 GB per replica (2 GB per vCPU minimum)
    expect(find(est, "aws.fargate.vcpu_hour")[0]!.monthlyUsd).toBe(round2(730 * 2 * 0.5 * P.vcpu)); // 29.55
    expect(find(est, "aws.fargate.gb_hour")[0]!.monthlyUsd).toBe(round2(730 * 2 * 1 * P.gb)); // 6.49
    // HA doubles instance hours and storage
    expect(find(est, "aws.rds_postgres.small_hour")[0]!.monthlyUsd).toBe(round2(730 * 2 * P.db)); // 46.72
    expect(find(est, "aws.rds_postgres.storage_gb_month")[0]!.monthlyUsd).toBe(round2(20 * 2 * P.dbStorage)); // 4.60
    // 20 GB x (1 + 5%/day x 7 days)
    expect(find(est, "aws.rds_postgres.backup_gb_month")[0]!.monthlyUsd).toBe(round2(20 * 1.35 * P.dbBackup)); // 2.57
    expect(find(est, "aws.alb.hour")[0]!.monthlyUsd).toBe(round2(730 * P.alb)); // 16.43
    expect(find(est, "aws.alb.lcu_hour")[0]!.monthlyUsd).toBe(round2(730 * 1 * P.lcu)); // 5.84
    expect(find(est, "aws.nat_gateway.hour")[0]!.monthlyUsd).toBe(round2(730 * P.nat)); // 32.85
    expect(find(est, "aws.nat_gateway.gb")[0]!.monthlyUsd).toBe(round2(50 * P.natGb)); // 2.25
    // 1 ALB x 2 AZ + 1 NAT gateway = 3 addresses
    expect(find(est, "aws.ipv4.hour")[0]!.monthlyUsd).toBe(round2(730 * 3 * P.ipv4)); // 10.95
    expect(find(est, "aws.data_transfer.internet_gb")[0]!.monthlyUsd).toBe(round2(50 * P.egress)); // 4.50
    expect(find(est, "aws.cloudwatch.logs_ingest_gb")[0]!.monthlyUsd).toBe(round2(5 * P.logs)); // 2.50
    expect(find(est, "aws.s3.storage_gb_month")[0]!.monthlyUsd).toBe(round2(10 * P.s3)); // 0.23
    expect(find(est, "aws.s3.get_million")[0]!.monthlyUsd).toBe(round2(0.9 * P.get)); // 0.36
    expect(find(est, "aws.s3.put_million")[0]!.monthlyUsd).toBe(round2(0.1 * P.put)); // 0.50
  });

  it("totals to the hand-computed 166.33 (rounded once, at the end)", () => {
    const raw =
      730 * 2 * 0.5 * P.vcpu +
      730 * 2 * 1 * P.gb +
      730 * 2 * P.db +
      20 * 2 * P.dbStorage +
      20 * 1.35 * P.dbBackup +
      10 * P.s3 +
      0.9 * P.get +
      0.1 * P.put +
      730 * P.alb +
      730 * P.lcu +
      730 * P.nat +
      50 * P.natGb +
      730 * 3 * P.ipv4 +
      50 * P.egress +
      5 * P.logs * 1;
    expect(raw).toBeCloseTo(166.3301, 3);
    expect(est.monthlyUsd).toBe(166.33);
    expect(est.monthlyUsd).toBe(round2(raw));
    // rounded lines differ from the total by at most a cent each
    const sum = est.lines.reduce((s, l) => s + l.monthlyUsd, 0);
    expect(Math.abs(sum - est.monthlyUsd)).toBeLessThanOrEqual(0.01 * est.lines.length);
  });

  it("carries a basis, a unit price from the catalog and a verification on every line", () => {
    for (const l of est.lines) {
      expect(l.basis.length).toBeGreaterThan(5);
      expect(l.unitUsd).toBe(book.price("aws", "us-east-1", l.sku));
      expect(l.priceVerification).toBeDefined();
      expect(l.quantity).toBeGreaterThan(0);
    }
    expect(est.kind).toBe("estimate");
    expect(est.currency).toBe("USD");
    expect(est.catalogVersion).toBe("2026-10-05.2");
    expect(est.assumptions.priceEvidenceWeakUsd).toBe(0); // every AWS number here was read from the price feed
  });

  it("includes NAT, IPv4, load balancer, egress and backups, and lists what is excluded", () => {
    const skus = est.lines.map((l) => l.sku);
    for (const s of ["aws.nat_gateway.hour", "aws.nat_gateway.gb", "aws.ipv4.hour", "aws.alb.hour", "aws.alb.lcu_hour", "aws.data_transfer.internet_gb", "aws.rds_postgres.backup_gb_month", "aws.cloudwatch.logs_ingest_gb"]) {
      expect(skus).toContain(s);
    }
    expect(est.included.join(" ")).toMatch(/NAT gateway/);
    expect(est.included.join(" ")).toMatch(/Public IPv4/);
    expect(est.included.join(" ")).toMatch(/Load balancer/);
    expect(est.included.join(" ")).toMatch(/egress/);
    expect(est.included.join(" ")).toMatch(/Backup/);
    expect(est.excluded.length).toBeGreaterThan(5);
    expect(est.excluded.join(" ")).toMatch(/not an invoice/);
    expect(est.excluded.join(" ")).toMatch(/free tiers/i);
    expect(est.excluded.join(" ")).toMatch(/Taxes/);
  });

  it("states every usage assumption the number depends on", () => {
    for (const k of ["egressGb", "requestsMillions", "logGbPerService", "dbStorageGb", "backupRetentionDays", "hoursPerMonth", "interComponentFraction"]) {
      expect(est.assumptions[k], k).toBeDefined();
    }
    expect(est.assumptions.egressGb).toBe(50);
    expect(est.assumptions.hoursPerMonth).toBe(730);
  });
});

describe("NAT and public IPv4 rules", () => {
  it("bills one NAT gateway per AZ in per_az mode and none in none mode", () => {
    const perAz = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1", { network: { natGateways: "per_az", azCount: 3 } }) }, { catalog });
    expect(find(perAz, "aws.nat_gateway.hour")[0]!.quantity).toBe(730 * 3);
    const none = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1", { network: { natGateways: "none" } }) }, { catalog });
    expect(none.lines.some((l) => l.sku === "aws.nat_gateway.hour")).toBe(false);
    expect(none.lines.some((l) => l.sku === "aws.nat_gateway.gb")).toBe(false);
  });

  it("charges one address per AZ for an AWS load balancer but one elsewhere", () => {
    const aws = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1", { network: { azCount: 3, natGateways: "none" } }) }, { catalog });
    expect(find(aws, "aws.ipv4.hour")[0]!.quantity).toBe(730 * 3);
    const gcp = estimateGraphCost({ nodes: stackNodes("gcp", "us-central1", { network: { azCount: 3, natGateways: "none" } }) }, { catalog });
    expect(find(gcp, "gcp.ipv4.hour")[0]!.quantity).toBe(730 * 1);
  });

  it("needs no NAT for public workloads but bills an address per public replica", () => {
    const est = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1", { web: { replicas: 3, publicIp: true }, network: { azCount: 2 } }) }, { catalog });
    expect(est.lines.some((l) => l.sku === "aws.nat_gateway.hour")).toBe(false);
    expect(find(est, "aws.ipv4.hour")[0]!.quantity).toBe(730 * (2 + 3));
  });

  it("prices a graph with no network node as one implicit private network and says so", () => {
    const est = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1").filter((n) => n.kind !== "network") }, { catalog });
    expect(find(est, "aws.nat_gateway.hour")[0]!.quantity).toBe(730);
    expect(est.assumptions.azCountDefault).toBe(2);
    expect(est.assumptions.natGatewaysDefault).toBe("single");
  });

  it("gives OCI and the zenith tier zero-priced NAT lines rather than pretending they do not exist", () => {
    const oci = estimateGraphCost({ nodes: stackNodes("oci", "us-ashburn-1") }, { catalog });
    expect(find(oci, "oci.nat_gateway.hour")[0]!.monthlyUsd).toBe(0);
    expect(oci.monthlyUsd).toBeGreaterThan(0);
  });
});

describe("kinds, ownership and sizes", () => {
  it("bills nothing for referenced and external nodes, and says how many were skipped", () => {
    const nodes: CostNode[] = [
      node("resource/db", "postgres", "aws", "us-east-1", { size: "standard" }, "referenced"),
      node("resource/api", "postgres", "aws", "us-east-1", { size: "standard" }, "external"),
    ];
    const est = estimateGraphCost({ nodes }, { catalog });
    expect(est.monthlyUsd).toBe(0);
    expect(est.lines).toEqual([]);
    expect(est.excluded.join(" ")).toMatch(/2 referenced or external/);
  });

  it("bills zero replicas as zero", () => {
    const est = estimateGraphCost({ nodes: [node("service/web", "container_service", "aws", "us-east-1", { replicas: 0 })] }, { catalog });
    expect(est.lines.filter((l) => l.sku.startsWith("aws.fargate"))).toEqual([]);
  });

  it("applies the provider memory minimum and OCI's whole-OCPU rule to container shapes", () => {
    const aws = estimateGraphCost({ nodes: [node("service/w", "container_service", "aws", "us-east-1", { size: "nano" })] }, { catalog });
    expect(find(aws, "aws.fargate.vcpu_hour")[0]!.quantity).toBe(730 * 0.25);
    expect(find(aws, "aws.fargate.gb_hour")[0]!.quantity).toBe(730 * 0.5); // 0.25 GB raised to 0.5 GB
    const oci = estimateGraphCost({ nodes: [node("service/w", "container_service", "oci", "us-ashburn-1", { size: "nano" })] }, { catalog });
    expect(find(oci, "oci.container_instances.vcpu_hour")[0]!.quantity).toBe(730 * 2); // one whole OCPU
    expect(find(oci, "oci.container_instances.vcpu_hour")[0]!.basis).toMatch(/OCI bills whole OCPUs/);
  });

  it("prices scheduled jobs at the legacy 15% duty cycle", () => {
    const svc = estimateGraphCost({ nodes: [node("service/w", "container_service", "aws", "us-east-1", { size: "small" })] }, { catalog });
    const job = estimateGraphCost({ nodes: [node("job/w", "scheduled_job", "aws", "us-east-1", { size: "small" })] }, { catalog });
    const vs = find(svc, "aws.fargate.vcpu_hour")[0]!.quantity;
    const vj = find(job, "aws.fargate.vcpu_hour")[0]!.quantity;
    expect(vj).toBeCloseTo(vs * 0.15, 6);
  });

  it("prices VMs by class with block storage, and optional IOPS and snapshots", () => {
    const est = estimateGraphCost({ nodes: [node("vm/a", "compute_instance", "aws", "us-east-1", { size: "performance", count: 2, volumeGb: 100, iops: 4000, backupRetentionDays: 7 })] }, { catalog });
    expect(find(est, "aws.ec2.large_hour")[0]!.quantity).toBe(730 * 2);
    expect(find(est, "aws.ebs.gp3_gb_month")[0]!.quantity).toBe(200);
    expect(find(est, "aws.ebs.gp3_iops_month")[0]!.quantity).toBe(8000);
    expect(find(est, "aws.ebs.snapshot_gb_month")[0]!.quantity).toBeCloseTo(200 * 1.35, 6);
  });

  it("prices Redis nodes, queues, DNS zones, volumes and certificates", () => {
    const est = estimateGraphCost(
      {
        nodes: [
          node("cache/c", "redis", "aws", "us-east-1", { size: "standard", ha: true }),
          node("queue/q", "queue", "aws", "us-east-1", { requestsMillions: 3 }),
          node("dns/z", "dns_zone", "aws", "us-east-1", { queriesMillions: 2 }),
          node("vol/v", "volume", "aws", "us-east-1", { sizeGb: 50, iops: 1000 }),
          node("cert/c", "tls_certificate", "aws", "us-east-1"),
        ],
      },
      { catalog },
    );
    expect(find(est, "aws.elasticache_redis.standard_hour")[0]!.quantity).toBe(730 * 2);
    expect(find(est, "aws.sqs.requests_million")[0]!.monthlyUsd).toBe(round2(3 * 0.4));
    expect(find(est, "aws.route53.zone_month")[0]!.monthlyUsd).toBe(0.5);
    expect(find(est, "aws.route53.queries_million")[0]!.quantity).toBe(2);
    expect(find(est, "aws.ebs.gp3_gb_month")[0]!.quantity).toBe(50);
    expect(find(est, "aws.acm.public_cert_month")[0]!.monthlyUsd).toBe(0);
  });

  it("prices MySQL with the PostgreSQL SKUs and says so", () => {
    const est = estimateGraphCost({ nodes: [node("db/m", "mysql", "aws", "us-east-1", { size: "small" })] }, { catalog });
    expect(est.lines.some((l) => l.sku === "aws.rds_postgres.small_hour")).toBe(true);
    expect(est.excluded.join(" ")).toMatch(/MySQL is priced with the provider's PostgreSQL SKUs/);
  });

  it("names unpriced kinds and unknown providers instead of pricing them at zero silently", () => {
    for (const unknown of [
      node("fn/f", "function", "aws", "us-east-1"),
      node("k/c", "kubernetes_cluster", "aws", "us-east-1"),
      node("svc/s", "container_service", "sandbox", "local"),
    ]) {
      expect(() => estimateGraphCost({ nodes: [unknown] }, { catalog })).toThrow(MissingPriceError);
      expect(() => estimateGraphCost({ nodes: [unknown] }, { catalog })).toThrow(unknown.provider === "sandbox" ? /managed provider not in catalog/ : new RegExp(`managed ${unknown.kind}`));
    }
  });

  it.each(["function", "static_site", "container_registry", "secret", "kubernetes_cluster", "kubernetes_namespace", "build_pipeline", "provider_native"] as const)("refuses a priced subtotal when managed %s has no model", (kind) => {
    const priced = node("service/web", "container_service", "aws", "us-east-1");
    expect(estimateGraphCost({ nodes: [priced] }, { catalog }).monthlyUsd).toBeGreaterThan(0);
    const unknown = node("unknown/main", kind, "aws", "us-east-1");
    expect(() => estimateGraphCost({ nodes: [priced, unknown] }, { catalog })).toThrow(MissingPriceError);
  });

  it("keeps genuinely no-charge native infrastructure and externally owned unknown nodes distinct", () => {
    const free = estimateGraphCost({ nodes: [node("network/main", "network", "aws", "us-east-1")] }, { catalog });
    expect(free.monthlyUsd).toBe(0);
    expect(free.lines).toEqual([]);
    for (const ownership of ["referenced", "external"] as const) {
      const outside = estimateGraphCost({ nodes: [node("unknown/main", "function", "sandbox", "local", {}, ownership)] }, { catalog });
      expect(outside.monthlyUsd).toBe(0);
      expect(outside.excluded.join(" ")).toContain("not Zenith's bill");
    }
  });

  it("flags Azure container pricing as an active-rate upper bound", () => {
    const est = estimateGraphCost({ nodes: [node("svc/s", "container_service", "azure", "eastus", { size: "small" })] }, { catalog });
    expect(String(est.assumptions.azureContainerBilling)).toMatch(/upper bound/);
  });
});

describe("weak price evidence is surfaced", () => {
  it("counts remembered, derived and internal prices in the assumptions", () => {
    const gcp = estimateGraphCost({ nodes: stackNodes("gcp", "asia-south1") }, { catalog });
    expect(Number(gcp.assumptions.priceEvidenceWeakUsd)).toBeGreaterThan(0);
    expect(gcp.lines.some((l) => l.priceVerification === "derived")).toBe(true);
    const zen = estimateGraphCost({ nodes: [node("svc/s", "container_service", "zenith", "us-east")] }, { catalog });
    expect(zen.lines.every((l) => l.priceVerification === "internal_assumption")).toBe(true);
    expect(Number(zen.assumptions.priceEvidenceWeakUsd)).toBeGreaterThan(0);
  });
});

describe("cross-boundary transfer", () => {
  const app = node("service/web", "container_service", "aws", "us-east-1", { size: "small" });

  it("bills inter-region transfer on the sender when the same provider spans regions", () => {
    const db = node("resource/db", "postgres", "aws", "eu-west-1", { size: "small" });
    const est = estimateGraphCost({ nodes: [app, db], edges: [{ from: "service/web", to: "resource/db", relation: "connects_to" }] }, { catalog });
    const line = est.lines.find((l) => l.description.startsWith("Cross-region transfer"))!;
    expect(line.sku).toBe("aws.data_transfer.inter_region_gb");
    expect(line.address).toBe("resource/db"); // the callee sends the responses
    expect(line.quantity).toBe(10); // 20% of 50 GB
    expect(line.monthlyUsd).toBe(round2(10 * book.price("aws", "eu-west-1", "aws.data_transfer.inter_region_gb")));
  });

  it("bills cross-cloud transfer at the sender's internet egress price", () => {
    const db = node("resource/db", "postgres", "azure", "eastus", { size: "small" });
    const est = estimateGraphCost({ nodes: [app, db], edges: [{ from: "service/web", to: "resource/db", relation: "connects_to" }] }, { catalog });
    const line = est.lines.find((l) => l.description.startsWith("Cross-cloud transfer"))!;
    expect(line.sku).toBe("azure.bandwidth.internet_gb");
    expect(line.monthlyUsd).toBe(round2(10 * book.price("azure", "eastus", "azure.bandwidth.internet_gb")));
    expect(est.included.join(" ")).toMatch(/Cross-region and cross-cloud transfer/);
  });

  it("bills the caller for publishes and ignores edges inside one site or non-traffic relations", () => {
    const q = node("queue/q", "queue", "gcp", "us-central1");
    const est = estimateGraphCost({ nodes: [app, q], edges: [{ from: "service/web", to: "queue/q", relation: "publishes_to" }] }, { catalog });
    const line = est.lines.find((l) => l.description.startsWith("Cross-cloud transfer"))!;
    expect(line.address).toBe("service/web");
    const same = estimateGraphCost({ nodes: [app, node("resource/db", "postgres", "aws", "us-east-1")], edges: [{ from: "service/web", to: "resource/db", relation: "connects_to" }] }, { catalog });
    expect(same.lines.some((l) => l.description.startsWith("Cross-"))).toBe(false);
    const secure = estimateGraphCost({ nodes: [app, node("resource/db", "postgres", "gcp", "us-central1")], edges: [{ from: "service/web", to: "resource/db", relation: "depends_on" }] }, { catalog });
    expect(secure.lines.some((l) => l.description.startsWith("Cross-"))).toBe(false);
  });

  it("scales with the usage assumptions", () => {
    const db = node("resource/db", "postgres", "azure", "eastus", { size: "small" });
    const edges = [{ from: "service/web", to: "resource/db", relation: "connects_to" }];
    const a = estimateGraphCost({ nodes: [app, db], edges }, { catalog, usage: { egressGb: 200, interComponentFraction: 0.5 } });
    expect(a.lines.find((l) => l.description.startsWith("Cross-cloud transfer"))!.quantity).toBe(100);
  });
});

describe("determinism, rounding and errors", () => {
  it("is independent of node order and repeatable", () => {
    const nodes = stackNodes("aws", "ap-south-1", { web: { replicas: 2 } });
    const a = estimateGraphCost({ nodes, edges: STACK_EDGES }, { catalog });
    const b = estimateGraphCost({ nodes: [...nodes].reverse(), edges: [...STACK_EDGES].reverse() }, { catalog });
    expect(b).toEqual(a);
    expect(estimateGraphCost({ nodes, edges: STACK_EDGES }, { catalog })).toEqual(a);
  });

  it("stamps computedAt from the catalog snapshot, or from options.now, never the wall clock", () => {
    const nodes = stackNodes("aws", "us-east-1");
    expect(estimateGraphCost({ nodes }, { catalog }).computedAt).toBe("2026-10-05T00:00:00.000Z");
    expect(estimateGraphCost({ nodes }, { catalog, now: "2027-01-02T03:04:05.000Z" }).computedAt).toBe("2027-01-02T03:04:05.000Z");
  });

  it("rounds half away from zero to two decimals and tolerates float noise", () => {
    expect(round2(31.025)).toBe(31.03);
    expect(round2(0.005)).toBe(0.01);
    expect(round2(0.004)).toBe(0);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0)).toBe(0);
  });

  it("rejects malformed input rather than guessing", () => {
    const bad = (spec: Record<string, unknown>, kind: CostNode["kind"] = "container_service") => () =>
      estimateGraphCost({ nodes: [node("x/y", kind, "aws", "us-east-1", spec)] }, { catalog });
    expect(bad({ size: "gigantic" })).toThrow(CostInputError);
    expect(bad({ replicas: -1 })).toThrow(CostInputError);
    expect(bad({ replicas: 1.5 })).toThrow(CostInputError);
    expect(bad({ replicas: "2" })).toThrow(CostInputError);
    expect(bad({ storageGb: -5 }, "postgres")).toThrow(CostInputError);
    expect(bad({ ha: "yes" }, "postgres")).toThrow(CostInputError);
    expect(bad({ natGateways: "many" }, "network")).not.toThrow(); // only read when there is private compute
    expect(() => estimateGraphCost({ nodes: [node("a", "network", "aws", "us-east-1", { natGateways: "many" }), node("b", "container_service", "aws", "us-east-1")] }, { catalog })).toThrow(CostInputError);
    expect(() => estimateGraphCost({ nodes: [node("a", "network", "aws", "us-east-1"), node("a", "network", "aws", "us-east-1")] }, { catalog })).toThrow(/Duplicate node address/);
    expect(() => estimateGraphCost({ nodes: [] }, { catalog, usage: { egressGb: -1 } })).toThrow(CostInputError);
    expect(() => estimateGraphCost({ nodes: [] }, { catalog, usage: { egressGb: Number.NaN } })).toThrow(CostInputError);
    expect(() => estimateGraphCost({ nodes: [] }, { catalog, usage: { interComponentFraction: 2 } })).toThrow(CostInputError);
    expect(() => estimateGraphCost({ nodes: [] }, { catalog, backupRetentionDays: -1 })).toThrow(CostInputError);
  });

  it("throws MissingPriceError for a region the catalog does not know, never a zero", () => {
    expect(() => estimateGraphCost({ nodes: [node("service/w", "container_service", "aws", "mars-1")] }, { catalog })).toThrow(MissingPriceError);
  });

  it("does not mutate its input", () => {
    const nodes = stackNodes("aws", "us-east-1");
    const snapshot = JSON.stringify(nodes);
    estimateGraphCost({ nodes, edges: STACK_EDGES }, { catalog });
    expect(JSON.stringify(nodes)).toBe(snapshot);
  });

  it("accepts a prebuilt price book as well as a catalog", () => {
    const nodes = stackNodes("aws", "us-east-1");
    expect(estimateGraphCost({ nodes }, { catalog: book })).toEqual(estimateGraphCost({ nodes }, { catalog }));
  });
});

describe("diffCost", () => {
  it("reports the delta lines between two estimates", () => {
    const before = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1", { web: { replicas: 1 } }), edges: STACK_EDGES }, { catalog });
    const after = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1", { web: { replicas: 3 }, db: { ha: true } }), edges: STACK_EDGES }, { catalog });
    const d = diffCost(before, after);
    expect(d.deltaMonthlyUsd).toBe(round2(after.monthlyUsd - before.monthlyUsd));
    expect(d.deltaMonthlyUsd).toBeGreaterThan(0);
    expect(d.catalogChanged).toBe(false);
    const cpu = d.lines.find((l) => l.sku === "aws.fargate.vcpu_hour")!;
    expect(cpu.change).toBe("changed");
    expect(cpu.deltaUsd).toBe(round2(after.lines.find((l) => l.sku === "aws.fargate.vcpu_hour")!.monthlyUsd - before.lines.find((l) => l.sku === "aws.fargate.vcpu_hour")!.monthlyUsd));
    // unchanged lines are not listed
    expect(d.lines.some((l) => l.sku === "aws.nat_gateway.hour")).toBe(false);
  });

  it("reports added and removed lines and a catalog version change", () => {
    const withNat = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1") }, { catalog });
    const noNat = estimateGraphCost({ nodes: stackNodes("aws", "us-east-1", { network: { natGateways: "none" } }) }, { catalog });
    const d = diffCost(withNat, noNat);
    expect(d.lines.filter((l) => l.change === "removed").map((l) => l.sku)).toContain("aws.nat_gateway.hour");
    expect(d.deltaMonthlyUsd).toBeLessThan(0);
    const other = { ...noNat, catalogVersion: "2026-10-01.1" };
    expect(diffCost(withNat, other).catalogChanged).toBe(true);
    expect(diffCost(withNat, withNat).lines).toEqual([]);
    expect(diffCost(withNat, withNat).deltaMonthlyUsd).toBe(0);
  });
});

// Exact current native profiles; these do not price an arbitrary secret or build.
describe("supported native auxiliary costs", () => {
  const secret = (provider = "aws", region = "us-east-1", extra: Record<string, unknown> = {}) => node("secret/env", "secret", provider, region, { store: "zenith_vault", purpose: "environment", secretRef: "vault:environment", ...extra });
  const registry = (extra: Record<string, unknown> = {}) => node("container_registry/web", "container_registry", "aws", "us-east-1", { scanOnPush: true, immutableTags: false, ...extra });
  const build = (extra: Record<string, unknown> = {}) => node("build_pipeline/web", "build_pipeline", "aws", "us-east-1", { location: "customer_account", source: { repo: ".", ref: "main", dockerfile: "Dockerfile" }, output: { registry: "container_registry/web" }, ...extra });

  it("charges native AWS secret storage and positive assumed API usage separately", () => {
    const estimate = estimateGraphCost({ nodes: [secret()] }, { catalog });
    expect(estimate.monthlyUsd).toBe(0.45);
    expect(find(estimate, "aws.secretsmanager.secret_month")[0]?.quantity).toBe(1);
    expect(find(estimate, "aws.secretsmanager.requests_million")[0]?.quantity).toBe(0.01);
    expect(estimate.assumptions.secretRequestsMillionsDefault).toBe(0.01);
    expect(estimate.lines.every((line) => line.priceVerification === "official_api")).toBe(true);
    expect(estimate.included.join(" ")).toContain("Supported native secret");
    expect(estimate.included).not.toContain("Object storage, queue and DNS request charges");
    expect(estimate.excluded.join(" ")).toContain("Custom secret key management");
    expect(estimate.kind).toBe("estimate");
  });

  it("charges GCP retained enabled or disabled versions and notifications without free allowances", () => {
    const estimate = estimateGraphCost({ nodes: [secret("gcp", "us-central1", { activeVersions: 2, requestsMillions: 0.1, rotationNotifications: 2 })] }, { catalog });
    expect(estimate.monthlyUsd).toBe(0.52);
    expect(find(estimate, "gcp.secret_manager.active_version_month")[0]?.quantity).toBe(2);
    expect(find(estimate, "gcp.secret_manager.rotation_notification")[0]?.quantity).toBe(2);
    expect(estimate.lines.every((line) => line.priceVerification === "official_page")).toBe(true);
    expect(find(estimate, "gcp.secret_manager.active_version_month")[0]?.basis).toContain("1 native replica location");
  });

  it("prices Azure Standard secret operations with a positive assumed request count", () => {
    const estimate = estimateGraphCost({ nodes: [secret("azure", "eastus")] }, { catalog });
    expect(estimate.monthlyUsd).toBe(0.03);
    expect(find(estimate, "azure.key_vault.secret_requests_million")[0]?.quantity).toBe(0.01);
    expect(estimate.assumptions.secretRequestsMillionsDefault).toBe(0.01);
    expect(estimate.lines).toHaveLength(1);
  });

  it("does not erase storage or a missing meter when API use is explicitly zero", () => {
    const s = secret("aws", "us-east-1", { requestsMillions: 0 });
    expect(estimateGraphCost({ nodes: [s] }, { catalog }).monthlyUsd).toBe(0.4);
    const missing = { ...catalog, entries: catalog.entries.filter((entry) => entry.sku !== "aws.secretsmanager.requests_million") };
    expect(() => estimateGraphCost({ nodes: [s] }, { catalog: missing })).toThrow(MissingPriceError);
  });

  it.each([null, -1, NaN, Infinity, "unknown"])("refuses invalid or unavailable secret operation quantity %s", (requestsMillions) => {
    expect(() => estimateGraphCost({ nodes: [secret("aws", "us-east-1", { requestsMillions })] }, { catalog })).toThrow(CostInputError);
  });

  it.each([
    { store: "provider_secret_manager" }, { store: "unknown" }, { purpose: "other" }, { secretRef: "provider:unknown" },
    { kmsKey: "custom" }, { rotation: true }, { privateEndpoint: true },
  ])("refuses unsupported secret billing effects %j without approving a priced subtotal", (extra) => {
    expect(() => estimateGraphCost({ nodes: [node("service/web", "container_service", "aws", "us-east-1"), secret("aws", "us-east-1", extra)] }, { catalog })).toThrow(MissingPriceError);
  });

  it("refuses unknown OCI key provenance and an unpriced managed-tier secret", () => {
    expect(() => estimateGraphCost({ nodes: [secret("oci", "us-ashburn-1")] }, { catalog })).toThrow(MissingPriceError);
    expect(() => estimateGraphCost({ nodes: [secret("zenith", "us-east")] }, { catalog })).toThrow(MissingPriceError);
  });

  it("keeps externally owned secret billing unknown to Zenith while native no-charge infrastructure stays zero", () => {
    for (const ownership of ["referenced", "external"] as const) {
      const estimate = estimateGraphCost({ nodes: [{ ...secret("oci", "us-ashburn-1"), ownership }] }, { catalog });
      expect(estimate.monthlyUsd).toBe(0); expect(estimate.lines).toEqual([]);
      expect(estimate.excluded.join(" ")).toContain("not Zenith's bill");
    }
    expect(estimateGraphCost({ nodes: [node("network/main", "network", "aws", "us-east-1")] }, { catalog }).monthlyUsd).toBe(0);
  });

  it("prices retained private images and charged pulls independently of free same-region pulls", () => {
    const estimate = estimateGraphCost({ nodes: [registry({ storageGb: 2, internetPullGb: 3 })] }, { catalog });
    expect(estimate.monthlyUsd).toBe(0.47);
    expect(find(estimate, "aws.ecr.storage_gb_month")[0]?.quantity).toBe(2);
    expect(find(estimate, "aws.data_transfer.internet_gb")[0]?.quantity).toBe(3);
    const local = estimateGraphCost({ nodes: [registry({ storageGb: 2, internetPullGb: 0 })] }, { catalog });
    expect(local.monthlyUsd).toBe(0.2); expect(local.lines).toHaveLength(1);
    const missing = { ...catalog, entries: catalog.entries.filter((entry) => entry.sku !== "aws.data_transfer.internet_gb") };
    expect(() => estimateGraphCost({ nodes: [registry({ internetPullGb: 0 })] }, { catalog: missing })).toThrow(MissingPriceError);
  });

  it("prices rounded native build minutes and its source, request, log and transfer auxiliaries", () => {
    const estimate = estimateGraphCost({ nodes: [build({ buildsPerMonth: 2, minutesPerBuild: 1.2 }), registry()] }, { catalog });
    expect(find(estimate, "aws.codebuild.medium_hour")[0]?.quantity).toBe(0.066667);
    expect(find(estimate, "aws.codebuild.medium_hour")[0]?.monthlyUsd).toBe(0.04);
    for (const sku of ["aws.s3.storage_gb_month", "aws.s3.get_million", "aws.s3.put_million", "aws.cloudwatch.logs_ingest_gb", "aws.cloudwatch.logs_storage_gb_month"]) expect(find(estimate, sku)[0]?.quantity).toBeGreaterThan(0);
    expect(estimate.lines.some((line) => line.description === "Build internet egress" && line.quantity > 0)).toBe(true);
    expect(estimate.assumptions.buildDriverProfile).toContain("BUILD_GENERAL1_MEDIUM");
    expect(estimate.assumptions.buildSourceRequestsDefault).toContain("multipart");
  });

  it("refuses missing build auxiliaries even when their explicit usage is zero", () => {
    const missing = { ...catalog, entries: catalog.entries.filter((entry) => entry.sku !== "aws.cloudwatch.logs_storage_gb_month") };
    expect(() => estimateGraphCost({ nodes: [build({ logStorageGb: 0 }), registry()] }, { catalog: missing })).toThrow(MissingPriceError);
  });

  it.each([{ location: "zenith_account" }, { output: { staticSite: "site/web" } }, { source: { repo: ".", ref: "main", cache: true } }, { kmsKey: "custom" }, { vpc: true }])("refuses unsupported build billing profile %j", (extra) => {
    expect(() => estimateGraphCost({ nodes: [build(extra), registry()] }, { catalog })).toThrow(MissingPriceError);
  });

  it("refuses unavailable build and image quantities and enhanced registry scanning", () => {
    expect(() => estimateGraphCost({ nodes: [build({ sourceStorageGb: null }), registry()] }, { catalog })).toThrow(CostInputError);
    expect(() => estimateGraphCost({ nodes: [registry({ storageGb: null })] }, { catalog })).toThrow(CostInputError);
    expect(() => estimateGraphCost({ nodes: [registry({ enhancedScanning: true })] }, { catalog })).toThrow(MissingPriceError);
  });
});
