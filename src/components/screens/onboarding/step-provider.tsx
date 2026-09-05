"use client";
/**
 * Step 2 — where this project will run. Nothing is created here: the choice is
 * handed to step 3, which builds the connection and the environment together.
 */
import { useEffect, useState } from "react";
import { ArrowRight, Check, Lock } from "lucide-react";
import { useJson } from "@/lib/client/api";
import type { CloudConnection } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProviderChoice, ProviderInfo } from "./types";

const AVAILABILITY_TONE: Record<ProviderInfo["availability"], ChipTone> = {
  available: "ok",
  preview: "warn",
  planned: "neutral",
};

const AVAILABILITY_LABEL: Record<ProviderInfo["availability"], string> = {
  available: "Available",
  preview: "Preview",
  planned: "Planned",
};

/** What a provider can honestly do today, straight off its adapter's availability. */
const AVAILABILITY_NOTE: Record<ProviderInfo["availability"], string> = {
  available: "Deploys run end to end.",
  preview: "Plan and Terraform export only — Orrery does not apply changes to it yet.",
  planned: "Not implemented. Nothing would happen if you picked it.",
};

/**
 * What a provider needs from the machine it runs against, when that is not
 * Orrery itself. Availability says the adapter works; it cannot say your
 * Docker is running. Providers listed here are probed on render through
 * GET /api/providers/:id/health, so the card reports what it found instead of
 * promising an end-to-end deploy the machine cannot do.
 */
const PROVIDER_PREREQUISITE: Record<string, string> = {
  localstack:
    "Needs LocalStack listening on localhost:4566 (Docker Desktop running, then `localstack start`).",
};

/** GET /api/providers/:id/health */
interface ProviderHealth {
  ok: boolean;
  checks: { id: string; label: string; status: string; detail?: string; fix?: string }[];
  probe?: { reachable: boolean; detail?: string; fix?: string };
  availability: ProviderInfo["availability"];
  displayName: string;
}

/** Why a provider cannot be picked. Only ever called for non-available ones. */
function notSelectableReason(p: ProviderInfo): string {
  return p.availability === "preview"
    ? `${p.displayName} is Preview: Orrery plans and exports Terraform for it, but cannot apply changes yet. Pick a provider marked Available, then export.`
    : `${p.displayName} is Planned, not implemented. Picking it would do nothing.`;
}

export interface StepProviderProps {
  providers: ProviderInfo[];
  connections: CloudConnection[];
  loading: boolean;
  onBack: () => void;
  /** the provider the project's first environment should deploy through */
  onNext: (choice: ProviderChoice) => void;
}

