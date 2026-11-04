"use client";
/** Create, review and revoke standing grants. Mutations are browser-session only; the server enforces role, bounds and origin. */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { StandingGrant, StandingGrantUse } from "@/lib/capabilities/standing-grants";
import type { RoleName } from "@/components/platform/labels";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { browserMutation, mutationError } from "../_lib/browser-api";

interface Row { grant: StandingGrant; uses: StandingGrantUse[] }
interface Props {
  workspaceId: string;
  viewerRole: RoleName;
  viewerId: string;
  environments: { id: string; name: string; class: string }[];
  capabilities: { name: string; title: string; risk: string }[];
  rows: Row[];
}

const when = (iso: string) => new Date(iso).toLocaleString();

function stateOf(g: StandingGrant, now: number): string {
  if (g.status === "revoked") return "Revoked";
  if (Date.parse(g.expiresAt) <= now) return "Expired";
  if (g.uses >= g.maxUses) return "Used up";
  return "Active";
}

export function StandingGrantsPanel({ workspaceId, viewerRole, viewerId, environments, capabilities, rows }: Props) {
  const router = useRouter();
  const [environmentId, setEnvironmentId] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [maxRisk, setMaxRisk] = useState("medium");
  const [principals, setPrincipals] = useState("");
  const [maxUses, setMaxUses] = useState("5");
  const [minutes, setMinutes] = useState("60");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const inFlight = useRef(false);
  const isAdmin = viewerRole === "admin";
  const blocked = isAdmin ? undefined : "Only a workspace admin can create or revoke a standing grant.";
  const now = Date.now();

  const create = async () => {
    if (blocked || inFlight.current) return;
    setError(undefined); setNotice(undefined);
    const allowedPrincipals = principals.split(/[\s,]+/).filter(Boolean);
    const uses = Number(maxUses), mins = Number(minutes);
    if (!environmentId) return setError("Choose the one environment this grant covers.");
    if (chosen.size === 0) return setError("Choose at least one capability.");
    if (allowedPrincipals.length === 0) return setError("Name at least one agent, as integration:<id> or navigator:<id>.");
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) return setError("Uses must be a whole number from 1 to 1000.");
    if (!Number.isInteger(mins) || mins < 5 || mins > 43200) return setError("The grant must expire between 5 minutes and 30 days (43200 minutes) from now.");
    inFlight.current = true; setPending("create");
    try {
      await browserMutation(workspaceId, "/api/platform/v1/standing-grants", {
        environmentId, capabilities: [...chosen], maxRisk, allowedPrincipals, maxUses: uses, expiresInMinutes: mins, ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setNotice("Standing grant created."); setChosen(new Set()); setPrincipals(""); setReason("");
      router.refresh();
    } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setPending(null); }
  };

  const revoke = async (g: StandingGrant) => {
    if (blocked || inFlight.current) return;
    setError(undefined); setNotice(undefined);
    inFlight.current = true; setPending(g.id);
    try {
      await browserMutation(workspaceId, `/api/platform/v1/standing-grants/${encodeURIComponent(g.id)}/revoke`, {});
      setNotice("Standing grant revoked. Operations already approved under it will not be dispatched.");
      router.refresh();
    } catch (failure) { setError(mutationError(failure)); }
    finally { inFlight.current = false; setPending(null); }
  };

  const toggle = (name: string, on: boolean) => setChosen((prev) => { const next = new Set(prev); if (on) next.add(name); else next.delete(name); return next; });

  return <div className="space-y-6">
    {error && <Callout tone="err">{error}</Callout>}
    {notice && <p role="status" className="text-[13px] text-ink-mute">{notice}</p>}

    <Card title="Create a standing grant" subtitle="Every bound is required">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void create(); }} aria-label="Create a standing grant">
        <Field label="Environment" help="The one environment this grant covers.">
          <Select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} placeholder="Choose an environment" disabled={Boolean(blocked) || pending !== null}
            options={environments.map((e) => ({ value: e.id, label: `${e.name} (${e.class})` }))} />
        </Field>
        <fieldset className="space-y-2" disabled={Boolean(blocked) || pending !== null}>
          <legend className="text-[13px] font-medium text-ink">Capabilities</legend>
          <p className="text-[12px] text-ink-mute">Destructive, raw-execution and critical-risk capabilities are never offered.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {capabilities.map((c) => <Checkbox key={c.name} checked={chosen.has(c.name)} onChange={(on) => toggle(c.name, on)} label={c.title} help={`${c.name} · ${c.risk} risk`} />)}
          </div>
        </fieldset>
        <Field label="Risk ceiling" help="The operation's evaluated risk may not exceed this.">
          <Select value={maxRisk} onChange={(event) => setMaxRisk(event.target.value)} disabled={Boolean(blocked) || pending !== null}
            options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} />
        </Field>
        <Field label="Agents that may use it" help="One per line or comma separated, as integration:<id> or navigator:<id>. People are never listed.">
          <Textarea value={principals} onChange={(event) => setPrincipals(event.target.value)} rows={3} maxLength={4000} disabled={Boolean(blocked) || pending !== null} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Maximum uses" help="1 to 1000. A use is spent when a proposal is approved under the grant.">
            <Input inputMode="numeric" value={maxUses} onChange={(event) => setMaxUses(event.target.value)} disabled={Boolean(blocked) || pending !== null} />
          </Field>
          <Field label="Expires in (minutes)" help="5 minutes to 30 days.">
            <Input inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={Boolean(blocked) || pending !== null} />
          </Field>
        </div>
        <Field label="Reason (optional)" help="Recorded in the audit log. Never paste credentials.">
          <Input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} disabled={Boolean(blocked) || pending !== null} />
        </Field>
        {blocked && <p className="text-[13px] text-ink-mute">{blocked}</p>}
        <Button type="submit" busy={pending === "create"} disabled={Boolean(blocked)} disabledReason={blocked}>Create standing grant</Button>
      </form>
    </Card>

    <section aria-labelledby="grants-h" className="space-y-3">
      <h2 id="grants-h" className="text-[15px] font-medium text-ink">Grants</h2>
      {rows.length === 0 ? <p className="text-[13px] text-ink-mute">No standing grants yet. Until you create one, every agent change waits for a person.</p> :
        <ul className="space-y-4">{rows.map(({ grant: g, uses }) => {
          const state = stateOf(g, now);
          const env = environments.find((e) => e.id === g.environmentId);
          const canRevoke = g.status === "active" && (isAdmin || g.createdBy === viewerId);
          return <li key={g.id}><Card title={`${state} · ${g.capabilities.join(", ")}`} subtitle={`${env ? env.name : g.environmentId} · created by ${g.createdByName} · ${when(g.createdAt)}`}>
            <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
              <div><dt className="text-ink-mute">Uses</dt><dd>{g.uses} of {g.maxUses}</dd></div>
              <div><dt className="text-ink-mute">Expires</dt><dd><time dateTime={g.expiresAt}>{when(g.expiresAt)}</time></dd></div>
              <div><dt className="text-ink-mute">Risk ceiling</dt><dd>{g.maxRisk}</dd></div>
              <div><dt className="text-ink-mute">Agents</dt><dd className="break-all">{g.allowedPrincipals.join(", ")}</dd></div>
              {g.status === "revoked" && <div><dt className="text-ink-mute">Revoked</dt><dd>{g.revokedAt ? when(g.revokedAt) : ""}{g.revokedReason ? ` · ${g.revokedReason}` : ""}</dd></div>}
            </dl>
            <details className="mt-3"><summary className="cursor-pointer text-[13px] font-medium">Usage history ({uses.length})</summary>
              {uses.length === 0 ? <p className="mt-2 text-[13px] text-ink-mute">Not used yet.</p> :
                <ul className="mt-2 divide-y divide-line text-[13px]">{uses.map((u) => <li key={u.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span><a className="text-signal hover:underline" href={`/platform/operations/${encodeURIComponent(u.operationId)}`}>{u.operationId}</a> · {u.principalKey}</span>
                  <span className="text-ink-mute"><time dateTime={u.createdAt}>{when(u.createdAt)}</time>{u.voidedAt ? " · returned unused" : ""}</span>
                </li>)}</ul>}
            </details>
            {canRevoke && <div className="mt-3"><Button onClick={() => void revoke(g)} busy={pending === g.id} disabled={Boolean(blocked) && g.createdBy !== viewerId} aria-label={`Revoke the standing grant for ${g.capabilities.join(", ")}`}>Revoke</Button></div>}
          </Card></li>;
        })}</ul>}
    </section>
  </div>;
}
