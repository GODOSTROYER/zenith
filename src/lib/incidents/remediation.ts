/**
 * Remediation options (spec §21, ADR-0014).
 *
 * For each hypothesis the engine PROPOSES zero or more fixes, each one the
 * exact `CapabilityRequest` a caller would submit to the capability broker.
 * Nothing here executes anything, and the engine never decides that a fix is
 * allowed:
 *
 *   - `approvalRequired` is computed from the policy dry-run port's decision
 *     (`allow` → false; `require_approval` or `deny` → true; a dry-run that
 *     fails → true, because an unanswered policy is not a permission). It is
 *     never assumed from the capability or the environment.
 *   - `risk` is the capability catalog's floor for that capability. Policy may
 *     raise it later; nothing here lowers it. How narrow this particular use is
 *     is stated separately in `blastRadius`.
 *   - A secret VALUE is never part of a proposal: `secret.write` names the
 *     reference, says a person must supply the value, and is flagged
 *     `humanInputRequired`.
 *   - Destructive capabilities (restore, delete, destroy) are never proposed.
 *
 * The `input` objects are the engine's best statement of intent. The executing
 * handler owns their schema and validates them again; treat them as proposals,
 * not as a wire format this module can guarantee.
 */
import { CAPABILITIES, type CapabilityName, type CapabilityRequest } from "@/lib/capabilities/catalog";
import type { PolicyDecision } from "@/lib/policy/types";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { InvestigationPorts } from "./ports";
import { mapPool } from "./probes";
import { sanitizeText } from "./sanitize";
import type { Evidence, Hypothesis, RemediationOption, RemediationPolicy } from "./types";

const RISK_ORDER = ["low", "medium", "high", "critical"] as const;
type Risk = (typeof RISK_ORDER)[number];
const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

export interface Draft {
  key: string;
  title: string;
  capability: CapabilityName;
  resourceId?: string;
  input: Record<string, unknown>;
  risk?: Risk;
  reversibility: string;
  expectedEffect: string;
  blastRadius: NonNullable<RemediationOption["blastRadius"]>;
  humanInputRequired?: boolean;
  manualSteps?: string[];
}

export interface RemediationContext {
  investigationId: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  graph: ResourceGraph;
  evidence: readonly Evidence[];
  ports: Pick<InvestigationPorts, "policyDryRun">;
  timeoutMs: number;
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/* --------------------------------- helpers ---------------------------------- */

const byCheck = (ev: readonly Evidence[], check: string, outcome: Evidence["outcome"], data?: Record<string, unknown>): Evidence[] =>
  ev.filter((e) => e.check === check && e.outcome === outcome && (!data || Object.entries(data).every(([k, v]) => e.data?.[k] === v)));

const nodeOf = (g: ResourceGraph, address: string | undefined): ResourceNode | undefined => g.nodes.find((n) => n.address === address);

const ruleText = (rule: unknown): string => {
  const r = rule as { source?: { address?: string; cidr?: string }; target?: string; port?: number } | undefined;
  return r ? `tcp/${r.port ?? "?"} from ${r.source?.address ?? r.source?.cidr ?? "?"} to ${r.target ?? "?"}` : "the ingress rule";
};

function rollbackDraft(ctx: RemediationContext): Draft | undefined {
  const recent = byCheck(ctx.evidence, "changes.recent", "pass", { recentDeployment: true })[0];
  if (!recent) return undefined;
  const latest = recent.data.latest as { at?: string; kind?: string; operationId?: string | null } | undefined;
  return {
    key: "rollback",
    title: `Roll back the latest deployment${latest?.at ? ` (${latest.at})` : ""}`,
    capability: "deployment.rollback",
    input: { strategy: "previous_revision", ...(latest?.operationId ? { operationId: latest.operationId } : {}) },
    reversibility: "Reversible by redeploying the revision that is rolled back. A rollback does not undo database migrations or data the new revision wrote.",
    expectedEffect: `Returns the environment to the revision that ran before ${latest?.at ?? "the latest deployment"}; failures that began with that rollout should stop once replacement tasks are healthy.`,
    blastRadius: "medium",
  };
}

/* --------------------------------- drafting --------------------------------- */

function unreachable(h: Hypothesis, ctx: RemediationContext, klass: "database" | "cache" | "service" | "internet"): { drafts: Draft[]; steps: string[] } {
  const drafts: Draft[] = [];
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const e of byCheck(ctx.evidence, "firewall.ingress_rule", "fail", { protects: klass })) {
    const address = e.address;
    if (!address || seen.has(address) || !h.supportingEvidence.includes(e.id)) continue;
    seen.add(address);
    const node = nodeOf(ctx.graph, address);
    const rule = ruleText(e.data.rule);
    const dep = String(e.data.dependency ?? "the target");
    const source = (e.data.rule as { source?: { cidr?: string } } | undefined)?.source;
    const client = String(e.data.client ?? source?.cidr ?? "the client");
    if (node?.ownership === "managed") {
      drafts.push({
        key: `repair-${slug(address)}`,
        title: `Re-apply ${address} (ingress ${rule})`,
        capability: "drift.repair",
        resourceId: address,
        input: { address, repair: "reapply_desired", via: "opentofu", drift: e.data.presence === "missing" ? "missing" : "changed", rule: e.data.rule },
        reversibility: "Reversible: the repair adds or restores one ingress rule, and removing it returns the current state. It runs through OpenTofu, so a plan is produced first and the prior state stays in the state history.",
        expectedEffect: `Restores ingress ${rule}, so ${client} can reach ${dep} again; its failures should stop and load balancer targets return to healthy within the retry and health-check interval. No other resource changes.`,
        blastRadius: "low",
      });
    } else {
      steps.push(`${address} is not managed by Zenith, so it cannot be repaired from here. In your cloud account, allow ingress ${rule}.`);
    }
  }
  if (drafts.length === 0 && steps.length === 0)
    steps.push(`The ingress rule to the ${klass === "internet" ? "load balancer" : klass} could not be read, so it is unverified. Check that its firewall/security group allows the traffic the desired graph describes.`);
  return { drafts, steps };
}

