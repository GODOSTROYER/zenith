"use client";
/**
 * Human browser teardown: server plan → exact name confirmation → operation
 * review. This control never approves or applies a destroy itself. The shared
 * ActionPlan details carry counts, stateful deletes and retained resources; do
 * not reconstruct them from stored observations or invent a second DTO.
 * HTTP replies and cloud execution are unverified live in this workstream.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ActionPlan } from "@/lib/actions/core";
import { ApiError, executeAction, planAction } from "@/lib/client/api";
import { roleShortfall } from "@/lib/domain/roles";
import type { RoleName } from "@/components/platform/labels";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { mutationError } from "../../_lib/browser-api";

interface TeardownProps {
  workspaceId: string;
  environmentId: string;
  environmentName?: string;
  viewerRole: RoleName;
}
type Phase = "idle" | "planning" | "preview" | "submitting" | "submitted" | "refused" | "unavailable" | "uncertain";

/** Runtime responses may come from an older server; fail closed on missing review facts. */
function reviewable(value: unknown): value is ActionPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<ActionPlan>;
  return typeof plan.summary === "string" && plan.summary.trim().length > 0
    && Array.isArray(plan.details) && plan.details.length > 0 && plan.details.every((line) => typeof line === "string")
    && Array.isArray(plan.warnings) && plan.warnings.every((line) => typeof line === "string")
    && typeof plan.requiresApproval === "boolean"
    && (plan.blocked === undefined || typeof plan.blocked === "string")
    && (plan.requiredRole === undefined || ["viewer", "editor", "admin"].includes(plan.requiredRole));
}

function operationId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("operationId" in data)) return undefined;
  const id = data.operationId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : undefined;
}

/** A new environment, workspace, name or role invalidates both review and confirmation. */
export function EnvironmentTeardown(props: TeardownProps) {
  return <TeardownControl key={JSON.stringify([props.workspaceId, props.environmentId, props.environmentName, props.viewerRole])} {...props} />;
}

