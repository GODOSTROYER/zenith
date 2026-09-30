import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import {
  SESSION_POLICY_MAX_CHARS,
  SessionPolicyError,
  logGroupPrefixes,
  sessionPolicyFor,
  sessionPolicyNeedsEnvironment,
  validateSessionPolicy,
} from "@/lib/credentials/aws";
import { ACCOUNT } from "./helpers";

const ctx = { accountId: ACCOUNT, region: "ap-south-1", environmentId: "env-prod1" };
const longEnv = "e".repeat(64);

const statements = (p: ReturnType<typeof sessionPolicyFor>) => (p?.Statement ?? []) as Record<string, unknown>[];
const asArray = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [v as string]);

describe("sessionPolicyFor", () => {
  const narrowed = [
    "infrastructure.observe",
    "topology.read",
    "firewall.inspect",
    "metrics.read",
    "logs.read",
    "service.restart",
    "service.scale",
    "database.snapshot",
  ];

  it.each(narrowed)("%s: valid, ≤ 2048 compact characters even with worst-case ids and partitions", (cap) => {
    for (const c of [ctx, { ...ctx, environmentId: longEnv, region: "us-gov-west-1", partition: "aws-us-gov" as const }]) {
      const policy = sessionPolicyFor(cap, c);
      expect(policy).toBeDefined();
      const compact = validateSessionPolicy(policy);
      expect(compact.length).toBeLessThanOrEqual(SESSION_POLICY_MAX_CHARS);
      // never a blanket allow
      for (const s of statements(policy)) {
        expect(asArray(s.Action)).not.toContain("*");
        expect(s.Effect).toBe("Allow");
      }
    }
  });

  it("returns undefined for capabilities whose role policy is the control (apply, deploy, destroy, …)", () => {
    for (const cap of ["infrastructure.apply", "infrastructure.destroy", "deployment.deploy", "deployment.rollback", "drift.repair", "infrastructure.plan", "dns.modify"]) {
      expect(sessionPolicyFor(cap, ctx)).toBeUndefined();
    }
  });

  it("covers every catalog capability without throwing (narrowed or explicitly none)", () => {
    for (const cap of Object.keys(CAPABILITIES)) {
      const policy = sessionPolicyFor(cap, ctx);
      if (policy) expect(() => validateSessionPolicy(policy)).not.toThrow();
    }
  });

  it("rejects unknown capabilities", () => {
    expect(() => sessionPolicyFor("nope.nothing", ctx)).toThrow(SessionPolicyError);
  });

  it("infrastructure.observe is read-only and covers the services Zenith drives", () => {
    const actions = statements(sessionPolicyFor("infrastructure.observe", ctx)).flatMap((s) => asArray(s.Action));
    for (const a of ["ec2:Describe*", "ecs:Describe*", "rds:Describe*", "elasticloadbalancing:Describe*", "s3:GetBucket*", "tag:GetResources", "secretsmanager:DescribeSecret"]) {
      expect(actions).toContain(a);
    }
    expect(actions).not.toContain("secretsmanager:GetSecretValue");
    expect(actions.filter((a) => /:(Create|Delete|Put|Update|Modify|Run|Start|Stop|Terminate|Attach|Detach)/.test(a))).toEqual([]);
    const iam = statements(sessionPolicyFor("infrastructure.observe", ctx)).find((s) => asArray(s.Action).some((a) => a.startsWith("iam:")))!;
    expect(iam.Resource).toBe(`arn:aws:iam::${ACCOUNT}:role/zenith-*`);
  });

  it("logs.read is limited to the environment's log-group prefixes by ARN", () => {
    const policy = sessionPolicyFor("logs.read", ctx)!;
    const main = statements(policy)[0];
    expect(asArray(main.Action)).toEqual(["logs:FilterLogEvents", "logs:GetLogEvents", "logs:StartQuery", "logs:DescribeLogStreams"]);
    expect(main.Resource).toEqual(logGroupPrefixes("env-prod1").map((p) => `arn:aws:logs:ap-south-1:${ACCOUNT}:log-group:${p}*`));
    expect(JSON.stringify(main.Resource)).toContain("/zenith/env-prod1/");
    expect(JSON.stringify(main.Resource)).toContain("/aws/ecs/zenith-env-prod1-");
    // the only "*" resource is the query-result statement, which IAM cannot scope
    const wildcard = statements(policy).filter((s) => s.Resource === "*");
    expect(wildcard).toHaveLength(1);
    expect(asArray(wildcard[0].Action)).toEqual(["logs:GetQueryResults", "logs:StopQuery", "logs:DescribeQueries"]);
  });

  it("service.restart/scale confine UpdateService to one environment's cluster and require the environment tag", () => {
    for (const cap of ["service.restart", "service.scale"]) {
      const s = statements(sessionPolicyFor(cap, ctx))[0];
      expect(asArray(s.Action)).toEqual(["ecs:UpdateService", "ecs:DescribeServices"]);
      expect(s.Resource).toBe(`arn:aws:ecs:ap-south-1:${ACCOUNT}:service/zenith-env-prod1/*`);
      expect(s.Condition).toEqual({ StringEquals: { "aws:ResourceTag/zenith:environment": "env-prod1" } });
    }
  });

  it("database.snapshot only touches zenith-<env>-* instances, clusters and snapshots", () => {
    const s = statements(sessionPolicyFor("database.snapshot", ctx))[0];
    expect(asArray(s.Resource)).toEqual([
      `arn:aws:rds:ap-south-1:${ACCOUNT}:db:zenith-env-prod1-*`,
      `arn:aws:rds:ap-south-1:${ACCOUNT}:cluster:zenith-env-prod1-*`,
      `arn:aws:rds:ap-south-1:${ACCOUNT}:snapshot:zenith-env-prod1-*`,
      `arn:aws:rds:ap-south-1:${ACCOUNT}:cluster-snapshot:zenith-env-prod1-*`,
    ]);
    expect(asArray(s.Action)).not.toContain("rds:DeleteDBInstance");
  });

  it("environment-scoped capabilities fail closed without (or with an unsafe) environment id", () => {
    for (const cap of ["logs.read", "service.restart", "service.scale", "database.snapshot"]) {
      expect(sessionPolicyNeedsEnvironment(cap)).toBe(true);
      expect(() => sessionPolicyFor(cap, { ...ctx, environmentId: undefined })).toThrow(/environment/);
      for (const bad of ["*", "prod*", "a/b", "${aws:username}", "a b", "", "x".repeat(65), "a?b"]) {
        expect(() => sessionPolicyFor(cap, { ...ctx, environmentId: bad })).toThrow(SessionPolicyError);
      }
    }
    expect(sessionPolicyNeedsEnvironment("infrastructure.observe")).toBe(false);
    expect(() => sessionPolicyFor("infrastructure.observe", { ...ctx, environmentId: undefined })).not.toThrow();
  });
});

