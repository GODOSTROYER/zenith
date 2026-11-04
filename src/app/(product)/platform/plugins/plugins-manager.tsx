"use client";
/** Review, approve a subset, revoke, and manage tokens. All decisions are server-checked; this only drives the browser-only routes. */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import type { PluginGrantView, PluginView } from "@/lib/plugins/view";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { mutationError } from "../_lib/browser-api";

interface Props {
  workspaceId: string;
  role: string;
  plugins: PluginView[];
  tokens: PluginGrantView[];
  resource: string | null;
}
interface Manifest {
  description?: string;
  publisher?: { id: string; name: string };
  capabilities?: { tools?: string[]; scopes?: string[] };
  components?: { skills?: string[]; agents?: { name: string }[]; mcpServers?: { name: string; command: string; args: string[] }[] };
}
const STATUS_LABEL: Record<string, string> = { pending_review: "Awaiting review", approved: "Approved", rejected: "Rejected", revoked: "Revoked" };

export function PluginsManager({ workspaceId, role, plugins, tokens, resource }: Props) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [issued, setIssued] = useState<{ token: string; expiresAt: string; pluginId: string }>();
  const [manifestText, setManifestText] = useState("");
  const admin = role === "admin";

  const call = async <T,>(key: string, path: string, body: unknown): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      return await api<T>(path, { method: "POST", credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, body: JSON.stringify(body) });
    } catch (failure) {
      setError(mutationError(failure));
      return undefined;
    } finally {
      inFlight.current = false;
      setBusy(undefined);
    }
  };
  const done = (message: string) => {
    setNotice(message);
    router.refresh();
  };

  const register = async () => {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      setError("Paste the signed manifest as valid JSON.");
      return;
    }
    if (await call("register", "/api/integrations/plugins", { manifest })) {
      setManifestText("");
      done("Registered. It now waits for review below.");
    }
  };

  return (
    <div className="space-y-5">
      {error && <Callout tone="err">{error}</Callout>}
      {notice && (
        <p role="status" className="text-[13px] text-ink-mute">
          {notice}
        </p>
      )}
      {issued && (
        <Callout tone="info" title={`Token for ${issued.pluginId}`}>
          <p className="text-[13px]">Copy it now into the plugin host. It is shown once and expires {new Date(issued.expiresAt).toLocaleString()}.</p>
          <Input readOnly aria-label="Plugin token" value={issued.token} onFocus={(event) => event.currentTarget.select()} />
          <Button variant="quiet" size="sm" onClick={() => setIssued(undefined)}>
            I have stored it
          </Button>
        </Callout>
      )}
      {admin && (
        <Card title="Register a plugin" subtitle="Paste a manifest signed by a publisher this deployment trusts.">
          <div className="space-y-3">
            <Field label="Signed manifest (JSON)" help="Manifests that fail signature, schema or isolation checks are refused and nothing is stored.">
              <Textarea value={manifestText} onChange={(event) => setManifestText(event.target.value)} rows={8} maxLength={60000} disabled={busy === "register"} />
            </Field>
            <Button onClick={() => void register()} busy={busy === "register"} disabled={!manifestText.trim()} disabledReason="Paste a manifest first.">
              Register plugin
            </Button>
          </div>
        </Card>
      )}
      {plugins.length === 0 && (
        <Callout tone="info" title="No plugins yet">
          {admin ? "Register a signed manifest above to review it." : "An admin has not approved any plugin in this workspace."}
        </Callout>
      )}
      <ul className="space-y-4" aria-label="Plugins">
        {plugins.map((plugin) => (
          <li key={plugin.id}>
            <PluginCard
              plugin={plugin}
              tokens={tokens.filter((t) => t.registrationId === plugin.id)}
              admin={admin}
              busy={busy}
              resource={resource}
              onApprove={async (tools, scopes) => {
                if (await call(`approve:${plugin.id}`, "/api/integrations/plugins/review", { registrationId: plugin.id, manifestDigest: plugin.manifestDigest, decision: "approve", tools, scopes })) done("Approved for the selected tools.");
              }}
              onReject={async () => {
                if (await call(`reject:${plugin.id}`, "/api/integrations/plugins/review", { registrationId: plugin.id, manifestDigest: plugin.manifestDigest, decision: "reject" })) done("Rejected.");
              }}
              onRevoke={async (reason) => {
                const r = await call<{ grantsRevoked: number }>(`revoke:${plugin.id}`, "/api/integrations/plugins/revoke", { registrationId: plugin.id, reason });
                if (r) done(`Revoked. ${r.grantsRevoked} token(s) stopped working.`);
              }}
              onIssue={async (credentialId, days) => {
                const r = await call<{ token: string; expiresAt: string }>(`issue:${plugin.id}`, "/api/integrations/plugins/tokens", { registrationId: plugin.id, credentialId, days });
                if (r) {
                  setIssued({ token: r.token, expiresAt: r.expiresAt, pluginId: plugin.pluginId });
                  done("Token issued.");
                }
              }}
              onRevokeToken={async (grantId) => {
                if (await call(`token:${grantId}`, "/api/integrations/plugins/tokens/revoke", { grantId })) done("Token revoked.");
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface CardProps {
  plugin: PluginView;
  tokens: PluginGrantView[];
  admin: boolean;
  busy?: string;
  resource: string | null;
  onApprove: (tools: string[], scopes: string[]) => Promise<void>;
  onReject: () => Promise<void>;
  onRevoke: (reason: string) => Promise<void>;
  onIssue: (credentialId: string, days: number) => Promise<void>;
  onRevokeToken: (grantId: string) => Promise<void>;
}

function PluginCard({ plugin, tokens, admin, busy, resource, onApprove, onReject, onRevoke, onIssue, onRevokeToken }: CardProps) {
  const manifest = plugin.manifest as Manifest;
  const provenance = plugin.provenance as { keyId?: string; verifiedAt?: string };
  const declaredTools = manifest.capabilities?.tools ?? [];
  const declaredScopes = manifest.capabilities?.scopes ?? [];
  const [tools, setTools] = useState<string[]>(declaredTools);
  const [scopes, setScopes] = useState<string[]>(declaredScopes);
  const [reason, setReason] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [credentialId, setCredentialId] = useState("");
  const [days, setDays] = useState("7");
  const toggle = (list: string[], set: (v: string[]) => void, item: string) => set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const pending = plugin.status === "pending_review";
  const approved = plugin.status === "approved";
  const mine = Boolean(busy?.endsWith(plugin.id));
  const daysOk = Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 30;
  return (
    <Card title={`${plugin.pluginId} ${plugin.version}`} subtitle={`${STATUS_LABEL[plugin.status] ?? plugin.status} · publisher ${manifest.publisher?.name ?? plugin.publisherId}`}>
      <div className="space-y-4">
        <details>
          <summary className="cursor-pointer text-[13px] font-medium">Manifest detail</summary>
          <div className="mt-3 space-y-2 text-[13px]">
            {manifest.description && <p>{manifest.description}</p>}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <dt className="text-ink-mute">Publisher</dt>
              <dd>
                {plugin.publisherId}, key {provenance.keyId ?? "unknown"}, signature verified {provenance.verifiedAt ?? "unknown"}
              </dd>
              <dt className="text-ink-mute">Manifest digest</dt>
              <dd className="break-all font-mono text-[12px]">{plugin.manifestDigest}</dd>
              <dt className="text-ink-mute">Archive sha256</dt>
              <dd className="break-all font-mono text-[12px]">{plugin.artifactDigest}</dd>
              <dt className="text-ink-mute">Requested scopes</dt>
              <dd>{declaredScopes.join(", ")}</dd>
              <dt className="text-ink-mute">Declared tools</dt>
              <dd>{declaredTools.join(", ")}</dd>
              {manifest.components?.skills && (
                <>
                  <dt className="text-ink-mute">Skills</dt>
                  <dd>{manifest.components.skills.join(", ")}</dd>
                </>
              )}
              {manifest.components?.agents && (
                <>
                  <dt className="text-ink-mute">Subagents</dt>
                  <dd>{manifest.components.agents.map((a) => a.name).join(", ")}</dd>
                </>
              )}
              {manifest.components?.mcpServers && (
                <>
                  <dt className="text-ink-mute">MCP servers</dt>
                  <dd>{manifest.components.mcpServers.map((s) => `${s.name}: ${s.command} ${s.args.join(" ")}`).join("; ")}</dd>
                </>
              )}
            </dl>
            <p className="text-ink-mute">Zenith does not download the archive. The installer must check its sha256 against the digest above before installing.</p>
          </div>
        </details>

        {approved && (
          <p className="text-[13px]">
            Approved tools: {plugin.approvedTools.join(", ")}. Scopes: {plugin.approvedScopes.join(", ")}.
          </p>
        )}
        {plugin.status === "revoked" && <p className="text-[13px] text-ink-mute">Revoked{plugin.revokeReason ? `: ${plugin.revokeReason}` : ""}. All its tokens stopped working.</p>}

        {pending && admin && (
          <fieldset className="space-y-2" disabled={mine}>
            <legend className="text-[13px] font-medium">Approve a subset</legend>
            <p className="text-[12px] text-ink-mute">Uncheck anything this workspace should not allow. A token can only hold what you approve and what the member&apos;s own credential holds.</p>
            <div role="group" aria-label="Tools to approve" className="grid gap-1">
              {declaredTools.map((tool) => (
                <label key={tool} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={tools.includes(tool)} onChange={() => toggle(tools, setTools, tool)} />
                  {tool}
                </label>
              ))}
            </div>
            <div role="group" aria-label="Scopes to approve" className="flex flex-wrap gap-4">
              {declaredScopes.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={scopes.includes(scope)} disabled={scope === "read"} onChange={() => toggle(scopes, setScopes, scope)} />
                  {scope}
                  {scope === "read" ? " (required)" : ""}
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void onApprove(tools, scopes)} busy={busy === `approve:${plugin.id}`} disabled={tools.length === 0} disabledReason="Approve at least one tool.">
                Approve selected
              </Button>
              <Button variant="quiet" onClick={() => void onReject()} busy={busy === `reject:${plugin.id}`}>
                Reject
              </Button>
            </div>
          </fieldset>
        )}
        {pending && !admin && <p className="text-[13px] text-ink-mute">Waiting for an admin to review this plugin.</p>}

        {approved && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-medium">Tokens</h3>
            {tokens.length === 0 ? (
              <p className="text-[13px] text-ink-mute">No tokens issued.</p>
            ) : (
              <ul className="space-y-1" aria-label={`Tokens for ${plugin.pluginId}`}>
                {tokens.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 text-[13px]">
                    <span>
                      {t.revokedAt ? "Revoked" : "Active"} · via credential {t.credentialId} · scopes {t.scopes.join(", ")} · expires {new Date(t.expiresAt).toLocaleDateString()}
                      {t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleString()}` : " · never used"}
                    </span>
                    {!t.revokedAt && (
                      <Button variant="quiet" size="sm" onClick={() => void onRevokeToken(t.id)} busy={busy === `token:${t.id}`} aria-label={`Revoke token ${t.id}`}>
                        Revoke token
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="grid max-w-md gap-2">
              <Field label="Your linked credential id" help="Shown on Integrations. The plugin token inherits at most this credential's access.">
                <Input value={credentialId} onChange={(event) => setCredentialId(event.target.value)} maxLength={128} />
              </Field>
              <Field label="Valid for (days, 1 to 30)">
                <Input type="number" min={1} max={30} value={days} onChange={(event) => setDays(event.target.value)} />
              </Field>
              <Button onClick={() => void onIssue(credentialId.trim(), Number(days))} busy={busy === `issue:${plugin.id}`} disabled={!credentialId.trim() || !daysOk} disabledReason="Enter your credential id and 1 to 30 days.">
                Issue token
              </Button>
              {resource && <p className="text-[12px] text-ink-mute">Valid only at {resource}.</p>}
            </div>
          </div>
        )}

        {admin && (pending || approved) && (
          <div className="border-t border-line pt-3">
            {!confirmRevoke ? (
              <Button variant="danger" size="sm" onClick={() => setConfirmRevoke(true)}>
                Revoke plugin
              </Button>
            ) : (
              <div className="max-w-md space-y-2" role="group" aria-label="Confirm revoke">
                <Field label="Reason">
                  <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
                </Field>
                <p className="text-[12px] text-ink-mute">Every token stops working on its next request. This cannot be undone; a new version must be registered.</p>
                <div className="flex gap-2">
                  <Button variant="danger" size="sm" onClick={() => void onRevoke(reason.trim())} busy={busy === `revoke:${plugin.id}`} disabled={!reason.trim()} disabledReason="Give a reason.">
                    Confirm revoke
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => setConfirmRevoke(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