export function StepProvider({
  providers,
  connections,
  loading,
  onBack,
  onNext,
}: StepProviderProps) {
  // Selectability comes from the adapter's own availability, never from a
  // hardcoded "sandbox is special" test — LocalStack reports available and is
  // therefore choosable, exactly as the README says.
  const selectable = providers.filter((p) => p.availability === "available");
  const rest = providers.filter((p) => p.availability !== "available");

  // A provider with a prerequisite is probed before it can be picked, so
  // "deploys run end to end" is a claim about this machine, not about the
  // adapter. Only one provider has a prerequisite today, so one call does it.
  const probeId = selectable.find((p) => PROVIDER_PREREQUISITE[p.id])?.id;
  const health = useJson<ProviderHealth>(
    probeId ? `/api/providers/${encodeURIComponent(probeId)}/health` : null
  );
  const probing = Boolean(probeId) && health.loading;
  const reachable = Boolean(health.data?.ok);
  /** null when the provider is fine (or has no prerequisite); a sentence otherwise. */
  const unreachable = (id: string): string | null => {
    if (id !== probeId || probing || reachable) return null;
    const from =
      health.data?.probe?.fix ??
      health.data?.checks.find((c) => c.status !== "pass")?.fix ??
      health.error?.fix;
    return `Not reachable: ${from ?? PROVIDER_PREREQUISITE[id] ?? "start it and reload this page."}`;
  };

  const [picked, setPicked] = useState<string>("");

  /** Available, and — where that depends on this machine — actually up. */
  const pickable = selectable.filter((p) => p.id !== probeId || (!probing && reachable));

  // The default is a real selection in state, not a render-time fallback, so
  // the card that looks chosen is the one aria-checked reports and the one the
  // Continue button names. A provider that turns out to be down drops the
  // selection rather than leaving a card that cannot be used looking chosen.
  const firstId = pickable[0]?.id;
  const pickedGone = picked !== "" && !pickable.some((p) => p.id === picked);
  useEffect(() => {
    if (!picked && firstId) setPicked(firstId);
    else if (pickedGone) setPicked(firstId ?? "");
  }, [picked, firstId, pickedGone]);

  const chosen = pickable.find((p) => p.id === picked);
  const existing = connections.find((c) => c.provider === chosen?.id);

  /** Arrow keys move the selection inside the group, as radios do. */
  const move = (dir: 1 | -1) => {
    if (pickable.length === 0) return;
    const at = pickable.findIndex((p) => p.id === picked);
    const next = pickable[(at + dir + pickable.length) % pickable.length];
    if (!next) return;
    setPicked(next.id);
    document.querySelector<HTMLElement>(`[data-provider="${CSS.escape(next.id)}"]`)?.focus();
  };

  if (loading && providers.length === 0) return <Skeleton height={240} />;

  return (
    <div className="max-w-[760px] space-y-8 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">
        Orrery deploys into your cloud, never ours. Every provider below is labelled exactly as
        honestly as it behaves, and only the ones that really execute can be picked.
      </p>

      <div className="space-y-3">
        <h3 id="providers-available" className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          Available now — deploys run end to end
        </h3>
        <div role="radiogroup" aria-labelledby="providers-available" className="grid gap-3">
          {selectable.map((p) => {
            const active = p.id === chosen?.id;
            const conn = connections.find((c) => c.provider === p.id);
            const prerequisite = PROVIDER_PREREQUISITE[p.id];
            const down = unreachable(p.id);
            const checking = p.id === probeId && probing;
            const off = Boolean(down) || checking;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                data-provider={p.id}
                aria-checked={active}
                aria-disabled={off || undefined}
                disabled={off}
                title={down ?? (checking ? "Checking whether it is reachable…" : undefined)}
                tabIndex={active ? 0 : -1}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                    e.preventDefault();
                    move(1);
                  } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    move(-1);
                  }
                }}
                onClick={() => !off && setPicked(p.id)}
                className={cx(
                  "block w-full rounded-card border p-5 text-left transition-colors duration-[var(--dur-fast)]",
                  active
                    ? "border-signal/50 bg-bg2 ring-1 ring-signal/20 hover:border-signal"
                    : "border-line bg-bg1 hover:border-line-strong",
                  off && "cursor-not-allowed opacity-70"
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-[16px] font-medium text-ink">{p.displayName}</h2>
                    <p className="mt-1 max-w-[52ch] text-[13px] text-ink-mute">{p.tagline}</p>
                    <p className="mt-1.5 text-[12.5px] text-ink-faint">
                      {conn
                        ? `Already connected as “${conn.label}” (${conn.status}).`
                        : p.id === "sandbox"
                          ? "Nothing to connect — the sandbox runs inside Orrery."
                          : `Nothing is connected yet. The last step connects it and runs its preflight checks${
                              p.regions[0] ? ` in ${p.regions[0].label}` : ""
                            }.`}
                    </p>
                    {conn && conn.status !== "healthy" && (
                      <p className="mt-1.5 text-[12.5px] text-warn">
                        That connection is {conn.status}. Re-check it in Settings → Connections
                        before you deploy through it.
                      </p>
                    )}
                    {prerequisite && (
                      <p
                        role={p.id === probeId ? "status" : undefined}
                        className={cx(
                          "mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed",
                          down ? "text-err" : "text-ink-faint"
                        )}
                      >
                        {checking ? `Checking ${p.displayName}…` : (down ?? prerequisite)}
                      </p>
                    )}
                  </div>
                  <Chip
                    tone={checking ? "neutral" : down ? "err" : "ok"}
                    icon={down || checking ? undefined : <Check className="h-3 w-3" />}
                    title={
                      p.id === probeId
                        ? "Checked against this machine just now, not just against the adapter."
                        : undefined
                    }
                  >
                    {checking ? "Checking…" : down ? "Not reachable" : "Available"}
                  </Chip>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <Card
        title="Exact access this grants"
        subtitle="Every connection lists what it can touch, before you pick it."
      >
        <ul className="space-y-2 text-[13px] text-ink-mute">
          {(existing?.grantedPermissions ??
            (chosen?.id === "sandbox"
              ? ["No cloud access — the sandbox runs inside Orrery and simulates deployments."]
              : [
                  `Not connected yet. ${chosen?.displayName ?? "This provider"} lists the exact permissions it takes on the connection screen, before anything is created.`,
                ])
          ).map((p) => (
            <li key={p} className="flex gap-2.5">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </Card>

      {rest.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
            Not selectable yet
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {rest.map((p) => (
              <div
                key={p.id}
                title={notSelectableReason(p)}
                aria-disabled="true"
                className="rounded-card border border-line bg-bg1 p-4 opacity-80"
              >
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-[14px] text-ink">{p.displayName}</h4>
                  <Chip tone={AVAILABILITY_TONE[p.availability]}>
                    {AVAILABILITY_LABEL[p.availability]}
                  </Chip>
                </div>
                <p className="mt-1.5 text-[12.5px] text-ink-mute">{p.tagline}</p>
                <p className="mt-2 text-[12px] text-ink-faint">
                  {AVAILABILITY_NOTE[p.availability]}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="quiet" onClick={onBack}>
          Back
        </Button>
        <Button
          disabled={!chosen}
          disabledReason={
            probing
              ? "Still checking whether the available provider is reachable from this machine."
              : selectable.length > 0
                ? "The provider that reports itself available is not reachable from this machine. Start it and reload, or pick another once one ships."
                : "No provider reports itself available in this build, so there is nothing to deploy through."
          }
          onClick={() =>
            chosen &&
            onNext({
              providerId: chosen.id,
              connectionId: existing?.id,
              displayName: chosen.displayName,
            })
          }
          icon={<ArrowRight className="h-3.5 w-3.5" />}
        >
          {chosen ? `Use ${chosen.displayName}` : "Continue"}
        </Button>
      </div>
    </div>
  );
}