function oom(ctx: RemediationContext): { drafts: Draft[]; steps: string[] } {
  const drafts: Draft[] = [];
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const e of byCheck(ctx.evidence, "service.stopped_tasks", "fail", { oom: true })) {
    const address = e.address;
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const spec = nodeOf(ctx.graph, address)?.spec as { memoryMb?: number; size?: string } | undefined;
    const current = typeof spec?.memoryMb === "number" ? spec.memoryMb : undefined;
    const suggested = current !== undefined ? Math.max(current * 2, current + 512) : undefined;
    drafts.push({
      key: `resize-${slug(address)}`,
      title: `Give ${address} more memory, then deploy${suggested ? ` (${current} MB → at least ${suggested} MB)` : ""}`,
      capability: "deployment.deploy",
      input: { proposal: "increase_memory", service: address, ...(spec?.size ? { currentSize: spec.size } : {}), ...(current !== undefined ? { currentMemoryMb: current, suggestedMemoryMb: suggested } : {}) },
      reversibility: "Reversible: deploy the previous size again. A larger size costs more while it runs.",
      expectedEffect: `Tasks of ${address} get headroom above their working set, so they stop being killed for memory. The fix is a manifest size change followed by a deploy; it does not take effect until that deploy runs.`,
      blastRadius: "medium",
      manualSteps: [`Edit the manifest so ${address} uses a larger size${suggested ? ` (at least ${suggested} MB)` : ""}.`, "Review the plan and deploy."],
    });
    drafts.push({
      key: `restart-${slug(address)}`,
      title: `Restart ${address} (temporary mitigation)`,
      capability: "service.restart",
      resourceId: address,
      input: { address },
      reversibility: "A restart cannot be undone, but it is safe to repeat. It only clears memory for a while; the out-of-memory kills will return until the size is raised or the leak is fixed.",
      expectedEffect: `Replaces the tasks of ${address} with fresh ones, which restores service for now. Capacity is briefly reduced while tasks cycle.`,
      blastRadius: "medium",
    });
  }
  steps.push("Find what is using memory: a leak, an unbounded cache, or a limit set too low for the workload.");
  return { drafts, steps };
}

