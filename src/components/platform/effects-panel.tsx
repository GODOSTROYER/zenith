"use client";
/**
 * External effects of one operation: provider calls whose outcome may be unknown (PROD-DUR-07 / PROD-DUR-08).
 *
 * Presentational. It renders `EffectView`s (the same projection the API returns) and reports operator intent
 * through two callbacks; the server routes decide authority. An uncertain effect is never offered a retry: the
 * only controls are an independent read-only readback, and, for an admin, a resolution bound to the exact
 * evidence on screen.
 *
 * Accessibility: a labelled region; each effect is an article with its own heading; state is printed as a word
 * beside its chip; resolution controls explain why they are unavailable in text.
 */
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Textarea } from "@/components/ui/textarea";
import type { EffectView } from "@/lib/effects/view";
import type { ResolutionDecision } from "@/lib/effects/types";
import { DigestValue } from "./badges";

const TONE: Record<EffectView["state"], ChipTone> = { pending: "info", accepted: "info", confirmed: "ok", uncertain: "warn", conflict: "warn", tombstoned: "neutral" };

export interface EffectsPanelProps {
  effects: readonly EffectView[];
  viewerRole: "none" | "viewer" | "editor" | "admin";
  /** run the read-only readback; resolves when the server has recorded it */
  onReadback?: (effectId: string) => Promise<void>;
  /** authorize a resolution on the reviewed binding digest */
  onResolve?: (input: { effectId: string; decision: ResolutionDecision; bindingDigest: string; reason: string }) => Promise<void>;
  /** an error from the last action, already worded for people */
  error?: string;
  busyEffectId?: string;
}

function Facts({ facts }: { facts: Record<string, string | number | boolean | null> }) {
  const rows = Object.entries(facts);
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-ink-mute">{k}</dt><dd className="break-all font-mono text-ink">{String(v)}</dd></div>
      ))}
    </dl>
  );
}

const DECISION_COPY: Record<ResolutionDecision, { button: string; legend: string }> = {
  confirm_applied: { button: "Confirm it happened", legend: "The provider shows it exists. Adopt it as this effect's result." },
  confirm_not_applied: { button: "Confirm it did not happen", legend: "The provider shows nothing. Retire this attempt; a new operation is needed to try again." },
};

