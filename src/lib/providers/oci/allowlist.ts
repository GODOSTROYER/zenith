/**
 * The OCI requests each capability may make through the runner, as data.
 *
 * This is the contract both sides enforce (RUNNER-PROTOCOL-OCI.md §6): the
 * control plane refuses to build a job outside it (`isAllowed`), and the
 * runner must refuse the same requests locally — the control plane's check is
 * a convenience, the runner's is the boundary. The table is derived from what
 * the drivers actually call; `tests/providers/oci/allowlist.test.ts` runs every
 * driver read and operation against a recording transport and fails if a call
 * falls outside its capability's rules, and checks the protocol document
 * lists every pattern here. Signal read capabilities permit two fixed read-only
 * POST queries from the OCI API reference, tested separately from driver GETs.
 *
 * Pattern syntax: `/`-separated segments after the API version; `{}` matches
 * exactly one non-empty, already-encoded segment. There is deliberately NO
 * wildcard segment. DELETE has one migration cleanup rule with an additional runner receipt guard.
 *
 * Never allowed, for any capability (enforced by absence, asserted in tests):
 *   - secret BUNDLE retrieval (`/20190301/secretbundles`): Zenith and the
 *     runner never read a secret value back;
 *   - object-level Object Storage (`/n/{ns}/b/{bucket}/o/…`): customer data;
 *   - IAM writes, `changeCompartment`, general resource deletion, secret deletion.
 */
import { OCI_SERVICE_HOSTS, type OciServiceId } from "./services";
import type { OciApiRequest, OciHttpMethod } from "./transport";

export interface OciAllowRule {
  service: OciServiceId;
  method: OciHttpMethod;
  /** path after the API version, e.g. `vcns/{}` */
  pattern: string;
}

const get = (service: OciServiceId, ...patterns: string[]): OciAllowRule[] => patterns.map((pattern) => ({ service, method: "GET", pattern }));

/** Read-only calls behind observe / runtime / verify / discover. */
export const OBSERVE_RULES: readonly OciAllowRule[] = [
  ...get("core", "vcns", "vcns/{}", "subnets", "subnets/{}", "internetGateways", "natGateways", "networkSecurityGroups", "networkSecurityGroups/{}/securityRules", "volumes", "volumes/{}", "instances", "instances/{}"),
  ...get("loadbalancer", "loadBalancers", "loadBalancers/{}", "loadBalancers/{}/health", "loadBalancers/{}/backendSets/{}/health"),
  ...get("certificates", "certificates", "certificates/{}"),
  ...get("dns", "zones", "zones/{}", "zones/{}/records/{}/{}"),
  ...get("containerinstances", "containerInstances", "containerInstances/{}", "containers/{}"),
  ...get("artifacts", "container/repositories", "container/repositories/{}"),
  ...get("postgresql", "dbSystems", "dbSystems/{}"),
  ...get("objectstorage", "n", "n/{}/b", "n/{}/b/{}"),
  ...get("queue", "queues", "queues/{}"),
  ...get("queue-data", "queues/{}/stats"),
  ...get("vault", "secrets", "secrets/{}"),
  ...get("identity", "dynamicGroups", "dynamicGroups/{}", "policies"),
  ...get("logging", "logGroups", "logGroups/{}", "logGroups/{}/logs"),
  ...get("redis", "redisClusters", "redisClusters/{}"),
  ...get("containerengine", "clusters", "clusters/{}", "nodePools", "nodePools/{}"),
  ...get("mysql", "dbSystems", "dbSystems/{}"),
];

/**
 * Compartment-scoped work-request listings (deletion/replacement evidence,
 * work-requests.ts). Listings carry `compartmentId`, so the runner can bind
 * them; by-id reads cannot be bound outside the runner's own receipt journal.
 * GET only; infrastructure.observe and incident.investigate (the two stay equal), not topology.
 */
const WORK_REQUEST_LISTS: readonly OciAllowRule[] = [
  ...get("containerinstances", "workRequests"),
  ...get("postgresql", "workRequests"),
  ...get("redis", "workRequests"),
  ...get("containerengine", "workRequests"),
  ...get("queue", "workRequests"),
  ...get("logging", "workRequests"),
];

