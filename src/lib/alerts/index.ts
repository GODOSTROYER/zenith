/**
 * Alert rules: a condition, an in-product record, and nothing else.
 *
 * Honesty rules, in order of importance:
 *
 *  - **Delivery is real, and only as real as it is.** A rule that fires writes
 *    an AlertEvent *and* one outbox row per selected channel, in the same save,
 *    and `./deliver` pushes it to the workspace's channels — webhook, Slack,
 *    and email when SMTP is configured. A workspace with no channels is still
 *    in-product only, and the screens say which of the two it is rather than
 *    implying delivery either way. Every attempt is recorded on the event
 *    (`deliveries`), successes and failures alike; a crash between the event
 *    and the send is replayed at the next boot rather than lost. There is no
 *    paging and no on-call rotation. docs/LIMITATIONS.md keeps the boundary.
 *  - **Same inputs as the screens.** Health comes from `@/lib/logsim` — exactly
 *    what the health cards render — cost from the price table, deploy outcomes
 *    from the durable deployment records. An alert can never disagree with the
 *    page it sits on, because it reads the page's own data.
 *  - **Simulated stays labelled.** `AlertEvent.simulated` is true whenever the
 *    condition read generated or estimated data, which today is every kind
 *    except a deployment failure on a non-sandbox provider.
 *
 * Evaluation is derived, not remembered: the condition is recomputed from
 * durable records every time, so a restart re-derives the same answer. The only
 * thing stored is the event log — one open event per rule, closed when the
 * condition clears.
 *
 * ponytail: no per-rule schedule and no hysteresis. A rule is evaluated on the
 * one 15s timer and on read; a condition that flaps faster than that produces
 * one event per flap. Add a "for N consecutive evaluations" field to AlertRule
 * if that ever gets noisy.
 */
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { db, q, save } from "@/lib/db/store";
import {
  id,
  type Actor,
  type AlertChannel,
  type AlertEvent,
  type AlertKind,
  type AlertRule,
  type Deployment,
  type DeploymentStatus,
  type Environment,
} from "@/lib/domain/types";
import { environmentHealth } from "@/lib/logsim";
import { log } from "@/lib/log";
import { findChannel } from "./channels";
import { queueDelivery } from "./deliver";

export * from "./channels";
export * from "./deliver";

/**
 * The two collections were added after stores already existed on disk (and in
 * a running process's memory), so a snapshot loaded before them has no arrays.
 * Backfill in place: the next save() persists them.
 */
function tables(): { rules: AlertRule[]; events: AlertEvent[] } {
  const d = db() as ReturnType<typeof db> & { alertRules?: AlertRule[]; alertEvents?: AlertEvent[] };
  d.alertRules ??= [];
  d.alertEvents ??= [];
  return { rules: d.alertRules, events: d.alertEvents };
}

/**
 * How often the background evaluator runs. Modest on purpose: the loop returns
 * immediately when the workspace has no rules, and one pass over every rule is
 * a health computation per environment — the same one the Observe page asks for
 * every 5 seconds while it is open. The timer is `unref`'d, so it never holds
 * the process open for a script or a test run.
 */
export const EVALUATION_INTERVAL_MS = 15_000;

/** Recent history kept alongside the open events in the summary response. */
const RECENT_EVENTS = 20;

const iso = (at: number) => new Date(at).toISOString();

/* --------------------------------- catalog -------------------------------- */

export interface ThresholdSpec {
  label: string;
  /** used when a rule leaves `threshold` unset */
  default: number;
  min: number;
  max: number;
  unit: string;
}

export interface AlertKindSpec {
  title: string;
  /** what the evaluator actually looks at, in one phrase */
  watches: string;
  severity: AlertEvent["severity"];
  threshold?: ThresholdSpec;
}

/** The vocabulary. UI copy, plan details and docs all read from here. */
export const ALERT_KINDS: Record<AlertKind, AlertKindSpec> = {
  health_degraded: {
    title: "A service is degraded",
    watches:
      "the health Zenith computes for every managed service in this environment, and the transitions it recorded in the last hour",
    severity: "medium",
  },
  deploy_failed: {
    title: "A deployment failed",
    watches: "the newest deployment to this environment that reached a final state",
    severity: "high",
  },
  budget_exceeded: {
    title: "Cost reached the budget",
    watches:
      "the estimated monthly cost of what is running here, against the environment's budget",
    severity: "medium",
    threshold: {
      label: "Fires at this percent of the budget",
      default: 100,
      min: 1,
      max: 500,
      unit: "%",
    },
  },
  replicas_below: {
    title: "Ready replicas below a floor",
    watches: "how many replicas of each managed service are passing their health probe",
    severity: "high",
    threshold: {
      label: "Minimum ready replicas per service",
      default: 1,
      min: 1,
      max: 10,
      unit: " replicas",
    },
  },
};