function EffectCard({ effect, viewerRole, onReadback, onResolve, busy }: { effect: EffectView; viewerRole: EffectsPanelProps["viewerRole"]; onReadback?: EffectsPanelProps["onReadback"]; onResolve?: EffectsPanelProps["onResolve"]; busy: boolean }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const canRead = (viewerRole === "editor" || viewerRole === "admin") && !!onReadback && effect.state !== "confirmed" && effect.storedState !== "tombstoned";
  const canResolve = viewerRole === "admin" && !!onResolve && effect.needsOperator;
  return (
    <article aria-labelledby={`${id}-h`} className="space-y-3 rounded-ctl border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-h`} className="text-[14px] font-medium text-ink">{effect.familyLabel} <span className="font-normal text-ink-mute">on {effect.provider}</span></h3>
        <Chip tone={TONE[effect.state]}>{effect.stateLabel}</Chip>
      </div>
      <p className="text-[13px] text-ink">{effect.headline}</p>
      {effect.reason && <p className="text-[12.5px] text-ink-mute">{effect.reason}</p>}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12.5px]">
        <dt className="text-ink-mute">Provider receipt</dt>
        <dd className="break-all font-mono text-ink">{effect.receipt ? (effect.receipt.resourceId ?? "none") : "none yet"}</dd>
        {effect.lateReceipt && <><dt className="text-ink-mute">Late receipt</dt><dd className="break-all font-mono text-ink">{effect.lateReceipt.resourceId ?? "no id"} (received {effect.lateReceipt.receivedAt}{effect.lateReceipt.staleFence ? ", after the lease was gone" : ""})</dd></>}
        <dt className="text-ink-mute">Provider token</dt>
        <dd className="text-ink">{effect.idempotency.supported ? (effect.idempotency.tokenSent ? "sent" : "supported, not sent") : "this provider takes none"}</dd>
        <dt className="text-ink-mute">Dispatching lease</dt>
        <dd className="text-ink">{effect.fence.scope ? `${effect.fence.live ? "still held" : "no longer held"} (fence ${effect.fence.epoch ?? "unknown"})` : "none recorded"}</dd>
      </dl>
      {effect.readback ? (
        <div className="space-y-1 rounded-ctl bg-bg2 p-2">
          <p className="text-[12.5px] text-ink"><strong>Independent readback:</strong> {effect.readback.outcome === "present" ? "found it" : effect.readback.outcome === "absent" ? "did not find it" : effect.readback.outcome === "mismatch" ? "found something that does not match" : "could not read"} via {effect.readback.source}, <time dateTime={effect.readback.observedAt}>{effect.readback.observedAt}</time></p>
          {effect.readback.reason && <p className="text-[12.5px] text-ink-mute">{effect.readback.reason}</p>}
          <Facts facts={effect.readback.facts} />
          <p className="text-[12px] text-ink-mute">Evidence digest <DigestValue digest={effect.readback.digest} what="readback digest" /></p>
        </div>
      ) : effect.needsOperator ? <p className="text-[12.5px] text-ink-mute">No independent readback has been recorded yet.</p> : null}
      {canRead && (
        <Button size="sm" busy={busy} disabled={busy} onClick={() => void onReadback!(effect.effectId)}>
          Read back from the provider
        </Button>
      )}
      {effect.needsOperator && (
        <div className="space-y-2" role="group" aria-label="Resolve this effect">
          {effect.resolutionOptions.map((o) => (
            <div key={o.decision} className="space-y-1">
              <p className="text-[12.5px] text-ink-mute">{DECISION_COPY[o.decision].legend}{!o.available && o.blockedBy ? ` Not available: ${o.blockedBy}` : ""}</p>
            </div>
          ))}
          {canResolve ? (
            <>
              <label htmlFor={`${id}-reason`} className="block text-[12.5px] text-ink">Why you are confident (recorded with your name)</label>
              <Textarea id={`${id}-reason`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                {effect.resolutionOptions.map((o) => (
                  <Button key={o.decision} size="sm" variant={o.decision === "confirm_not_applied" ? "danger" : "primary"} busy={busy}
                    disabled={busy || !o.available || reason.trim().length < 3}
                    disabledReason={!o.available ? o.blockedBy : reason.trim().length < 3 ? "Write a short reason first." : undefined}
                    onClick={() => void onResolve!({ effectId: effect.effectId, decision: o.decision, bindingDigest: o.bindingDigest!, reason: reason.trim() })}>
                    {DECISION_COPY[o.decision].button}
                  </Button>
                ))}
              </div>
            </>
          ) : <p className="text-[12.5px] text-ink-mute">Only a workspace admin, signed in through the browser, can resolve this. Ask one to review the evidence above.</p>}
        </div>
      )}
    </article>
  );
}

export function EffectsPanel({ effects, viewerRole, onReadback, onResolve, error, busyEffectId }: EffectsPanelProps) {
  const id = useId();
  if (effects.length === 0) return null;
  const open = effects.filter((e) => e.needsOperator).length;
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3 rounded-card border border-line bg-bg1 p-4">
      <h2 id={`${id}-h`} className="text-[15px] font-medium text-ink">External changes</h2>
      <p className="text-[12.5px] text-ink-mute">Each row is one call Zenith made to a provider. Zenith records it before the call, never repeats it on its own, and confirms it by reading the provider back.</p>
      {open > 0 && <Callout tone="warn" title={`${open} ${open === 1 ? "change needs" : "changes need"} your review`}>Zenith cannot prove whether {open === 1 ? "it" : "they"} happened. Nothing will be retried.</Callout>}
      {error && <Callout tone="err">{error}</Callout>}
      <div className="space-y-3">
        {effects.map((e) => <EffectCard key={`${e.effectId}:${e.version}`} effect={e} viewerRole={viewerRole} onReadback={onReadback} onResolve={onResolve} busy={busyEffectId === e.effectId} />)}
      </div>
    </section>
  );
}
