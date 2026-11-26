"use client";
/**
 * Connect AWS in as few steps as AWS allows.
 *
 * Default (one-click) path: the admin enters the account id and region, Zenith
 * saves the connection with a generated name suffix and derived role ARNs, and
 * returns a CloudFormation quick-create link with every template parameter
 * filled in. In AWS the user ticks the IAM acknowledgement and clicks Create
 * stack; this page keeps checking the read-only role until the stack is ready.
 * The trust model (AssumeRole + ExternalId, or OIDC) and Zenith's principal ARN
 * come from the server, never from the user.
 *
 * The manual path (OpenTofu, existing stacks, a chosen suffix) remains below.
 * Creation never implies verification; observe-role identity does not prove
 * deploy-role permissions.
 */
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ActionResult } from "@/lib/actions/core";
import { ApiError } from "@/lib/client/api";
import { AWS_CONNECTION_REGIONS } from "@/lib/aws-bootstrap-input";
import { AwsConnectionSetup, type AwsConnectionInput, type AwsTrust } from "@/components/platform/aws-connection-setup";
import { ACCOUNT_ID_RE, CFN_TEMPLATE_PATH, looksLikeAccessKey } from "@/components/platform/aws-connection-validation";
import type { RoleName } from "@/components/platform/labels";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { browserMutation, mutationError } from "../../_lib/browser-api";

const Created = z.object({ connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), subject: z.string().max(300), issuerHost: z.string().max(300).optional(), externalId: z.string().max(100).optional() });
const Launch = z.object({
  stackName: z.string().max(128),
  parameters: z.record(z.string().regex(/^[A-Za-z0-9]{1,255}$/), z.string().max(2048)),
  url: z.string().max(8192).startsWith("https://").optional(),
});
const QuickCreated = Created.extend({
  mode: z.enum(["oidc_web_identity", "aws_assume_role"]),
  accountId: z.string().regex(/^\d{12}$/),
  region: z.string().max(40),
  launch: Launch,
});
type QuickCreatedT = z.infer<typeof QuickCreated>;

const sameConfig = (a: AwsConnectionInput, b: AwsConnectionInput) => a.accountId === b.accountId && a.region === b.region && a.observeRoleArn === b.observeRoleArn && a.deployRoleArn === b.deployRoleArn && a.secretWriterRoleArn === b.secretWriterRoleArn && (a.bootstrapNameSuffix ?? "") === (b.bootstrapNameSuffix ?? "");

/** Polling cadence while the stack is being created: frequent enough to feel immediate, bounded so a forgotten tab stops. */
export const CHECK_INTERVAL_MS = 20_000;
export const CHECK_ATTEMPTS = 45;
const MFA_RETURN = "/account/mfa/challenge?next=%2Fplatform%2Fconnections%2Faws";

const needsMfa = (failure: unknown) => failure instanceof ApiError && failure.status === 403 && typeof failure.fix === "string" && failure.fix.includes("/account/mfa");

export interface AwsLaunchSettings {
  /** Zenith's own IAM role for AssumeRole + ExternalId, when this installation has one */
  brokerPrincipalArn?: string;
  /** whether the bootstrap template is published for one-click links */
  oneClickReady: boolean;
}

export function AwsConnectionFlow({ workspaceId, viewerRole, launch = { oneClickReady: false } }: { workspaceId: string; viewerRole: RoleName; launch?: AwsLaunchSettings }) {
  return <div className="space-y-6">
    <QuickConnect workspaceId={workspaceId} viewerRole={viewerRole} launch={launch} />
    <details className="rounded-card border border-line bg-bg1 p-4">
      <summary className="cursor-pointer text-[13px] font-medium text-ink">Set up manually (OpenTofu, an existing stack or a chosen name suffix)</summary>
      <div className="mt-4"><ManualConnect workspaceId={workspaceId} viewerRole={viewerRole} brokerPrincipalArn={launch.brokerPrincipalArn} /></div>
    </details>
  </div>;
}

type Check = { state: "idle" | "waiting" | "ok" | "fail" | "stopped"; detail?: string; attempts: number };