export const thresholdOf = (rule: Pick<AlertRule, "kind" | "threshold">): number | undefined => {
  const spec = ALERT_KINDS[rule.kind].threshold;
  if (!spec) return undefined;
  return rule.threshold ?? spec.default;
};

/* -------------------------------- conditions ------------------------------- */

export interface AlertCondition {
  firing: boolean;
  /** one line, written for both outcomes — the all-clear says why it is clear */
  summary: string;
  detail: string;
  severity: AlertEvent["severity"];
  /** true when the inputs were generated or estimated rather than measured */
  simulated: boolean;
}

const TERMINAL: DeploymentStatus[] = ["succeeded", "failed", "cancelled", "rolled_back"];

const SIMULATED_NOTE =
  "Health here is generated by Zenith's log simulator from the deployed revision — nothing was measured against a running process.";

const COST_NOTE = "Cost is an estimate from the price table, not a bill.";

/** Service names come from the revision that is actually running. */
function serviceName(env: Environment, serviceId: string): string {
  const revision = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
  return revision?.manifest.services.find((s) => s.id === serviceId)?.name ?? serviceId;
}

function newestFinished(environmentId: string): Deployment | undefined {
  return db()
    .deployments.filter((d) => d.environmentId === environmentId && TERMINAL.includes(d.status))
    .sort((a, b) => ((a.endedAt ?? a.createdAt) < (b.endedAt ?? b.createdAt) ? 1 : -1))[0];
}

function healthCondition(rule: AlertRule, env: Environment): AlertCondition {
  const services = Object.entries(environmentHealth(env.id));
  const degraded = services.filter(([, h]) => h.status === "degraded");
  const base = { severity: ALERT_KINDS[rule.kind].severity, simulated: true };

  if (services.length === 0)
    return {
      ...base,
      firing: false,
      summary: `Nothing is running in ${env.name}, so no service can be degraded.`,
      detail: `${env.name} has no deployed revision with managed services. Deploy it and this rule starts watching. ${SIMULATED_NOTE}`,
    };
  if (degraded.length === 0)
    return {
      ...base,
      firing: false,
      summary: `All ${services.length} managed service${services.length === 1 ? "" : "s"} in ${env.name} are healthy.`,
      detail: SIMULATED_NOTE,
    };

  const names = degraded.map(([sid]) => serviceName(env, sid));
  return {
    ...base,
    firing: true,
    summary: `${names.join(", ")} degraded in ${env.name}.`,
    detail: [
      ...degraded.map(([sid, h]) => `${serviceName(env, sid)}: ${h.reason}`),
      SIMULATED_NOTE,
    ].join(" "),
  };
}

function deployCondition(rule: AlertRule, env: Environment): AlertCondition {
  const last = newestFinished(env.id);
  const providerId = q.connection(env.connectionId)?.provider ?? "sandbox";
  // A sandbox deployment created nothing, so its failure is a simulated one.
  // Any other adapter really ran the steps that failed.
  const base = { severity: ALERT_KINDS[rule.kind].severity, simulated: providerId === "sandbox" };

  if (!last)
    return {
      ...base,
      firing: false,
      summary: `No deployment to ${env.name} has finished yet.`,
      detail: "This rule fires when the newest finished deployment ends in failure.",
    };
  if (last.status !== "failed")
    return {
      ...base,
      firing: false,
      summary: `The newest deployment to ${env.name} ${last.status}.`,
      detail: `${last.changeSummary || "The last deployment"} finished as ${last.status}.`,
    };

  const revision = q.revision(last.revisionId);
  return {
    ...base,
    firing: true,
    summary: `Deployment of r${revision?.number ?? "?"} to ${env.name} failed.`,
    detail: [
      last.error ?? "The deployment failed without recording an error.",
      `Open it under Deploys for the step that failed. This clears when a later deployment to ${env.name} finishes without failing.`,
    ].join(" "),
  };
}

