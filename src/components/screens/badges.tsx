"use client";
/** One-liner presenters every screen shares: titles, dots, chips, change rows. */
import type { ReactNode } from "react";
import type { Actor, ChangeItem, EnvironmentClass } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { CostDelta } from "@/components/ui/cost-delta";
import { RiskBadge } from "@/components/ui/risk-badge";

/**
 * The label above a group of fields inside a panel — inspector tabs, the
 * deploy dock, the changes review. One markup, so a section heading never
 * drifts a pixel between two panels that sit side by side.
 */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[13px] font-semibold leading-snug text-ink-mute">
      {children}
    </h3>
  );
}

/**
 * "This number was computed, not measured." One label for every surface that
 * shows generated health, generated logs or an estimated cost, so the claim
 * reads the same wherever it appears. `title` says what was simulated when the
 * surface can be specific about it.
 */
export function SimulatedChip({ title }: { title?: string }) {
  return (
    <Chip tone="info" title={title}>
      simulated
    </Chip>
  );
}

const ENV_TONE: Record<EnvironmentClass, ChipTone> = {
  sandbox: "info",
  staging: "signal",
  production: "prod",
};

export const envTone = (klass: EnvironmentClass): ChipTone => ENV_TONE[klass];

/** class-coloured dot used on environment chips across overview + settings. */
export function EnvDot({ klass }: { klass: EnvironmentClass }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        klass === "production" ? "bg-prod" : klass === "staging" ? "bg-signal" : "bg-info"
      )}
    />
  );
}

/** Agent work is always visibly agent work. */
export function ActorDot({ actor }: { actor: Actor }) {
  const tone =
    actor.type === "navigator" ? "bg-nav-accent" : actor.type === "user" ? "bg-signal" : "bg-ink-faint";
  return (
    <span
      title={`${actor.name} (${actor.type})`}
      className={cx("inline-block h-2 w-2 shrink-0 rounded-full", tone)}
    />
  );
}

const OP_TONE: Record<ChangeItem["op"], ChipTone> = {
  create: "signal",
  update: "signal",
  delete: "err",
};

const OP_LABEL: Record<ChangeItem["op"], string> = {
  create: "add",
  update: "change",
  delete: "remove",
};

/** One line of a changeset — same explanation strings everywhere. */
export function ChangeRow({ item, onSelect, selected = false }: { item: ChangeItem; onSelect?: () => void; selected?: boolean }) {
  return (
    <li className={cx("flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 transition-colors duration-[var(--dur-fast)]", selected && "bg-signal-dim")}>
      <Chip tone={OP_TONE[item.op]} className="mt-0.5">
        {OP_LABEL[item.op]}
      </Chip>
      <div className="min-w-[140px] flex-1">
        <p className="text-[13px] text-ink">
          {onSelect ? <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`Inspect ${item.nodeName}`} className="break-all text-left font-mono underline decoration-line-strong underline-offset-4 hover:text-signal">{item.nodeName}</button> : <span className="break-all font-mono">{item.nodeName}</span>}{" "}
          <span className="text-ink-faint">{item.nodeType}</span>
        </p>
        <p className="mt-0.5 text-[12.5px] text-ink-mute">{item.explanation}</p>
        {item.fields && item.fields.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 font-mono text-[11.5px] text-ink-faint">
            {item.fields.map((f) => (
              <li key={f.field} className="break-all">
                {f.field}: {JSON.stringify(f.before)} → {JSON.stringify(f.after)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.costDeltaUsd !== 0 && <CostDelta usd={item.costDeltaUsd} />}
        <RiskBadge level={item.risk} />
      </div>
    </li>
  );
}
