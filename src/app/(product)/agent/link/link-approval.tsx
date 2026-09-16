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
  /** The link protocol the terminal spoke. Absent from an older server = 1. */
  protocolVersion?: number;
  /** Whether the whole-workspace grant may be offered (protocol >= 2). */
  wholeWorkspace?: boolean;
  /** What the terminal asked for. Unverified text; it only sets defaults. */
  hint?: { workspaceId?: string; member?: boolean; workspaceName?: string; unverified: true } | null;
  /** Whether this server lets a signed-in person create another workspace. */
  canCreateWorkspace?: boolean;
}

type Mode = "workspace" | "projects";

/**
 * The least-privilege default: an explicit project list whenever the workspace
 * has projects to list, and the whole workspace only when it has none (there
 * is nothing else it could be) — and only for a terminal that can receive it.
 */
const defaultMode = (request: LinkRequest, workspaceId: string): Mode =>
  request.wholeWorkspace && !request.projects.some((p) => p.workspaceId === workspaceId)
    ? "workspace"
    : "projects";

const OPTION_CLASS =
  "flex cursor-pointer gap-3 rounded-card border p-4 transition-colors duration-[var(--dur-fast)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-signal";

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
  const [mode, setMode] = useState<Mode>("projects");
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const outcomeRef = useRef<HTMLDivElement>(null);
  const busy = busyKey !== undefined;

  /**
   * Read the waiting request. `prefer` selects a workspace the person just
   * created, with the whole workspace forced — a brand-new workspace has no
   * projects, so that is the only grant it can have.
   */
  const load = useCallback(async (value: string, signal?: AbortSignal, prefer?: string) => {
    setLoadError("");
    try {
      const data = await send<LinkRequest>(
        `/api/integrations/agent/link?code=${encodeURIComponent(value)}`,
        undefined,
        signal
      );
      setRequest(data);
      // The server puts the hinted workspace (only when this person is a member
      // of it), then the one this browser is already looking at, first.
      const chosen =
        prefer && data.workspaces.some((w) => w.id === prefer) ? prefer : data.workspaces[0]?.id ?? "";
      setWorkspaceId(chosen);
      setProjectIds([]);
      setEnvironmentIds([]);
      setNarrowEnvironments(false);
      setMode(prefer && data.wholeWorkspace ? "workspace" : defaultMode(data, chosen));
      setNewName((name) => name || data.hint?.workspaceName || "");
      if (!prefer) {
        setLabel(data.client.label ?? "");
        setDays(Math.min(30, data.maxDays));
      }
    } catch (e) {
      if (!signal?.aborted)
        setLoadError(e instanceof Error ? e.message : "This code could not be checked.");
    }
  }, []);

  /**
   * The same same-origin `POST /api/workspace` onboarding makes: a person
   * clicking Create, never the program. The program's suggested name only
   * prefilled the box.
   */
  async function createWorkspace() {
    const name = newName.trim();
    if (!name) return;
    setBusyKey("create");
    setCreateError("");
    try {
      const created = await send<{ workspace: { id: string } }>("/api/workspace", { name });
      await load(code, undefined, created.workspace.id);
      setNote({ kind: "ok", text: `Created “${name}”. It is selected below.` });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "The workspace could not be created.");
    } finally {
      setBusyKey(undefined);
    }
  }

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
  const workspace = request?.workspaces.find((w) => w.id === workspaceId);
  const role = workspace?.role ?? "";
  const viewer = role === "viewer";
  const whole = mode === "workspace" && request?.wholeWorkspace === true;
  const ready = Boolean(workspaceId) && (whole || projectIds.length > 0);

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
              ...(whole
                ? { projectIds: [], allProjects: true }
                : {
                    projectIds,
                    ...(narrowEnvironments && environmentIds.length ? { environmentIds } : {}),
                    // A protocol-1 terminal's body stays exactly what it was.
                    ...(request?.wholeWorkspace ? { allProjects: false } : {}),
                  }),
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
              {request.hint?.workspaceId && (
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <dt className="text-ink-faint">Asked for workspace</dt>
                  <dd className="min-w-0 break-all text-ink">
                    <span className="font-mono">{request.hint.workspaceId}</span>
                    <span className="text-ink-mute">
                      {request.hint.member
                        ? " · one of your workspaces, selected below"
                        : " · not one of your workspaces, so it was ignored"}
                    </span>
                  </dd>
                </div>
              )}
              {request.hint?.workspaceName && (
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <dt className="text-ink-faint">Suggested new workspace</dt>
                  <dd className="min-w-0 break-all text-ink">
                    {request.hint.workspaceName}
                    <span className="text-ink-mute"> · nothing is created until you press Create</span>
                  </dd>
                </div>
              )}
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
                The program supplied its own name, version, label and any workspace it suggested.
                Nothing checks them. Approve
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
                    setNarrowEnvironments(false);
                    setMode(defaultMode(request, e.target.value));
                  }}
                  options={request.workspaces.map((w) => ({
                    value: w.id,
                    label: `${w.name} · ${w.role}`,
                  }))}
                  className="max-w-[26rem]"
                />
              </Field>

              {request.wholeWorkspace && request.canCreateWorkspace && (
                <fieldset className="min-w-0 rounded-card border border-line p-4">
                  <legend className="px-1 text-[13px] font-medium text-ink">
                    Create a new workspace
                  </legend>
                  <p className="mb-3 text-[12px] text-ink-faint">
                    Optional. You become its admin, it starts with a Zenith Sandbox connection and
                    no projects, and it is selected above with the whole workspace chosen.
                    {request.hint?.workspaceName
                      ? " The name below was suggested by the program; change it if you like."
                      : ""}
                  </p>
                  <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createWorkspace();
                    }}
                  >
                    <Field label="Workspace name" help="1-60 characters.">
                      <Input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        maxLength={60}
                        autoComplete="off"
                        className="w-64 max-w-full"
                      />
                    </Field>
                    <Button
                      type="submit"
                      busy={busyKey === "create"}
                      disabled={!newName.trim() || (busy && busyKey !== "create")}
                      disabledReason={
                        !newName.trim()
                          ? "Type a name for the new workspace first."
                          : "This is available again when the current request settles."
                      }
                    >
                      Create
                    </Button>
                  </form>
                  {createError && (
                    <Callout tone="err" compact live="alert" className="mt-3">
                      <p>{createError}</p>
                    </Callout>
                  )}
                </fieldset>
              )}

              <fieldset className="min-w-0">
                <legend className="text-[13px] font-medium text-ink">Projects</legend>
                {request.wholeWorkspace ? (
                  <div role="radiogroup" aria-label="Project access" className="mt-2 mb-3 space-y-2">
                    <label
                      className={
                        OPTION_CLASS +
                        (mode === "workspace"
                          ? " border-signal bg-signal-dim"
                          : " border-line bg-bg1 hover:border-line-strong")
                      }
                    >
                      <input
                        type="radio"
                        name="project-access"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--signal)]"
                        checked={mode === "workspace"}
                        onChange={() => {
                          setMode("workspace");
                          setNarrowEnvironments(false);
                          setEnvironmentIds([]);
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">
                          Whole workspace (including projects created later)
                        </span>
                        <span className="mt-1 block max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                          All current and future projects in {workspace?.name ?? "this workspace"},
                          plus workspace settings: create projects, connections, alerts and rename.
                          Every change is still reviewed on the Integrations screen before it runs.
                        </span>
                      </span>
                    </label>
                    <label
                      className={
                        OPTION_CLASS +
                        (mode === "projects"
                          ? " border-signal bg-signal-dim"
                          : " border-line bg-bg1 hover:border-line-strong") +
                        (projects.length === 0 ? " cursor-not-allowed opacity-55" : "")
                      }
                      title={
                        projects.length === 0
                          ? "This workspace has no projects yet, so there is nothing to list."
                          : undefined
                      }
                    >
                      <input
                        type="radio"
                        name="project-access"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--signal)]"
                        checked={mode === "projects"}
                        disabled={projects.length === 0}
                        onChange={() => setMode("projects")}
                      />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">
                          Only these projects
                        </span>
                        <span className="mt-1 block max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                          The agent sees nothing outside what you tick below, and a project created
                          later is not included.
                        </span>
                      </span>
                    </label>
                  </div>
                ) : (
                  <p className="mt-0.5 mb-2 text-[12px] text-ink-faint">
                    The agent sees nothing outside what you tick here. At least one is required, and
                    what you tick is recorded as those projects — not as a standing “everything”.
                  </p>
                )}
                {whole ? null : projects.length === 0 ? (
                  <p className="text-[13px] text-ink-mute">
                    This workspace has no projects yet, so there is nothing to give access to.
                    {request.wholeWorkspace
                      ? ""
                      : " Update the Zenith plugin and run `zenith login` again to link a whole workspace."}
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

              {!whole && projectIds.length > 0 && environments.length > 0 && (
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
              disabled={!ready || (busy && busyKey !== "approve")}
              disabledReason={
                !workspaceId
                  ? "Choose a workspace, or create one, before this agent can be linked."
                  : !ready
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
