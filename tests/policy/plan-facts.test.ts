/**
 * Plan-fact extraction from realistic normalized OpenTofu plans.
 */
import { describe, expect, it } from "vitest";
import { materializeAfter, MASKED_VALUE, parseAttributePath, UNKNOWN_VALUE } from "@/lib/policy/plan-attributes";
import { extractPlanFacts, loadPolicyEngine } from "@/lib/policy";
import type { NormalizedPlan, PlanAttributeChange, PlanResourceChange } from "@/lib/tofu/types";
import { loadPlanFixture } from "./plan-fixtures";
import { policyInput } from "./support";

const change = (path: string, after: unknown, sensitive = false): PlanAttributeChange => ({
  path,
  before: null,
  after,
  sensitive,
  forcesReplacement: false,
});

function planWith(...resourceChanges: PlanResourceChange[]): NormalizedPlan {
  return { ...loadPlanFixture("no-changes"), resourceChanges, empty: false };
}

function resource(type: string, action: PlanResourceChange["action"], changes: PlanAttributeChange[], address = `${type}.x`, destroysData = false): PlanResourceChange {
  return { address, type, providerName: "registry.opentofu.org/hashicorp/aws", action, changes, destroysData };
}

describe("extractPlanFacts: a benign web stack", () => {
  const facts = extractPlanFacts(loadPlanFixture("web-stack-create"));

  it("counts changes from the resource changes", () => {
    expect(facts).toMatchObject({ create: 10, update: 0, delete: 0, replace: 0 });
  });

  it("finds the region from availability zones and the bucket region", () => {
    expect(facts.regions).toEqual(["us-east-1"]);
  });

  it("lists identity, firewall and dns changes", () => {
    expect(facts.identityChanges).toEqual(["aws_iam_role.task", "aws_iam_role_policy.task"]);
    expect(facts.firewallChanges).toEqual(["aws_security_group.web"]);
    expect(facts.dnsChanges).toEqual(["aws_route53_record.www"]);
  });

  it("does not flag 443/80 from anywhere, private ingress, tight IAM, or a private database", () => {
    expect(facts.openIngress).toEqual([]);
    expect(facts.publicDatabases).toEqual([]);
    expect(facts.wildcardIam).toEqual([]);
    expect(facts.destroysData).toBe(false);
    expect(facts.destroyedStatefulAddresses).toEqual([]);
    expect(facts.unresolved).toEqual([]);
  });
});

describe("extractPlanFacts: risky creates and updates", () => {
  const facts = extractPlanFacts(loadPlanFixture("risky-changes"));

  it("counts creates and updates", () => {
    expect(facts).toMatchObject({ create: 13, update: 4, delete: 0, replace: 0 });
  });

  it("flags publicly accessible databases (RDS, Redshift)", () => {
    expect(facts.publicDatabases).toEqual(["aws_db_instance.reports", "aws_redshift_cluster.warehouse"]);
  });

  it("flags internet ingress on non-web ports across every rule form, sorted", () => {
    expect(facts.openIngress).toEqual([
      { address: "aws_network_acl_rule.allow_all", cidr: "0.0.0.0/0", port: "all" },
      { address: "aws_security_group.admin", cidr: "0.0.0.0/0", port: "22" },
      { address: "aws_security_group.admin", cidr: "0.0.0.0/0", port: "8000-9000" },
      { address: "aws_security_group.admin", cidr: "::/0", port: "all" },
      { address: "aws_security_group_rule.db", cidr: "0.0.0.0/0", port: "5432" },
      { address: "aws_vpc_security_group_ingress_rule.rdp", cidr: "0.0.0.0/0", port: "3389" },
    ]);
  });

  it("does not flag 443, ICMP, egress rules, deny rules or private CIDRs", () => {
    const flagged = facts.openIngress.map((f) => f.address);
    expect(flagged).not.toContain("aws_vpc_security_group_ingress_rule.https");
    expect(flagged).not.toContain("aws_vpc_security_group_ingress_rule.ping");
    expect(flagged).not.toContain("aws_security_group_rule.egress_all");
    expect(flagged).not.toContain("aws_network_acl_rule.deny_all");
    expect(facts.openIngress.filter((f) => f.address === "aws_security_group.admin").map((f) => f.port)).not.toContain("443");
    expect(facts.openIngress.filter((f) => f.address === "aws_security_group.admin").map((f) => f.port)).not.toContain("8443");
  });

  it("flags wildcard IAM: Action *, service:*, NotAction, inline policies, AdministratorAccess", () => {
    expect(facts.wildcardIam).toEqual([
      "aws_iam_policy.admin#statement[1]",
      "aws_iam_role.legacy#statement[0]",
      "aws_iam_role_policy.notaction#statement[0]",
      "aws_iam_role_policy.svc#statement[0]",
      "aws_iam_role_policy_attachment.admin#AdministratorAccess",
    ]);
  });

  it("does not flag a Deny statement, a read-only managed policy, or `*` resource with a specific action", () => {
    expect(facts.wildcardIam.join(" ")).not.toContain("deny_everything");
    expect(facts.wildcardIam.join(" ")).not.toContain("readonly");
  });

  it("collects firewall and identity changes including the ones that are safe", () => {
    expect(facts.firewallChanges).toEqual([
      "aws_network_acl_rule.allow_all",
      "aws_network_acl_rule.deny_all",
      "aws_security_group.admin",
      "aws_security_group_rule.db",
      "aws_security_group_rule.egress_all",
      "aws_vpc_security_group_ingress_rule.https",
      "aws_vpc_security_group_ingress_rule.ping",
      "aws_vpc_security_group_ingress_rule.rdp",
    ]);
    expect(facts.identityChanges).toHaveLength(7);
  });

  it("resolves everything it could read (nothing left unresolved)", () => {
    expect(facts.unresolved).toEqual([]);
  });
});

