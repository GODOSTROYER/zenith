"use client";
/**
 * Dismissal is a mutation like any other, so it goes through the same
 * plan-first dialog as Fix. The reason is part of the planned input — the
 * preview quotes exactly the sentence that will be written to the audit log,
 * and an empty one is refused by the action's own schema rather than by a
 * disabled button this screen invented.
 *
 * ponytail: the reason is debounced before planning, so the plan on screen can
 * be up to 250ms behind the keystrokes. It is always the input that executes.
 */
import { useEffect, useState } from "react";
import type { SecurityFinding } from "@/lib/domain/types";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { ActionConfirm, type Scope } from "@/components/screens/shared";

/** How long the typed reason settles before it is planned. */
const REASON_DEBOUNCE_MS = 250;

export interface DismissDialogProps {
  finding: SecurityFinding | null;
  scope: Scope;
  onClose: () => void;
  onDone: () => void;
}

export function DismissDialog({ finding, scope, onClose, onDone }: DismissDialogProps) {
  const [reason, setReason] = useState("");
  const [planned, setPlanned] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setPlanned(reason.trim()), REASON_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [reason]);

  // A new finding is a new decision: never carry a reason across.
  useEffect(() => {
    if (finding) {
      setReason("");
      setPlanned("");
    }
  }, [finding]);

  const settling = reason.trim() !== planned;

  return (
    <ActionConfirm
      open={finding !== null}
      onClose={onClose}
      actionId="security.dismissFinding"
      input={{ findingId: finding?.id, reason: planned }}
      scope={scope}
      title="Dismiss this finding"
      description={finding?.title}
      confirmLabel="Dismiss"
      onDone={onDone}
    >
      <div className="space-y-3">
        <p className="text-[13px] text-ink-mute">
          Dismissing changes nothing about the system. The finding moves to History with the reason
          below, which is permanent — reopening it later does not erase this.
        </p>
        {finding?.severity === "high" && (
          <Callout tone="warn" compact>
            This is a high-severity finding. Dismissing it does not make it safe.
          </Callout>
        )}
        <label className="block space-y-1.5">
          <span className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Reason</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Accepted — internal-only service behind the VPN"
            autoFocus
          />
        </label>
        <p className="text-[11.5px] text-ink-faint">
          {settling
            ? "Updating the preview for what you typed…"
            : "The preview below is for exactly this reason."}
        </p>
      </div>
    </ActionConfirm>
  );
}
