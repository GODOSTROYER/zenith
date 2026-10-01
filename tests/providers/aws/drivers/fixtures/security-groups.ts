/**
 * A tiny fake of the security groups an applied fixture graph would leave in an
 * account, served through `aws-sdk-client-mock` with REAL filter semantics
 * (tag filters, group ids, `group-id` rule filters) so firewall tests exercise
 * the driver's lookup logic rather than a canned answer. Hand-written rule
 * lists, not derived from the driver's compile: a circular fixture would prove
 * nothing.
 *
 * CONTRACT-LEVEL FAKE: it mirrors the EC2 response shapes the driver reads; it
 * is not a claim about how a live account behaves.
 */
import { DescribeSecurityGroupRulesCommand, DescribeSecurityGroupsCommand, EC2Client, type SecurityGroupRule } from "@aws-sdk/client-ec2";
import type { AwsClientStub } from "aws-sdk-client-mock";
import { FIXTURE_ENVIRONMENT_ID, FIXTURE_WORKSPACE_ID } from "./graph";

export interface FakeGroup {
  id: string;
  address: string;
  name: string;
  tags: Record<string, string>;
}

export const SG = {
  lb: "sg-00000000000000001",
  web: "sg-00000000000000002",
  api: "sg-00000000000000003",
  db: "sg-00000000000000004",
} as const;

const OWNER = "123456789012";

function tagsFor(address: string): Record<string, string> {
  return { "zenith:workspace": FIXTURE_WORKSPACE_ID, "zenith:environment": FIXTURE_ENVIRONMENT_ID, "zenith:resource": address, "zenith:managed": "true" };
}

export const GROUPS: FakeGroup[] = [
  { id: SG.lb, address: "load_balancer/public", name: "acme-prod-load-balancer-public", tags: tagsFor("load_balancer/public") },
  { id: SG.web, address: "container_service/web", name: "acme-prod-container-service-web", tags: tagsFor("container_service/web") },
  { id: SG.api, address: "container_service/api", name: "acme-prod-container-service-api", tags: tagsFor("container_service/api") },
  { id: SG.db, address: "postgres/db", name: "acme-prod-postgres-db", tags: tagsFor("postgres/db") },
];

let counter = 0;
const ingress = (group: string, port: number, peer: { cidr: string } | { sg: string }, description = ""): SecurityGroupRule => ({
  SecurityGroupRuleId: `sgr-${(++counter).toString(16).padStart(17, "0")}`,
  GroupId: group,
  GroupOwnerId: OWNER,
  IsEgress: false,
  IpProtocol: "tcp",
  FromPort: port,
  ToPort: port,
  ...("cidr" in peer ? { CidrIpv4: peer.cidr } : { ReferencedGroupInfo: { GroupId: peer.sg, UserId: OWNER } }),
  Description: description,
});
const egress = (group: string, port: number, peer: { cidr: string } | { sg: string }): SecurityGroupRule => ({ ...ingress(group, port, peer), IsEgress: true });

/** The rules the fixture graph's six firewall nodes (and the workload baseline egress) produce when applied. */
export function appliedRules(): SecurityGroupRule[] {
  return [
    ingress(SG.lb, 80, { cidr: "0.0.0.0/0" }),
    ingress(SG.lb, 443, { cidr: "0.0.0.0/0" }),
    egress(SG.lb, 3000, { sg: SG.web }),
    egress(SG.lb, 8080, { sg: SG.api }),
    ingress(SG.web, 3000, { sg: SG.lb }),
    ingress(SG.api, 8080, { sg: SG.lb }),
    egress(SG.web, 443, { cidr: "0.0.0.0/0" }),
    egress(SG.api, 443, { cidr: "0.0.0.0/0" }),
    egress(SG.web, 5432, { sg: SG.db }),
    egress(SG.api, 5432, { sg: SG.db }),
    ingress(SG.db, 5432, { sg: SG.web }),
    ingress(SG.db, 5432, { sg: SG.api }),
  ];
}

export class FakeAccount {
  groups: FakeGroup[] = [...GROUPS];
  rules: SecurityGroupRule[] = appliedRules();

  /** The rule id of the (group, direction, port, peer) rule, e.g. to delete it. */
  ruleId(group: string, dir: "ingress" | "egress", port: number, peer: string): string {
    const r = this.rules.find((x) => x.GroupId === group && x.IsEgress === (dir === "egress") && x.FromPort === port && (x.CidrIpv4 === peer || x.ReferencedGroupInfo?.GroupId === peer));
    if (!r?.SecurityGroupRuleId) throw new Error(`no such rule ${group} ${dir} ${port} ${peer}`);
    return r.SecurityGroupRuleId;
  }

  remove(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.SecurityGroupRuleId !== ruleId);
  }

  add(rule: SecurityGroupRule): void {
    this.rules = [...this.rules, rule];
  }

  install(m: AwsClientStub<EC2Client>): void {
    m.on(DescribeSecurityGroupsCommand).callsFake((input: { GroupIds?: string[]; Filters?: { Name: string; Values: string[] }[] }) => {
      let hits = this.groups;
      if (input.GroupIds) {
        const unknownIds = input.GroupIds.filter((id) => !this.groups.some((g) => g.id === id));
        if (unknownIds.length) throw Object.assign(new Error(`The security group '${unknownIds[0]}' does not exist`), { name: "InvalidGroup.NotFound", $metadata: { httpStatusCode: 400 } });
        hits = hits.filter((g) => input.GroupIds!.includes(g.id));
      }
      for (const f of input.Filters ?? []) {
        if (f.Name.startsWith("tag:")) hits = hits.filter((g) => f.Values.includes(g.tags[f.Name.slice(4)]));
      }
      return {
        SecurityGroups: hits.map((g) => ({
          GroupId: g.id,
          GroupName: g.name,
          VpcId: "vpc-0abc1234def567890",
          Tags: Object.entries(g.tags).map(([Key, Value]) => ({ Key, Value })),
          IpPermissions: this.rules.filter((r) => r.GroupId === g.id && !r.IsEgress).map(() => ({})),
          IpPermissionsEgress: this.rules.filter((r) => r.GroupId === g.id && r.IsEgress).map(() => ({})),
        })),
      };
    });
    m.on(DescribeSecurityGroupRulesCommand).callsFake((input: { Filters?: { Name: string; Values: string[] }[] }) => {
      const groupIds = input.Filters?.find((f) => f.Name === "group-id")?.Values;
      return { SecurityGroupRules: this.rules.filter((r) => !groupIds || groupIds.includes(r.GroupId ?? "")), $metadata: { requestId: "req-rules-1" } };
    });
  }
}
