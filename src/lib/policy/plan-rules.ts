/**
 * Per-resource-type rule table for plan-fact extraction (spec §14).
 *
 * AWS is populated first. Another provider adds rows here — `TYPE_RULES` and
 * `TYPE_PREFIX_RULES` for resource types, `PROVIDER_REGIONS` for how a
 * provider's resources name their region — and touches nothing else. Every
 * row is data plus a small pure function over the planned attribute tree
 * (`plan-attributes.ts`); nothing here reads a clock, the network or the
 * environment.
 *
 * What is and is not judged (honest limits):
 *  - Exposure is judged only from attributes the normalized plan reports. An
 *    attribute absent from the diff is "not asserted", never "safe".
 *  - A value that is masked or only known after apply cannot be judged. Where
 *    that value decides exposure (a public-access flag, an ingress CIDR or
 *    port, an IAM policy document) the resource is reported under `unresolved`
 *    instead of being guessed either way; the policy asks a person to review.
 *  - IAM: a statement is "wildcard" when it Allows every action (`*`) or every
 *    action of a service (`s3:*`) — or uses `NotAction`, which allows all but
 *    the listed actions — on Resource `*`. Partial wildcards (`ec2:Describe*`)
 *    and full-service actions on specific ARNs are not flagged. The managed
 *    `AdministratorAccess` policy attached anywhere counts as wildcard IAM.
 *  - Ingress: 0.0.0.0/0 and ::/0 on anything but a single tcp/udp port 80 or
 *    443. ICMP is not a port and is not flagged.
 *  - Regions come from a resource's `region`, `availability_zone(s)` and own
 *    `arn` attributes only. Cross-region references (`*_arn` attributes that
 *    point elsewhere) are deliberately ignored, and nothing is inferred from a
 *    provider block: an unknown region stays unknown.
 */
import {
  asList,
  asNumber,
  asString,
  isRecord,
  isUnresolvable,
  type Attrs,
} from "./plan-attributes";

export type ChangeCategory = "identity" | "firewall" | "dns";

export interface OpenIngressFinding {
  address: string;
  port: string;
  cidr: string;
}

/** What a rule reports; the extractor turns these into `PlanFacts`. */
export interface Findings {
  publicDatabases: Set<string>;
  openIngress: Map<string, OpenIngressFinding>;
  wildcardIam: Set<string>;
  unresolved: Set<string>;
}

export function newFindings(): Findings {
  return { publicDatabases: new Set(), openIngress: new Map(), wildcardIam: new Set(), unresolved: new Set() };
}

/** One ingress rule as the type's attributes describe it, before judging it. */
export interface IngressSpec {
  cidrs: unknown[];
  protocol: unknown;
  from: unknown;
  to: unknown;
}

/** Reports, via `note`, an attribute that decides exposure but cannot be read. */
type IngressExtractor = (attrs: Attrs, note: (attribute: string) => void) => IngressSpec[];

export interface TypeRule {
  category?: ChangeCategory;
  /** deleting or replacing it loses data */
  stateful?: boolean;
  /** boolean attribute that makes the resource reachable from the internet when true */
  publicFlag?: string;
  ingress?: IngressExtractor;
  /** scan for IAM policy documents (JSON in attributes named policy / policy_document / inline_policy) */
  iamDocuments?: boolean;
  /** attribute keys holding managed-policy ARNs to check for AdministratorAccess */
  managedPolicyKeys?: readonly string[];
}

/* ------------------------------------------------------------ ingress ---- */

const blocks = (value: unknown, note: () => void): Attrs[] => {
  if (isUnresolvable(value)) {
    note();
    return [];
  }
  return asList(value).filter(isRecord);
};

const securityGroupBlocks: IngressExtractor = (attrs, note) =>
  blocks(attrs.ingress, () => note("ingress")).map((b) => ({
    cidrs: [...asList(b.cidr_blocks), ...asList(b.ipv6_cidr_blocks)],
    protocol: b.protocol,
    from: b.from_port,
    to: b.to_port,
  }));