describe("extractPlanFacts: stateful destroys", () => {
  const facts = extractPlanFacts(loadPlanFixture("stateful-destroy"));

  it("counts every action kind and ignores no-op and read", () => {
    expect(facts).toMatchObject({ create: 0, update: 1, delete: 10, replace: 1 });
  });

  it("reports stateful deletes and replaces, by type table or by the normalizer's flag", () => {
    expect(facts.destroysData).toBe(true);
    expect(facts.statefulDeletes).toEqual(facts.destroyedStatefulAddresses);
    expect(facts.dnsDeletes).toEqual(["aws_route53_record.old"]);
    expect(facts.destroyedStatefulAddresses).toEqual([
      "aws_db_instance.legacy",
      "aws_ebs_volume.data",
      "aws_elasticache_cluster.cache",
      "aws_s3_bucket.logs",
      "aws_sqs_queue.jobs",
      "custom_store.central",
    ]);
  });

  it("does not treat stateless deletes or in-place updates of stateful types as data loss", () => {
    const addresses = facts.destroyedStatefulAddresses;
    expect(addresses).not.toContain("aws_instance.old");
    expect(addresses).not.toContain("aws_elasticache_subnet_group.cache");
    expect(addresses).not.toContain("aws_dynamodb_table.orders");
  });

  it("still lists deleted firewall, identity and dns resources as changes", () => {
    expect(facts.firewallChanges).toEqual(["aws_security_group.old"]);
    expect(facts.identityChanges).toEqual(["aws_iam_role.old"]);
    expect(facts.dnsChanges).toEqual(["aws_route53_record.old"]);
  });

  it("takes no regions from resources being destroyed", () => {
    expect(facts.regions).toEqual([]);
  });

  it("reports only DNS record deletes and replacements across provider types, sorted and unique", () => {
    const types = ["aws_route53_record", "google_dns_record_set", "azurerm_dns_a_record", "oci_dns_rrset"];
    const deletions = types.flatMap((type) => [resource(type, "delete", [], `${type}.old`), resource(type, "replace", [], `${type}.replaced`)]);
    const changes = types.flatMap((type) => [resource(type, "create", [], `${type}.new`), resource(type, "update", [], `${type}.updated`), resource(type, "no-op", [], `${type}.same`), resource(type, "read", [], `${type}.read`)]);
    const plan = planWith(...deletions, ...changes, deletions[0], resource("aws_route53_zone", "delete", []));
    const result = extractPlanFacts(plan);
    expect(result.dnsDeletes).toEqual(deletions.map((r) => r.address).sort());
    expect(result).toEqual(extractPlanFacts({ ...plan, resourceChanges: [...plan.resourceChanges].reverse() }));
  });
});

describe("extractPlanFacts: unknown and masked values", () => {
  const facts = extractPlanFacts(loadPlanFixture("unknown-values"));

  it("reports what it cannot judge instead of guessing", () => {
    expect(facts.unresolved).toEqual([
      "aws_db_instance.replica:publicly_accessible",
      "aws_iam_policy.hidden:policy",
      "aws_iam_role_policy.broken:policy",
      "aws_iam_role_policy.dynamic:policy",
      "aws_security_group.dynamic:ingress",
      "aws_security_group.whole_block_unknown:ingress",
      "aws_security_group_rule.unknown_type:type",
    ]);
  });

  it("does not call an unknown database public, nor an unreadable IAM document wildcard", () => {
    expect(facts.publicDatabases).toEqual([]);
    expect(facts.wildcardIam).toEqual([]);
  });

  it("flags an open CIDR whose port is unknown, with port \"unknown\"", () => {
    expect(facts.openIngress).toEqual([{ address: "aws_security_group.unknown_port", cidr: "0.0.0.0/0", port: "unknown" }]);
  });

  it("leaves an unknown region unknown", () => {
    expect(facts.regions).toEqual([]);
  });
});

