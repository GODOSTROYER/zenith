"use client";
/**
 * Alerts — where an alert goes once it exists.
 *
 * A channel is workspace-wide: configure `#ops` once and every rule in every
 * project can use it. That is why creating, editing and deleting one is admin,
 * while sending a test is editor — proving a channel works changes nothing
 * about where alerts go.
 *
 * Two things this screen must not lie about:
 *
 *  - **What is stored.** A webhook signing secret and a Slack webhook URL are
 *    credentials held in plain text in this server's state file. The list masks
 *    the URL past its host and never shows the secret, and every plan says
 *    where the value ends up before it is saved.
 *  - **What actually happened.** The last delivery result is shown as it is:
 *    accepted, or failed with the reason and the fix. A channel that has never
 *    been used says that rather than looking healthy.
 */
import { useState } from "react";
import { Radio, Send, Trash2, Pencil, Plus } from "lucide-react";
import type { Role } from "@/lib/actions/core";
import type { AlertChannelKind } from "@/lib/domain/types";
import { useProjectAlerts, type PublicAlertChannel } from "@/lib/client/alerts";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeAgo } from "@/components/ui/time-ago";
import { ActionConfirm, ErrorNote } from "@/components/screens/shared";
import { useGate } from "./access";

const KIND_LABEL: Record<AlertChannelKind, string> = {
  webhook: "Webhook",
  slack: "Slack",
  email: "Email",
};

const KIND_HELP: Record<AlertChannelKind, string> = {
  webhook:
    "A POST of JSON to your endpoint. With a secret, each request carries X-Zenith-Signature (HMAC-SHA256 over the exact body) so the receiver can prove Zenith sent it. " +
    "Delivery is retried, so the same alert can arrive more than once: dedupe on X-Zenith-Idempotency-Key, which is stable across retries — the body is not, since it carries the send time.",
  slack:
    "Slack's incoming-webhook payload — text plus blocks. Copy the URL from the incoming-webhook app; that URL is the credential, so Zenith masks it everywhere after you save it.",
  email:
    "One recipient address, sent over SMTP. Needs ZENITH_SMTP_URL and ZENITH_ALERT_FROM on this server — the password lives there, never on the channel.",
};

const TARGET_LABEL: Record<AlertChannelKind, string> = {
  webhook: "Endpoint URL",
  slack: "Slack incoming-webhook URL",
  email: "Recipient address",
};

const TARGET_PLACEHOLDER: Record<AlertChannelKind, string> = {
  webhook: "https://example.com/hooks/zenith",
  slack: "https://hooks.slack.com/services/T000/B000/xxxx",
  email: "ops@example.com",
};

type Draft = {
  kind: AlertChannelKind;
  name: string;
  target: string;
  secret: string;
  enabled: boolean;
};

/** What ActionConfirm plans against, captured once so typing never re-plans. */
type Pending =
  | { kind: "create"; draft: Draft }
  | { kind: "edit"; channel: PublicAlertChannel; draft: Draft }
  | { kind: "delete"; channel: PublicAlertChannel }
  | { kind: "test"; channel: PublicAlertChannel };

