/**
 * Alert rules: create, edit, delete, acknowledge.
 *
 * Every plan says the same three things, because they are the three things an
 * operator needs before trusting an alert: what is watched, how often it is
 * checked, and where it will show up. The third one is the honest one — there
 * is no email, Slack or webhook delivery in Orrery, so an alert nobody opens
 * the product to see is an alert nobody sees.
 */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import {
  ALERT_KINDS,
  EVALUATION_INTERVAL_MS,
  acknowledge,
  evaluateRule,
  openEventFor,
  requireEvent,
  requireRule,
  resolveOpen,
  rulesOf,
  thresholdOf,
} from "@/lib/alerts";
import { db, save } from "@/lib/db/store";
import { AlertKind, id, type AlertRule } from "@/lib/domain/types";
import { requireEnvironment, requireProject } from "./_shared";

/** The delivery truth, repeated on every mutation. See docs/LIMITATIONS.md. */
const WHERE_IT_SHOWS =
  "In-product only: Observe → Alerts, and anywhere else that reads the alerts feed. Orrery has no email, Slack or webhook delivery — if nobody opens Orrery, nobody is told.";

const HOW_OFTEN = `Checked every ${EVALUATION_INTERVAL_MS / 1000} seconds while the server is running, and again whenever the Alerts panel is read.`;

const DEDUPE_NOTE =
  "One open alert per rule: it stays open until the condition clears, so a service that flaps is one record, not a hundred.";

const describe = (rule: Pick<AlertRule, "kind" | "threshold">): string => {
  const spec = ALERT_KINDS[rule.kind];
  const t = thresholdOf(rule);
  return spec.threshold ? `${spec.title} (${t}${spec.threshold.unit})` : spec.title;
};

/* -------------------------------- createRule ------------------------------- */

const Create = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  kind: AlertKind,
  threshold: z.number().optional(),
  enabled: z.boolean().optional(),
});
type Create = z.infer<typeof Create>;

/** A threshold outside its kind's range is a rule that can never be useful. */
function thresholdProblem(input: Pick<Create, "kind" | "threshold">): string | undefined {
  const spec = ALERT_KINDS[input.kind].threshold;
  if (input.threshold === undefined) return undefined;
  if (!spec)
    return `"${ALERT_KINDS[input.kind].title}" has no threshold to set — it is either true or it is not. Leave the threshold empty.`;
  if (input.threshold < spec.min || input.threshold > spec.max)
    return `A threshold of ${input.threshold}${spec.unit} is outside the useful range for this rule. Pick a value between ${spec.min}${spec.unit} and ${spec.max}${spec.unit}.`;
  return undefined;
}

defineAction<Create>({
  id: "alerts.createRule",
  title: "Create alert rule",
  category: "operations",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: Create,
  plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const spec = ALERT_KINDS[input.kind];
    const threshold = thresholdOf({ kind: input.kind, threshold: input.threshold });
    const duplicate = rulesOf(project.id, env.id).find(
      (r) => r.kind === input.kind && thresholdOf(r) === threshold
    );
    // Written before it exists, so the operator sees what it would say today.
    const preview = evaluateRule({
      id: "preview",
      projectId: project.id,
      environmentId: env.id,
      kind: input.kind,
      threshold: input.threshold,
      enabled: true,
      createdBy: ctx.actor,
      createdAt: new Date().toISOString(),
    });

    return {
      summary: `Watch ${env.name} for: ${describe(input)}.`,
      details: [
        `Watches ${spec.watches}.`,
        HOW_OFTEN,
        WHERE_IT_SHOWS,
        DEDUPE_NOTE,
        preview.firing
          ? `This condition is true right now, so the rule fires as soon as it is created: ${preview.summary}`
          : `Not firing right now: ${preview.summary}`,
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: preview.simulated
        ? ["Simulated: this condition reads generated health or estimated cost, not a measurement."]
        : [],
      requiresApproval: false,
      blocked:
        thresholdProblem(input) ??
        (duplicate
          ? `${env.name} already has this exact rule (${describe(duplicate)}), so a second one would only duplicate every alert. Edit the existing rule instead, or pick a different threshold.`
          : undefined),
    };
  },
  execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const problem = thresholdProblem(input);
    if (problem) return { ok: false, summary: "That threshold cannot be used.", error: problem };

    const rule: AlertRule = {
      id: id(),
      projectId: project.id,
      environmentId: env.id,
      kind: input.kind,
      threshold: input.threshold,
      enabled: input.enabled ?? true,
      createdBy: ctx.actor,
      createdAt: new Date().toISOString(),
    };
    db().alertRules.push(rule);
    save();
    return {
      ok: true,
      summary: `${describe(rule)} is now watched on ${env.name}. It shows in the product only — there is no email or Slack delivery.`,
      data: { ruleId: rule.id, kind: rule.kind, environmentId: env.id },
    };
  },
});

/* -------------------------------- updateRule ------------------------------- */

const Update = z.object({
  ruleId: z.string().min(1),
  threshold: z.number().optional(),
  enabled: z.boolean().optional(),
});
type Update = z.infer<typeof Update>;