describe("extractPlanFacts: regions", () => {
  const facts = extractPlanFacts(loadPlanFixture("regions-mixed"));

  it("reads region, availability zones and the resource's own ARN", () => {
    expect(facts.regions).toEqual(["ap-southeast-2", "ca-central-1", "eu-central-1", "eu-west-1", "us-west-2"]);
  });

  it("ignores cross-region references, deleted resources, local zones, hostile text and unsupported providers", () => {
    expect(facts.regions).not.toContain("us-east-1"); // CloudFront's ACM certificate ARN
    expect(facts.regions).not.toContain("sa-east-1"); // resource being deleted
    expect(facts.regions.join(" ")).not.toMatch(/ignore|instructions|central1/);
  });
});

describe("extractPlanFacts: nothing to do", () => {
  it("returns zero facts for a plan of no-ops and reads", () => {
    const facts = extractPlanFacts(loadPlanFixture("no-changes"));
    expect(facts).toEqual({
      create: 0,
      update: 0,
      delete: 0,
      replace: 0,
      destroysData: false,
      destroyedStatefulAddresses: [],
      statefulDeletes: [],
      dnsDeletes: [],
      regions: [],
      publicDatabases: [],
      openIngress: [],
      wildcardIam: [],
      identityChanges: [],
      firewallChanges: [],
      dnsChanges: [],
      unresolved: [],
    });
  });

  it("does not analyze attributes of a no-op (an existing public database is not this plan's doing)", () => {
    expect(extractPlanFacts(loadPlanFixture("no-changes")).publicDatabases).toEqual([]);
  });
});

