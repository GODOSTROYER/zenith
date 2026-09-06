"use client";
import { useState } from "react";
import { ArrowRight, Lock, RefreshCw } from "lucide-react";
import { api, useJson } from "@/lib/client/api";
import type { CloudConnection } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProviderChoice, ProviderInfo } from "./types";

interface ProviderHealth {
  ok: boolean;
  checks: { id: string; label: string; status: string; detail?: string; fix?: string }[];
  probe?: { reachable: boolean; detail?: string; fix?: string };
}
export interface StepProviderProps {
  providers: ProviderInfo[]; connections: CloudConnection[]; loading: boolean;
  initialChoice?: ProviderChoice; onBack: () => void; onNext: (choice: ProviderChoice) => void;
}
export function StepProvider({ providers, connections, loading, initialChoice, onBack, onNext }: StepProviderProps) {
  const [picked, setPicked] = useState(initialChoice?.providerId ?? "");
  const health = useJson<ProviderHealth>(providers.some((p) => p.id === "localstack") ? "/api/providers/localstack/health" : null);
  const [rechecking, setRechecking] = useState(false);
  const [rechecked, setRechecked] = useState<ProviderHealth>();
  const [recheckError, setRecheckError] = useState<string>();
  const currentHealth = rechecked ?? health.data;
  const probing = health.loading || rechecking;
  const reachable = !probing && !recheckError && !!currentHealth?.ok;
  const selectable = providers.filter((p) => p.availability === "available" || p.id === "aws" && p.availability === "preview");
  const future = [
    ...providers.filter((p) => !selectable.some((s) => s.id === p.id)),
    ...[{ id: "azure", displayName: "Azure" }, { id: "oracle", displayName: "Oracle Cloud" }].filter((p) => !providers.some((s) => s.id === p.id)).map((p) => ({ ...p, availability: "planned" as const, tagline: "Provider support is not implemented.", regions: [] })),
  ];
  const chosen = selectable.find((p) => p.id === picked);
  const existing = connections.find((c) => c.id === initialChoice?.connectionId && c.provider === chosen?.id)
    ?? connections.find((c) => c.provider === chosen?.id && c.status === "healthy")
    ?? connections.find((c) => c.provider === chosen?.id);
  const blocked = !chosen || chosen.id === "localstack" && !reachable;
  const recheck = async () => {
    if (rechecking) return;
    setRechecking(true);
    setRecheckError(undefined);
    try { setRechecked(await api<ProviderHealth>("/api/providers/localstack/health")); }
    catch (error) { setRechecked(undefined); setRecheckError(error instanceof Error ? error.message : "The probe failed."); }
    finally { setRechecking(false); }
  };
  const permissions = existing?.declaredPermissions ?? existing?.grantedPermissions ?? (
    chosen?.id === "aws" ? ["No credentials or IAM permissions are needed. The AWS adapter does not call AWS or apply changes.", "Preview a plan and export Terraform; any external use of that export is a separate workflow."]
    : chosen?.id === "localstack" ? ["Calls the configured local LocalStack endpoint for supported S3 buckets and SQS queues.", "App services, routes and unsupported resources are blocked by deployment preflight."]
    : chosen?.id === "sandbox" ? ["No cloud access. Services, resources, deploys and observations are simulated."]
    : ["Select a provider to see its access and execution limits."]);
  if (loading && !providers.length) return <Skeleton height={240} />;
  return <div className="max-w-[760px] space-y-7 animate-enter">
    <p className="text-base leading-relaxed text-ink-mute">Choose what this project should use. Gimbal will keep the distinction between a local emulator, an AWS preview and a simulation visible throughout your workspace.</p>
    <div role="radiogroup" aria-label="Provider choices" className="space-y-3">
      {selectable.map((p) => <button type="button" key={p.id} role="radio" aria-checked={picked === p.id} onClick={() => setPicked(p.id)}
        onKeyDown={(e) => {
          if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) return;
          e.preventDefault();
          const at = selectable.findIndex((item) => item.id === p.id);
          const next = selectable[(at + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + selectable.length) % selectable.length];
          setPicked(next.id);
          document.getElementById(`guide-provider-${next.id}`)?.focus();
        }}
        id={`guide-provider-${p.id}`} tabIndex={picked ? (picked === p.id ? 0 : -1) : p.id === selectable[0]?.id ? 0 : -1}
        className={cx("block w-full rounded-card border p-5 text-left transition-colors", picked === p.id ? "border-signal bg-bg2" : "border-line bg-bg1 hover:border-line-strong")}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium text-ink">{p.id === "localstack" ? "Build locally" : p.id === "aws" ? "Prepare for AWS" : p.id === "sandbox" ? "Explore a simulation" : p.displayName}</h2><Chip tone={p.id === "aws" ? "warn" : "neutral"}>{p.id === "aws" ? "Preview · no apply" : p.id === "sandbox" ? "Simulation" : "Local emulator"}</Chip></div>
        <p className="mt-1 text-xs text-ink-faint">{p.displayName}</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-mute">{p.id === "aws" ? "Plan and export Terraform. Zenith.ai does not call AWS or deploy to it. No credentials or IAM setup required." : p.id === "localstack" ? "Real S3 and SQS operations against LocalStack on your machine. Needs a reachable local endpoint; full application deploys are not supported." : p.id === "sandbox" ? "Explore the complete workflow with simulated infrastructure. No cloud account or billable execution." : p.tagline}</p>
        {p.id === "localstack" && <p className={cx("mt-3 text-xs", reachable ? "text-signal" : "text-warn")}>{probing ? "Checking LocalStack…" : reachable ? "Local endpoint responded to the latest probe. Connection preflight still runs before creation." : recheckError ?? currentHealth?.probe?.fix ?? currentHealth?.checks.find((c) => c.status !== "pass")?.fix ?? "LocalStack is not reachable. Start the configured endpoint (usually localhost:4566), then recheck below."}</p>}
      </button>)}
    </div>
    {providers.some((p) => p.id === "localstack") && <Button variant="quiet" size="sm" busy={rechecking} onClick={recheck} icon={<RefreshCw className="h-3.5 w-3.5" />}>Recheck LocalStack</Button>}
    <div className="border-y border-line py-5"><h3 className="text-sm font-medium text-ink">Access and limits</h3><ul className="mt-3 space-y-2 text-sm text-ink-mute">{permissions.map((permission) => <li key={permission} className="flex gap-2"><Lock className="mt-1 h-3.5 w-3.5 shrink-0 text-signal" /><span>{permission}</span></li>)}</ul>
      {existing && <p className="mt-3 text-xs text-ink-faint">Existing connection: {existing.label} · {existing.status}. These are declared permissions; this screen does not grant access or recheck the saved connection.</p>}
    </div>
    <div><h3 className="text-sm text-ink-mute">Coming later</h3><div className="mt-3 grid gap-3 sm:grid-cols-2">{future.map((p) => <button type="button" disabled key={p.id} className="rounded-card border border-line p-4 text-left opacity-70" title="This provider is not implemented."><span className="text-sm text-ink">{p.displayName}</span><span className="ml-3 text-xs text-ink-faint">Coming later</span></button>)}</div></div>
    <div className="flex flex-wrap gap-2"><Button variant="quiet" onClick={onBack}>Back</Button><Button variant="primary" disabled={blocked} disabledReason={!chosen ? "Choose a provider explicitly." : "Start LocalStack and use Recheck LocalStack before continuing."} onClick={() => chosen && !blocked && onNext({ providerId: chosen.id, connectionId: existing?.id, displayName: chosen.displayName })} icon={<ArrowRight className="h-3.5 w-3.5" />}>{chosen ? `Continue with ${chosen.displayName}` : "Choose a provider"}</Button></div>
  </div>;
}
