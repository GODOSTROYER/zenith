/**
 * Alert delivery channels: where an alert goes besides the screen.
 *
 * A channel belongs to the workspace, not a project — an operator configures
 * `#ops` once, and every rule in every project can use it. Rules select
 * channels by id; a rule that selects none (the default) uses every enabled
 * channel, which is the behaviour somebody who just added their first webhook
 * expects.
 *
 * Storage is `db().settings.alertChannels`. `settings` is
 * `Record<string, unknown>` in the Database type, so this is additive: no
 * schema change, and a store written before channels existed loads fine.
 *
 * Two secrets live here and neither ever leaves the server:
 *  - `secret`, the HMAC key for a signed webhook;
 *  - the token inside a Slack incoming-webhook URL, which is the whole URL's
 *    reason to be secret. `maskTarget` keeps it out of every response.
 */
import { db, flush, q } from "@/lib/db/store";
import type { AlertChannel, AlertChannelKind, AlertRule } from "@/lib/domain/types";
import {
  putSecret,
  readSecretValue,
  removeSecret,
  secretStoreState,
} from "@/lib/secrets";

/** Additive fields understood by the alert store; old rows omit secretRef. */
export type StoredAlertChannel = AlertChannel & { secretRef?: string };

/** Stable, workspace-scoped identity for a channel's signing key. */
export const alertChannelSecretRef = (channelId: string): string =>
  `vault:alert-channel/${channelId}/SIGNING_SECRET`;

/** Read a signing key without exposing it to callers that only need metadata. */
export function channelSecret(channel: AlertChannel): string | undefined {
  const stored = channel as StoredAlertChannel;
  if (stored.secretRef) {
    const value = readSecretValue(channel.workspaceId, stored.secretRef);
    if (value === undefined)
      throw new Error("The channel's signing secret is missing from Zenith's secret store; set it again before sending.");
    return value;
  }
  // Compatibility for rows created before channel secrets used the store.
  return channel.secret;
}

/** Resolve a Slack URL credential without exposing it to metadata callers. */
export function channelTarget(channel: AlertChannel): string {
  const stored = channel as StoredAlertChannel;
  if (channel.kind === "slack" && stored.secretRef) {
    const value = readSecretValue(channel.workspaceId, stored.secretRef);
    if (value === undefined)
      throw new Error("The channel's Slack webhook URL is missing from Zenith's secret store; set it again before sending.");
    return value;
  }
  return channel.target;
}

export const channelHasSecret = (channel: AlertChannel): boolean => {
  const stored = channel as StoredAlertChannel;
  return channel.kind === "slack" ? !!stored.secretRef || !!channel.target : !!stored.secretRef || !!channel.secret;
};

/** Store or clear a channel signing key without leaving a plaintext row. */
export function setChannelSecret(channel: AlertChannel, value: string | undefined, by: string): void {
  const stored = channel as StoredAlertChannel;
  const ref = stored.secretRef ?? alertChannelSecretRef(channel.id);
  if (value) {
    putSecret(channel.workspaceId, ref, value, by);
    stored.secretRef = ref;
  } else if (stored.secretRef) {
    removeSecret(channel.workspaceId, stored.secretRef);
    delete stored.secretRef;
  }
  delete channel.secret;
}

/** Store a Slack webhook URL while retaining only its non-secret origin. */
export function setChannelTargetSecret(channel: AlertChannel, value: string, by: string): void {
  const stored = channel as StoredAlertChannel;
  const ref = stored.secretRef ?? alertChannelSecretRef(channel.id);
  const origin = new URL(value).origin;
  putSecret(channel.workspaceId, ref, value, by);
  stored.secretRef = ref;
  channel.target = origin;
}