const securityGroupRule: IngressExtractor = (attrs, note) => {
  if (isUnresolvable(attrs.type)) {
    note("type");
    return [];
  }
  if (attrs.type === "egress") return [];
  return [
    {
      cidrs: [...asList(attrs.cidr_blocks), ...asList(attrs.ipv6_cidr_blocks)],
      protocol: attrs.protocol,
      from: attrs.from_port,
      to: attrs.to_port,
    },
  ];
};

const vpcIngressRule: IngressExtractor = (attrs) => [
  {
    cidrs: [...asList(attrs.cidr_ipv4), ...asList(attrs.cidr_ipv6)],
    protocol: attrs.ip_protocol,
    from: attrs.from_port,
    to: attrs.to_port,
  },
];

const allowsTraffic = (action: unknown): boolean => {
  const value = asString(action);
  // Masked/unknown/absent actions are treated as allow: the conservative reading.
  return value === undefined || value.toLowerCase() !== "deny";
};

const naclBlocks: IngressExtractor = (attrs, note) =>
  blocks(attrs.ingress, () => note("ingress"))
    .filter((b) => allowsTraffic(b.action))
    .map((b) => ({
      cidrs: [...asList(b.cidr_block), ...asList(b.ipv6_cidr_block)],
      protocol: b.protocol,
      from: b.from_port,
      to: b.to_port,
    }));

const naclRule: IngressExtractor = (attrs) => {
  if (attrs.egress === true || !allowsTraffic(attrs.rule_action)) return [];
  return [
    {
      cidrs: [...asList(attrs.cidr_block), ...asList(attrs.ipv6_cidr_block)],
      protocol: attrs.protocol,
      from: attrs.from_port,
      to: attrs.to_port,
    },
  ];
};

function isOpenCidr(cidr: string): boolean {
  if (cidr === "0.0.0.0/0") return true;
  const slash = cidr.lastIndexOf("/");
  if (slash === -1 || cidr.slice(slash + 1) !== "0") return false;
  const address = cidr.slice(0, slash);
  return address.includes(":") && /^[0:]+$/.test(address);
}

type ProtocolClass = "all" | "tcp" | "udp" | "icmp" | "other" | "unknown";

function classifyProtocol(protocol: unknown): ProtocolClass {
  if (protocol === undefined || protocol === null || isUnresolvable(protocol)) return "unknown";
  const value = String(protocol).trim().toLowerCase();
  if (value === "-1" || value === "all") return "all";
  if (value === "tcp" || value === "6") return "tcp";
  if (value === "udp" || value === "17") return "udp";
  if (value === "icmp" || value === "1" || value === "icmpv6" || value === "58") return "icmp";
  return "other";
}

/** The port label to report for an open rule, or `null` when the rule is exempt. */
function openPortLabel(spec: IngressSpec): string | null {
  const protocol = classifyProtocol(spec.protocol);
  if (protocol === "icmp") return null;
  if (protocol === "all" || protocol === "other") return "all";
  if (protocol === "unknown") return "unknown";
  const from = asNumber(spec.from);
  const to = asNumber(spec.to);
  if (from === undefined || to === undefined) return "unknown";
  if (from === to && (from === 80 || from === 443)) return null;
  return from === to ? String(from) : `${from}-${to}`;
}

export function judgeIngress(address: string, specs: readonly IngressSpec[], findings: Findings): void {
  for (const spec of specs) {
    for (const cidr of spec.cidrs) {
      if (isUnresolvable(cidr)) {
        findings.unresolved.add(`${address}:ingress`);
        continue;
      }
      if (typeof cidr !== "string" || !isOpenCidr(cidr)) continue;
      const port = openPortLabel(spec);
      if (port === null) continue;
      findings.openIngress.set(`${address}|${cidr}|${port}`, { address, port, cidr });
    }
  }
}

/* --------------------------------------------------------------- IAM ----- */

const DOCUMENT_KEYS = new Set(["policy", "policy_document", "inline_policy"]);
const MAX_WALK_DEPTH = 12;
const ADMIN_POLICY_ARN = /^arn:[a-z-]+:iam::aws:policy\/AdministratorAccess$/;

const isWildcardAction = (action: unknown): boolean =>
  typeof action === "string" && (action === "*" || /^[A-Za-z0-9-]+:\*$/.test(action));