function missingSecret(ctx: RemediationContext): { drafts: Draft[]; steps: string[] } {
  const drafts: Draft[] = [];
  const steps: string[] = [];
  const seen = new Set<string>();
  const add = (address: string, owner: string | undefined) => {
    if (seen.has(address)) return;
    seen.add(address);
    const node = nodeOf(ctx.graph, address);
    const ref = (node?.spec as { secretRef?: string } | undefined)?.secretRef;
    drafts.push({
      key: `secret-${slug(address)}`,
      title: `Provide a value for ${address}${ref ? ` (${sanitizeText(ref, 80)})` : ""}`,
      capability: "secret.write",
      resourceId: address,
      input: { address, ...(ref ? { secretRef: ref } : {}) },
      reversibility: "A value can be rotated or overwritten later. Zenith keeps no copy of what it replaces, so keep the previous value elsewhere if it may be needed.",
      expectedEffect: `${owner ?? "The workload"} can resolve the secret on its next start; tasks that failed to start because of it should come up.`,
      blastRadius: "low",
      humanInputRequired: true,
      manualSteps: [
        `A person sets the value of ${ref ?? address} in Zenith's secret store. Zenith never reads, generates or displays it, and this proposal does not contain it.`,
        `Restart or redeploy ${owner ?? "the service"} so tasks pick it up.`,
      ],
    });
  };
  for (const e of byCheck(ctx.evidence, "secret.present", "fail")) if (e.address) add(e.address, nodeOf(ctx.graph, e.address) ? secretOwner(ctx, e.address) : undefined);

  // a missing environment variable that is bound to a secret reference we did not already cover
  for (const e of byCheck(ctx.evidence, "logs.missing_env", "fail")) {
    const keys = Array.isArray(e.data.envVars) ? (e.data.envVars as unknown[]).map(String) : [];
    const svc = nodeOf(ctx.graph, e.address);
    const env = (svc?.spec as { env?: { key: string; secretRef?: string }[] } | undefined)?.env ?? [];
    for (const k of keys) {
      const bound = env.find((x) => x.key === k && typeof x.secretRef === "string");
      const secret = bound ? ctx.graph.nodes.find((n) => n.kind === "secret" && (n.spec as { secretRef?: string }).secretRef === bound.secretRef) : undefined;
      if (secret) add(secret.address, e.address);
      else steps.push(`${e.address ?? "The service"} logs that ${sanitizeText(k, 64)} is not set. Add it to the service's environment (as a secret reference if it is sensitive), then redeploy.`);
    }
  }
  if (byCheck(ctx.evidence, "logs.db_auth_failure", "fail").length > 0)
    steps.push("The application's database credentials are being rejected. If the database password was rotated, update the secret the service reads and restart the service.");
  return { drafts, steps };
}

function secretOwner(ctx: RemediationContext, secretAddress: string): string | undefined {
  return ctx.graph.edges.find((e) => e.relation === "reads_secret" && e.to === secretAddress)?.from;
}