/** Safely migrate legacy plaintext channel keys when encryption is configured. */
function migrateLegacyChannelSecrets(channels: AlertChannel[]): boolean {
  if (!secretStoreState().configured) return false;
  let changed = false;
  for (const channel of channels) {
    if ((channel.kind === "slack" ? !channel.target : !channel.secret) || (channel as StoredAlertChannel).secretRef)
      continue;
    try {
      if (channel.kind === "slack") setChannelTargetSecret(channel, channel.target, "system:alert-channel-migration");
      else setChannelSecret(channel, channel.secret, "system:alert-channel-migration");
      changed = true;
    } catch {
      // Keep the old value if the key/store is unavailable; retry next read.
    }
  }
  return changed;
}

/**
 * The channel list, backfilled in place. Same trick as `tables()` in ./index:
 * a snapshot written before channels existed has no array, and the next save()
 * persists the one we put there.
 */
export function channelTable(): AlertChannel[] {
  const settings = db().settings as { alertChannels?: AlertChannel[] };
  settings.alertChannels ??= [];
  if (migrateLegacyChannelSecrets(settings.alertChannels)) flush();
  return settings.alertChannels;
}

export const channelsOf = (workspaceId: string): AlertChannel[] =>
  channelTable()
    .filter((c) => c.workspaceId === workspaceId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

export const findChannel = (channelId: string): AlertChannel | undefined =>
  channelTable().find((c) => c.id === channelId);

export const requireChannel = (channelId: string): AlertChannel => {
  const channel = findChannel(channelId);
  if (!channel)
    throw new Error(
      `Delivery channel "${channelId}" was not found. Reload Settings → Alerts — someone may have deleted it.`
    );
  return channel;
};

/** The workspace a rule's alerts belong to, via its project. */
export const workspaceOfRule = (rule: Pick<AlertRule, "projectId">): string | undefined =>
  q.project(rule.projectId)?.workspaceId;

/**
 * Which channels this rule delivers to, right now.
 *
 * `channelIds` unset = every enabled channel in the workspace. `[]` = none, so
 * a rule can be kept deliberately on-screen-only. A disabled channel is never
 * used, whether it was named or not.
 */
export function channelsForRule(rule: AlertRule, workspaceId?: string): AlertChannel[] {
  const ws = workspaceId ?? workspaceOfRule(rule);
  if (!ws) return [];
  const enabled = channelsOf(ws).filter((c) => c.enabled);
  if (rule.channelIds === undefined) return enabled;
  return enabled.filter((c) => rule.channelIds!.includes(c.id));
}

/* --------------------------------- masking -------------------------------- */

/**
 * A target safe to put in a response.
 *
 * A Slack incoming-webhook URL is a bearer credential in URL form, and a
 * generic webhook URL often carries a token in its path or query too — so
 * everything past the host is replaced. An email address is not a credential
 * (the SMTP password lives in `ZENITH_SMTP_URL`, never on the channel), so it
 * is shown: masking it would only stop an operator checking the recipient.
 */
export function maskTarget(kind: AlertChannelKind, target: string): string {
  if (kind === "email") return target;
  try {
    const url = new URL(target);
    const rest = url.pathname === "/" && !url.search ? "" : "/…";
    return `${url.protocol}//${url.host}${rest}`;
  } catch {
    // Not a URL — it should not have been stored, but never echo it back.
    return "(not a valid URL)";
  }
}

/** A channel as it goes on the wire: no secret, no token in the target. */
export interface PublicAlertChannel
  extends Omit<AlertChannel, "secret" | "target"> {
  /** the endpoint with anything credential-shaped removed */
  target: string;
  /** whether a webhook signing secret is set — never the secret itself */
  hasSecret: boolean;
}

export const publicChannel = (c: AlertChannel): PublicAlertChannel => ({
  id: c.id,
  workspaceId: c.workspaceId,
  kind: c.kind,
  name: c.name,
  target: maskTarget(c.kind, c.target),
  hasSecret: channelHasSecret(c),
  enabled: c.enabled,
  createdBy: c.createdBy,
  createdAt: c.createdAt,
  lastDelivery: c.lastDelivery,
});

export const publicChannels = (workspaceId: string): PublicAlertChannel[] =>
  channelsOf(workspaceId).map(publicChannel);