function budgetCondition(rule: AlertRule, env: Environment): AlertCondition {
  const base = { severity: ALERT_KINDS[rule.kind].severity, simulated: true };
  const budget = env.policies.budgetUsdMonthly;
  if (!budget)
    return {
      ...base,
      firing: false,
      summary: `${env.name} has no budget, so there is nothing to compare against.`,
      detail:
        "Set a monthly budget in Settings → Environments for this rule to do anything. Until then it can never fire.",
    };

  const running = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
  const manifest = running?.manifest ?? q.project(env.projectId)?.workingManifest;
  if (!manifest)
    return {
      ...base,
      firing: false,
      summary: `${env.name} has no system to price.`,
      detail: "The project this environment belongs to no longer exists.",
    };

  const cost = monthlyCostUsd(manifest);
  const at = Math.round((cost / budget) * 100);
  const threshold = thresholdOf(rule)!;
  const what = running
    ? `r${running.number}, the revision running in ${env.name}`
    : `the working copy — nothing is deployed to ${env.name} yet`;
  const money = `$${cost.toFixed(2)} of the $${budget.toFixed(2)} budget (${at}%), priced from ${what}.`;

  return {
    ...base,
    firing: at >= threshold,
    summary:
      at >= threshold
        ? `${env.name} is at ${at}% of its budget (threshold ${threshold}%).`
        : `${env.name} is at ${at}% of its budget, under the ${threshold}% threshold.`,
    detail: `${money} ${COST_NOTE}`,
  };
}

function replicaCondition(rule: AlertRule, env: Environment): AlertCondition {
  const base = { severity: ALERT_KINDS[rule.kind].severity, simulated: true };
  const floor = thresholdOf(rule)!;
  const services = Object.entries(environmentHealth(env.id));
  if (services.length === 0)
    return {
      ...base,
      firing: false,
      summary: `Nothing is running in ${env.name}, so there are no replicas to count.`,
      detail: `Deploy ${env.name} and this rule starts watching. ${SIMULATED_NOTE}`,
    };

  const short = services.filter(([, h]) => h.replicasReady < floor);
  if (short.length === 0)
    return {
      ...base,
      firing: false,
      summary: `Every managed service in ${env.name} has at least ${floor} ready replica${floor === 1 ? "" : "s"}.`,
      detail: SIMULATED_NOTE,
    };

  return {
    ...base,
    firing: true,
    summary: `${short.map(([sid]) => serviceName(env, sid)).join(", ")} below ${floor} ready replica${floor === 1 ? "" : "s"} in ${env.name}.`,
    detail: [
      ...short.map(
        ([sid, h]) =>
          `${serviceName(env, sid)}: ${h.replicasReady} of ${h.replicasDesired} ready.`
      ),
      SIMULATED_NOTE,
    ].join(" "),
  };
}

/**
 * Evaluate one rule against the current state. Pure with respect to the store:
 * it reads, it never writes, and it never throws — the evaluator runs on a
 * timer, so a rule pointing at a deleted environment reports that instead.
 */
export function evaluateRule(rule: AlertRule): AlertCondition {
  const env = q.environment(rule.environmentId);
  if (!env)
    return {
      firing: false,
      summary: "The environment this rule watches no longer exists.",
      detail: `Delete this rule, or recreate the environment it was made for. It cannot fire while its environment is missing.`,
      severity: ALERT_KINDS[rule.kind].severity,
      simulated: true,
    };
  switch (rule.kind) {
    case "health_degraded":
      return healthCondition(rule, env);
    case "deploy_failed":
      return deployCondition(rule, env);
    case "budget_exceeded":
      return budgetCondition(rule, env);
    case "replicas_below":
      return replicaCondition(rule, env);
  }
}

/* --------------------------------- record --------------------------------- */

export const openEventFor = (ruleId: string): AlertEvent | undefined =>
  tables().events.find((e) => e.ruleId === ruleId && !e.resolvedAt);

/**
 * Close a rule's open event, if it has one. Used when the condition clears and
 * when the rule stops watching (disabled, deleted) — a record that stays open
 * for a rule nobody is evaluating would be a lie.
 */
export function resolveOpen(ruleId: string, reason: string, at = Date.now()): boolean {
  const open = openEventFor(ruleId);
  if (!open) return false;
  open.resolvedAt = iso(at);
  open.resolvedReason = reason;
  // Every close routes through here — condition cleared, rule turned off, rule
  // deleted — so this is the one place a receiver's open alert gets closed too.
  // The outbox row is written now, in the same save as `resolvedAt`: an alert
  // that is closed in the record must never stay open at the receiver because
  // the process died between the two.
  queueDelivery(open, "resolved");
  return true;
}

