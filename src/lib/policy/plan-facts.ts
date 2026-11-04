/**
 * Deterministic plan analysis: `NormalizedPlan` -> `PlanFacts` (spec §14).
 *
 * The policy engine never reads a plan; it reads these facts. The extraction is
 * a pure function of the plan — no clock, no network, no environment — and
 * every list in the result is sorted and de-duplicated, so the same plan always
 * yields the same facts and therefore the same policy input digest.
 *
 * What each fact means, and what it deliberately does not claim, is documented
 * in `plan-rules.ts` (the per-type rule table). The short version: facts are
 * derived from what the normalized plan reports; a value that is masked or
 * unknown until apply is reported under `unresolved` rather than guessed, and a
 * region that is not stated by the resource is left out, not inferred.
 *
 * The counts (`create` … `replace`) are recomputed from the resource changes,
 * not copied from `plan.summary`, so a normalizer bug cannot desynchronize the
 * facts from the changes they describe. `read` and `no-op` changes are not
 * changes and contribute nothing.
 */
import type { NormalizedPlan, PlanResourceChange, TofuAction } from "@/lib/tofu/types";
import { isUnresolvable, materializeAfter } from "./plan-attributes";
import { judgeIam, judgeIngress, newFindings, regionsOf, ruleFor, type ChangeCategory, type Findings } from "./plan-rules";
import type { PlanFacts } from "./types";

const CHANGING: ReadonlySet<TofuAction> = new Set(["create", "update", "delete", "replace"]);
const DESTROYING: ReadonlySet<TofuAction> = new Set(["delete", "replace"]);
const CREATING: ReadonlySet<TofuAction> = new Set(["create", "update", "replace"]);
// Records only: deleting a zone or another DNS object is not a record deletion.
const DNS_RECORD_TYPE = /^(?:aws_route53_record|google_dns_record_set|azurerm_dns_[a-z0-9_]+_record|oci_dns_rrset)$/;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);

/** Judge one created/updated/replaced resource's planned attributes into `findings`. */
function analyzePlannedResource(change: PlanResourceChange, findings: Findings, regions: Set<string>): void {
  const rule = ruleFor(change.type);
  const attrs = materializeAfter(change.changes);

  for (const region of regionsOf(change.type, attrs)) regions.add(region);

  if (rule.publicFlag) {
    const flag = attrs[rule.publicFlag];
    if (flag === true) findings.publicDatabases.add(change.address);
    else if (isUnresolvable(flag)) findings.unresolved.add(`${change.address}:${rule.publicFlag}`);
  }

  if (rule.ingress) {
    const specs = rule.ingress(attrs, (attribute) => findings.unresolved.add(`${change.address}:${attribute}`));
    judgeIngress(change.address, specs, findings);
  }

  if (rule.iamDocuments || rule.managedPolicyKeys) judgeIam(change.address, attrs, rule, findings);
}

/** Extract policy facts from a normalized OpenTofu plan. */
export function extractPlanFacts(plan: NormalizedPlan): PlanFacts {
  const counts = { create: 0, update: 0, delete: 0, replace: 0 };
  const destroyedStateful = new Set<string>();
  const deletedDns = new Set<string>();
  const regions = new Set<string>();
  const categories: Record<ChangeCategory, Set<string>> = { identity: new Set(), firewall: new Set(), dns: new Set() };
  const findings = newFindings();

  for (const change of plan.resourceChanges) {
    if (!CHANGING.has(change.action)) continue;
    counts[change.action as keyof typeof counts] += 1;

    const rule = ruleFor(change.type);
    if (rule.category) categories[rule.category].add(change.address);
    if (DESTROYING.has(change.action) && (change.destroysData || rule.stateful)) destroyedStateful.add(change.address);
    if (DESTROYING.has(change.action) && DNS_RECORD_TYPE.test(change.type)) deletedDns.add(change.address);
    if (CREATING.has(change.action)) analyzePlannedResource(change, findings, regions);
  }

  const openIngress = [...findings.openIngress.values()].sort(
    (a, b) => compare(a.address, b.address) || compare(a.cidr, b.cidr) || compare(a.port, b.port)
  );

  return {
    ...counts,
    destroysData: destroyedStateful.size > 0,
    destroyedStatefulAddresses: sortedUnique(destroyedStateful),
    statefulDeletes: sortedUnique(destroyedStateful),
    dnsDeletes: sortedUnique(deletedDns),
    regions: sortedUnique(regions),
    publicDatabases: sortedUnique(findings.publicDatabases),
    openIngress,
    wildcardIam: sortedUnique(findings.wildcardIam),
    identityChanges: sortedUnique(categories.identity),
    firewallChanges: sortedUnique(categories.firewall),
    dnsChanges: sortedUnique(categories.dns),
    unresolved: sortedUnique(findings.unresolved),
  };
}