function iam(ctx: RemediationContext): { drafts: Draft[]; steps: string[] } {
  const drafts: Draft[] = [];
  const steps: string[] = [];
  const seen = new Set<string>();
  const drifted = [...byCheck(ctx.evidence, "drift.changed", "fail", { nodeKind: "identity" }), ...byCheck(ctx.evidence, "drift.missing", "fail", { nodeKind: "identity" })];
  for (const e of drifted) {
    const address = e.address;
    if (!address || seen.has(address)) continue;
    seen.add(address);
    if (nodeOf(ctx.graph, address)?.ownership !== "managed") continue;
    drafts.push({
      key: `repair-${slug(address)}`,
      title: `Re-apply ${address} (restore the desired least-privilege grants)`,
      capability: "drift.repair",
      resourceId: address,
      input: { address, repair: "reapply_desired", via: "opentofu" },
      reversibility: "Reversible through OpenTofu: the plan shows the exact grants that change, and the prior state stays in the state history.",
      expectedEffect: `Restores the grants the desired graph gives ${address}, which were changed or removed outside Zenith. The repair narrows or restores access; it never adds a wildcard.`,
      blastRadius: "medium",
    });
  }
  const reviewed = new Set<string>();
  for (const e of byCheck(ctx.evidence, "identity.access_denied", "fail")) {
    const address = e.address;
    if (!address || reviewed.has(address)) continue;
    reviewed.add(address);
    const actions = Array.isArray(e.data.actions) ? (e.data.actions as unknown[]).map((a) => sanitizeText(a, 80)) : [];
    drafts.push({
      key: `identity-${slug(address)}`,
      title: `Review and grant the missing access for ${address}${actions.length ? ` (${actions.slice(0, 3).join(", ")})` : ""}`,
      capability: "identity.modify",
      resourceId: address,
      input: { address, deniedActions: actions, reviewRequired: true },
      reversibility: "Reversible if the grant is removed again, but until then the workload holds the added access. Review it against least privilege first.",
      expectedEffect: `Lets the workload perform the denied action${actions.length ? ` (${actions.slice(0, 3).join(", ")})` : ""}. Identity changes are critical: Zenith proposes the change and never widens access on its own.`,
      blastRadius: "high",
      humanInputRequired: true,
      manualSteps: [
        "Confirm the denied action is one the application genuinely needs.",
        "Grant the minimum statement that covers it on the exact resource, never a wildcard.",
      ],
    });
  }
  if (drafts.length === 0) steps.push("Find the denied action in the application logs and confirm whether the workload identity should be allowed it.");
  return { drafts, steps };
}

function dns(ctx: RemediationContext): { drafts: Draft[]; steps: string[] } {
  const drafts: Draft[] = [];
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const e of [...byCheck(ctx.evidence, "dns.record_present", "fail"), ...byCheck(ctx.evidence, "dns.record_target", "fail")]) {
    const address = e.address;
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const name = String(e.data.name ?? address);
    if (nodeOf(ctx.graph, address)?.ownership === "managed") {
      drafts.push({
        key: `repair-${slug(address)}`,
        title: `Re-apply ${address} (restore the DNS record for ${sanitizeText(name, 100)})`,
        capability: "drift.repair",
        resourceId: address,
        input: { address, repair: "reapply_desired", via: "opentofu", drift: e.check === "dns.record_present" ? "missing" : "changed" },
        reversibility: "Reversible through OpenTofu: the plan shows the record change, and the previous record is in the state history. DNS caches may delay the effect in both directions.",
        expectedEffect: `Points ${sanitizeText(name, 100)} at the load balancer again. Resolvers pick it up as their cached answer expires.`,
        blastRadius: "low",
      });
    } else steps.push(`${address} is not managed by Zenith. In your DNS provider, point ${sanitizeText(name, 100)} at the load balancer.`);
  }
  for (const e of byCheck(ctx.evidence, "http.dns_resolution", "fail")) if (e.data.host && !seen.size) steps.push(`${sanitizeText(e.data.host, 100)} did not resolve from the prober. Check the record exists in the authoritative zone.`);
  return { drafts, steps };
}

function certificate(ctx: RemediationContext): { drafts: Draft[]; steps: string[] } {
  const drafts: Draft[] = [];
  const steps: string[] = [];
  for (const e of byCheck(ctx.evidence, "tls.certificate_issued", "fail")) {
    const address = e.address;
    const node = nodeOf(ctx.graph, address);
    const domain = String(e.data.domain ?? address);
    if (address && e.data.presence === "missing" && node?.ownership === "managed") {
      drafts.push({
        key: `repair-${slug(address)}`,
        title: `Re-apply ${address} (request the certificate for ${sanitizeText(domain, 100)} again)`,
        capability: "drift.repair",
        resourceId: address,
        input: { address, repair: "reapply_desired", via: "opentofu", drift: "missing" },
        reversibility: "Reversible through OpenTofu: the plan shows the certificate to be created, and it can be removed again. Issuance needs DNS validation to complete.",
        expectedEffect: `Requests a new certificate for ${sanitizeText(domain, 100)}. It becomes usable once validation completes, which can take minutes.`,
        blastRadius: "low",
      });
    } else if (e.data.validation === "dns_manual") {
      steps.push(`The certificate for ${sanitizeText(domain, 100)} uses manual DNS validation (managedDns is off). Create the validation record your provider shows for it.`);
    } else {
      steps.push(`The certificate for ${sanitizeText(domain, 100)} is not issued (status ${sanitizeText(e.data.status ?? "unknown", 40)}). Check that its DNS validation record exists in the zone.`);
    }
  }
  if (byCheck(ctx.evidence, "tls.certificate_expiry", "fail").length > 0)
    steps.push("A certificate is expired or within 14 days of expiry. Certificates with automatic DNS validation renew on their own; if this one is not renewing, check its validation record and re-apply.");
  return { drafts, steps };
}