/** One rule, one pass. Returns true when the event log changed. */
function applyRule(rule: AlertRule, at: number): boolean {
  if (!rule.enabled) return resolveOpen(rule.id, "The rule was turned off.", at);
  const cond = evaluateRule(rule);
  const open = openEventFor(rule.id);

  if (cond.firing && !open) {
    const event: AlertEvent = {
      id: id(),
      ruleId: rule.id,
      projectId: rule.projectId,
      environmentId: rule.environmentId,
      firedAt: iso(at),
      summary: cond.summary,
      severity: cond.severity,
      detail: cond.detail,
      simulated: cond.simulated,
    };
    tables().events.push(event);
    log.info("alert fired", { scope: "alerts", ruleId: rule.id, kind: rule.kind });
    // Queued, not awaited — but *durably* queued: one outbox row per selected
    // channel is written here, so the pass's own save() carries the event and
    // the intent to deliver it in the same atomic write. The send itself
    // happens on a microtask after that, and survives a crash either way.
    queueDelivery(event, "fired");
    return true;
  }
  if (!cond.firing && open) return resolveOpen(rule.id, cond.summary, at);
  return false;
}

/**
 * Evaluate a set of rules and persist any change. Saving only when something
 * actually changed is what keeps a 15s timer from rewriting state.json forever
 * in a workspace where nothing is wrong.
 */
function evaluate(rules: AlertRule[], at = Date.now()): number {
  let changed = 0;
  for (const rule of rules) if (applyRule(rule, at)) changed++;
  if (changed) save();
  return changed;
}

/** Everything, for the background pass. */
export const evaluateAll = (at = Date.now()): number => evaluate(tables().rules, at);

/** One project, for a read of the alerts API — the page shows a fresh answer. */
export const evaluateProject = (projectId: string, at = Date.now()): number =>
  evaluate(
    tables().rules.filter((r) => r.projectId === projectId),
    at
  );

/* --------------------------------- queries -------------------------------- */

