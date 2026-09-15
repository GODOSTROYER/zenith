"use client";
/**
 * Approve a terminal's request to link an agent to this account.
 *
 * Three rules shape the screen. **Everything the program said about itself is
 * unverified text** — it named itself, and nothing checked the name — so it is
 * rendered as data, next to a sentence saying exactly that. **Approving issues
 * a credential and deploys nothing**: every change the agent later proposes is
 * reviewed again on /integrations before it runs. And **the code has to match
 * the terminal**: a person who did not just run `zenith login` has no reason to
 * be on this page, and the screen says so rather than assuming.
 *
 * It is a section, not a `<main>` — the product layout already owns the page's
 * single main landmark — and it is built from the shared kit, so a refusal, a
 * busy control and a disabled reason read the same here as everywhere else.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate } from "@/lib/format";

interface LinkRequest {
  userCode: string;
  client: { name: string; version: string | null; label: string | null; unverified: boolean };
  requestedScopes: string[];
  startedAt: string;
  expiresAt: string;
  status: string;
  subject: string;
  workspaces: { id: string; name: string; role: string }[];
  projects: { id: string; workspaceId: string; name: string }[];
  environments: { id: string; projectId: string; name: string }[];
  maxDays: number;
}

const SCOPES = ["read", "plan", "export", "write", "publish", "logs"] as const;

/** The same words the Integrations screen uses for the same permissions. */
const SCOPE_HELP: Record<(typeof SCOPES)[number], string> = {
  read: "Read projects, revisions and operations. Always included.",
  plan: "Prepare proposals for review here. Never executes anything.",
  export: "Export a project's configuration.",
  write: "Dispatch a proposal you have approved.",
  publish: "Release an app it also has an explicit owner grant for.",
  logs: "Read redacted deployment logs.",
};

/**
 * What a fresh screen starts with. `read` is locked on because the credential
 * format requires it; `plan` and `write` are on because preparing a change and
 * dispatching one you approved is what a coding agent is for; `logs`, `export`
 * and `publish` are separate decisions and start off.
 */
const DEFAULT_SCOPES = ["read", "plan", "write"];

/** Offered lifetimes. The server refuses anything above `maxDays` regardless. */
const DAY_CHOICES = [1, 7, 30];

async function send<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw Error(data?.error?.message ?? "This request was refused.");
  if (data === undefined)
    throw Error("The server sent a reply this screen could not read. Reload and try again.");
  return data as T;
}