function TeardownControl({ environmentId, environmentName, viewerRole }: TeardownProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<ActionPlan>();
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState("");
  const [createdId, setCreatedId] = useState<string>();
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const unavailable = !environmentName?.trim() ? "The environment name is unavailable. Reload before requesting teardown."
    : viewerRole === "none" ? "Workspace membership is required to review teardown." : undefined;
  const approvalGap = plan && !plan.requiresApproval ? "Human approval is unavailable for this plan. Teardown cannot be requested. Reload after restoring the approval service." : undefined;
  const roleGap = viewerRole === "none" ? unavailable : roleShortfall(plan?.requiredRole ?? "admin", viewerRole, "Requesting teardown");
  const confirmReason = plan?.blocked !== undefined ? "The server refused this teardown plan. Review the refusal below."
    : approvalGap ?? roleGap ?? (typed !== environmentName ? "Type the exact environment name to confirm." : undefined);
  const scope = { environmentId };
  const input = { environmentId };
  const operationsHref = `/platform?environmentId=${encodeURIComponent(environmentId)}`;

  const review = async () => {
    if (inFlight.current || unavailable || phase === "submitted" || phase === "uncertain") return;
    inFlight.current = true;
    setPhase("planning"); setPlan(undefined); setTyped(""); setMessage("");
    try {
      const next = await planAction("env.teardown", { input, scope });
      if (!alive.current) return;
      if (!reviewable(next)) {
        setPhase("unavailable"); setMessage("The destroy-plan summary is unavailable or incomplete. Reload after the teardown service is restored.");
      } else { setPlan(next); setPhase("preview"); }
    } catch (error) {
      if (!alive.current) return;
      const status = error instanceof ApiError ? error.status : undefined;
      setPhase(status === 401 || status === 403 || status === 409 ? "refused" : "unavailable");
      setMessage(status === 404 ? "Teardown is unavailable for this environment or server. Reload after the teardown action is available." : mutationError(error));
    } finally { inFlight.current = false; }
  };

  const submit = async () => {
    if (inFlight.current || unavailable || phase !== "preview" || !plan || confirmReason) return;
    inFlight.current = true; setPhase("submitting"); setMessage("");
    try {
      const result = await executeAction("env.teardown", { input, scope, idempotencyKey: crypto.randomUUID() });
      if (!alive.current) return;
      if (result?.ok === false) {
        setPhase("refused"); setTyped(""); setMessage("The server refused the teardown request. Review a new plan after checking your session, workspace role and policy.");
      } else {
        const id = result?.ok === true ? operationId(result.data) : undefined;
        if (id) { setCreatedId(id); setPhase("submitted"); }
        else { setPhase("uncertain"); setMessage("The request returned without a verifiable operation reference. Check environment operations before making another request."); }
      }
    } catch (error) {
      if (!alive.current) return;
      const status = error instanceof ApiError ? error.status : undefined;
      // A lost reply may follow a committed proposal. Do not offer a blind retry.
      const refused = status === 401 || status === 403 || status === 404 || status === 409;
      setPhase(refused ? "refused" : "uncertain"); setTyped("");
      setMessage(refused ? mutationError(error) : "The teardown request could not be confirmed. Check environment operations before making another request.");
    } finally { inFlight.current = false; }
  };

  const preview = plan && (phase === "preview" || phase === "submitting");
  return <section aria-label="Environment teardown" className="space-y-4 border-t border-line pt-5">
    <div className="space-y-2">
      <h2 className="text-[20px] font-medium text-ink">Teardown environment</h2>
      <p className="max-w-prose text-[13px] text-ink-mute">Review the destroy plan before requesting removal of this environment’s infrastructure. Stateful deletions can permanently remove data. A human must approve the resulting operation separately.</p>
    </div>
    {unavailable && <Callout tone="warn" title="Teardown unavailable">{unavailable}</Callout>}
    {phase !== "submitted" && phase !== "uncertain" && <Button onClick={() => void review()} busy={phase === "planning"}
      disabled={Boolean(unavailable) || phase === "submitting"} disabledReason={unavailable ?? "The teardown request is being submitted."}>
      {phase === "preview" ? "Review a new plan" : "Review teardown plan"}
    </Button>}
    {phase === "planning" && <p role="status" className="text-[13px] text-ink-mute">Loading the server’s destroy-plan summary…</p>}
    {preview && <div className="space-y-4">
      <div className="space-y-2 break-words">
        <h3 className="text-[16px] font-medium text-ink">Destroy-plan summary</h3>
        <p className="text-[13px] text-ink">{plan.summary}</p>
        <p className="text-[12px] text-ink-mute">Review the server’s resource counts, stateful deletions and retained resources below. Final approval uses the operation’s recorded plan.</p>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink">{plan.details.map((line, index) => <li key={index}>{line}</li>)}</ul>
        {plan.warnings.map((warning, index) => <Callout key={index} tone="warn">{warning}</Callout>)}
      </div>
      {plan.blocked !== undefined && <Callout tone="err" title="Teardown refused">{plan.blocked || "The server refused this plan. Review a new plan after checking workspace policy."}</Callout>}
      {approvalGap && <Callout tone="warn" title="Approval unavailable">{approvalGap}</Callout>}
      {roleGap && <Callout tone="warn" title="Teardown refused">{roleGap}</Callout>}
      <Field label="Confirm environment name" help={<>Type <strong className="whitespace-pre-wrap break-words text-ink">{environmentName}</strong> exactly, including case and spaces.</>} required>
        <Input value={typed} onChange={(event) => setTyped(event.target.value)} disabled={phase === "submitting" || Boolean(confirmReason && (plan.blocked !== undefined || approvalGap || roleGap))} autoComplete="off" spellCheck={false} />
      </Field>
      <Button variant="danger" onClick={() => void submit()} busy={phase === "submitting"} disabled={Boolean(confirmReason)} disabledReason={confirmReason}>Request teardown for approval</Button>
      {phase === "submitting" && <p role="status" className="text-[13px] text-ink-mute">Submitting the teardown request…</p>}
    </div>}
    {(phase === "refused" || phase === "unavailable" || phase === "uncertain") && <Callout tone={phase === "refused" ? "err" : "warn"}
      title={phase === "refused" ? "Teardown refused" : phase === "uncertain" ? "Request outcome unknown" : "Teardown unavailable"}>
      {message}
      {phase === "uncertain" && <Link href={operationsHref} className="mt-2 block text-signal underline underline-offset-4">Review environment operations</Link>}
    </Callout>}
    {phase === "submitted" && createdId && <div role="status" className="space-y-2 text-[13px]">
      <p>Teardown request recorded. Review the operation’s plan and approval state.</p>
      <Link href={`/platform/operations/${encodeURIComponent(createdId)}`} className="text-signal underline underline-offset-4">Review teardown operation for approval</Link>
    </div>}
  </section>;
}
