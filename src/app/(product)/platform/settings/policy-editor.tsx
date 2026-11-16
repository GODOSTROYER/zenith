"use client";
/** Policy writes replace overrides with an explicit reviewed version; the broker validates every field. */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkspacePolicyView } from "@/lib/capabilities/policy-settings";
import type { RoleName } from "@/components/platform/labels";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { browserMutation, mutationError } from "../_lib/browser-api";
export function WorkspacePolicyEditor({ initial, viewerRole }: { initial: WorkspacePolicyView; viewerRole: RoleName }) {
  const [current, setCurrent] = useState(initial);
  const [draft, setDraft] = useState(JSON.stringify(initial.overrides, null, 2));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const router = useRouter();
  const blocked = viewerRole !== "admin" ? "Only a workspace admin can change policy. Ask an admin to save these settings." : undefined;
  const save = async () => {
    if (blocked || inFlight.current) return;
    setError(undefined); setSaved(false);
    let overrides: unknown;
    try { overrides = JSON.parse(draft); }
    catch { setError("Enter a valid JSON object of policy overrides."); return; }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) { setError("Policy overrides must be a JSON object."); return; }
    inFlight.current = true; setPending(true);
    try {
      const next = await browserMutation<WorkspacePolicyView>(current.workspaceId, "/api/platform/v1/workspace/policy", { overrides, expectedVersion: current.version }, "PUT");
      setCurrent(next); setDraft(JSON.stringify(next.overrides, null, 2)); setSaved(true);
    } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <Card title="Policy parameters" subtitle={`Version ${current.version}${current.isDefault ? " · workspace defaults" : " · configured overrides"}`}>
    <div className="space-y-4">
      <p className="text-[13px] text-ink-mute">Policy applies at every autonomy level. Saving replaces this workspace’s overrides; omitted fields use defaults. Regions, budgets, approval thresholds, two-person approval, remediation and denied capabilities are validated by the server.</p>
      <details open><summary className="text-[13px] font-medium">Effective policy</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap break-words text-[12px]">{JSON.stringify(current.effective, null, 2)}</pre></details>
      <Field label="Policy overrides (JSON)" help="Enter parameters only. Never paste credentials or secret values.">
        <Textarea value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); }} rows={14} maxLength={60000} disabled={Boolean(blocked) || pending} />
      </Field>
      {blocked && <p className="text-[13px] text-ink-mute">{blocked}</p>}
      {error && <Callout tone="err">{error}</Callout>}
      {saved && <p role="status" className="text-[13px] text-ink-mute">Policy saved at version {current.version}.</p>}
      <Button onClick={() => void save()} busy={pending} disabled={Boolean(blocked)} disabledReason={blocked}>Save workspace policy</Button>
      <Button variant="quiet" onClick={() => router.refresh()}>Reload policy</Button>
    </div>
  </Card>;
}