export const rulesOf = (projectId: string, environmentId?: string): AlertRule[] =>
  db()
    .alertRules.filter(
      (r) => r.projectId === projectId && (!environmentId || r.environmentId === environmentId)
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

/*
 * TENANCY — the three lookups below, and why two shapes of them exist.
 *
 * A rule id, an alert id and a channel id are all bearer tokens: `runAction`
 * checks the caller's role in `ctx.workspaceId` and nothing else, so a finder
 * that reads the whole store lets an admin of workspace A act on workspace B by
 * quoting one of B's ids. On a channel that is not a read — `alerts.updateChannel`
 * rewrites `target` and `secret`, which is where a workspace's alerts go and
 * what signs them, so a global finder there is a redirect of someone else's
 * deliveries to an endpoint of the caller's choosing.
 *
 * So every caller that has a workspace uses the `scoped*` pair below. A rule and
 * an event carry no workspace of their own and scope transitively through their
 * project (Rule/Event → Project → workspace); a channel carries its own
 * `workspaceId` and needs no hop.
 *
 * The `require*` finders stay for the internal callers that have already scoped
 * the id (`acknowledge` re-reads an event `scopedEvent` just resolved) and for
 * the evaluator, which is not acting for anybody. Nothing that takes an id from
 * a request may use them.
 *
 * A foreign id gets the SAME sentence as an absent one — one factory each, used
 * by both shapes, so the two can never drift apart. Anything else ("you don't
 * have access to that") confirms the object exists and makes the id space
 * enumerable across tenants.
 */

const noRule = (ref: string) =>
  new Error(`Alert rule "${ref}" was not found. Reload Observe — someone may have deleted it.`);
const noEvent = (ref: string) =>
  new Error(`Alert "${ref}" was not found. Reload Observe — the alert list may have moved on.`);
/** Byte-identical to the sentence `requireChannel` in ./channels throws. */
const noChannel = (ref: string) =>
  new Error(
    `Delivery channel "${ref}" was not found. Reload Settings → Alerts — someone may have deleted it.`
  );

/**
 * Does this workspace own that project? Matches on id ONLY — `q.project` and
 * `workspaceOfRule` also accept a slug, and a slug is user-chosen: a project
 * slugged with another tenant's project id must never be what decides tenancy.
 * An empty workspace matches no project, so it resolves nothing.
 */
const ownsProject = (workspaceId: string, projectId: string): boolean =>
  db().projects.some((p) => p.id === projectId && p.workspaceId === workspaceId);

export const requireEvent = (eventId: string): AlertEvent => {
  const event = tables().events.find((e) => e.id === eventId);
  if (!event) throw noEvent(eventId);
  return event;
};

/** A rule, scoped through the project that owns it. */
export function scopedRule(workspaceId: string, ruleId: string): AlertRule {
  const rule = tables().rules.find((r) => r.id === ruleId);
  if (!rule || !ownsProject(workspaceId, rule.projectId)) throw noRule(ruleId);
  return rule;
}

/** An alert, scoped through the project that owns it. */
export function scopedEvent(workspaceId: string, eventId: string): AlertEvent {
  const event = tables().events.find((e) => e.id === eventId);
  if (!event || !ownsProject(workspaceId, event.projectId)) throw noEvent(eventId);
  return event;
}

/** A delivery channel. This one carries its own workspaceId — no hop needed. */
export function scopedChannel(workspaceId: string, channelId: string): AlertChannel {
  const channel = findChannel(channelId);
  if (!channel || !workspaceId || channel.workspaceId !== workspaceId) throw noChannel(channelId);
  return channel;
}

/** Newest first, open events ahead of resolved ones. */
const byRecency = (a: AlertEvent, b: AlertEvent) => (a.firedAt < b.firedAt ? 1 : -1);

export function eventsOf(
  projectId: string,
  opts: { environmentId?: string; open?: boolean } = {}
): AlertEvent[] {
  return db()
    .alertEvents.filter(
      (e) =>
        e.projectId === projectId &&
        (!opts.environmentId || e.environmentId === opts.environmentId) &&
        (!opts.open || !e.resolvedAt)
    )
    .sort(byRecency);
}

/**
 * Open events first, then the most recent resolved ones. This is what the
 * Observe banner and the shell bell read: the open list is the thing that
 * matters, the tail is the record that a service *was* degraded.
 */
export function summaryFor(
  projectId: string,
  environmentId?: string
): { open: AlertEvent[]; recent: AlertEvent[] } {
  const all = eventsOf(projectId, { environmentId });
  return {
    open: all.filter((e) => !e.resolvedAt),
    recent: all.filter((e) => e.resolvedAt).slice(0, RECENT_EVENTS),
  };
}

/**
 * A page of history, newest first. The cursor is the sort key of the last row
 * returned, so a page is stable while new events arrive at the front.
 */
export function eventPage(opts: {
  projectId: string;
  environmentId?: string;
  limit: number;
  cursor?: string;
}): { events: AlertEvent[]; nextCursor?: string } {
  const key = (e: AlertEvent) => `${e.firedAt}|${e.id}`;
  const rows = eventsOf(opts.projectId, { environmentId: opts.environmentId }).filter(
    (e) => !opts.cursor || key(e) < opts.cursor
  );
  const events = rows.slice(0, opts.limit);
  return {
    events,
    nextCursor:
      rows.length > events.length && events.length > 0
        ? key(events[events.length - 1])
        : undefined,
  };
}

/** Acknowledge: a human says they have seen it. It does not close the event. */
export function acknowledge(eventId: string, actor: Actor, note?: string): AlertEvent {
  const event = requireEvent(eventId);
  event.acknowledgedAt = new Date().toISOString();
  event.acknowledgedBy = actor;
  if (note) event.acknowledgedNote = note;
  save();
  return event;
}

/* -------------------------------- evaluator ------------------------------- */

type G = typeof globalThis & { __orreryAlertTimer?: ReturnType<typeof setInterval> };

/**
 * Start the background pass. Idempotent, and `unref`'d so it never keeps the
 * process alive: this is a convenience for a server that is already running,
 * not a scheduler. Nothing is evaluated when the workspace has no rules.
 */
export function startAlertEvaluator(): void {
  const g = globalThis as G;
  if (g.__orreryAlertTimer) return;
  const pass = () => {
    try {
      if (tables().rules.length === 0) return;
      evaluateAll();
    } catch (err) {
      // A broken rule must not kill the timer for every other rule.
      log.error("alert evaluation failed", { scope: "alerts", error: err });
    }
  };
  pass(); // re-derive open state immediately after a restart
  g.__orreryAlertTimer = setInterval(pass, EVALUATION_INTERVAL_MS);
  (g.__orreryAlertTimer as { unref?: () => void }).unref?.();
}