defineAction<Update>({
  id: "alerts.updateRule",
  title: "Update alert rule",
  category: "operations",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: Update,
  plan(_ctx, input) {
    const rule = requireRule(input.ruleId);
    const env = envName(rule);
    const next = { kind: rule.kind, threshold: input.threshold ?? rule.threshold };
    const enabled = input.enabled ?? rule.enabled;
    const open = openEventFor(rule.id);
    const nothing = input.threshold === undefined && input.enabled === undefined;

    const details = [`Watches ${ALERT_KINDS[rule.kind].watches}.`, HOW_OFTEN, WHERE_IT_SHOWS];
    if (input.threshold !== undefined && thresholdOf(next) !== thresholdOf(rule))
      details.push(`Threshold moves from ${describe(rule)} to ${describe(next)}.`);
    if (enabled !== rule.enabled)
      details.push(
        enabled
          ? "Turning it back on: it is evaluated again on the next pass."
          : `Turning it off stops evaluation${open ? " and closes the alert that is open now — the record stays under history." : "."}`
      );

    return {
      summary: nothing
        ? `Nothing to change on ${describe(rule)} in ${env}.`
        : `Update ${describe(rule)} on ${env}.`,
      details,
      costDeltaUsd: 0,
      risk: "low",
      warnings: [],
      requiresApproval: false,
      blocked:
        thresholdProblem({ kind: rule.kind, threshold: input.threshold }) ??
        (nothing
          ? "Change the threshold or the on/off switch — this would save the rule exactly as it is."
          : undefined),
    };
  },
  execute(_ctx, input) {
    const rule = requireRule(input.ruleId);
    const problem = thresholdProblem({ kind: rule.kind, threshold: input.threshold });
    if (problem) return { ok: false, summary: "That threshold cannot be used.", error: problem };

    if (input.threshold !== undefined) rule.threshold = input.threshold;
    if (input.enabled !== undefined) {
      rule.enabled = input.enabled;
      // A rule nobody evaluates cannot hold an alert open.
      if (!input.enabled) resolveOpen(rule.id, "The rule was turned off.");
    }
    save();
    return {
      ok: true,
      summary: `${describe(rule)} is ${rule.enabled ? "watching" : "turned off"} on ${envName(rule)}.`,
      data: { ruleId: rule.id, enabled: rule.enabled, threshold: rule.threshold },
    };
  },
});

/* -------------------------------- deleteRule ------------------------------- */

const Delete = z.object({ ruleId: z.string().min(1) });
type Delete = z.infer<typeof Delete>;

defineAction<Delete>({
  id: "alerts.deleteRule",
  title: "Delete alert rule",
  category: "operations",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: Delete,
  plan(_ctx, input) {
    const rule = requireRule(input.ruleId);
    const fired = db().alertEvents.filter((e) => e.ruleId === rule.id).length;
    const open = openEventFor(rule.id);
    return {
      summary: `Stop watching ${envName(rule)} for: ${describe(rule)}.`,
      details: [
        "Nothing in the environment changes — this only stops the check.",
        open
          ? "The alert that is open now is closed as part of the deletion."
          : "No alert is open for this rule.",
        fired > 0
          ? `Its ${fired} past alert${fired === 1 ? "" : "s"} stay under history: the record that something was wrong outlives the rule that noticed.`
          : "It has never fired, so there is no history to keep.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: open
        ? ["The condition that is true right now will stop being reported anywhere."]
        : [],
      requiresApproval: false,
    };
  },
  execute(_ctx, input) {
    const rule = requireRule(input.ruleId);
    resolveOpen(rule.id, "The rule was deleted.");
    db().alertRules = db().alertRules.filter((r) => r.id !== rule.id);
    save();
    return {
      ok: true,
      summary: `${envName(rule)} is no longer watched for ${describe(rule)}. Past alerts stay under history.`,
      data: { ruleId: rule.id },
    };
  },
});

/* ------------------------------- acknowledge ------------------------------- */

const Ack = z.object({
  eventId: z.string().min(1),
  note: z.string().optional(),
});
type Ack = z.infer<typeof Ack>;

/**
 * Acknowledging is editor-level, not viewer-level: it writes to a shared
 * record that tells everyone else somebody is on it. It does NOT close the
 * alert — only the condition clearing does that.
 */
defineAction<Ack>({
  id: "alerts.acknowledge",
  title: "Acknowledge alert",
  category: "operations",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: Ack,
  plan(ctx, input) {
    const event = requireEvent(input.eventId);
    return {
      summary: `Acknowledge "${event.summary}".`,
      details: [
        event.detail,
        `Records that ${ctx.actor.name} has seen it, with the time. It does not change the system and it does not close the alert — that happens on its own when the condition clears.`,
        input.note ? `Note recorded: "${input.note}".` : "No note recorded.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: event.simulated
        ? ["Simulated: this alert fired on generated health or estimated cost."]
        : [],
      requiresApproval: false,
      blocked: event.resolvedAt
        ? `This alert already closed (${event.resolvedReason ?? "the condition cleared"}), so there is nothing outstanding to acknowledge.`
        : event.acknowledgedAt
          ? `${event.acknowledgedBy?.name ?? "Someone"} already acknowledged this alert. Acknowledging twice would overwrite who is on it.`
          : undefined,
    };
  },
  execute(ctx, input) {
    const event = requireEvent(input.eventId);
    if (event.resolvedAt)
      return {
        ok: false,
        summary: "That alert already closed.",
        error: `It closed because ${event.resolvedReason ?? "the condition cleared"}. Reload Observe — it is under history now.`,
      };
    acknowledge(event.id, ctx.actor, input.note);
    return {
      ok: true,
      summary: `Acknowledged: ${event.summary} It stays open until the condition clears.`,
      data: { eventId: event.id, acknowledgedBy: ctx.actor.id },
    };
  },
});

/** Environment name for copy, without failing when it was deleted underneath. */
function envName(rule: AlertRule): string {
  return db().environments.find((e) => e.id === rule.environmentId)?.name ?? "a deleted environment";
}