function QuickConnect({ workspaceId, viewerRole, launch }: { workspaceId: string; viewerRole: RoleName; launch: AwsLaunchSettings }) {
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState<string>(AWS_CONNECTION_REGIONS[0]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; mfa?: boolean }>();
  const [created, setCreated] = useState<QuickCreatedT>();
  const [check, setCheck] = useState<Check>({ state: "idle", attempts: 0 });
  const inFlight = useRef(false);
  const checking = useRef(false);
  const key = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);

  const trimmed = accountId.replace(/[\s-]/g, "");
  const accountError = !accountId ? undefined : looksLikeAccessKey(accountId) ? "That looks like an access key. Zenith never needs one: enter the 12-digit account ID instead." : ACCOUNT_ID_RE.test(trimmed) ? undefined : "Enter the 12-digit AWS account ID.";
  const blocked = viewerRole !== "admin" ? "Only a workspace admin can connect an AWS account." : !ACCOUNT_ID_RE.test(trimmed) || accountError ? "Enter your 12-digit AWS account ID first." : undefined;

  const connect = async () => {
    if (blocked || inFlight.current) return;
    inFlight.current = true; setPending(true); setError(undefined);
    key.current ??= crypto.randomUUID();
    try {
      const response = await browserMutation<{ result: ActionResult }>(workspaceId, "/platform/connections/aws/action", {
        actionId: "connection.createAws", idempotencyKey: key.current, input: { accountId: trimmed, region },
      });
      if (!response.result.ok) throw new Error(response.result.error ?? "Creation refused");
      const parsed = QuickCreated.parse(response.result.data);
      if (parsed.accountId !== trimmed || parsed.region !== region) throw new Error("The saved connection does not match what you entered.");
      setCreated(parsed);
      setCheck({ state: "idle", attempts: 0 });
    } catch (failure) {
      key.current = undefined;
      setError(needsMfa(failure) ? { text: "Confirm it's you with two-factor authentication, then come back and connect.", mfa: true } : { text: failure instanceof ApiError ? mutationError(failure) : failure instanceof Error && failure.message ? failure.message : mutationError(failure) });
    } finally { inFlight.current = false; setPending(false); }
  };

  const verifyOnce = async (attempts: number) => {
    if (!created || checking.current) return;
    checking.current = true;
    try {
      const response = await browserMutation<{ result: ActionResult }>(workspaceId, "/platform/connections/aws/action", { actionId: "connection.verifyAws", input: { connectionId: created.connectionId } });
      if (!mounted.current) return;
      if (response.result.ok) {
        setCheck({ state: "ok", attempts, detail: response.result.summary });
        return;
      }
      if (attempts >= CHECK_ATTEMPTS) { setCheck({ state: "fail", attempts, detail: "Zenith still cannot reach the read-only role. Check that the stack finished with CREATE_COMPLETE in the same account and region, then check again." }); return; }
      setCheck({ state: "waiting", attempts });
      timer.current = setTimeout(() => void verifyOnce(attempts + 1), CHECK_INTERVAL_MS);
    } catch (failure) {
      if (!mounted.current) return;
      setCheck({ state: "stopped", attempts, detail: needsMfa(failure) ? "Two-factor confirmation expired. Confirm it again, then check again." : mutationError(failure) });
    } finally { checking.current = false; }
  };

  const openAws = () => {
    if (!created?.launch.url) return;
    window.open(created.launch.url, "_blank", "noopener,noreferrer");
    clearTimeout(timer.current);
    setCheck({ state: "waiting", attempts: 0 });
    // Stack creation takes a minute or two; the first check waits for one interval.
    timer.current = setTimeout(() => void verifyOnce(1), CHECK_INTERVAL_MS);
  };
  const checkNow = () => { clearTimeout(timer.current); void verifyOnce(Math.max(1, check.attempts)); };

  return (
    <Card title="Connect your AWS account" subtitle="Zenith creates two roles in your account with a CloudFormation stack. It never asks for access keys or secrets.">
      <div className="space-y-5">
        {!created && <>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="AWS account ID" help="12 digits. In the AWS console, open the account menu at the top right." error={accountError} required>
              <Input mono inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="123456789012" value={accountId} onChange={(e) => { setAccountId(e.target.value); setError(undefined); }} />
            </Field>
            <Field label="Region" help="Where Zenith keeps its deployment state in your account." required>
              <Select value={region} onChange={(e) => setRegion(e.target.value)} options={AWS_CONNECTION_REGIONS.map((r) => ({ value: r, label: r }))} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void connect()} busy={pending} disabled={Boolean(blocked)} disabledReason={blocked}>Connect AWS</Button>
            {blocked && <span className="text-[12.5px] text-ink-mute">{blocked}</span>}
          </div>
          {!launch.oneClickReady && <p className="text-[12.5px] text-ink-mute">One-click setup is not enabled on this installation yet. After you connect, Zenith shows the exact values to enter in AWS.</p>}
          {error && <Callout tone="err">{error.text}{error.mfa && <> <a className="underline" href={MFA_RETURN}>Confirm with two-factor</a></>}</Callout>}
        </>}

        {created && <>
          <Callout tone="info" title={`Connection saved for account ${created.accountId} in ${created.region}`}>
            {created.launch.url
              ? "Open AWS, tick the box that allows IAM resources, then click Create stack. This page checks the connection automatically."
              : "One-click setup is not enabled on this Zenith installation yet. Create the stack with the values below, then check the connection."}
          </Callout>
          {created.launch.url
            ? <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={openAws}>Open AWS to create the stack</Button>
                <span className="text-[12.5px] text-ink-mute">Sign in to account {created.accountId} if AWS asks.</span>
              </div>
            : <ManualParameters created={created} />}
          <div aria-live="polite" className="space-y-2">
            {check.state === "waiting" && <p className="text-[13px] text-ink-mute">Waiting for the stack. Zenith checks every {CHECK_INTERVAL_MS / 1000} seconds{check.attempts > 0 ? ` (check ${check.attempts} of ${CHECK_ATTEMPTS})` : ""}.</p>}
            {check.state === "ok" && <Callout tone="ok" title="AWS connected">Zenith reached account {created.accountId} with the read-only role. The deploy role is checked when you first deploy.</Callout>}
            {(check.state === "fail" || check.state === "stopped") && <Callout tone="err" title="Not connected yet">{check.detail}{check.detail?.includes("Two-factor") && <> <a className="underline" href={MFA_RETURN}>Confirm with two-factor</a></>}</Callout>}
            {check.state !== "ok" && <Button onClick={checkNow} disabled={viewerRole === "viewer" || viewerRole === "none"} disabledReason="An editor or admin must check the connection.">Check now</Button>}
          </div>
        </>}
      </div>
    </Card>
  );
}