/** Indexes of Allow statements that grant `*`/`service:*` (or all-but) actions on `*`. */
function wildcardStatementIndexes(document: Attrs): number[] {
  const raw = document.Statement;
  const statements = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const found: number[] = [];
  statements.forEach((statement, index) => {
    if (!isRecord(statement) || statement.Effect !== "Allow") return;
    const wildAction = asList(statement.Action).some(isWildcardAction) || statement.NotAction !== undefined;
    const wildResource = asList(statement.Resource).some((r) => r === "*");
    if (wildAction && wildResource) found.push(index);
  });
  return found;
}

/** Parse a policy document value; `null` when it cannot be read (masked, unknown, not JSON). */
function readPolicyDocument(value: unknown): Attrs | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || isUnresolvable(value)) return null;
  const text = value.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function walkDocuments(node: unknown, path: string, depth: number, visit: (path: string, value: unknown) => void): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => walkDocuments(child, `${path}[${index}]`, depth + 1, visit));
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    const isDocument =
      DOCUMENT_KEYS.has(key) && (typeof value === "string" || (isRecord(value) && value.Statement !== undefined));
    if (isDocument) visit(here, value);
    else walkDocuments(value, here, depth + 1, visit);
  }
}

function walkStrings(node: unknown, keys: readonly string[], depth: number, visit: (value: string) => void): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(node)) {
    node.forEach((child) => walkStrings(child, keys, depth + 1, visit));
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (keys.includes(key)) asList(value).forEach((v) => typeof v === "string" && visit(v));
    else walkStrings(value, keys, depth + 1, visit);
  }
}

export function judgeIam(address: string, attrs: Attrs, rule: TypeRule, findings: Findings): void {
  if (rule.iamDocuments) {
    walkDocuments(attrs, "", 0, (path, value) => {
      const document = readPolicyDocument(value);
      if (!document) {
        findings.unresolved.add(`${address}:${path}`);
        return;
      }
      for (const index of wildcardStatementIndexes(document)) findings.wildcardIam.add(`${address}#statement[${index}]`);
    });
  }
  if (rule.managedPolicyKeys) {
    walkStrings(attrs, rule.managedPolicyKeys, 0, (arn) => {
      if (ADMIN_POLICY_ARN.test(arn)) findings.wildcardIam.add(`${address}#AdministratorAccess`);
    });
  }
}

/* ---------------------------------------------------------- type tables --- */

const DATABASE = { stateful: true } as const;
const PUBLIC_DATABASE = { stateful: true, publicFlag: "publicly_accessible" } as const;
const INLINE_IAM = { category: "identity", iamDocuments: true } as const;
const MANAGED_ATTACHMENT = { category: "identity", managedPolicyKeys: ["policy_arn", "managed_policy_arn", "managed_policy_arns"] } as const;

