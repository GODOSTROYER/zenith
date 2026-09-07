/**
 * What actually happened to an invitation email — and the way out when nothing
 * happened at all.
 *
 * "Sent" here means a mail server accepted the message. It does not mean it
 * arrived, and this component never says it did. When the API hands back an
 * acceptance link, that link is shown once: copying it is the owner's only way
 * to pass the invitation on by hand.
 *
 * Workstream W9 (hosted R3)
 */
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import type { DeliveryState, InviteDelivery } from "@/lib/hosted/contracts/types";
import { DELIVERY_STATE, TRANSPORT_NOTE } from "./labels";

/** The sentence is long on purpose, so it reads as text rather than a badge. */
const DOT: Record<DeliveryState, DotStatus> = {
  pending: "idle",
  sending: "running",
  sent: "info",
  failed: "err",
};

export interface DeliveryNoteProps {
  delivery?: InviteDelivery | null;
  /** returned once, when the owner has to hand the link over themselves */
  acceptUrl?: string;
  /** who the invitation is for, so the copy names them */
  email: string;
  className?: string;
}

export function DeliveryNote({ delivery, acceptUrl, email, className }: DeliveryNoteProps) {
  if (!delivery && !acceptUrl) return null;
  const label = delivery ? DELIVERY_STATE[delivery.state] : null;
  const transportNote = delivery?.transport ? TRANSPORT_NOTE[delivery.transport] : undefined;

  return (
    <div className={className}>
      {label && delivery && (
        <p className="flex items-start gap-2 text-[12.5px] text-ink">
          <StatusDot status={DOT[delivery.state]} className="mt-1.5" label={label.text} />
          <span className="min-w-0">{label.text}</span>
        </p>
      )}

      {delivery?.state === "failed" && (
        <Callout tone="err" compact className="mt-2">
          <p>
            The invitation email for {email} was not sent.
            {delivery.error ? ` ${delivery.error}` : ""}
          </p>
          {!acceptUrl && (
            <p className="mt-1 text-ink-mute">
              Resend it, or ask an operator to check the mail configuration for this install.
            </p>
          )}
        </Callout>
      )}

      {transportNote && delivery?.state !== "failed" && (
        <p className="mt-1.5 max-w-[70ch] text-[12.5px] text-ink-mute">{transportNote}</p>
      )}

      {acceptUrl && (
        <div className="mt-2 space-y-2 rounded-card border border-line bg-bg1 p-3">
          <p className="max-w-[70ch] text-[12.5px] text-ink">
            This link is shown once. Copy it now and send it to {email} yourself — Zenith cannot show
            it again, and it only works for that address.
          </p>
          <p className="font-mono text-[12px] break-all text-ink-mute">{acceptUrl}</p>
          <CopyButton
            value={acceptUrl}
            variant="quiet"
            label="Copy invite link"
            what={`the invitation link for ${email}`}
          />
        </div>
      )}
    </div>
  );
}
