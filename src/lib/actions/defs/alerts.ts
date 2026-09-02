/**
 * Alert rules: create, edit, delete, acknowledge — and the delivery channels
 * they push to.
 *
 * Every rule plan says the same three things, because they are the three things
 * an operator needs before trusting an alert: what is watched, how often it is
 * checked, and where it will show up. The third one is the honest one, and it
 * is now read from the workspace rather than asserted: a workspace with no
 * channels is told it is on-screen only, and one with channels is told exactly
 * which endpoints will receive the alert.
 *
 * Channel mutations are admin, because a channel is workspace-wide and its
 * target is where this server's alerts go. Test-sending is editor: it proves a
 * channel works without being able to change where anything is sent.
 */
import { z } from "zod";
import { defineAction, type ActionContext } from "@/lib/actions/core";
import {
  ALERT_KINDS,
  DELIVERY_ATTEMPTS,
  DELIVERY_TIMEOUT_MS,
  EVALUATION_INTERVAL_MS,
  SIGNATURE_HEADER,
  acknowledge,
  channelTable,
  channelsOf,
  deliverToChannel,
  emailProblem,
  evaluateRule,
  maskTarget,
  messageText,
  openEventFor,
  requireChannel,
  requireEvent,
  requireRule,
  resolveOpen,
  rulesOf,
  thresholdOf,
  type AlertMessage,
} from "@/lib/alerts";
import { db, save } from "@/lib/db/store";
import { env } from "@/lib/env";
import {
  AlertChannelKind,
  AlertKind,
  id,
  type AlertChannel,
  type AlertRule,
} from "@/lib/domain/types";
import { requireEnvironment, requireProject } from "./_shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How a channel reads in prose: name, kind and the endpoint, target masked. */
const channelLabel = (c: AlertChannel) =>
  `${c.name} (${c.kind} → ${maskTarget(c.kind, c.target)})`;

/**
 * The delivery truth, read from this workspace rather than asserted. Repeated
 * on every rule mutation. See docs/LIMITATIONS.md for the boundary.
 */
function whereItShows(ctx: ActionContext, channelIds?: string[]): string {
  const enabled = channelsOf(ctx.workspaceId).filter((c) => c.enabled);
  const selected = channelIds === undefined ? enabled : enabled.filter((c) => channelIds.includes(c.id));
  if (enabled.length === 0)
    return "In-product only: Observe → Alerts, and anywhere else that reads the alerts feed. This workspace has no delivery channels, so if nobody opens Orrery, nobody is told — add one under Settings → Alerts.";
  if (selected.length === 0)
    return `In-product only: this rule is set to deliver nowhere, even though the workspace has ${plural(enabled.length, "enabled channel")}. It shows under Observe → Alerts and nowhere else.`;
  return `Shows under Observe → Alerts, and is delivered to ${plural(selected.length, "channel")}: ${selected.map(channelLabel).join(", ")}. Every attempt is recorded on the alert, successes and failures alike.`;
}

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
  /** omit for every enabled channel; `[]` for none (on-screen only) */
  channelIds: z.array(z.string()).optional(),
});
type Create = z.infer<typeof Create>;

/** A named channel that does not exist is a rule that silently delivers less. */
function channelProblem(ctx: ActionContext, channelIds?: string[]): string | undefined {
  if (!channelIds?.length) return undefined;
  const mine = new Set(channelsOf(ctx.workspaceId).map((c) => c.id));
  const unknown = channelIds.filter((cid) => !mine.has(cid));
  if (unknown.length === 0) return undefined;
  return `${unknown.join(", ")} ${unknown.length === 1 ? "is not a delivery channel" : "are not delivery channels"} in this workspace. Pick from the list under Settings → Alerts, or leave the selection empty to use every enabled channel.`;
}

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
        whereItShows(ctx, input.channelIds),
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
        channelProblem(ctx, input.channelIds) ??
        (duplicate
          ? `${env.name} already has this exact rule (${describe(duplicate)}), so a second one would only duplicate every alert. Edit the existing rule instead, or pick a different threshold.`
          : undefined),
    };
  },
  execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const problem = thresholdProblem(input) ?? channelProblem(ctx, input.channelIds);
    if (problem) return { ok: false, summary: "That rule cannot be created.", error: problem };

    const rule: AlertRule = {
      id: id(),
      projectId: project.id,
      environmentId: env.id,
      kind: input.kind,
      threshold: input.threshold,
      enabled: input.enabled ?? true,
      channelIds: input.channelIds,
      createdBy: ctx.actor,
      createdAt: new Date().toISOString(),
    };
    db().alertRules.push(rule);
    save();
    return {
      ok: true,
      summary: `${describe(rule)} is now watched on ${env.name}. ${whereItShows(ctx, rule.channelIds)}`,
      data: {
        ruleId: rule.id,
        kind: rule.kind,
        environmentId: env.id,
        channelIds: rule.channelIds,
      },
    };
  },
});

