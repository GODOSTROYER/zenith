"use client";
/**
 * Environments — what a revision runs on, and everything about it that can be
 * changed without a deploy.
 *
 * Every control here is plan-first and role-gated at the point it is pressed,
 * not after a dialog has already been walked through. The cards also say what
 * is actually true of each environment right now: which revision is live, when
 * it landed, and how the (simulated) health of that revision reads.
 */
import { useState, type ReactNode } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useJson } from "@/lib/client/api";
import type { Role } from "@/lib/actions/core";
import type {
  CloudConnection,
  Deployment,
  Environment,
  EnvironmentClass,
} from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { TimeAgo } from "@/components/ui/time-ago";
import type { RevisionMeta } from "@/components/screens/project-data";
import { ActionConfirm, envTone } from "@/components/screens/shared";
import { useGate } from "./access";
import { CONN_DOT, unusableReason, type ProviderInfo } from "./shared";

/** `/api/health/:envId` — synthetic for every provider, and says so. */
interface HealthPayload {
  simulated: boolean;
  provider: { id: string; displayName: string };
  generatedBy: string;
  services: Record<string, { status: "ok" | "degraded"; reason: string }>;
}

const BUDGET_MIN = 1;
const BUDGET_MAX = 1_000_000;

type Pending =
  | { kind: "budget"; env: Environment; value: number | null }
  | { kind: "approval"; env: Environment; value: boolean }
  | { kind: "stateful"; env: Environment; value: boolean }
  | { kind: "create"; input: { name: string; class: EnvironmentClass; connectionId?: string } }
  | { kind: "clone"; env: Environment; name: string }
  | { kind: "update"; env: Environment; input: { name?: string; region?: string } }
  | { kind: "move"; env: Environment; connection: CloudConnection }
  | { kind: "delete"; env: Environment };

export interface EnvironmentsSectionProps {
  environments: Environment[];
  revisions: RevisionMeta[];
  /** newest deployment per environment, from /api/bootstrap */
  deployments: Deployment[];
  connections: CloudConnection[];
  providerById: Map<string, ProviderInfo>;
  connectionsLoaded: boolean;
  role: Role | null | undefined;
  projectId: string;
  refresh: () => void;
}