describe("validateSessionPolicy", () => {
  const ok = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::zenith-x/*" }] };

  it("returns the compact JSON that will be sent to STS", () => {
    expect(validateSessionPolicy(ok)).toBe(JSON.stringify(ok));
    expect(validateSessionPolicy({ ...ok, Statement: ok.Statement[0] })).toContain('"Statement"');
  });

  it("rejects Allow * on *, in every spelling", () => {
    for (const [Action, Resource] of [
      ["*", "*"],
      [["*"], "*"],
      ["*", ["arn:aws:s3:::x", "*"]],
      [["s3:GetObject", "*"], ["*"]],
      ["*:*", "*"],
    ] as const) {
      expect(() => validateSessionPolicy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action, Resource }] })).toThrow(
        /narrows nothing/
      );
    }
    // Deny * on * is a legitimate guard rail and Allow * on a scoped resource is not the wildcard pair.
    expect(() => validateSessionPolicy({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }] })).not.toThrow();
    expect(() =>
      validateSessionPolicy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "arn:aws:s3:::zenith-a/*" }] })
    ).not.toThrow();
  });

  it("rejects malformed structure", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      {},
      { Version: "2008-10-17", Statement: ok.Statement },
      { Version: "2012-10-17", Statement: [] },
      { Version: "2012-10-17", Statement: [{ Effect: "Maybe", Action: "s3:Get*", Resource: "*" }] },
      { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:Get*" }] },
      { Version: "2012-10-17", Statement: [{ Effect: "Allow", Resource: "*" }] },
      { Version: "2012-10-17", Statement: [{ Effect: "Allow", NotAction: "iam:*", Resource: "*" }] },
      { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:Get*", NotResource: "x" }] },
      { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:Get*", Resource: "*", Principal: "*" }] },
      { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "not an action", Resource: "*" }] },
      { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: 5, Resource: "*" }] },
      { Version: "2012-10-17", Statement: Array.from({ length: 21 }, () => ok.Statement[0]) },
    ];
    for (const p of bad) expect(() => validateSessionPolicy(p)).toThrow(SessionPolicyError);
  });

  it("rejects oversize policies (> 2048 compact chars) and non-Latin-1 characters", () => {
    const big = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: Array.from({ length: 60 }, (_, i) => `arn:aws:s3:::zenith-bucket-${i}/*`) }] };
    expect(JSON.stringify(big).length).toBeGreaterThan(2048);
    expect(() => validateSessionPolicy(big)).toThrow(/2048/);
    const exactly = (n: number) => {
      const base = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: ["r".repeat(1000), ""] }] };
      base.Statement[0].Resource[1] = "r".repeat(n - JSON.stringify(base).length);
      return base;
    };
    expect(JSON.stringify(exactly(2048)).length).toBe(2048);
    expect(() => validateSessionPolicy(exactly(2048))).not.toThrow();
    expect(() => validateSessionPolicy(exactly(2049))).toThrow(/2048/);
    expect(() => validateSessionPolicy({ ...ok, Statement: [{ ...ok.Statement[0], Resource: "arn:aws:s3:::zenith-☃" }] })).toThrow(/U\+0020/);
  });
});
