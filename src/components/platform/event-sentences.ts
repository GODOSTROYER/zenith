/**
 * One human sentence per control-plane event type, plus the grouping rules the
 * timeline uses. Pure; `import type` only.
 *
 * `event.data` is a redacted, bounded summary written by other subsystems and
 * some of its strings originate outside Zenith (cloud responses, tool output).
 * It is treated as data: only a few known keys are read, only when they are
 * strings, they are length-bounded, and they are rendered as text, never as
 * markup and never as an instruction. Nothing that looks like a secret path is
 * shown. A sentence never claims more than the event type says: `resource.applied`
 * is "the provider accepted the change", not "the change is verified".
 */
import type { PlatformEvent, PlatformEventType } from "@/lib/controlplane/types";
import type { DotStatus } from "@/components/ui/status-dot";
import { UNCERTAIN_EXPLANATION } from "./labels";
import { isSecretishPath, truncate } from "./text";

export interface EventDescription {
  sentence: string;
  /** the dot colour; `idle` for neutral bookkeeping */
  tone: DotStatus;
  /** the event says it came from a simulation */
  simulated: boolean;
  /** one bounded line of context from the event's own data, when it has one */
  detail?: string;
}

type Data = Record<string, unknown>;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function str(data: Data, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.trim() !== "" ? truncate(v.replace(CONTROL_CHARS, " ").trim(), 240) : undefined;
}

const OUTCOME_SENTENCE: Record<string, string> = {
  allow: "Policy allowed the request.",
  deny: "Policy blocked the request.",
  require_approval: "Policy requires a person's approval before this runs.",
};

type Rule = { sentence: (who: string, d: Data) => string; tone: DotStatus };

const RULES: Record<PlatformEventType, Rule> = {
  "operation.proposed": { sentence: (w) => `${w} proposed this change.`, tone: "idle" },
  "operation.prepared": { sentence: () => "Zenith prepared the change for execution.", tone: "idle" },
  "operation.approved": { sentence: (w) => `${w} approved this proposal.`, tone: "ok" },
  "operation.rejected": { sentence: (w) => `${w} rejected this proposal. Nothing was changed.`, tone: "idle" },
  "operation.denied": { sentence: () => "Policy blocked this change before it ran.", tone: "err" },
  "operation.started": { sentence: () => "Execution started.", tone: "info" },
  "operation.succeeded": { sentence: () => "Execution finished without an error.", tone: "ok" },
  "operation.failed": { sentence: () => "Execution failed.", tone: "err" },
  "operation.uncertain": { sentence: () => UNCERTAIN_EXPLANATION, tone: "warn" },
  "operation.cancelled": { sentence: () => "The operation was cancelled.", tone: "idle" },
  "policy.evaluated": {
    sentence: (_w, d) => OUTCOME_SENTENCE[String(d.outcome)] ?? "Policy evaluated the request.",
    tone: "idle",
  },
  "workflow.started": { sentence: () => "The workflow that carries out this change started.", tone: "info" },
  "workflow.completed": { sentence: () => "The workflow finished.", tone: "idle" },
  "lease.acquired": {
    sentence: () => "Zenith took an exclusive lock on the target so nothing else changes it at the same time.",
    tone: "idle",
  },
  "lease.lost": {
    sentence: () => "Zenith lost its exclusive lock on the target. The operation had to stop and will be reconciled.",
    tone: "err",
  },
  "lease.released": { sentence: () => "Zenith released the exclusive lock on the target.", tone: "idle" },
  "credential.assumed": { sentence: () => "Short-lived cloud access was granted for this step.", tone: "idle" },
  "credential.denied": { sentence: () => "The cloud account refused Zenith's access for this step.", tone: "err" },
  "resource.planned": { sentence: () => "A plan for the change was produced.", tone: "idle" },
  "resource.applying": { sentence: () => "Zenith is applying the change at the provider.", tone: "info" },
  "resource.applied": { sentence: () => "The provider accepted the change.", tone: "idle" },
  "resource.verified": { sentence: () => "Zenith checked the result against the provider.", tone: "ok" },
  "resource.observed": { sentence: () => "Zenith read the current state of the resource.", tone: "idle" },
  "deployment.healthy": { sentence: () => "The deployment reports healthy.", tone: "ok" },
  "deployment.unhealthy": { sentence: () => "The deployment reports unhealthy.", tone: "err" },
  "drift.detected": {
    sentence: () => "Zenith found that the real infrastructure differs from the desired configuration.",
    tone: "warn",
  },
  "drift.cleared": { sentence: () => "Drift was cleared: the real infrastructure matches the configuration again.", tone: "ok" },
  "incident.opened": { sentence: () => "An incident was opened.", tone: "warn" },
  "incident.investigated": { sentence: () => "Zenith investigated the incident.", tone: "idle" },
  "incident.resolved": { sentence: () => "The incident was resolved.", tone: "ok" },
  "incident.escalated": { sentence: () => "The incident was escalated to a person.", tone: "warn" },
  "incident.remediation_blocked": { sentence: () => "An automatic fix was held back by incident safety limits.", tone: "warn" },
  "incident.postmortem_recorded": { sentence: () => "A postmortem was recorded for the incident.", tone: "idle" },
  "remediation.proposed": { sentence: () => "A fix was proposed.", tone: "idle" },
  "remediation.approved": { sentence: (w) => `${w} approved the fix.`, tone: "ok" },
  "remediation.completed": { sentence: () => "The fix finished.", tone: "idle" },
  "runner.registered": { sentence: () => "A runner in your network registered with Zenith.", tone: "idle" },
  "runner.revoked": { sentence: () => "A runner's access was revoked.", tone: "warn" },
  "runner.job.dispatched": { sentence: () => "A job was sent to a runner.", tone: "idle" },
  "runner.job.completed": { sentence: () => "A runner finished a job.", tone: "idle" },
  "machine.registered": { sentence: () => "A machine registered with Zenith.", tone: "idle" },
  "machine.revoked": { sentence: () => "A machine's access was revoked.", tone: "warn" },
  "machine.request.completed": { sentence: () => "A request to a machine completed.", tone: "idle" },
};