function capacity(ctx: RemediationContext): { drafts: Draft[]; steps: string[] } {
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (const e of [...byCheck(ctx.evidence, "capacity.cpu", "fail"), ...byCheck(ctx.evidence, "capacity.memory", "fail")]) {
    const address = e.address;
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const steady = byCheck(ctx.evidence, "service.running_vs_desired", "pass").find((x) => x.address === address);
    const desired = typeof steady?.data.desired === "number" ? steady.data.desired : (nodeOf(ctx.graph, address)?.spec as { replicas?: number } | undefined)?.replicas;
    if (typeof desired !== "number" || desired < 1) continue;
    const target = Math.max(desired + 1, Math.ceil(desired * 1.5));
    drafts.push({
      key: `scale-${slug(address)}`,
      title: `Scale ${address} from ${desired} to ${target} tasks`,
      capability: "service.scale",
      resourceId: address,
      input: { address, replicas: target },
      reversibility: `Reversible: scale back to ${desired}. Note that a manifest-managed replica count will be restored by the next deploy unless the manifest is changed too.`,
      expectedEffect: `Adds ${target - desired} task${target - desired === 1 ? "" : "s"} to spread the load, at a proportional increase in running cost while they exist.`,
      blastRadius: "low",
    });
  }
  return { drafts, steps: ["If utilization stays high after scaling out, raise the service size in the manifest (this needs a deploy)."] };
}

/** Drafts and manual follow-ups for one hypothesis. Pure. */
export function draftRemediations(h: Hypothesis, ctx: RemediationContext): { drafts: Draft[]; steps: string[] } {
  switch (h.code) {
    case "db_unreachable_security_group":
      return unreachable(h, ctx, "database");
    case "cache_unreachable_security_group":
      return unreachable(h, ctx, "cache");
    case "service_unreachable_security_group":
      return unreachable(h, ctx, "service");
    case "public_ingress_blocked":
      return unreachable(h, ctx, "internet");
    case "bad_deploy": {
      const d = rollbackDraft(ctx);
      return { drafts: d ? [d] : [], steps: d ? [] : ["The failure looks deployment-related but no recent deployment was recorded. Identify the last good revision and redeploy it."] };
    }
    case "container_crash_oom":
      return oom(ctx);
    case "image_pull_failure": {
      const d = rollbackDraft(ctx);
      return {
        drafts: d ? [d] : [],
        steps: ["Check that the image tag exists in the registry, that the task's identity may pull from it (image_pull grant), and that the registry is reachable from the private subnets."],
      };
    }
    case "missing_secret":
      return missingSecret(ctx);
    case "iam_denied":
      return iam(ctx);
    case "dns_misconfigured":
      return dns(ctx);
    case "certificate_invalid":
      return certificate(ctx);
    case "capacity_saturation":
      return capacity(ctx);
    case "db_down": {
      const status = byCheck(ctx.evidence, "db.available", "fail")[0]?.data.status;
      return {
        drafts: [],
        steps: [
          `Check the database's state at the provider${status ? ` (status ${sanitizeText(status, 48)})` : ""} and its recent events.`,
          "Recovery (start, expand storage, restore from a snapshot) is a human decision; Zenith does not restore or delete databases automatically.",
        ],
      };
    }
    case "lb_no_healthy_targets":
      return {
        drafts: [],
        steps: ["Check the service's health check path and port, that its tasks are running, and that the load balancer's ingress rule to the service is present."],
      };
    case "dependency_unavailable":
      return { drafts: [], steps: ["Check the state of the failing cache, queue or object store at the provider; Zenith proposes no automatic change for it."] };
    case "unknown": {
      const unknown = ctx.evidence.filter((e) => e.outcome === "unknown");
      const failing = ctx.evidence.filter((e) => e.outcome === "fail");
      const steps: string[] = [];
      if (failing.length) steps.push(`Review the failing checks: ${failing.slice(0, 5).map((e) => e.id).join(", ")}.`);
      if (unknown.length) steps.push(`${unknown.length} check${unknown.length === 1 ? "" : "s"} could not be completed (${[...new Set(unknown.map((e) => e.check))].slice(0, 6).join(", ")}). Restoring read access or the signal source would let the investigation conclude.`);
      if (!steps.length) steps.push("Every check on the request path passed. If users still see the problem, widen the investigation: name the affected service or host, or check a path the graph does not model.");
      return { drafts: [], steps };
    }
    default:
      return { drafts: [], steps: [] };
  }
}