const FIREWALL_INSPECT: readonly OciAllowRule[] = get("core", "networkSecurityGroups", "networkSecurityGroups/{}/securityRules");
const LOG_READ_RULE: OciAllowRule = { service: "loggingsearch", method: "POST", pattern: "search" };
const METRIC_READ_RULE: OciAllowRule = { service: "monitoring", method: "POST", pattern: "metrics/actions/summarizeMetricsData" };
/** Live DNS target checks during normal plan/final-plan/exact apply; GET only. */
const DNS_DELETION_READS: readonly OciAllowRule[] = [
  ...get("dns", "zones/{}", "zones/{}/records/{}/{}"),
  ...get("loadbalancer", "loadBalancers", "loadBalancers/{}"),
];

export const OCI_ALLOWLIST: Readonly<Record<string, readonly OciAllowRule[]>> = {
  "infrastructure.plan": DNS_DELETION_READS,
  "infrastructure.apply": DNS_DELETION_READS,
  "deployment.rollback": DNS_DELETION_READS,
  "infrastructure.observe": [
    ...OBSERVE_RULES,
    // Read-only query APIs; POST does not imply a mutation.
    LOG_READ_RULE,
    METRIC_READ_RULE,
  ].concat(WORK_REQUEST_LISTS),
  "topology.read": OBSERVE_RULES,
  "incident.investigate": [...OBSERVE_RULES, LOG_READ_RULE, METRIC_READ_RULE].concat(WORK_REQUEST_LISTS),
  "logs.read": [LOG_READ_RULE],
  "metrics.read": [METRIC_READ_RULE],
  "firewall.inspect": FIREWALL_INSPECT,
  // Images are immutable; only the migration launch needs a write. Workload
  // replacement stays in the reviewed OpenTofu plan, never a fabricated PUT.
  "deployment.deploy": [
    ...DNS_DELETION_READS,
    ...get("containerinstances", "containerInstances", "containerInstances/{}", "containers/{}"),
    // Work-request receipt reads. The runner additionally restricts these to ids
    // recorded in its own journal for the signed workspace and operation.
    ...get("containerinstances", "workRequests/{}"),
    ...get("core", "vnics/{}"),
    { service: "containerinstances", method: "POST", pattern: "containerInstances" },
    { service: "containerinstances", method: "DELETE", pattern: "containerInstances/{}" },
  ],
  "service.restart": [...get("containerinstances", "containerInstances"), { service: "containerinstances", method: "POST", pattern: "containerInstances/{}/actions/restart" }],
  "database.snapshot": [...get("postgresql", "dbSystems", "dbSystems/{}"), { service: "postgresql", method: "POST", pattern: "backups" }],
  "secret.write": [...get("vault", "secrets", "secrets/{}"), { service: "vault", method: "PUT", pattern: "secrets/{}" }],
};

export function ruleMatches(rule: OciAllowRule, req: Pick<OciApiRequest, "service" | "method" | "path">): boolean {
  if (rule.service !== req.service || rule.method !== req.method) return false;
  const version = OCI_SERVICE_HOSTS[req.service].version;
  const segments = req.path.split("/").slice(1);
  const rest = version ? (segments[0] === version ? segments.slice(1) : undefined) : segments;
  if (!rest) return false;
  const want = rule.pattern.split("/");
  if (want.length !== rest.length) return false;
  return want.every((w, i) => (w === "{}" ? rest[i].length > 0 : w === rest[i]));
}

/** May `capability` make this request? Unknown capabilities may make none. */
export function isAllowed(capability: string, req: Pick<OciApiRequest, "service" | "method" | "path">): boolean {
  return (OCI_ALLOWLIST[capability] ?? []).some((r) => ruleMatches(r, req));
}

/** `service METHOD /<version>/<pattern>` lines, for the protocol document and tests. */
export function describeRule(rule: OciAllowRule): string {
  const version = OCI_SERVICE_HOSTS[rule.service].version;
  return `${rule.service} ${rule.method} /${[...(version ? [version] : []), rule.pattern].join("/")}`;
}
