"use client";
/**
 * Connection administration. Every control calls the same REST verbs the CLI
 * and the action registry use. Revocation is terminal and says so; a rotation
 * keeps the current access serving until a verified candidate is promoted.
 * Results speak in plain sentences: no raw status codes, and a passing check
 * never claims more than it proved.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ConnectionView } from "@/lib/connections/service";
import type { RoleName } from "@/components/platform/labels";
import { Button } from "@/components/ui/button";
import { Callout, type CalloutTone } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import { browserMutation, mutationError } from "../_lib/browser-api";

interface Answer { ok: boolean; summary: string; error?: string; data: Record<string, unknown> | null }
interface Notice { tone: CalloutTone; title: string; lines: string[] }

const PROVIDER_LABEL: Record<string, string> = { aws: "AWS", gcp: "Google Cloud", azure: "Azure", oci: "Oracle Cloud", kubernetes: "Kubernetes" };
const STATUS_LABEL: Record<string, string> = { pending_verification: "Not verified yet", verified: "Verified", failed: "Verification failed", revoked: "Revoked" };
const STATUS_DOT: Record<string, DotStatus> = { pending_verification: "info", verified: "ok", failed: "err", revoked: "idle" };
const ROTATION_LABEL: Record<string, string> = { staged: "Staged", verified: "Verified, ready to promote", failed: "Failed verification" };

type Field = { key: string; label: string; placeholder: string; optional?: boolean };
const CREATE_FIELDS: Record<"gcp" | "azure" | "oci", Field[]> = {
  gcp: [
    { key: "projectId", label: "Project id", placeholder: "my-project-123" },
    { key: "region", label: "Region", placeholder: "us-central1" },
    { key: "workloadIdentityProvider", label: "Workload identity provider", placeholder: "projects/123456789/locations/global/workloadIdentityPools/zenith/providers/zenith" },
    { key: "observeServiceAccount", label: "Observe service account", placeholder: "zenith-observe@my-project-123.iam.gserviceaccount.com" },
    { key: "deployServiceAccount", label: "Deploy service account", placeholder: "zenith-deploy@my-project-123.iam.gserviceaccount.com" },
    { key: "label", label: "Label", placeholder: "Optional", optional: true },
  ],
  azure: [
    { key: "tenantId", label: "Tenant id", placeholder: "00000000-0000-0000-0000-000000000000" },
    { key: "clientId", label: "Application (client) id", placeholder: "00000000-0000-0000-0000-000000000000" },
    { key: "subscriptionId", label: "Subscription id", placeholder: "00000000-0000-0000-0000-000000000000" },
    { key: "region", label: "Region", placeholder: "eastus" },
    { key: "cloud", label: "Azure cloud", placeholder: "public (default), usgov or china", optional: true },
    { key: "label", label: "Label", placeholder: "Optional", optional: true },
  ],
  oci: [
    { key: "tenancyOcid", label: "Tenancy OCID", placeholder: "ocid1.tenancy.oc1..aaaa" },
    { key: "compartmentOcid", label: "Compartment OCID", placeholder: "ocid1.compartment.oc1..aaaa" },
    { key: "region", label: "Region", placeholder: "us-ashburn-1" },
    { key: "runnerId", label: "Registered runner id", placeholder: "The runner that serves this tenancy" },
    { key: "label", label: "Label", placeholder: "Optional", optional: true },
  ],
};
const ROTATE_FIELDS: Record<string, Field[]> = {
  aws: [
    { key: "observeRoleArn", label: "New observe role ARN", placeholder: "arn:aws:iam::123456789012:role/ZenithObserveV2", optional: true },
    { key: "deployRoleArn", label: "New deploy role ARN", placeholder: "arn:aws:iam::123456789012:role/ZenithDeployV2", optional: true },
  ],
  gcp: [
    { key: "workloadIdentityProvider", label: "New workload identity provider", placeholder: "projects/.../providers/...", optional: true },
    { key: "observeServiceAccount", label: "New observe service account", placeholder: "name@project.iam.gserviceaccount.com", optional: true },
    { key: "deployServiceAccount", label: "New deploy service account", placeholder: "name@project.iam.gserviceaccount.com", optional: true },
  ],
  azure: [{ key: "clientId", label: "New application (client) id", placeholder: "00000000-0000-0000-0000-000000000000", optional: true }],
  oci: [{ key: "runnerId", label: "New runner id", placeholder: "Register the new runner first", optional: true }],
  kubernetes: [
    { key: "credentialRef", label: "New vault reference (guest minter for a scoped guest connection)", placeholder: "vault:kubeconfig-v2", optional: true },
    { key: "deployerCredentialRef", label: "Deployer vault reference (deploy and observe only; scoped guest connections)", placeholder: "vault:cluster-deployer", optional: true },
    { key: "deployerScope", label: "Deployer scope: namespaced or cluster", placeholder: "namespaced", optional: true },
  ],
};

const ENDPOINT = "/api/platform/v1/connections";

export function ConnectionAdmin({ workspaceId, viewerRole, initial }: { workspaceId: string; viewerRole: RoleName; initial: ConnectionView[] }) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<string>();
  const admin = viewerRole === "admin";
  const editor = admin || viewerRole === "editor";

  async function call(key: string, path: string, body: unknown, describe: (answer: Answer) => Notice) {
    if (busy) return false;
    setBusy(key); setNotice(undefined);
    try {
      const answer = await browserMutation<Answer>(workspaceId, path, body);
      setNotice(describe(answer));
      router.refresh();
      return answer.ok;
    } catch (failure) {
      setNotice({ tone: "err", title: "Not done", lines: [mutationError(failure)] });
      return false;
    } finally { setBusy(undefined); }
  }

  return <div className="space-y-5">
    <p className="text-[13px] text-ink-mute">Each connection stores identifiers only, never keys. A connection deploys nothing until it is verified, and a passing check proves the observe identity, not deploy permissions. Revoking is immediate and permanent.</p>
    {notice && <Callout tone={notice.tone} title={notice.title}>{notice.lines.map((line, i) => <p key={i} className="break-words">{line}</p>)}</Callout>}
    {initial.length === 0
      ? <Callout tone="info" title="No cloud connections yet">Connect a cloud below. Environments without a connection use the built-in sandbox.</Callout>
      : <ul className="space-y-3">{initial.map((c) => <li key={c.id}><ConnectionCard c={c} admin={admin} editor={editor} busy={busy} call={call} /></li>)}</ul>}
    <CreatePanel admin={admin} busy={busy} call={call} />
  </div>;
}

type Call = (key: string, path: string, body: unknown, describe: (answer: Answer) => Notice) => Promise<boolean>;
const lines = (...values: unknown[]): string[] => values.filter((v): v is string => typeof v === "string" && v !== "");
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function ConnectionCard({ c, admin, editor, busy, call }: { c: ConnectionView; admin: boolean; editor: boolean; busy: string | undefined; call: Call }) {
  const [panel, setPanel] = useState<"none" | "rotate" | "revoke">("none");
  const revoked = c.status === "revoked";
  const disabledAdmin = admin ? undefined : "Only a workspace admin can do this.";
  const disabledEditor = editor ? undefined : "An editor or admin can run this check.";
  const base = `${ENDPOINT}/${encodeURIComponent(c.id)}`;
  return <div className="rounded-ctl border border-line bg-bg1 p-4">
    <div className="flex flex-wrap items-center gap-2.5">
      <StatusDot status={STATUS_DOT[c.status] ?? "idle"} label={STATUS_LABEL[c.status] ?? "Unknown"} />
      <span className="break-words text-[14px] font-medium">{c.label}</span>
      <span className="text-[12px] text-ink-mute">{PROVIDER_LABEL[c.provider] ?? c.provider} · {STATUS_LABEL[c.status] ?? "Unknown"}</span>
    </div>
    <p className="mt-1 break-all text-[12px] text-ink-mute">{Object.entries(c.identity).map(([k, v]) => `${k}: ${v}`).join(" · ")}{c.runnerId ? ` · runner: ${c.runnerId}` : ""}</p>
    {c.verificationDetail && <p className="mt-1 break-words text-[12px] text-ink-mute">{c.verificationDetail}{c.verifiedAt ? ` (${c.verifiedAt})` : ""}</p>}
    {c.rotation && <div className="mt-3 rounded-ctl border border-line bg-bg2 p-3 text-[12.5px]">
      <p className="font-medium">New access {ROTATION_LABEL[c.rotation.status]?.toLowerCase() ?? "staged"}</p>
      <p className="mt-1 text-ink-mute">Changes: {c.rotation.changes.join(", ") || "none"}. The current access keeps serving until you promote.</p>
      {c.rotation.verificationDetail && <p className="mt-1 break-words text-ink-mute">{c.rotation.verificationDetail}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" busy={busy === `promote:${c.id}`} disabled={!admin || c.rotation.status !== "verified" || !!busy}
          disabledReason={disabledAdmin ?? (c.rotation.status !== "verified" ? "The new access has not passed verification." : "Another action is running.")}
          onClick={() => void call(`promote:${c.id}`, `${base}/rotation/promote`, { rotationId: c.rotation!.id }, (a) => ({ tone: a.ok ? "ok" : "err", title: a.ok ? "New access is live" : "Not promoted", lines: lines(a.summary, a.error, ...asStrings(a.data?.nextSteps)) }))}>
          Promote new access
        </Button>
        <Button size="sm" variant="ghost" busy={busy === `abort:${c.id}`} disabled={!admin || !!busy} disabledReason={disabledAdmin ?? "Another action is running."}
          onClick={() => void call(`abort:${c.id}`, `${base}/rotation/abort`, { rotationId: c.rotation!.id }, (a) => ({ tone: a.ok ? "ok" : "err", title: a.ok ? "Staged access discarded" : "Not discarded", lines: lines(a.summary, a.error) }))}>
          Discard
        </Button>
      </div>
    </div>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" busy={busy === `verify:${c.id}`} disabled={revoked || !editor || !!busy}
        disabledReason={revoked ? "A revoked connection cannot be verified." : disabledEditor ?? "Another action is running."}
        onClick={() => void call(`verify:${c.id}`, `${base}/verify`, {}, (a) => ({ tone: a.ok ? "ok" : "err", title: a.ok ? "Identity verified" : "Verification failed", lines: lines(a.summary, a.error, typeof a.data?.scope === "string" ? a.data.scope : undefined) }))}>
        Verify
      </Button>
      <Button size="sm" disabled={revoked || !admin || !!busy} disabledReason={revoked ? "A revoked connection cannot be rotated." : disabledAdmin ?? "Another action is running."} onClick={() => setPanel(panel === "rotate" ? "none" : "rotate")}>Rotate access</Button>
      <Button size="sm" variant="ghost" disabled={revoked || !admin || !!busy} disabledReason={revoked ? "Already revoked." : disabledAdmin ?? "Another action is running."} onClick={() => setPanel(panel === "revoke" ? "none" : "revoke")}>Revoke</Button>
    </div>
    {panel === "rotate" && <RotatePanel c={c} base={base} busy={busy} call={call} onDone={() => setPanel("none")} />}
    {panel === "revoke" && <RevokePanel c={c} base={base} busy={busy} call={call} onDone={() => setPanel("none")} />}
  </div>;
}

function RotatePanel({ c, base, busy, call, onDone }: { c: ConnectionView; base: string; busy: string | undefined; call: Call; onDone: () => void }) {
  const fields = [...(ROTATE_FIELDS[c.provider] ?? [])];
  const [values, setValues] = useState<Record<string, string>>({});
  const [externalId, setExternalId] = useState(false);
  const [promote, setPromote] = useState(false);
  const [retire, setRetire] = useState(false);
  const [convert, setConvert] = useState(false);
  const [retainLegacy, setRetainLegacy] = useState(false);
  const legacyKube = c.provider === "kubernetes" && c.mode === "kubeconfig_ref";
  const patch: Record<string, unknown> = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
  if (legacyKube && convert) patch.convertToScopedGuest = true;
  if (legacyKube && convert && retainLegacy) patch.retainLegacyAsDeployer = patch.deployerScope === "cluster" ? "cluster" : "namespaced";
  if (legacyKube) { delete patch.deployerCredentialRef; if (!(convert && retainLegacy)) delete patch.deployerScope; }
  if (externalId) patch.rotateExternalId = true;
  const empty = Object.keys(patch).length === 0;
  return <div className="mt-3 space-y-3 border-t border-line pt-3">
    <p className="text-[12.5px] text-ink-mute">Name only what changes. The cloud account, project, tenant or cluster stays pinned. Zenith verifies the new access beside the current one; nothing switches until it passes.</p>
    {legacyKube && <Callout tone="warn" compact title="Legacy kubeconfig connection">Guest sessions are refused for this connection because its credential is broad and tenant-supplied. Convert it to a scoped guest connection (the default): enter a new vault reference holding a namespaced minter credential, Zenith verifies it, then promote. Zenith then mints a short-lived least-privilege token per guest dispatch.</Callout>}
    {legacyKube && <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={convert} onChange={(e) => setConvert(e.target.checked)} />Convert to scoped guest (requires a new minter vault reference below)</label>}
    {legacyKube && convert && <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={retainLegacy} onChange={(e) => setRetainLegacy(e.target.checked)} />Keep the current credential as the deployer of this connection for deploy and observe (declare its scope below; default namespaced)</label>}
    {c.provider === "kubernetes" && c.mode === "scoped_guest" && <Callout tone="info" compact title="One connection, two credentials">The guest minter and the deployer are separate vault credentials. The deployer serves deploy and observe only; the minter serves guest sessions only. Neither can stand in for the other. Zenith verifies both before anything switches, and revoking the connection ends both together.</Callout>}
    {fields.map((f) => <label key={f.key} className="block space-y-1 text-[12.5px]">{f.label}<Input value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} /></label>)}
    {c.provider === "aws" && c.mode === "aws_assume_role" && <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={externalId} onChange={(e) => setExternalId(e.target.checked)} />Generate a new ExternalId (add it to both role trust policies next to the current one)</label>}
    {c.runnerId && <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={retire} onChange={(e) => setRetire(e.target.checked)} />After switching, revoke the previous runner if no other connection uses it</label>}
    <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={promote} onChange={(e) => setPromote(e.target.checked)} />Switch immediately if the new access verifies</label>
    <div className="flex gap-2">
      <Button size="sm" variant="primary" busy={busy === `rotate:${c.id}`} disabled={empty || !!busy} disabledReason={empty ? "Enter at least one new value." : "Another action is running."}
        onClick={() => void call(`rotate:${c.id}`, `${base}/rotate`, { patch, promote, retirePreviousRunner: retire }, (a) => ({
          tone: a.ok ? "ok" : "err", title: a.ok ? (a.data?.promoted ? "Rotated" : "New access verified") : "New access did not verify",
          lines: lines(a.summary, a.error, typeof a.data?.externalId === "string" ? `New ExternalId (shown once, not secret): ${a.data.externalId}` : undefined, ...asStrings(a.data?.nextSteps)),
        })).then((ok) => { if (ok) onDone(); })}>Stage and verify</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
    </div>
  </div>;
}

function RevokePanel({ c, base, busy, call, onDone }: { c: ConnectionView; base: string; busy: string | undefined; call: Call; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [runner, setRunner] = useState(false);
  return <div className="mt-3 space-y-3 border-t border-line pt-3">
    <Callout tone="warn" compact title="Revoking is immediate and permanent">The next deploy, observe or verify through this connection is refused, with no fallback to another connection or the sandbox. To use this cloud again you create a new connection. Also remove the Zenith trust in your cloud; credentials Zenith already minted expire within minutes.</Callout>
    <label className="block space-y-1 text-[12.5px]">Type the connection id to confirm<Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={c.id} /></label>
    <label className="block space-y-1 text-[12.5px]">Reason (optional)<Input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    {c.runnerId && <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={runner} onChange={(e) => setRunner(e.target.checked)} />Also revoke its runner if no other connection uses it</label>}
    <div className="flex gap-2">
      <Button size="sm" variant="danger" busy={busy === `revoke:${c.id}`} disabled={typed !== c.id || !!busy} disabledReason={typed !== c.id ? "Type the connection id exactly." : "Another action is running."}
        onClick={() => void call(`revoke:${c.id}`, `${base}/revoke`, { confirm: c.id, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(runner ? { revokeRunner: true } : {}) }, (a) => ({
          tone: a.ok ? "ok" : "err", title: a.ok ? "Connection revoked" : "Not revoked", lines: lines(a.summary, a.error, ...asStrings(a.data?.customerSteps)),
        })).then((ok) => { if (ok) onDone(); })}>Revoke connection</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
    </div>
  </div>;
}

function CreatePanel({ admin, busy, call }: { admin: boolean; busy: string | undefined; call: Call }) {
  const [provider, setProvider] = useState<"gcp" | "azure" | "oci">("gcp");
  const [values, setValues] = useState<Record<string, string>>({});
  const fields = CREATE_FIELDS[provider];
  const missing = fields.some((f) => !f.optional && !(values[f.key] ?? "").trim());
  const body = { provider, ...Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? "").trim()]).filter(([, v]) => v !== "")) };
  return <div className="rounded-ctl border border-line bg-bg1 p-4">
    <h2 className="text-[14px] font-medium">Connect a cloud</h2>
    <p className="mt-1 text-[12.5px] text-ink-mute">Saving records identifiers only and runs no cloud call. Set up the trust shown afterwards, then verify. AWS and Kubernetes have their own guided flows: <Link href="/platform/connections/aws" className="text-signal">Connect AWS</Link>, and Settings, Connections for Kubernetes.</p>
    <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Provider">
      {(["gcp", "azure", "oci"] as const).map((p) => <Button key={p} size="sm" variant={provider === p ? "primary" : "quiet"} onClick={() => { setProvider(p); setValues({}); }}>{PROVIDER_LABEL[p]}</Button>)}
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {fields.map((f) => <label key={f.key} className="block space-y-1 text-[12.5px]">{f.label}<Input value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} /></label>)}
    </div>
    <div className="mt-3">
      <Button variant="primary" busy={busy === "create"} disabled={!admin || missing || !!busy} disabledReason={!admin ? "Only a workspace admin can connect a cloud." : missing ? "Fill every required field." : "Another action is running."}
        onClick={() => void call("create", ENDPOINT, body, (a) => {
          const trust = a.data?.trust as { subject?: string; steps?: unknown } | undefined;
          return { tone: a.ok ? "ok" : "err", title: a.ok ? "Connection saved, not verified yet" : "Not saved",
            lines: lines(a.summary, a.error, trust?.subject ? `Trust this exact subject: ${trust.subject}` : undefined, ...asStrings(trust?.steps)) };
        }).then((ok) => { if (ok) setValues({}); })}>Save connection</Button>
    </div>
  </div>;
}