/* ------------------------------- policy dry run ------------------------------ */

function toPolicy(d: PolicyDecision): RemediationPolicy {
  return { outcome: d.outcome, reasons: (d.reasons ?? []).map((r) => sanitizeText(r.code, 80)).filter(Boolean).slice(0, 8) };
}

async function dryRun(request: CapabilityRequest, ctx: RemediationContext): Promise<RemediationPolicy> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const decision = await Promise.race([
      Promise.resolve(ctx.ports.policyDryRun(request, { signal: controller.signal })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("policy dry-run timed out"));
        }, ctx.timeoutMs);
      }),
    ]);
    if (!decision || !["allow", "require_approval", "deny"].includes(decision.outcome)) return { outcome: "unavailable", reasons: ["malformed_decision"] };
    return toPolicy(decision);
  } catch {
    return { outcome: "unavailable", reasons: ["dry_run_failed"] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function requestFor(draft: Draft, h: Hypothesis, ctx: RemediationContext): CapabilityRequest {
  const evidenceIds = h.supportingEvidence.slice(0, 8).join(", ");
  return {
    capability: draft.capability,
    scope: {
      workspaceId: ctx.workspaceId,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      environmentId: ctx.environmentId,
      ...(draft.resourceId ? { resourceId: draft.resourceId } : {}),
    },
    input: draft.input,
    reason: `Incident investigation ${ctx.investigationId}: hypothesis ${h.code} (confidence ${h.confidence}). Evidence: ${evidenceIds || "none"}.`.slice(0, 2000),
  };
}

/**
 * Attach remediation options and next steps to each hypothesis. Dry-runs run
 * with bounded concurrency; a failed or timed-out dry-run fails CLOSED
 * (`approvalRequired: true`, policy outcome `unavailable`).
 */
export async function attachRemediations(hypotheses: readonly Hypothesis[], ctx: RemediationContext): Promise<Hypothesis[]> {
  const plans = hypotheses.map((h) => ({ h, ...draftRemediations(h, ctx) }));
  const jobs = plans.flatMap((p, hi) => p.drafts.slice(0, 6).map((draft) => ({ hi, draft, request: requestFor(draft, p.h, ctx) })));
  const decided = await mapPool(jobs, 4, async (job) => ({ job, policy: await dryRun(job.request, ctx) }));

  return plans.map((p, hi) => {
    const remediations: RemediationOption[] = decided
      .filter((d) => d.job.hi === hi)
      .map(({ job, policy }) => {
        const catalogRisk = CAPABILITIES[job.draft.capability].risk as Risk;
        return {
          id: `rem:${p.h.code}:${job.draft.key}`,
          title: job.draft.title,
          request: job.request,
          risk: maxRisk(catalogRisk, job.draft.risk ?? "low"),
          approvalRequired: policy.outcome !== "allow",
          reversibility: job.draft.reversibility,
          expectedEffect: job.draft.expectedEffect,
          blastRadius: job.draft.blastRadius,
          policy,
          ...(job.draft.humanInputRequired ? { humanInputRequired: true } : {}),
          ...(job.draft.manualSteps ? { manualSteps: job.draft.manualSteps } : {}),
        };
      });
    return { ...p.h, remediations, ...(p.steps.length ? { nextSteps: [...new Set(p.steps)].slice(0, 8) } : {}) };
  });
}