describe("extractPlanFacts: determinism and hygiene", () => {
  it("is a pure function: same plan, same facts, regardless of resource order", () => {
    const plan = loadPlanFixture("risky-changes");
    const reversed: NormalizedPlan = { ...plan, resourceChanges: [...plan.resourceChanges].reverse() };
    expect(extractPlanFacts(reversed)).toEqual(extractPlanFacts(plan));
    expect(JSON.stringify(extractPlanFacts(plan))).toBe(JSON.stringify(extractPlanFacts(plan)));
  });

  it("does not mutate the plan", () => {
    const plan = loadPlanFixture("risky-changes");
    const before = JSON.stringify(plan);
    extractPlanFacts(plan);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("ignores plan.summary and recomputes counts from the changes", () => {
    const plan = loadPlanFixture("web-stack-create");
    const lying: NormalizedPlan = { ...plan, summary: { create: 0, update: 99, delete: 99, replace: 99, noop: 0 } };
    expect(extractPlanFacts(lying)).toMatchObject({ create: 10, update: 0, delete: 0, replace: 0 });
  });

  it("de-duplicates repeated findings", () => {
    const facts = extractPlanFacts(
      planWith(
        resource("aws_security_group", "create", [
          change("ingress[0].cidr_blocks[0]", "0.0.0.0/0"),
          change("ingress[0].cidr_blocks[1]", "0.0.0.0/0"),
          change("ingress[0].from_port", 22),
          change("ingress[0].to_port", 22),
          change("ingress[0].protocol", "tcp"),
        ])
      )
    );
    expect(facts.openIngress).toEqual([{ address: "aws_security_group.x", cidr: "0.0.0.0/0", port: "22" }]);
  });

  it("output passes the engine's strict input schema (facts are a valid policy input)", async () => {
    const engine = await loadPolicyEngine();
    for (const name of ["web-stack-create", "risky-changes", "stateful-destroy", "unknown-values", "regions-mixed", "no-changes"]) {
      const result = await engine.evaluate(policyInput("infrastructure.apply", { environment: { autonomyLevel: 5 }, plan: extractPlanFacts(loadPlanFixture(name)) }));
      expect(result.decision.reasons.map((r) => r.code)).not.toContain("policy_error");
    }
  });
});

describe("plan facts through the policy", () => {
  async function decide(name: string, patch: Record<string, unknown> = {}) {
    const engine = await loadPolicyEngine();
    return (await engine.evaluate(policyInput("infrastructure.apply", { environment: { autonomyLevel: 5 }, plan: extractPlanFacts(loadPlanFixture(name)), ...patch }))).decision;
  }

  it("a benign stack at full autonomy runs unattended", async () => {
    const decision = await decide("web-stack-create");
    expect(decision.outcome).toBe("allow");
  });

  it("a benign stack touching identity in production needs an admin", async () => {
    const decision = await decide("web-stack-create", { environment: { class: "production", autonomyLevel: 5 } });
    expect(decision.outcome).toBe("require_approval");
    expect(decision.approval?.minRole).toBe("admin");
    expect(decision.reasons.map((r) => r.code)).toEqual(["production_network_identity_change"]);
  });

  it("the risky plan is denied for its public databases and wildcard IAM", async () => {
    const decision = await decide("risky-changes");
    expect(decision.outcome).toBe("deny");
    expect(decision.reasons.map((r) => r.code)).toEqual(["public_database", "wildcard_iam"]);
  });

  it("a production apply that destroys stateful resources is denied", async () => {
    const decision = await decide("stateful-destroy", { environment: { class: "production", autonomyLevel: 5 } });
    expect(decision.outcome).toBe("deny");
    expect(decision.reasons.map((r) => r.code)).toContain("production_destroys_data");
  });

  it("stateful and DNS deletions in development need human review even at full autonomy", async () => {
    const decision = await decide("stateful-destroy");
    expect(decision.outcome).toBe("require_approval");
    expect(decision.reasons.map((r) => r.code)).toEqual(["dns_deletes_require_approval", "stateful_deletes_require_approval"]);
  });

  it("unresolved security values ask for review", async () => {
    const decision = await decide("unknown-values");
    expect(decision.outcome).toBe("require_approval");
    expect(decision.reasons.map((r) => r.code)).toContain("unresolved_security_attributes");
    expect(decision.reasons.map((r) => r.code)).toContain("open_ingress");
  });

  it("a region outside the approved list, read from the plan, is denied", async () => {
    const engine = await loadPolicyEngine();
    const result = await engine.evaluate(
      policyInput(
        "infrastructure.apply",
        { environment: { autonomyLevel: 5, region: "eu-west-1" }, plan: extractPlanFacts(loadPlanFixture("regions-mixed")) },
        { approvedRegions: ["eu-west-1", "us-west-2"] }
      )
    );
    expect(result.decision.outcome).toBe("deny");
    expect(result.decision.reasons[0].message).toBe("Region(s) outside the workspace's approved regions: ap-southeast-2, ca-central-1, eu-central-1.");
  });
});

describe("attribute path parsing and materialization", () => {
  it("parses dotted, indexed and quoted paths", () => {
    expect(parseAttributePath("publicly_accessible")).toEqual(["publicly_accessible"]);
    expect(parseAttributePath("ingress[0].cidr_blocks[1]")).toEqual(["ingress", 0, "cidr_blocks", 1]);
    expect(parseAttributePath("ingress.0.from_port")).toEqual(["ingress", 0, "from_port"]);
    expect(parseAttributePath('tags["Name"]')).toEqual(["tags", "Name"]);
    expect(parseAttributePath('tags["a.b[0]"].x')).toEqual(["tags", "a.b[0]", "x"]);
  });

  it("rejects malformed paths", () => {
    for (const bad of ["", ".", "a[", "a[x]", 'a["b', 'a["b"', "a[-1]"]) expect(parseAttributePath(bad), bad).toBeNull();
  });

  it("builds nested structure from per-attribute changes and from whole-block values", () => {
    const attrs = materializeAfter([
      change("ingress[0].from_port", 22),
      change("ingress[1].cidr_blocks", ["10.0.0.0/8"]),
      change("egress", [{ to_port: 0 }]),
      change("tags.Name", "web"),
    ]);
    expect(attrs).toEqual({ ingress: [{ from_port: 22 }, { cidr_blocks: ["10.0.0.0/8"] }], egress: [{ to_port: 0 }], tags: { Name: "web" } });
  });

  it("keeps sentinels distinct and masks sensitive values", () => {
    const attrs = materializeAfter([change("a", UNKNOWN_VALUE), change("b", "secret-value", true)]);
    expect(attrs.a).toBe(UNKNOWN_VALUE);
    expect(attrs.b).toBe(MASKED_VALUE);
    expect(JSON.stringify(attrs)).not.toContain("secret-value");
  });

  it("cannot be used to pollute prototypes or allocate huge arrays", () => {
    const attrs = materializeAfter([
      change("__proto__.polluted", "yes"),
      change("constructor.prototype.polluted", "yes"),
      change("list[999999999]", "x"),
      change("ok", 1),
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(attrs)).toEqual(["ok"]);
  });

  it("lets a later change replace a conflicting earlier one instead of throwing", () => {
    expect(materializeAfter([change("a", "scalar"), change("a.b", 1)])).toEqual({ a: { b: 1 } });
    expect(materializeAfter([change("a.b", 1), change("a[0]", 2)])).toEqual({ a: [2] });
  });
});