/* -------------------------------- updateRule ------------------------------- */

const Update = z.object({
  ruleId: z.string().min(1),
  threshold: z.number().optional(),
  enabled: z.boolean().optional(),
  /**
   * Three states, because there are three: omit to leave the rule's selection
   * alone, `null` to go back to every enabled channel, `[]` to deliver nowhere.
   */
  channelIds: z.array(z.string()).nullable().optional(),
});
type Update = z.infer<typeof Update>;

/** The selection this update would leave on the rule. */
const nextChannelIds = (input: Update, rule: AlertRule): string[] | undefined =>
  input.channelIds === undefined ? rule.channelIds : (input.channelIds ?? undefined);

defineAction<Update>({
  id: "alerts.updateRule",
  title: "Update alert rule",
  category: "operations",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: Update,
  plan(ctx, input) {
    const rule = requireRule(input.ruleId);
    const env = envName(rule);
    const next = { kind: rule.kind, threshold: input.threshold ?? rule.threshold };
    const enabled = input.enabled ?? rule.enabled;
    const open = openEventFor(rule.id);
    const nothing =
      input.threshold === undefined && input.enabled === undefined && input.channelIds === undefined;

    const details = [
      `Watches ${ALERT_KINDS[rule.kind].watches}.`,
      HOW_OFTEN,
      whereItShows(ctx, nextChannelIds(input, rule)),
    ];
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
        channelProblem(ctx, input.channelIds ?? undefined) ??
        (nothing
          ? "Change the threshold, the on/off switch or the channels — this would save the rule exactly as it is."
          : undefined),
    };
  },
  execute(ctx, input) {
    const rule = requireRule(input.ruleId);
    const problem =
      thresholdProblem({ kind: rule.kind, threshold: input.threshold }) ??
      channelProblem(ctx, input.channelIds ?? undefined);
    if (problem) return { ok: false, summary: "That rule cannot be saved.", error: problem };

    if (input.threshold !== undefined) rule.threshold = input.threshold;
    if (input.channelIds !== undefined) rule.channelIds = input.channelIds ?? undefined;
    if (input.enabled !== undefined) {
      rule.enabled = input.enabled;
      // A rule nobody evaluates cannot hold an alert open.
      if (!input.enabled) resolveOpen(rule.id, "The rule was turned off.");
    }
    save();
    return {
      ok: true,
      summary: `${describe(rule)} is ${rule.enabled ? "watching" : "turned off"} on ${envName(rule)}. ${whereItShows(ctx, rule.channelIds)}`,
      data: {
        ruleId: rule.id,
        enabled: rule.enabled,
        threshold: rule.threshold,
        channelIds: rule.channelIds,
      },
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

/* -------------------------------- channels -------------------------------- */

const STATE_FILE = "this server's state file (<ORRERY_DATA>/state.json)";

/** The SMTP host, never the URL — the URL carries the password. */
function smtpHost(): string | undefined {
  const url = env().ORRERY_SMTP_URL;
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return "the configured SMTP server";
  }
}

/** Exactly what leaves this server, and where it lands. */
function whatWillBeSent(kind: AlertChannel["kind"], target: string): string {
  const where = maskTarget(kind, target);
  if (kind === "webhook")
    return `Every alert this workspace raises — and every one that closes — is POSTed to ${where} as JSON: the severity, the summary line, the detail, the rule/project/environment ids, and whether the condition was simulated.`;
  if (kind === "slack")
    return `Every alert this workspace raises — and every one that closes — is posted to ${where} as a Slack incoming-webhook message (text plus blocks): severity and summary on the first line, the detail under it, and a note when the condition was simulated.`;
  const host = smtpHost();
  return `Every alert this workspace raises — and every one that closes — is emailed to ${target}${host ? ` through ${host}` : ""}, with the summary as the subject and the detail as the body. From: ${env().ORRERY_ALERT_FROM ?? "(ORRERY_ALERT_FROM is not set)"}.`;
}

/** Where the credential ends up. Said on every channel plan, without exception. */
function whereTheSecretLives(kind: AlertChannel["kind"], hasSecret: boolean): string {
  if (kind === "email")
    return `The SMTP password lives in ORRERY_SMTP_URL in this server's environment, not in this channel — the channel holds only the recipient address.`;
  if (kind === "slack")
    return `A Slack incoming-webhook URL is itself the credential: anyone holding it can post to that channel. It is stored in plain text in ${STATE_FILE} and masked everywhere Orrery shows it, but anyone who can read this server's disk can read it.`;
  return hasSecret
    ? `Each request carries ${SIGNATURE_HEADER}: sha256=… , an HMAC over the exact bytes of the body. That signing secret is stored in plain text in ${STATE_FILE} — no route returns it and the UI masks it, but anyone who can read this server's disk can read it.`
    : `No signing secret: requests go out unsigned and the receiver cannot prove Orrery sent them. Set one to have Orrery send ${SIGNATURE_HEADER}.`;
}

/** A target that cannot work, with the fix. Blocking, not advisory. */
function targetProblem(kind: AlertChannel["kind"], target: string): string | undefined {
  const t = target.trim();
  if (!t) return "Enter where the alert should go — a URL for a webhook or Slack, an address for email.";
  if (kind === "email")
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)
      ? undefined
      : `"${t}" is not an email address. Use one like ops@example.com — one address per channel; add a second channel for a second recipient.`;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return `"${t}" is not a URL. Paste the full endpoint, starting with https://.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return `Orrery can only POST over http or https, and "${url.protocol}" is neither. Paste the endpoint's https:// URL.`;
  return undefined;
}

/** Worth knowing, but not a refusal. */
function targetWarnings(kind: AlertChannel["kind"], target: string, hasSecret: boolean): string[] {
  const out: string[] = [];
  if (kind === "email") {
    const problem = emailProblem();
    if (problem)
      out.push(
        `Nothing will actually be sent to this address yet: ${problem} Until then every delivery to this channel is recorded as failed with that reason.`
      );
    return out;
  }
  let url: URL | undefined;
  try {
    url = new URL(target.trim());
  } catch {
    return out;
  }
  if (url.protocol === "http:")
    out.push(
      `${url.host} is plain http, so the alert — and the signature, if any — crosses the network unencrypted. Use https unless this endpoint is on the same host.`
    );
  if (kind === "slack" && url.hostname !== "hooks.slack.com")
    out.push(
      `${url.hostname} is not hooks.slack.com. Orrery will still send Slack's payload shape there, which is what Mattermost and Discord-compatible receivers expect — but if you meant Slack, copy the URL from the incoming-webhook app again.`
    );
  if (kind === "webhook" && !hasSecret)
    out.push(
      "Without a secret the receiver has no way to tell an Orrery alert from anything else that can reach that URL."
    );
  return out;
}

/** How many rules would start using a channel the moment it exists. */
function rulesUsing(workspaceId: string, channelId?: string): { all: number; named: AlertRule[] } {
  const projectIds = new Set(
    db()
      .projects.filter((p) => p.workspaceId === workspaceId)
      .map((p) => p.id)
  );
  const mine = db().alertRules.filter((r) => projectIds.has(r.projectId) && r.enabled);
  return {
    all: mine.filter((r) => r.channelIds === undefined).length,
    named: channelId ? mine.filter((r) => r.channelIds?.includes(channelId)) : [],
  };
}

/* ------------------------------ createChannel ----------------------------- */

const CreateChannel = z.object({
  kind: AlertChannelKind,
  name: z.string().min(1).max(60),
  target: z.string().min(1),
  /** webhook only; ignored for slack and email */
  secret: z.string().optional(),
  enabled: z.boolean().optional(),
});
type CreateChannel = z.infer<typeof CreateChannel>;

defineAction<CreateChannel>({
  id: "alerts.createChannel",
  title: "Add alert delivery channel",
  category: "operations",
  risk: "medium",
  // Workspace-wide, and its target is where this server's alerts go.
  requiredRole: "admin",
  mutates: true,
  input: CreateChannel,
  plan(ctx, input) {
    const hasSecret = input.kind === "webhook" && !!input.secret?.trim();
    const enabled = input.enabled ?? true;
    const using = rulesUsing(ctx.workspaceId);
    const duplicate = channelsOf(ctx.workspaceId).find(
      (c) => c.kind === input.kind && c.target === input.target.trim()
    );

    return {
      summary: `Deliver this workspace's alerts to ${input.name.trim()} (${input.kind}).`,
      details: [
        whatWillBeSent(input.kind, input.target),
        whereTheSecretLives(input.kind, hasSecret),
        enabled
          ? using.all > 0
            ? `${plural(using.all, "enabled rule")} in this workspace deliver to every channel, so this one starts receiving their alerts on the next evaluation — including any alert that is open right now, when it closes.`
            : "No rule delivers to every channel yet, so nothing reaches this until a rule is created or an existing one is pointed at it."
          : "Created switched off: it receives nothing until it is enabled.",
        "Use Test on the channel afterwards to send one labelled message and see the result — Orrery does not test it as part of creating it.",
      ],
      costDeltaUsd: 0,
      risk: "medium",
      warnings: targetWarnings(input.kind, input.target, hasSecret),
      requiresApproval: false,
      blocked:
        targetProblem(input.kind, input.target) ??
        (input.kind !== "webhook" && input.secret?.trim()
          ? `A ${input.kind} channel has no signature to compute, so a secret here would be stored and never used. Leave it empty.`
          : duplicate
            ? `${duplicate.name} already sends to this exact ${input.kind} target, so a second channel would only deliver every alert twice. Edit that one instead.`
            : undefined),
    };
  },
  execute(ctx, input) {
    const problem = targetProblem(input.kind, input.target);
    if (problem) return { ok: false, summary: "That target cannot be used.", error: problem };

    const channel: AlertChannel = {
      id: id(),
      workspaceId: ctx.workspaceId,
      kind: input.kind,
      name: input.name.trim(),
      target: input.target.trim(),
      secret: input.kind === "webhook" ? input.secret?.trim() || undefined : undefined,
      enabled: input.enabled ?? true,
      createdBy: ctx.actor,
      createdAt: new Date().toISOString(),
    };
    channelTable().push(channel);
    save();
    return {
      ok: true,
      summary: `${channel.name} now receives this workspace's alerts (${channel.kind} → ${maskTarget(channel.kind, channel.target)}). Nothing has been sent to it yet — use Test to prove it works.`,
      data: { channelId: channel.id, kind: channel.kind, enabled: channel.enabled },
    };
  },
});

/* ------------------------------ updateChannel ----------------------------- */

const UpdateChannel = z.object({
  channelId: z.string().min(1),
  name: z.string().min(1).max(60).optional(),
  target: z.string().min(1).optional(),
  /** a new signing secret; "" clears it, omit to leave it alone */
  secret: z.string().optional(),
  enabled: z.boolean().optional(),
});
type UpdateChannel = z.infer<typeof UpdateChannel>;

defineAction<UpdateChannel>({
  id: "alerts.updateChannel",
  title: "Update alert delivery channel",
  category: "operations",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: UpdateChannel,
  plan(_ctx, input) {
    const channel = requireChannel(input.channelId);
    const target = input.target?.trim() ?? channel.target;
    const enabled = input.enabled ?? channel.enabled;
    const hasSecret =
      channel.kind === "webhook" &&
      (input.secret === undefined ? !!channel.secret : !!input.secret.trim());
    const nothing =
      input.name === undefined &&
      input.target === undefined &&
      input.secret === undefined &&
      input.enabled === undefined;

    const details = [whatWillBeSent(channel.kind, target), whereTheSecretLives(channel.kind, hasSecret)];
    if (input.target !== undefined && target !== channel.target)
      details.push(
        `The destination moves from ${maskTarget(channel.kind, channel.target)} to ${maskTarget(channel.kind, target)}. Nothing is sent to the old one again.`
      );
    if (input.secret !== undefined)
      details.push(
        channel.kind !== "webhook"
          ? `A ${channel.kind} channel computes no signature, so this secret would be stored and never used.`
          : input.secret.trim()
            ? `The signing secret is replaced. Every request after this is signed with the new one — update the receiver at the same time or it starts rejecting alerts.`
            : `The signing secret is removed. Requests go out unsigned from then on.`
      );
    if (enabled !== channel.enabled)
      details.push(
        enabled
          ? "Turning it back on: it receives alerts again from the next transition."
          : "Turning it off stops delivery to it. Rules keep firing and alerts keep being recorded — they just do not reach here."
      );

    return {
      summary: nothing
        ? `Nothing to change on ${channel.name}.`
        : `Update the ${channel.kind} channel ${channel.name}.`,
      details,
      costDeltaUsd: 0,
      risk: "medium",
      warnings: targetWarnings(channel.kind, target, hasSecret),
      requiresApproval: false,
      blocked:
        (input.target !== undefined ? targetProblem(channel.kind, input.target) : undefined) ??
        (nothing
          ? "Change the name, the destination, the secret or the on/off switch — this would save the channel exactly as it is."
          : undefined),
    };
  },
  execute(_ctx, input) {
    const channel = requireChannel(input.channelId);
    if (input.target !== undefined) {
      const problem = targetProblem(channel.kind, input.target);
      if (problem) return { ok: false, summary: "That target cannot be used.", error: problem };
      channel.target = input.target.trim();
    }
    if (input.name !== undefined) channel.name = input.name.trim();
    if (input.secret !== undefined)
      channel.secret = channel.kind === "webhook" ? input.secret.trim() || undefined : undefined;
    if (input.enabled !== undefined) channel.enabled = input.enabled;
    save();
    return {
      ok: true,
      summary: `${channel.name} is ${channel.enabled ? "receiving" : "not receiving"} alerts (${channel.kind} → ${maskTarget(channel.kind, channel.target)}).`,
      data: { channelId: channel.id, enabled: channel.enabled, hasSecret: !!channel.secret },
    };
  },
});

/* ------------------------------ deleteChannel ----------------------------- */

const DeleteChannel = z.object({ channelId: z.string().min(1) });
type DeleteChannel = z.infer<typeof DeleteChannel>;

defineAction<DeleteChannel>({
  id: "alerts.deleteChannel",
  title: "Delete alert delivery channel",
  category: "operations",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: DeleteChannel,
  plan(ctx, input) {
    const channel = requireChannel(input.channelId);
    const using = rulesUsing(ctx.workspaceId, channel.id);
    const orphaned = using.named.filter((r) => (r.channelIds ?? []).length === 1);
    const remaining = channelsOf(ctx.workspaceId).filter(
      (c) => c.id !== channel.id && c.enabled
    ).length;

    return {
      summary: `Stop delivering alerts to ${channelLabel(channel)}.`,
      details: [
        "Nothing else changes: rules keep being evaluated and alerts keep being recorded and shown under Observe → Alerts.",
        using.named.length > 0
          ? `${plural(using.named.length, "rule")} name this channel explicitly and stop using it.`
          : "No rule names this channel explicitly.",
        using.all > 0
          ? `${plural(using.all, "rule")} deliver to every channel and will use the ${plural(remaining, "one")} that remain${remaining === 1 ? "s" : ""}.`
          : "No rule delivers to every channel.",
        channel.kind === "webhook" && channel.secret
          ? "The stored signing secret is deleted with it and is not recoverable."
          : channel.kind === "slack"
            ? "The stored webhook URL is deleted with it. Revoke it in Slack as well if it should stop working entirely."
            : "Nothing else is stored for this channel.",
        `The delivery results already recorded on past alerts stay: they are the record that something was, or was not, sent.`,
      ],
      costDeltaUsd: 0,
      risk: "medium",
      warnings: [
        ...(orphaned.length > 0
          ? [
              `${plural(orphaned.length, "rule")} deliver to this channel and nothing else, so ${orphaned.length === 1 ? "it becomes" : "they become"} on-screen only.`,
            ]
          : []),
        ...(remaining === 0 && using.all > 0
          ? ["This is the last enabled channel: after this the whole workspace is on-screen only."]
          : []),
      ],
      requiresApproval: false,
    };
  },
  execute(_ctx, input) {
    const channel = requireChannel(input.channelId);
    const table = channelTable();
    const at = table.findIndex((c) => c.id === channel.id);
    if (at >= 0) table.splice(at, 1);
    // A rule pointing at a channel that no longer exists would silently deliver
    // to nothing; drop the id so what the rule says matches what it does.
    for (const rule of db().alertRules)
      if (rule.channelIds?.includes(channel.id))
        rule.channelIds = rule.channelIds.filter((cid) => cid !== channel.id);
    save();
    return {
      ok: true,
      summary: `${channel.name} no longer receives alerts. Past delivery results stay on the alerts they belong to.`,
      data: { channelId: channel.id },
    };
  },
});

/* ------------------------------- testChannel ------------------------------ */

const TestChannel = z.object({ channelId: z.string().min(1) });
type TestChannel = z.infer<typeof TestChannel>;

/**
 * Editor, not admin: proving a channel works sends one labelled message and
 * changes nothing about where alerts go. It is also the only way to find out
 * whether a webhook URL is right without waiting for something to break.
 */
defineAction<TestChannel>({
  id: "alerts.testChannel",
  title: "Send a test alert",
  category: "operations",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: TestChannel,
  plan(ctx, input) {
    const channel = requireChannel(input.channelId);
    const msg = testMessage(ctx.actor.name);
    return {
      summary: `Send one test message to ${channelLabel(channel)}.`,
      details: [
        `Exactly one message goes out, now, labelled as a test: "${messageText(msg)}"`,
        whatWillBeSent(channel.kind, channel.target).replace(
          /^Every alert this workspace raises — and every one that closes — is/,
          "It is"
        ),
        whereTheSecretLives(channel.kind, channel.kind === "webhook" && !!channel.secret),
        `Up to ${DELIVERY_ATTEMPTS} attempts with backoff, ${DELIVERY_TIMEOUT_MS / 1000}s each — the same path a real alert takes. The result is recorded on the channel either way, and shown under Settings → Alerts.`,
        "No alert rule fires and no alert is recorded: this proves the channel, not a condition.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: [
        ...(channel.enabled
          ? []
          : ["This channel is switched off. The test is still sent, but real alerts are not."]),
        ...targetWarnings(channel.kind, channel.target, !!channel.secret),
      ],
      requiresApproval: false,
    };
  },
  async execute(ctx, input) {
    const channel = requireChannel(input.channelId);
    const delivery = await deliverToChannel(channel, testMessage(ctx.actor.name));
    save();
    return {
      ok: delivery.ok,
      summary: delivery.ok
        ? `${channel.name} accepted the test message${delivery.status ? ` (HTTP ${delivery.status})` : ""} after ${plural(delivery.attempts ?? 1, "attempt")}.`
        : `${channel.name} did not accept the test message.`,
      error: delivery.error,
      data: { channelId: channel.id, ok: delivery.ok, status: delivery.status, at: delivery.at },
    };
  },
});

/** The one message a test sends. Labelled, so nobody mistakes it for an alert. */
const testMessage = (actorName: string): AlertMessage => ({
  phase: "test",
  title: "Test message from Orrery",
  body: `${actorName} sent this from Settings → Alerts to check that this channel works. No alert rule fired, and nothing is wrong.`,
  severity: "low",
  simulated: false,
});
