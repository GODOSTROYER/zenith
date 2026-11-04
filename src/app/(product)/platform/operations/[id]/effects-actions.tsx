"use client";
/** Readback and resolution go through the browser routes; the server decides who may do either. */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EffectsPanel } from "@/components/platform/effects-panel";
import type { EffectView } from "@/lib/effects/view";
import type { ResolutionDecision } from "@/lib/effects/types";
import { browserMutation, mutationError } from "../../_lib/browser-api";

export function EffectsActions({ effects, viewerRole, workspaceId }: { effects: EffectView[]; viewerRole: "none" | "viewer" | "editor" | "admin"; workspaceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const run = async (effectId: string, path: string, body: unknown) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(effectId); setError(undefined);
    try {
      await browserMutation(workspaceId, `/api/platform/v1/effects/${encodeURIComponent(effectId)}/${path}`, body);
      router.refresh();
    } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setBusy(undefined); }
  };
  return <EffectsPanel effects={effects} viewerRole={viewerRole} busyEffectId={busy} error={error}
    onReadback={(effectId) => run(effectId, "readback", {})}
    onResolve={(input: { effectId: string; decision: ResolutionDecision; bindingDigest: string; reason: string }) => run(input.effectId, "resolve", { decision: input.decision, bindingDigest: input.bindingDigest, reason: input.reason })} />;
}
