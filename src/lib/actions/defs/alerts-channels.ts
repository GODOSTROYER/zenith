/**
 * The delivery channels alert rules push to.
 *
 * Channel mutations are admin, because a channel is workspace-wide and its
 * target is where this server's alerts go. Test-sending is editor: it proves a
 * channel works without being able to change where anything is sent.
 *
 * Every channel is resolved with `scopedChannel` (see @/lib/alerts) rather
 * than a global finder: otherwise an admin of one workspace could point
 * another workspace's channel at an endpoint of their choosing. A foreign id
 * is refused with the same sentence as an id that never existed.
 *
 * Split out of the single-file module; the code is unchanged.
 */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import {
  DELIVERY_ATTEMPTS,
  DELIVERY_TIMEOUT_MS,
  SIGNATURE_HEADER,
  channelTable,
  channelsOf,
  deliverToChannel,
  emailProblem,
  maskTarget,
  messageText,
  scopedChannel,
  type AlertMessage,
} from "@/lib/alerts";
import { db, save } from "@/lib/db/store";
import { env } from "@/lib/env";
import {
  AlertChannelKind,
  id,
  type AlertChannel,
  type AlertRule,
} from "@/lib/domain/types";
import { channelLabel, plural } from "./_shared";
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
    return `A Slack incoming-webhook URL is itself the credential: anyone holding it can post to that channel. It is stored in plain text in ${STATE_FILE} and masked everywhere Zenith shows it, but anyone who can read this server's disk can read it.`;
  return hasSecret
    ? `Each request carries ${SIGNATURE_HEADER}: sha256=… , an HMAC over the exact bytes of the body. That signing secret is stored in plain text in ${STATE_FILE} — no route returns it and the UI masks it, but anyone who can read this server's disk can read it.`
    : `No signing secret: requests go out unsigned and the receiver cannot prove Zenith sent them. Set one to have Zenith send ${SIGNATURE_HEADER}.`;
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
    return `Zenith can only POST over http or https, and "${url.protocol}" is neither. Paste the endpoint's https:// URL.`;
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
      `${url.hostname} is not hooks.slack.com. Zenith will still send Slack's payload shape there, which is what Mattermost and Discord-compatible receivers expect — but if you meant Slack, copy the URL from the incoming-webhook app again.`
    );
  if (kind === "webhook" && !hasSecret)
    out.push(
      "Without a secret the receiver has no way to tell a Zenith alert from anything else that can reach that URL."
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
        "Use Test on the channel afterwards to send one labelled message and see the result — Zenith does not test it as part of creating it.",
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
  plan(ctx, input) {
    const channel = scopedChannel(ctx.workspaceId, input.channelId);
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
  execute(ctx, input) {
    const channel = scopedChannel(ctx.workspaceId, input.channelId);
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
    const channel = scopedChannel(ctx.workspaceId, input.channelId);
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
  execute(ctx, input) {
    const channel = scopedChannel(ctx.workspaceId, input.channelId);
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
    const channel = scopedChannel(ctx.workspaceId, input.channelId);
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
    const channel = scopedChannel(ctx.workspaceId, input.channelId);
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
  title: "Test message from Zenith",
  body: `${actorName} sent this from Settings → Alerts to check that this channel works. No alert rule fired, and nothing is wrong.`,
  severity: "low",
  simulated: false,
});