export function EnvironmentsSection({
  environments,
  revisions,
  deployments,
  connections,
  providerById,
  connectionsLoaded,
  role,
  projectId,
  refresh,
}: EnvironmentsSectionProps) {
  const [pending, setPending] = useState<Pending | null>(null);
  const done = () => {
    setPending(null);
    refresh();
  };
  const connectionById = new Map(connections.map((c) => [c.id, c]));

  return (
    <div className="space-y-4">
      <div className="grid gap-4">
        {environments.map((e) => (
          <EnvironmentCard
            key={e.id}
            env={e}
            connection={connectionById.get(e.connectionId)}
            connections={connections}
            providerById={providerById}
            connectionsLoaded={connectionsLoaded}
            revision={revisions.find((r) => r.id === e.deployedRevisionId)}
            deployment={deployments.find((d) => d.environmentId === e.id)}
            onlyOne={environments.length === 1}
            role={role}
            onPending={setPending}
          />
        ))}
      </div>

      <NewEnvironmentForm
        connections={connections}
        providerById={providerById}
        role={role}
        onSubmit={(input) => setPending({ kind: "create", input })}
      />

      {pending?.kind === "budget" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="env.setBudget"
          input={{ environmentId: pending.env.id, budgetUsdMonthly: pending.value }}
          scope={{ projectId, environmentId: pending.env.id }}
          title={
            pending.value === null
              ? `Remove the budget on ${pending.env.name}`
              : `Set a ${fmtUsd(pending.value)}/month budget on ${pending.env.name}`
          }
          confirmLabel="Apply"
          onDone={done}
        />
      )}

      {pending?.kind === "approval" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="env.updatePolicies"
          input={{ environmentId: pending.env.id, approvalRequired: pending.value }}
          scope={{ projectId, environmentId: pending.env.id }}
          title={
            pending.value
              ? `Require approval on ${pending.env.name}`
              : `Stop requiring approval on ${pending.env.name}`
          }
          confirmLabel={pending.value ? "Require approval" : "Remove the gate"}
          danger={!pending.value && pending.env.class === "production"}
          typeToConfirm={
            !pending.value && pending.env.class === "production" ? pending.env.name : undefined
          }
          onDone={done}
        />
      )}

      {pending?.kind === "stateful" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="env.updatePolicies"
          input={{ environmentId: pending.env.id, allowStatefulDeletion: pending.value }}
          scope={{ projectId, environmentId: pending.env.id }}
          title={
            pending.value
              ? `Allow stateful deletion in ${pending.env.name}`
              : `Block stateful deletion in ${pending.env.name}`
          }
          confirmLabel={pending.value ? "Allow it" : "Block it"}
          danger={pending.value}
          typeToConfirm={
            pending.value && pending.env.class === "production" ? pending.env.name : undefined
          }
          onDone={done}
        />
      )}

      {pending?.kind === "create" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="env.create"
          input={{ ...pending.input, projectId }}
          scope={{ projectId }}
          title={`Create the “${pending.input.name}” environment`}
          confirmLabel="Create environment"
          onDone={done}
        />
      )}

      {pending?.kind === "clone" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="env.clone"
          input={{ environmentId: pending.env.id, name: pending.name }}
          scope={{ projectId, environmentId: pending.env.id }}
          // The plan states the name the clone actually gets (lowercased,
          // dashed), so the title does not promise the raw text back.
          title={`Clone the ${pending.env.name} environment`}
          confirmLabel="Create the clone"
          onDone={done}
        />
      )}

      {pending?.kind === "update" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="env.update"
          input={{ environmentId: pending.env.id, ...pending.input }}
          scope={{ projectId, environmentId: pending.env.id }}
          title={`Update ${pending.env.name}`}
          confirmLabel="Apply"
          onDone={done}
        />
      )}

      {pending?.kind === "move" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="env.setConnection"
          input={{ environmentId: pending.env.id, connectionId: pending.connection.id }}
          scope={{ projectId, environmentId: pending.env.id }}
          title={`Point ${pending.env.name} at ${pending.connection.label}`}
          description="Nothing already running is moved, copied or deleted — this only changes where the next deploy goes."
          confirmLabel="Move it"
          onDone={done}
        />
      )}

      {pending?.kind === "delete" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="env.delete"
          input={{ environmentId: pending.env.id }}
          scope={{ projectId, environmentId: pending.env.id }}
          title={`Delete the ${pending.env.name} environment`}
          confirmLabel="Delete environment"
          danger
          typeToConfirm={pending.env.name}
          onDone={done}
        />
      )}
    </div>
  );
}

/* ------------------------------- environment ------------------------------ */

const budgetText = (usd: number | undefined) => (usd ? String(usd) : "");