export function AlertChannelsSection({
  projectId,
  role,
}: {
  /** channels are workspace-wide, but they ride on a project's alerts payload */
  projectId: string | undefined;
  role: Role | null | undefined;
}) {
  const gate = useGate();
  const alerts = useProjectAlerts(projectId);
  const [form, setForm] = useState<{ editing?: PublicAlertChannel; draft: Draft } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const manageGate = gate(role, "alerts.createChannel");
  const testGate = gate(role, "alerts.testChannel");
  const channels = alerts.channels;
  const done = () => {
    setPending(null);
    setForm(null);
    alerts.refresh();
  };

  if (!projectId)
    return (
      <Callout tone="info">
        Delivery channels belong to the workspace, but this screen reads them through a project.
        Open a project to manage them.
      </Callout>
    );
  if (alerts.error) return <ErrorNote error={alerts.error} />;
  if (!alerts.data) return <Skeleton height={180} />;

  const emailProblem = alerts.data.emailProblem;
  const hasEmail = channels.some((c) => c.kind === "email");

  return (
    <>
      {emailProblem && hasEmail ? (
        <Callout tone="warn" title="Email channels cannot send on this server">
          <p>{emailProblem}</p>
          <p className="mt-1 text-ink-mute">
            Webhook and Slack channels are unaffected. Until this is set, every delivery to an email
            channel is recorded as failed with that reason — nothing is silently dropped.
          </p>
        </Callout>
      ) : null}

      <Card
        title={`${channels.length} delivery channel${channels.length === 1 ? "" : "s"}`}
        subtitle="Workspace-wide. A rule with no channels of its own delivers to every enabled one here; alerts are recorded and shown in Observe either way."
        padded={false}
        actions={
          <Button
            size="sm"
            variant="quiet"
            icon={<Plus className="h-3.5 w-3.5" />}
            disabled={!!manageGate}
            disabledReason={manageGate}
            onClick={() =>
              setForm({
                draft: { kind: "webhook", name: "", target: "", secret: "", enabled: true },
              })
            }
          >
            Add channel
          </Button>
        }
      >
        {channels.length === 0 ? (
          <div className="px-5 py-4">
            <EmptyState
              icon={<Radio className="h-5 w-5" />}
              title="No delivery channels"
              body="Alerts are recorded and shown under Observe → Alerts, and nowhere else: if nobody opens Zenith, nobody is told. A channel sends each alert — and each one that closes — to a webhook, a Slack channel or an email address. There is no paging and no on-call rotation."
              action={
                <Button
                  size="sm"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  disabled={!!manageGate}
                  disabledReason={manageGate}
                  onClick={() =>
                    setForm({
                      draft: { kind: "webhook", name: "", target: "", secret: "", enabled: true },
                    })
                  }
                >
                  Add the first channel
                </Button>
              }
            />
          </div>
        ) : (
          <ul>
            {channels.map((c) => (
              <li key={c.id} className="border-b border-line px-5 py-3.5 last:border-b-0">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="break-words text-[13px] font-medium text-ink">{c.name}</span>
                      <Chip tone="neutral">{KIND_LABEL[c.kind]}</Chip>
                      {c.enabled ? (
                        <Chip tone="ok">on</Chip>
                      ) : (
                        <Chip tone="neutral" title="Switched off: alerts are recorded but not sent here.">
                          off
                        </Chip>
                      )}
                      {c.kind === "webhook" &&
                        (c.hasSecret ? (
                          <Chip tone="ok" title="Requests carry X-Zenith-Signature, an HMAC-SHA256 over the exact body.">
                            signed
                          </Chip>
                        ) : (
                          <Chip tone="warn" title="No signing secret: the receiver cannot prove Zenith sent the request.">
                            unsigned
                          </Chip>
                        ))}
                    </p>
                    <p className="mt-0.5 break-all font-mono text-[12px] text-ink-mute" title={c.target}>
                      {c.target}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-ink-faint">
                      <LastDelivery channel={c} /> · added by {c.createdBy?.name ?? "someone"}{" "}
                      <TimeAgo iso={c.createdAt} />
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="quiet"
                      icon={<Send className="h-3.5 w-3.5" />}
                      disabled={!!testGate}
                      disabledReason={testGate}
                      onClick={() => setPending({ kind: "test", channel: c })}
                    >
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Pencil className="h-3.5 w-3.5" />}
                      disabled={!!manageGate}
                      disabledReason={manageGate}
                      onClick={() =>
                        setForm({
                          editing: c,
                          draft: {
                            kind: c.kind,
                            name: c.name,
                            // The stored target is masked on the wire, so editing
                            // starts empty rather than saving the mask back.
                            target: "",
                            secret: "",
                            enabled: c.enabled,
                          },
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      disabled={!!manageGate}
                      disabledReason={manageGate}
                      onClick={() => setPending({ kind: "delete", channel: c })}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {form && (
        <ChannelForm
          editing={form.editing}
          draft={form.draft}
          emailProblem={emailProblem}
          onChange={(draft) => setForm({ ...form, draft })}
          onCancel={() => setForm(null)}
          onSubmit={(draft) =>
            setPending(
              form.editing
                ? { kind: "edit", channel: form.editing, draft }
                : { kind: "create", draft }
            )
          }
        />
      )}

      {pending?.kind === "create" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="alerts.createChannel"
          input={{
            kind: pending.draft.kind,
            name: pending.draft.name.trim(),
            target: pending.draft.target.trim(),
            secret: pending.draft.secret.trim() || undefined,
            enabled: pending.draft.enabled,
          }}
          title={`Send alerts to ${pending.draft.name.trim() || "this channel"}`}
          description="The plan below names exactly what leaves this server, where it lands, and where the credential is kept."
          confirmLabel="Add channel"
          onDone={done}
        />
      )}

      {pending?.kind === "edit" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="alerts.updateChannel"
          input={{
            channelId: pending.channel.id,
            name: pending.draft.name.trim() || undefined,
            target: pending.draft.target.trim() || undefined,
            secret: pending.draft.secret.trim() || undefined,
            enabled: pending.draft.enabled,
          }}
          title={`Update ${pending.channel.name}`}
          confirmLabel="Save channel"
          onDone={done}
        />
      )}

      {pending?.kind === "delete" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="alerts.deleteChannel"
          input={{ channelId: pending.channel.id }}
          danger
          title={`Delete ${pending.channel.name}`}
          description="Alerts keep being evaluated, recorded and shown. They stop being sent here."
          confirmLabel="Delete channel"
          onDone={done}
        />
      )}

      {pending?.kind === "test" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="alerts.testChannel"
          input={{ channelId: pending.channel.id }}
          title={`Send a test to ${pending.channel.name}`}
          description="One labelled message, down the same path a real alert takes. The result is recorded on the channel whether it works or not."
          confirmLabel="Send test"
          onDone={done}
        />
      )}
    </>
  );
}

/** The last thing that happened to this channel, as it happened. */
function LastDelivery({ channel }: { channel: PublicAlertChannel }) {
  const last = channel.lastDelivery;
  if (!last)
    return (
      <span title="Zenith has not tried to send anything here yet — creating a channel does not test it.">
        nothing sent yet
      </span>
    );
  if (last.ok)
    return (
      <span className="text-ok">
        delivered <TimeAgo iso={last.at} />
        {last.status ? ` · HTTP ${last.status}` : ""}
      </span>
    );
  return (
    <span className="text-err" title={last.error}>
      failed <TimeAgo iso={last.at} />
      {last.error ? `: ${last.error}` : ""}
    </span>
  );
}

/* ---------------------------------- form ---------------------------------- */

function ChannelForm({
  editing,
  draft,
  emailProblem,
  onChange,
  onCancel,
  onSubmit,
}: {
  editing?: PublicAlertChannel;
  draft: Draft;
  emailProblem: string | null;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSubmit: (draft: Draft) => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const name = draft.name.trim();
  const target = draft.target.trim();
  // Editing leaves the target blank to mean "keep the one you cannot see".
  const needsTarget = !editing && target.length === 0;
  const why = !name
    ? "Give the channel a name — it is what the alert plans and the audit trail call it."
    : needsTarget
      ? `Enter the ${TARGET_LABEL[draft.kind].toLowerCase()}.`
      : undefined;

  return (
    <Card
      className="animate-enter"
      title={editing ? `Edit ${editing.name}` : "New delivery channel"}
      subtitle={KIND_HELP[draft.kind]}
    >
      <div className="max-w-[560px] space-y-3">
        {!editing && (
          <Field label="Kind" help={KIND_HELP[draft.kind]}>
            <Select
              value={draft.kind}
              onChange={(e) =>
                set({ kind: e.target.value as AlertChannelKind, target: "", secret: "" })
              }
              options={(Object.keys(KIND_LABEL) as AlertChannelKind[]).map((k) => ({
                value: k,
                label: KIND_LABEL[k],
              }))}
            />
          </Field>
        )}

        {draft.kind === "email" && emailProblem && (
          <Callout tone="warn">{emailProblem}</Callout>
        )}

        <Field label="Name" help="Shown in plans, in the channel list and on every delivery result.">
          <Input
            value={draft.name}
            autoFocus
            maxLength={60}
            placeholder="#ops in Slack"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>

        <Field
          label={TARGET_LABEL[draft.kind]}
          help={
            editing
              ? `Leave empty to keep the current one — Zenith masks it (${editing.target}) rather than sending it back to the browser.`
              : draft.kind === "email"
                ? "One address per channel. Add a second channel for a second recipient."
                : "The full URL, starting with https://."
          }
        >
          <Input
            value={draft.target}
            spellCheck={false}
            placeholder={editing ? "unchanged" : TARGET_PLACEHOLDER[draft.kind]}
            onChange={(e) => set({ target: e.target.value })}
          />
        </Field>

        {draft.kind === "webhook" && (
          <Field
            label="Signing secret (optional)"
            help={`Zenith signs the exact body with HMAC-SHA256 and sends X-Zenith-Signature. The secret is stored in plain text in this server's state file. ${editing ? "Leave empty to keep the current one." : "Leave empty to send unsigned requests."}`}
          >
            <Input
              type="password"
              value={draft.secret}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={editing && editing.hasSecret ? "unchanged" : "Paste or invent a shared secret"}
              onChange={(e) => set({ secret: e.target.value })}
            />
          </Field>
        )}

        <Field label="Delivery" help="Switched off, alerts are still recorded and shown — they just are not sent here.">
          <Select
            value={draft.enabled ? "on" : "off"}
            onChange={(e) => set({ enabled: e.target.value === "on" })}
            options={[
              { value: "on", label: "Receiving alerts" },
              { value: "off", label: "Switched off" },
            ]}
          />
        </Field>

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            disabled={!!why}
            disabledReason={why}
            onClick={() => onSubmit(draft)}
          >
            {editing ? "Preview and save" : "Preview and add"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