/** Fallback when the installation has not published the template: the same values, to enter by hand. */
function ManualParameters({ created }: { created: QuickCreatedT }) {
  return <div className="space-y-3">
    <p className="text-[13px] text-ink-mute">
      In the AWS CloudFormation console for {created.region}, choose Create stack, upload <code className="font-mono text-[12.5px] text-ink">{CFN_TEMPLATE_PATH}</code> (it is too large to paste), name the stack <code className="font-mono text-[12.5px] text-ink">{created.launch.stackName}</code> and enter:
    </p>
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="CloudFormation parameters">
      <table className="w-full min-w-[520px] table-fixed border-collapse text-left">
        <caption className="sr-only">CloudFormation parameters and their values</caption>
        <thead><tr className="text-[12px] text-ink-mute"><th scope="col" className="w-[35%] py-1.5 pr-4 font-medium">Parameter</th><th scope="col" className="py-1.5 font-medium">Value</th></tr></thead>
        <tbody>
          {Object.entries(created.launch.parameters).map(([name, value]) => (
            <tr key={name} className="border-t border-line align-top">
              <th scope="row" className="py-2.5 pr-4 text-left font-normal"><code className="font-mono text-[12.5px] text-ink">{name}</code></th>
              <td className="py-2.5"><span className="inline-flex items-center gap-1"><code className="break-all font-mono text-[12px] text-ink">{value || "(leave empty)"}</code>{value && <CopyButton value={value} what={name} />}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>;
}

function ManualConnect({ workspaceId, viewerRole, brokerPrincipalArn }: { workspaceId: string; viewerRole: RoleName; brokerPrincipalArn?: string }) {
  const [mode, setMode] = useState<"oidc_web_identity" | "aws_assume_role">(brokerPrincipalArn ? "aws_assume_role" : "oidc_web_identity");
  return <div className="space-y-4">
    {brokerPrincipalArn && <Field label="Trust model" help="AssumeRole with an ExternalId is the default for this installation.">
      <Select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} options={[{ value: "aws_assume_role", label: "AssumeRole with an ExternalId" }, { value: "oidc_web_identity", label: "OIDC web identity" }]} />
    </Field>}
    <ConnectionSetup key={mode} mode={mode} principalArn={brokerPrincipalArn ?? ""} workspaceId={workspaceId} viewerRole={viewerRole} />
  </div>;
}

function ConnectionSetup({ workspaceId, viewerRole, mode, principalArn }: { workspaceId: string; viewerRole: RoleName; mode: "oidc_web_identity" | "aws_assume_role"; principalArn: string }) {
  const [draft, setDraft] = useState<AwsConnectionInput | null>(null);
  const [saved, setSaved] = useState<{ id: string; config: AwsConnectionInput; trust: AwsTrust }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const key = useRef<string | undefined>(undefined);
  const unchanged = Boolean(saved && draft && sameConfig(saved.config, draft));
  const blocked = viewerRole !== "admin" ? "Only a workspace admin can create an AWS connection." : !draft ? "Enter a valid account, region and both role ARNs first." : unchanged ? "These identifiers are already saved. Bootstrap the trust below, then verify." : undefined;
  const create = async () => {
    if (blocked || !draft || inFlight.current) return;
    inFlight.current = true; setPending(true); setError(undefined);
    key.current ??= crypto.randomUUID();
    try {
      const response = await browserMutation<{ result: ActionResult }>(workspaceId, "/platform/connections/aws/action", {
        actionId: "connection.createAws", idempotencyKey: key.current,
        input: { accountId: draft.accountId, region: draft.region, observeRoleArn: draft.observeRoleArn, deployRoleArn: draft.deployRoleArn, ...(draft.secretWriterRoleArn ? { secretWriterRoleArn: draft.secretWriterRoleArn } : {}), bootstrapNameSuffix: draft.bootstrapNameSuffix ?? "", mode },
      });
      if (!response.result.ok) throw new Error("Creation refused");
      const created = Created.parse(response.result.data);
      let trust: AwsTrust;
      if (mode === "oidc_web_identity") {
        if (!created.issuerHost || created.subject !== `zenith:ws:${workspaceId}:conn:${created.connectionId}`) throw new Error("Trust unavailable");
        trust = { mode, issuerHost: created.issuerHost, oidcSubject: created.subject, bootstrapNameSuffix: draft.bootstrapNameSuffix ?? "" };
      } else {
        if (!created.externalId || !principalArn) throw new Error("Trust unavailable");
        trust = { mode, zenithPrincipalArn: principalArn, externalId: created.externalId, bootstrapNameSuffix: draft.bootstrapNameSuffix ?? "" };
      }
      setSaved({ id: created.connectionId, config: draft, trust });
    } catch (failure) {
      setError(needsMfa(failure) ? "Confirm it's you with two-factor authentication (Account, then Two-factor), then save again." : `${mutationError(failure)} Check the platform connection store and OIDC issuer configuration.`);
    }
    finally { inFlight.current = false; setPending(false); }
  };
  const verifyBlocked = !saved ? "Save the connection identifiers first, then bootstrap the generated trust in AWS." : !unchanged ? "These inputs differ from the saved connection. Save a new connection before verifying." : viewerRole === "viewer" || viewerRole === "none" ? "An editor or admin must verify the connection." : undefined;
  return <div className="space-y-4">
    <p className="text-[13px] text-ink-mute">Enter the account and planned role ARNs, save them to generate the exact trust values, deploy the bootstrap template with those values, then verify. Creating this connection performs no live AWS check.</p>
    <Button onClick={() => void create()} busy={pending} disabled={Boolean(blocked)} disabledReason={blocked}>{saved ? "Save new connection identifiers" : "Save connection identifiers"}</Button>
    {blocked && <p className="text-[12px] text-ink-mute">{blocked}</p>}
    {error && <Callout tone="err">{error}</Callout>}
    {saved && <Callout tone="info">Saved connection {saved.id}. Observe and deploy roles remain unverified until the identity check below; deploy-role permissions remain unverified even after it succeeds.</Callout>}
    <AwsConnectionSetup trust={saved?.trust} verifyDisabledReason={pending ? "Wait for the connection to finish saving." : verifyBlocked} onConfigChange={(config) => { setDraft(config); key.current = undefined; }} onVerify={async (config) => {
      if (!saved || !sameConfig(saved.config, config) || verifyBlocked) return { ok: false, detail: verifyBlocked ?? "Save this configuration before verifying." };
      try {
        const response = await browserMutation<{ result: ActionResult }>(workspaceId, "/platform/connections/aws/action", { actionId: "connection.verifyAws", input: { connectionId: saved.id } });
        return { ok: response.result.ok, detail: response.result.ok ? "Observe-role identity verified. Deploy-role permissions and worker health remain unverified." : "Observe-role identity could not be verified. Check the bootstrap trust, role ARNs and credential broker, then retry." };
      } catch (failure) { throw new Error(mutationError(failure)); }
    }} />
  </div>;
}