/** Exact resource types. Add another provider's types here. */
const TYPE_RULES = new Map<string, TypeRule>([
  // firewalls
  ["aws_security_group", { category: "firewall", ingress: securityGroupBlocks }],
  ["aws_default_security_group", { category: "firewall", ingress: securityGroupBlocks }],
  ["aws_security_group_rule", { category: "firewall", ingress: securityGroupRule }],
  ["aws_vpc_security_group_ingress_rule", { category: "firewall", ingress: vpcIngressRule }],
  ["aws_vpc_security_group_egress_rule", { category: "firewall" }],
  ["aws_network_acl", { category: "firewall", ingress: naclBlocks }],
  ["aws_default_network_acl", { category: "firewall", ingress: naclBlocks }],
  ["aws_network_acl_rule", { category: "firewall", ingress: naclRule }],
  // identity: inline policy documents and managed-policy attachments
  ["aws_iam_policy", INLINE_IAM],
  ["aws_iam_role_policy", INLINE_IAM],
  ["aws_iam_user_policy", INLINE_IAM],
  ["aws_iam_group_policy", INLINE_IAM],
  ["aws_iam_role", { category: "identity", iamDocuments: true, managedPolicyKeys: ["managed_policy_arns"] }],
  ["aws_ssoadmin_permission_set_inline_policy", INLINE_IAM],
  ["aws_iam_role_policy_attachment", MANAGED_ATTACHMENT],
  ["aws_iam_user_policy_attachment", MANAGED_ATTACHMENT],
  ["aws_iam_group_policy_attachment", MANAGED_ATTACHMENT],
  ["aws_iam_policy_attachment", MANAGED_ATTACHMENT],
  ["aws_ssoadmin_managed_policy_attachment", MANAGED_ATTACHMENT],
  // data-bearing (deleting or replacing them loses data) and public-access flags
  ["aws_db_instance", PUBLIC_DATABASE],
  ["aws_rds_cluster_instance", { publicFlag: "publicly_accessible" }],
  ["aws_rds_cluster", DATABASE],
  ["aws_redshift_cluster", PUBLIC_DATABASE],
  ["aws_redshiftserverless_workgroup", { publicFlag: "publicly_accessible" }],
  ["aws_elasticache_cluster", PUBLIC_DATABASE],
  ["aws_elasticache_replication_group", PUBLIC_DATABASE],
  ["aws_elasticache_serverless_cache", DATABASE],
  ["aws_elasticache_global_replication_group", DATABASE],
  ["aws_docdb_cluster", DATABASE],
  ["aws_neptune_cluster", DATABASE],
  ["aws_memorydb_cluster", DATABASE],
  ["aws_opensearch_domain", DATABASE],
  ["aws_elasticsearch_domain", DATABASE],
  ["aws_dynamodb_table", DATABASE],
  ["aws_s3_bucket", DATABASE],
  ["aws_efs_file_system", DATABASE],
  ["aws_ebs_volume", DATABASE],
  ["aws_sqs_queue", DATABASE],
  ["aws_secretsmanager_secret", DATABASE],
  ["aws_kms_key", DATABASE],
]);

/** Whole families of types that share a category. */
const TYPE_PREFIX_RULES: readonly (readonly [string, TypeRule])[] = [
  ["aws_iam_", { category: "identity" }],
  ["aws_ssoadmin_", { category: "identity" }],
  ["aws_route53_", { category: "dns" }],
  ["aws_wafv2_", { category: "firewall" }],
  ["aws_waf_", { category: "firewall" }],
  ["aws_networkfirewall_", { category: "firewall" }],
];

/** The merged rule for a resource type: the exact row over any prefix rows. */
export function ruleFor(type: string): TypeRule {
  let merged: TypeRule = {};
  for (const [prefix, rule] of TYPE_PREFIX_RULES) if (type.startsWith(prefix)) merged = { ...merged, ...rule };
  const exact = TYPE_RULES.get(type);
  return exact ? { ...merged, ...exact } : merged;
}

/* ------------------------------------------------------------- regions ---- */

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const AVAILABILITY_ZONE = /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})[a-z]$/;
const ARN_REGION = /^arn:[a-z-]+:[a-z0-9-]+:([a-z0-9-]+):/;

function awsRegions(attrs: Attrs): string[] {
  const found = new Set<string>();
  const region = asString(attrs.region);
  if (region && REGION.test(region)) found.add(region);
  for (const zone of [...asList(attrs.availability_zone), ...asList(attrs.availability_zones)]) {
    const match = AVAILABILITY_ZONE.exec(asString(zone) ?? "");
    if (match) found.add(match[1]);
  }
  const arnRegion = ARN_REGION.exec(asString(attrs.arn) ?? "")?.[1];
  if (arnRegion && REGION.test(arnRegion)) found.add(arnRegion);
  return [...found];
}

/** How each provider's resources name their region. Add GCP/Azure rows here. */
const PROVIDER_REGIONS: readonly { prefix: string; regions: (attrs: Attrs) => string[] }[] = [
  { prefix: "aws_", regions: awsRegions },
];

/** Regions a planned resource states for itself; empty when unknown or provider unsupported. */
export function regionsOf(type: string, attrs: Attrs): string[] {
  const provider = PROVIDER_REGIONS.find((p) => type.startsWith(p.prefix));
  return provider ? provider.regions(attrs) : [];
}