export default function LinkApproval() {
  const [code, setCode] = useState("");
  const [typed, setTyped] = useState("");
  const [request, setRequest] = useState<LinkRequest>();
  const [loadError, setLoadError] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string }>();
  const [busyKey, setBusyKey] = useState<string>();
  const [outcome, setOutcome] = useState<"approved" | "denied">();
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [narrowEnvironments, setNarrowEnvironments] = useState(false);
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [days, setDays] = useState(30);
  const [label, setLabel] = useState("");
  const outcomeRef = useRef<HTMLDivElement>(null);
  const busy = busyKey !== undefined;

  const load = useCallback(async (value: string, signal?: AbortSignal) => {
    setLoadError("");
    try {
      const data = await send<LinkRequest>(
        `/api/integrations/agent/link?code=${encodeURIComponent(value)}`,
        undefined,
        signal
      );
      setRequest(data);
      // The server puts the workspace this browser is already looking at first.
      setWorkspaceId(data.workspaces[0]?.id ?? "");
      setLabel(data.client.label ?? "");
      setDays(Math.min(30, data.maxDays));
    } catch (e) {
      if (!signal?.aborted)
        setLoadError(e instanceof Error ? e.message : "This code could not be checked.");
    }
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("code") ?? "";
    setCode(query);
    setTyped(query);
    if (!query) return;
    const controller = new AbortController();
    void load(query, controller.signal);
    return () => controller.abort();
  }, [load]);

  // The outcome is where the next thing to read is, and the control that
  // produced it is gone by then.
  useEffect(() => {
    if (outcome) outcomeRef.current?.focus();
  }, [outcome]);

  const projects = (request?.projects ?? []).filter((p) => p.workspaceId === workspaceId);
  const environments = (request?.environments ?? []).filter((e) =>
    projectIds.includes(e.projectId)
  );
  const role = request?.workspaces.find((w) => w.id === workspaceId)?.role ?? "";
  const viewer = role === "viewer";

  async function answer(approve: boolean) {
    setBusyKey(approve ? "approve" : "deny");
    setNote(undefined);
    try {
      await send("/api/integrations/agent/link/approve", {
        userCode: code,
        approve,
        ...(approve
          ? {
              workspaceId,
              projectIds,
              ...(narrowEnvironments && environmentIds.length ? { environmentIds } : {}),
              scopes: viewer ? scopes.filter((s) => s !== "write" && s !== "publish") : scopes,
              days,
              ...(label ? { label } : {}),
            }
          : {}),
      });
      setOutcome(approve ? "approved" : "denied");
    } catch (e) {
      setNote({ kind: "err", text: e instanceof Error ? e.message : "This request was refused." });
    } finally {
      setBusyKey(undefined);
    }
  }

  return (
    <div className="product-page mx-auto h-full w-full max-w-[860px] overflow-y-auto">
      <header className="app-page-heading">
        <div className="min-w-0">
          <h1 className="app-page-title">Link an agent</h1>
          <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-ink-mute">
            A program on your machine is asking to act on this account through the Zenith agent
            API. Approving issues it a credential. It does not deploy anything: every change this
            agent proposes is reviewed again on the Integrations screen before it runs.
          </p>
        </div>
      </header>

      <div ref={outcomeRef} tabIndex={-1} className="mb-6 space-y-3 outline-none">
        {outcome === "approved" && (
          <Callout tone="ok" live="status" title="Approved">
            <p>
              Return to your terminal — it collects the credential on its next poll, and prints
              what it is allowed to do. You can withdraw it at any time under Integrations →
              Linked agents.
            </p>
          </Callout>
        )}
        {outcome === "denied" && (
          <Callout tone="ok" live="status" title="Denied">
            <p>
              Nothing was issued. The terminal will say the request was denied. If that was a
              mistake, run <code>zenith login</code> again.
            </p>
          </Callout>
        )}
        {note && (
          <Callout tone={note.kind} live={note.kind === "err" ? "alert" : "status"}>
            <p>{note.text}</p>
          </Callout>
        )}
        {loadError && (
          <Callout tone="err" title="This code is not waiting for approval">
            <p>{loadError}</p>
            <p className="mt-2">
              Check it against the one in your terminal. A code expires ten minutes after it is
              issued; run <code>zenith login</code> again for a fresh one.
            </p>
          </Callout>
        )}
      </div>

      {outcome ? null : !code || loadError ? (
        <Card title="Enter the code from your terminal">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setCode(typed);
              void load(typed);
            }}
          >
            <Field label="Code" required help="Eight characters, as shown in your terminal.">
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                maxLength={9}
                autoComplete="off"
                spellCheck={false}
                mono
                className="w-44"
              />
            </Field>
            <Button type="submit" variant="primary" disabled={typed.trim().length < 8}>
              Check this code
            </Button>
          </form>
        </Card>
      ) : !request ? (
        <div className="space-y-4" role="status" aria-label="Checking this code">
          <Skeleton height={20} width="30%" />
          <Skeleton height={260} />
        </div>
      ) : (
        <div className="space-y-8 pb-16">
          <Card title="The request">
            <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
              <div className="flex flex-wrap gap-2">
                <dt className="text-ink-faint">Code</dt>
                <dd className="tnum font-mono text-[15px] tracking-[0.12em] text-ink">
                  {request.userCode}
                </dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="text-ink-faint">Program</dt>
                <dd className="min-w-0 break-all text-ink">
                  {request.client.name}
                  {request.client.version ? ` ${request.client.version}` : ""}
                </dd>
              </div>
              {request.client.label && (
                <div className="flex flex-wrap gap-2">
                  <dt className="text-ink-faint">Called itself</dt>
                  <dd className="min-w-0 break-all text-ink">{request.client.label}</dd>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <dt className="text-ink-faint">Asked for</dt>
                <dd className="text-ink">{request.requestedScopes.join(", ") || "read"}</dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="text-ink-faint">Started</dt>
                <dd className="text-ink" title={fmtDate(request.startedAt)}>
                  {fmtDate(request.startedAt)}
                </dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="text-ink-faint">Expires</dt>
                <dd className="text-ink" title={fmtDate(request.expiresAt)}>
                  {fmtDate(request.expiresAt)}
                </dd>
              </div>
            </dl>
            <Callout tone="warn" compact className="mt-4" title="This text is not verified">
              <p>
                The program supplied its own name, version and label. Nothing checks them. Approve
                only if this code is the one your own terminal is showing you right now.
              </p>
            </Callout>
          </Card>

          <Card title="What this agent may reach">
            <div className="space-y-6">
              <Field label="Workspace" required help="The agent can act in this workspace only.">
                <Select
                  value={workspaceId}
                  onChange={(e) => {
                    setWorkspaceId(e.target.value);
                    setProjectIds([]);
                    setEnvironmentIds([]);
                  }}
                  options={request.workspaces.map((w) => ({
                    value: w.id,
                    label: `${w.name} · ${w.role}`,
                  }))}
                  className="max-w-[26rem]"
                />
              </Field>

              <fieldset className="min-w-0">
                <legend className="text-[13px] font-medium text-ink">Projects</legend>
                <p className="mt-0.5 mb-2 text-[12px] text-ink-faint">
                  The agent sees nothing outside what you tick here. At least one is required, and
                  what you tick is recorded as those projects — not as a standing “everything”.
                </p>
                {projects.length === 0 ? (
                  <p className="text-[13px] text-ink-mute">
                    This workspace has no projects yet, so there is nothing to give access to.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                      {projects.map((p) => (
                        <Checkbox
                          key={p.id}
                          label={p.name}
                          checked={projectIds.includes(p.id)}
                          onChange={(on) =>
                            setProjectIds((ids) =>
                              on ? [...ids, p.id] : ids.filter((id) => id !== p.id)
                            )
                          }
                        />
                      ))}
                    </div>
                    <Button
                      size="sm"
                      variant="quiet"
                      className="mt-3"
                      onClick={() => setProjectIds(projects.map((p) => p.id))}
                    >
                      Select all current projects
                    </Button>
                  </>
                )}
              </fieldset>

              {projectIds.length > 0 && environments.length > 0 && (
                <fieldset className="min-w-0">
                  <legend className="text-[13px] font-medium text-ink">Environments</legend>
                  <Checkbox
                    className="mt-1"
                    label="Narrow to specific environments"
                    help="Off means every environment of the projects above, which is what a credential without a narrowing means."
                    checked={narrowEnvironments}
                    onChange={(on) => {
                      setNarrowEnvironments(on);
                      if (!on) setEnvironmentIds([]);
                    }}
                  />
                  {narrowEnvironments && (
                    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                      {environments.map((e) => (
                        <Checkbox
                          key={e.id}
                          label={e.name}
                          checked={environmentIds.includes(e.id)}
                          onChange={(on) =>
                            setEnvironmentIds((ids) =>
                              on ? [...ids, e.id] : ids.filter((id) => id !== e.id)
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                </fieldset>
              )}

              <fieldset className="min-w-0">
                <legend className="text-[13px] font-medium text-ink">Permitted operations</legend>
                <p className="mt-0.5 mb-2 text-[12px] text-ink-faint">
                  Read is always included. Approving a proposal is still a separate act by a
                  person, whatever is ticked here.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {SCOPES.map((scope) => {
                    const locked = scope === "read";
                    const roleBlocked = viewer && (scope === "write" || scope === "publish");
                    return (
                      <Checkbox
                        key={scope}
                        label={scope}
                        help={
                          roleBlocked
                            ? `${SCOPE_HELP[scope]} Your role in this workspace is viewer, so you cannot grant it.`
                            : SCOPE_HELP[scope]
                        }
                        checked={!roleBlocked && scopes.includes(scope)}
                        disabled={locked || roleBlocked}
                        disabledReason={
                          locked
                            ? "Read is the minimum any agent needs and cannot be removed."
                            : "Only an editor or admin can grant write or publish."
                        }
                        onChange={(on) =>
                          setScopes((values) =>
                            on ? [...values, scope] : values.filter((v) => v !== scope)
                          )
                        }
                      />
                    );
                  })}
                </div>
              </fieldset>

              <Field
                label="Expires after"
                help={`Between 1 and ${request.maxDays} days. The credential stops working on its own; it does not need to be cleaned up.`}
              >
                <Select
                  value={String(days)}
                  onChange={(e) => setDays(Number(e.target.value))}
                  options={DAY_CHOICES.filter((d) => d <= request.maxDays).map((d) => ({
                    value: String(d),
                    label: d === 1 ? "1 day" : `${d} days`,
                  }))}
                  className="w-40"
                />
              </Field>

              <Field
                label="Name this agent"
                help="Optional. Shown under Integrations → Linked agents, so you can tell two terminals apart."
              >
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={40}
                  autoComplete="off"
                  className="max-w-[20rem]"
                />
              </Field>
            </div>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
              busy={busyKey === "approve"}
              disabled={projectIds.length === 0 || !workspaceId || (busy && busyKey !== "approve")}
              disabledReason={
                projectIds.length === 0
                  ? "Choose at least one project before this agent can be linked."
                  : "This is available again when the current request settles."
              }
              onClick={() => void answer(true)}
            >
              Approve and issue a credential
            </Button>
            <Button
              variant="quiet"
              icon={<Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
              busy={busyKey === "deny"}
              disabled={busy && busyKey !== "deny"}
              disabledReason="This is available again when the current request settles."
              onClick={() => void answer(false)}
            >
              Deny
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