function EnvironmentCard({
  env,
  connection,
  connections,
  providerById,
  connectionsLoaded,
  revision,
  deployment,
  onlyOne,
  role,
  onPending,
}: {
  env: Environment;
  connection: CloudConnection | undefined;
  connections: CloudConnection[];
  providerById: Map<string, ProviderInfo>;
  connectionsLoaded: boolean;
  revision: RevisionMeta | undefined;
  deployment: Deployment | undefined;
  onlyOne: boolean;
  role: Role | null | undefined;
  onPending: (p: Pending) => void;
}) {
  const gate = useGate();
  const current = env.policies.budgetUsdMonthly;
  const [budget, setBudget] = useState(budgetText(current));
  const [seen, setSeen] = useState(current);
  const [movedWhileTyping, setMovedWhileTyping] = useState(false);
  const [form, setForm] = useState<"rename" | "clone" | "move" | null>(null);

  // The budget can change under this form (another tab, the Navigator, another
  // member). Adopt the new value when the field is untouched; when it is not,
  // keep what is being typed and say what happened instead of silently losing
  // either one.
  if (seen !== current) {
    const typing = budget !== budgetText(seen);
    setSeen(current);
    if (typing) setMovedWhileTyping(true);
    else setBudget(budgetText(current));
  }

  const parsed = budget.trim() === "" ? null : Number(budget);
  const invalid =
    parsed !== null &&
    (!Number.isFinite(parsed) || parsed < BUDGET_MIN || parsed > BUDGET_MAX);
  const unchanged = (parsed ?? null) === (current ?? null);
  const isProd = env.class === "production";
  const unusable = connection ? unusableReason(connection, providerById) : undefined;

  const budgetGate = gate(role, "env.setBudget");
  const policyGate = gate(role, "env.updatePolicies");

  return (
    <Card
      prod={isProd}
      title={
        <span className="flex items-center gap-2.5">
          {env.name}
          <Chip tone={envTone(env.class)}>{env.class}</Chip>
        </span>
      }
      subtitle={
        <>
          {env.region} · routes under <span className="font-mono">{env.baseDomain}</span>
        </>
      }
      actions={
        connection ? (
          <span className="flex items-center gap-2 text-[12.5px] text-ink-mute">
            <StatusDot status={CONN_DOT[connection.status]} label={connection.status} />
            {connection.label}
          </span>
        ) : connectionsLoaded ? (
          <Chip tone="err">no connection</Chip>
        ) : (
          <Skeleton width={120} height={16} />
        )
      }
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            icon={<Pencil className="h-3.5 w-3.5" />}
            disabled={!!gate(role, "env.update")}
            disabledReason={gate(role, "env.update")}
            onClick={() => setForm(form === "rename" ? null : "rename")}
          >
            Rename or move region
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy className="h-3.5 w-3.5" />}
            disabled={!!gate(role, "env.clone")}
            disabledReason={gate(role, "env.clone")}
            onClick={() => setForm(form === "clone" ? null : "clone")}
          >
            Clone
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            disabled={!!gate(role, "env.delete") || onlyOne}
            disabledReason={
              gate(role, "env.delete") ??
              "This is the only environment in the project, and every project screen needs one. Create another first, or delete the project in Danger zone."
            }
            onClick={() => onPending({ kind: "delete", env })}
          >
            Delete
          </Button>
        </div>
      }
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <DeployedState env={env} revision={revision} deployment={deployment} />

        <div>
          <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Deploys through</p>
          {connection ? (
            <>
              <p className="mt-2 text-[13px] text-ink">
                {connection.label}{" "}
                <span className="text-ink-faint">
                  · {connection.provider} · {connection.region}
                </span>
              </p>
              <p className="mt-1 text-[12.5px] text-ink-mute">
                {unusable
                  ? `Deploys are refused right now — ${unusable}.`
                  : "Preflight passed the last time this connection was checked."}
              </p>
            </>
          ) : (
            <p className="mt-2 text-[13px] text-ink-mute">
              {connectionsLoaded
                ? `This environment points at connection "${env.connectionId}", which is not in the workspace any more. Pick another one — nothing can deploy until you do.`
                : "Loading…"}
            </p>
          )}
          <Button
            size="sm"
            variant="quiet"
            className="mt-2.5"
            disabled={!!gate(role, "env.setConnection")}
            disabledReason={gate(role, "env.setConnection")}
            onClick={() => setForm(form === "move" ? null : "move")}
          >
            Change connection
          </Button>
        </div>
      </div>

      {form === "move" && (
        <MoveForm
          env={env}
          connections={connections}
          providerById={providerById}
          onCancel={() => setForm(null)}
          onSubmit={(c) => {
            setForm(null);
            onPending({ kind: "move", env, connection: c });
          }}
        />
      )}

      {form === "rename" && (
        <RenameForm
          env={env}
          provider={connection ? providerById.get(connection.provider) : undefined}
          onCancel={() => setForm(null)}
          onSubmit={(input) => {
            setForm(null);
            onPending({ kind: "update", env, input });
          }}
        />
      )}

      {form === "clone" && (
        <CloneForm
          env={env}
          onCancel={() => setForm(null)}
          onSubmit={(name) => {
            setForm(null);
            onPending({ kind: "clone", env, name });
          }}
        />
      )}

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <Field
          label="Monthly budget"
          help={`Estimates only. Budgets warn before a deploy; they never stop a running system. $${BUDGET_MIN} to $${BUDGET_MAX.toLocaleString("en-US")}.`}
          error={
            invalid
              ? `Enter a number between $${BUDGET_MIN} and $${BUDGET_MAX.toLocaleString("en-US")}, or leave it blank to remove the budget.`
              : undefined
          }
        >
          <div className="flex gap-2">
            <Input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="no budget"
              inputMode="decimal"
              prefix="$"
              suffix="/mo"
              mono
            />
            <Button
              variant="quiet"
              disabled={invalid || unchanged || !!budgetGate}
              disabledReason={
                budgetGate ??
                (invalid
                  ? `Enter a number between $${BUDGET_MIN} and $${BUDGET_MAX.toLocaleString("en-US")}, or leave it blank.`
                  : "This is already the budget on this environment.")
              }
              onClick={() => onPending({ kind: "budget", env, value: parsed })}
            >
              {parsed === null ? "Remove" : "Set"}
            </Button>
          </div>
          {movedWhileTyping && (
            <p className="mt-1.5 text-[12px] text-warn">
              This budget changed to {current ? fmtUsd(current) : "no budget"} somewhere else
              while you were typing. Your text was kept.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink"
                onClick={() => {
                  setBudget(budgetText(current));
                  setMovedWhileTyping(false);
                }}
              >
                Use {current ? fmtUsd(current) : "no budget"}
              </button>
            </p>
          )}
        </Field>

        <div>
          <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Deploy policy</p>

          <div className="mt-2.5 flex items-start gap-3">
            <Switch
              checked={env.policies.approvalRequired}
              disabled={!!policyGate}
              disabledReason={policyGate}
              onChange={(value) => onPending({ kind: "approval", env, value })}
              label={`Require approval before deploying to ${env.name}`}
            />
            <div className="min-w-0">
              <p className="text-[13px] text-ink">Approval required</p>
              <p className="mt-0.5 text-[12.5px] text-ink-mute">
                {env.policies.approvalRequired
                  ? "Deploys wait at “awaiting approval” until a human approves them."
                  : isProd
                    ? "Any deploy applies to production straight away."
                    : "Deploys apply as soon as they start."}
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-start gap-3">
            <Switch
              checked={env.policies.allowStatefulDeletion}
              disabled={!!policyGate}
              disabledReason={policyGate}
              onChange={(value) => onPending({ kind: "stateful", env, value })}
              label={`Allow deleting databases and other stateful resources in ${env.name}`}
            />
            <div className="min-w-0">
              <p className="text-[13px] text-ink">
                Stateful deletion{" "}
                {env.policies.allowStatefulDeletion && (
                  <Chip tone="warn" className="ml-1">
                    allowed
                  </Chip>
                )}
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink-mute">
                {env.policies.allowStatefulDeletion
                  ? "A plan that destroys a database, cache, queue or bucket here is allowed to run. Rollback restores the manifest, not the data."
                  : "A plan that would destroy a database, cache, queue or bucket here is blocked before it starts."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** What is live here, when it landed, and how it reads — nothing asserted. */
function DeployedState({
  env,
  revision,
  deployment,
}: {
  env: Environment;
  revision: RevisionMeta | undefined;
  deployment: Deployment | undefined;
}) {
  // Keyed by the live revision: health is computed from it, so when a deploy
  // elsewhere moves the environment, the URL changes and this refetches.
  const health = useJson<HealthPayload>(
    env.deployedRevisionId ? `/api/health/${env.id}?rev=${env.deployedRevisionId}` : null
  );
  // Only the deployment that put the live revision there can date it.
  const landed =
    deployment && deployment.revisionId === env.deployedRevisionId ? deployment : undefined;
  const services = Object.values(health.data?.services ?? {});
  const ok = services.filter((s) => s.status === "ok").length;

  return (
    <div>
      <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Deployed</p>
      {env.deployedRevisionId ? (
        <>
          <p className="mt-2 text-[13px] text-ink">
            {revision ? (
              `revision ${revision.number}`
            ) : (
              <span
                className="font-mono"
                title="This project's revision list does not contain the revision this environment is running, so its number is unknown here."
              >
                revision {env.deployedRevisionId.slice(0, 8)}
              </span>
            )}
            {landed ? (
              <span className="text-ink-mute">
                {" · "}
                <TimeAgo iso={landed.endedAt ?? landed.createdAt} prefix="deployed" />
              </span>
            ) : revision ? (
              <span
                className="text-ink-faint"
                title="Orrery no longer holds the deployment record that landed this revision, so this is when the revision was created."
              >
                {" · "}
                <TimeAgo iso={revision.createdAt} prefix="revision cut" />
              </span>
            ) : null}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {health.loading && !health.data ? (
              <Skeleton width={90} height={18} />
            ) : services.length ? (
              <>
                <Chip tone={ok === services.length ? "ok" : "warn"}>
                  {ok}/{services.length} services ok
                </Chip>
                <Chip tone="info" title={health.data?.generatedBy}>
                  simulated
                </Chip>
              </>
            ) : (
              <span className="text-[12.5px] text-ink-mute">
                The deployed revision has no managed services to report health for.
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-ink-mute">
          Never deployed.{" "}
          {deployment
            ? `The last deployment here ${deployment.status === "failed" ? "failed" : `ended ${deployment.status}`}.`
            : "Nothing has ever run in this environment."}
        </p>
      )}
      {deployment && deployment.revisionId !== env.deployedRevisionId && (
        <p className="mt-1.5 text-[12.5px] text-ink-mute">
          A newer deployment is {deployment.status}. Watch it on the Deploys page.
        </p>
      )}
    </div>
  );
}

/* --------------------------------- forms ---------------------------------- */

function InlineForm({
  children,
  onCancel,
  submit,
}: {
  children: ReactNode;
  onCancel: () => void;
  submit: ReactNode;
}) {
  return (
    <div className="mt-5 rounded-card border border-line bg-bg1 p-4">
      {children}
      <div className="mt-4 flex gap-2">
        {submit}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RenameForm({
  env,
  provider,
  onCancel,
  onSubmit,
}: {
  env: Environment;
  provider: ProviderInfo | undefined;
  onCancel: () => void;
  onSubmit: (input: { name?: string; region?: string }) => void;
}) {
  const [name, setName] = useState(env.name);
  const [region, setRegion] = useState(env.region);
  const trimmed = name.trim();
  const unchanged = trimmed === env.name && region === env.region;
  const regions = provider?.regions ?? [];

  return (
    <InlineForm
      onCancel={onCancel}
      submit={
        <Button
          disabled={!trimmed || unchanged}
          disabledReason={!trimmed ? "Give the environment a name." : "Nothing has changed yet."}
          onClick={() =>
            onSubmit({
              name: trimmed === env.name ? undefined : trimmed,
              region: region === env.region ? undefined : region,
            })
          }
        >
          Preview and apply
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          help={
            env.class === "production"
              ? "Production hostnames follow the project slug, so a rename here does not move any route."
              : `Managed routes move to <name>.${env.baseDomain.split(".").slice(1).join(".")} at the next deploy.`
          }
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>
        <Field
          label="Region"
          help={
            regions.length
              ? "The regions this environment's provider exposes."
              : "This provider exposes no region list, so the value is a label."
          }
        >
          {regions.length ? (
            <Select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              options={regions.map((r) => ({ value: r.id, label: `${r.id} · ${r.label}` }))}
            />
          ) : (
            <Input value={region} onChange={(e) => setRegion(e.target.value)} mono />
          )}
        </Field>
      </div>
    </InlineForm>
  );
}

function CloneForm({
  env,
  onCancel,
  onSubmit,
}: {
  env: Environment;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(`${env.name}-copy`);
  const trimmed = name.trim();

  return (
    <InlineForm
      onCancel={onCancel}
      submit={
        <Button
          disabled={!trimmed || trimmed === env.name}
          disabledReason={
            trimmed ? "The clone needs a different name." : "Give the new environment a name."
          }
          onClick={() => onSubmit(trimmed)}
        >
          Preview and clone
        </Button>
      }
    >
      <Field
        label="New environment name"
        help={`Copies ${env.name}'s class, connection, region, budget and deploy policy. Nothing is deployed to the copy.`}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </Field>
    </InlineForm>
  );
}

function MoveForm({
  env,
  connections,
  providerById,
  onCancel,
  onSubmit,
}: {
  env: Environment;
  connections: CloudConnection[];
  providerById: Map<string, ProviderInfo>;
  onCancel: () => void;
  onSubmit: (connection: CloudConnection) => void;
}) {
  const others = connections.filter((c) => c.id !== env.connectionId);
  const [id, setId] = useState(others.find((c) => !unusableReason(c, providerById))?.id ?? "");
  const picked = others.find((c) => c.id === id);
  const why = picked ? unusableReason(picked, providerById) : undefined;

  return (
    <InlineForm
      onCancel={onCancel}
      submit={
        <Button
          disabled={!picked}
          disabledReason={
            others.length
              ? "Pick the connection this environment should deploy through."
              : "There is no other connection in this workspace. Connect a cloud under Connections first."
          }
          onClick={() => picked && onSubmit(picked)}
        >
          Preview and move
        </Button>
      }
    >
      <Field
        label="Connection"
        help="Nothing already running moves. This changes where the next deploy goes."
        error={why ? `Deploys through this connection are refused: ${why}.` : undefined}
      >
        <Select
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder={others.length ? "Pick a connection" : "No other connection"}
          options={others.map((c) => {
            const reason = unusableReason(c, providerById);
            return {
              value: c.id,
              label: reason
                ? `${c.label} · ${c.provider} — ${reason}`
                : `${c.label} · ${c.provider}`,
            };
          })}
        />
      </Field>
    </InlineForm>
  );
}

function NewEnvironmentForm({
  connections,
  providerById,
  role,
  onSubmit,
}: {
  connections: CloudConnection[];
  providerById: Map<string, ProviderInfo>;
  role: Role | null | undefined;
  onSubmit: (input: { name: string; class: EnvironmentClass; connectionId?: string }) => void;
}) {
  const gate = useGate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [klass, setKlass] = useState<EnvironmentClass>("staging");
  const usable = connections.filter((c) => !unusableReason(c, providerById));
  const [connectionId, setConnectionId] = useState(usable[0]?.id ?? "");
  const createGate = gate(role, "env.create");

  if (!open)
    return (
      <Button
        variant="quiet"
        icon={<Plus className="h-3.5 w-3.5" />}
        disabled={!!createGate}
        disabledReason={createGate}
        onClick={() => setOpen(true)}
      >
        New environment
      </Button>
    );

  return (
    <Card title="New environment" subtitle="Creating one costs nothing until you deploy to it.">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" help="lowercase, dashes">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="staging-2" />
        </Field>
        <Field label="Class" help="Production defaults to requiring approval.">
          <Select
            value={klass}
            onChange={(e) => setKlass(e.target.value as EnvironmentClass)}
            options={[
              { value: "sandbox", label: "sandbox" },
              { value: "staging", label: "staging" },
              { value: "production", label: "production" },
            ]}
          />
        </Field>
        <Field
          label="Connection"
          help={
            usable.length === connections.length
              ? "Leave it blank to use the built-in sandbox."
              : `Leave it blank to use the built-in sandbox. ${connections.length - usable.length} connection(s) are listed but not selectable — each option says why.`
          }
        >
          <Select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            placeholder="Sandbox (default)"
            options={connections.map((c) => {
              const why = unusableReason(c, providerById);
              return {
                value: c.id,
                label: why ? `${c.label} · ${c.provider} — ${why}` : `${c.label} · ${c.provider}`,
                disabled: !!why,
              };
            })}
          />
        </Field>
      </div>
      <div className="mt-4 flex gap-2">
        <Button
          disabled={!name.trim()}
          disabledReason="Give the environment a name."
          onClick={() =>
            onSubmit({
              name: name.trim(),
              class: klass,
              connectionId: connectionId || undefined,
            })
          }
        >
          Preview and create
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