/** Keys whose string value is worth surfacing as one line of context. */
const DETAIL_KEYS = ["message", "error", "reason"] as const;

export function describeEvent(event: PlatformEvent): EventDescription {
  const rule = RULES[event.type] as Rule | undefined;
  const who = event.actor?.name?.trim() || "Zenith";
  const data: Data = event.data ?? {};
  const simulated = data.simulated === true;
  if (!rule) {
    // A newer server may emit a type this build does not know. Say so plainly
    // instead of inventing a sentence for it.
    return {
      sentence: "Zenith recorded an event this version of the interface does not describe.",
      tone: "idle",
      simulated,
    };
  }
  let detail: string | undefined;
  for (const key of DETAIL_KEYS) {
    const v = str(data, key);
    if (v) {
      detail = v;
      break;
    }
  }
  let tone = rule.tone;
  // A simulated "verified" is not verification of anything real.
  if (simulated && tone === "ok") tone = "info";
  const sentence =
    event.type === "resource.verified" && simulated
      ? "The simulated result was checked. No real infrastructure was read."
      : rule.sentence(who, data);
  return { sentence, tone, simulated, ...(detail ? { detail } : {}) };
}

/** Scalar entries of an event's data that are safe to list: no secret-looking keys, bounded. */
export function safeDataEntries(data: Data | undefined, limit = 12): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(data ?? {})) {
    if (out.length >= limit) break;
    if (isSecretishPath(key)) continue;
    if (typeof value === "string") out.push({ key, value: truncate(value.replace(CONTROL_CHARS, " "), 200) });
    else if (typeof value === "number" || typeof value === "boolean") out.push({ key, value: String(value) });
  }
  return out;
}

export interface EventGroup {
  correlationId: string;
  events: PlatformEvent[];
}

/**
 * Chronological events grouped by correlation id. Events within a group are in
 * sequence order; groups are ordered by their first event. Duplicate events
 * (same id) are dropped so a replayed stream cannot double-print a step.
 */
export function groupByCorrelation(events: readonly PlatformEvent[]): EventGroup[] {
  const seen = new Set<string>();
  const sorted = events
    .filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    })
    .sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, EventGroup>();
  for (const e of sorted) {
    const g = groups.get(e.correlationId) ?? { correlationId: e.correlationId, events: [] };
    g.events.push(e);
    groups.set(e.correlationId, g);
  }
  return [...groups.values()];
}
