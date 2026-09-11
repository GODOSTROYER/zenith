/**
 * The sentences the alerts screen writes about a rule: what it watches, where
 * it goes, and which channels it never reached. One place, so the banner, the
 * card and the dialogs cannot drift apart.
 */
import type { AlertKindSpec } from "@/lib/alerts";
import type { AlertsFeed, PublicAlertChannel } from "@/lib/client/alerts";
import type { AlertEvent, AlertRule } from "@/lib/domain/types";

export type Kinds = AlertsFeed["kinds"];

export const effectiveThreshold = (rule: Pick<AlertRule, "kind" | "threshold">, kinds: Kinds) =>
  rule.threshold ?? kinds[rule.kind]?.threshold?.default;

export function ruleLabel(rule: Pick<AlertRule, "kind" | "threshold">, kinds: Kinds): string {
  const spec: AlertKindSpec | undefined = kinds[rule.kind];
  if (!spec) return rule.kind;
  return spec.threshold
    ? `${spec.title} (${effectiveThreshold(rule, kinds)}${spec.threshold.unit})`
    : spec.title;
}

/* -------------------------------- delivery -------------------------------- */

/** Which channels this rule sends to, in the words the rule's own field means. */
export function ruleChannelLine(rule: AlertRule, channels: PublicAlertChannel[]): string {
  const enabled = channels.filter((c) => c.enabled);
  if (enabled.length === 0) return "Not sent anywhere: this workspace has no delivery channels.";
  if (rule.channelIds === undefined)
    return `Sent to every enabled channel (${enabled.map((c) => c.name).join(", ")}).`;
  const picked = enabled.filter((c) => rule.channelIds!.includes(c.id));
  return picked.length === 0
    ? "Set to deliver nowhere: shown here and not sent."
    : `Sent to ${picked.map((c) => c.name).join(", ")}.`;
}

/** The channels this alert never reached, for the one-line history row. */
export function failedNames(event: AlertEvent, channels: PublicAlertChannel[]): string {
  const failed = (event.deliveries ?? []).filter((d) => !d.ok);
  if (failed.length === 0) return "";
  return [
    ...new Set(failed.map((d) => channels.find((c) => c.id === d.channelId)?.name ?? "a deleted channel")),
  ].join(", ");
}
