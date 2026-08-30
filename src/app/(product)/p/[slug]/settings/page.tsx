"use client";
/**
 * Settings — environments and the policy that guards them, cloud connections
 * and the exact access each one holds, the export bundle, and the one
 * destructive thing this build cannot do.
 */
import { useMemo, useState } from "react";
import { Plug, Plus, Trash2 } from "lucide-react";
import { useJson } from "@/lib/client/api";
import type { CloudConnection, Environment, EnvironmentClass } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
  Field,
  Input,
  Select,
  Skeleton,
  StatusDot,
  Switch,
  TimeAgo,
  type DotStatus,
} from "@/components/ui";
import { ExportPanel } from "@/components/screens/export-panel";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ActionConfirm, ErrorNote, envTone, useRunAction } from "@/components/screens/shared";

const CONN_DOT: Record<CloudConnection["status"], DotStatus> = {
  healthy: "ok",
  degraded: "warn",
  disconnected: "err",
  connecting: "info",
};

const DELETE_DISABLED_REASON =
  "There is no project.delete action in the catalog, so nothing here could actually remove the project. Delete the .data directory and re-seed to start over.";

interface Bootstrap {
  connections: CloudConnection[];
}

type Pending =
  | { kind: "budget"; env: Environment; value: number | null }
  | { kind: "approval"; env: Environment; value: boolean }
  | { kind: "createEnv"; input: { name: string; class: EnvironmentClass; connectionId?: string } }
  | { kind: "disconnect"; connection: CloudConnection };

export default function SettingsPage() {
  const { data, env, projectId, refresh } = useSelectedEnv();
  const boot = useJson<Bootstrap>("/api/bootstrap");
  const [pending, setPending] = useState<Pending | null>(null);

  const connections = useMemo(() => boot.data?.connections ?? [], [boot.data]);
  const connectionById = useMemo(
    () => new Map(connections.map((c) => [c.id, c])),
    [connections]
  );

  if (!data)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  const done = () => {
    setPending(null);
    refresh();
    boot.refresh();
  };

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1040px] space-y-10 px-6 py-6">
      {/* ------------------------------ environments ----------------------- */}
      <section className="space-y-4">
        <SectionHead
          title="Environments"
          body="Where revisions run. Class decides the defaults; policy decides who can change them."
        />
        <div className="grid gap-4">
          {data.environments.map((e) => (
            <EnvironmentCard
              key={e.id}
              env={e}
              connection={connectionById.get(e.connectionId)}
              connectionsLoaded={!!boot.data}
              onBudget={(value) => setPending({ kind: "budget", env: e, value })}
              onApproval={(value) => setPending({ kind: "approval", env: e, value })}
            />
          ))}
        </div>
        <NewEnvironmentForm
          connections={connections}
          onSubmit={(input) => setPending({ kind: "createEnv", input })}
        />
      </section>

      {/* ------------------------------ connections ------------------------ */}
      <section className="space-y-4">
        <SectionHead
          title="Connections"
          body="Every connection lists the exact access it holds. Orrery never asks for more than it shows."
        />
        {boot.error ? <ErrorNote error={boot.error} /> : null}
        {!boot.data ? (
          <Skeleton height={120} />
        ) : connections.length === 0 ? (
          <Card>
            <p className="text-[13px] text-ink-mute">
              No connections in this workspace. Environments fall back to the built-in sandbox.
            </p>
          </Card>
        ) : (
          <div className="grid gap-3">
            {connections.map((c) => (
              <ConnectionCard
                key={c.id}
                connection={c}
                onChecked={boot.refresh}
                onDisconnect={() => setPending({ kind: "disconnect", connection: c })}
              />
            ))}
          </div>
        )}
      </section>

      {/* --------------------------------- export -------------------------- */}
      <section className="space-y-4">
        <SectionHead
          title="Export"
          body="Everything Orrery generated for this environment, in files you can run yourself."
        />
        <ExportPanel
          environmentId={env?.id}
          environmentName={env?.name}
          workingManifest={data.project.workingManifest}
        />
      </section>

      {/* ------------------------------ danger zone ------------------------ */}
      <section className="space-y-4">
        <SectionHead title="Danger zone" body="Irreversible things live here." />
        <Card className="border-err/25">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-[14px] text-ink">Delete this project</h3>
              <p className="mt-1 max-w-[62ch] text-[12.5px] text-ink-mute">
                {DELETE_DISABLED_REASON}
              </p>
            </div>
            <Button
              variant="danger"
              disabled
              disabledReason={DELETE_DISABLED_REASON}
              icon={<Trash2 className="h-3.5 w-3.5" />}
            >
              Delete project
            </Button>
          </div>
        </Card>
      </section>

      {/* ------------------------------ confirmations ---------------------- */}
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

      {pending?.kind === "createEnv" && (
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

      {pending?.kind === "disconnect" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="connection.disconnect"
          input={{ connectionId: pending.connection.id }}
          scope={{ projectId }}
          title={`Disconnect ${pending.connection.label}`}
          description="Nothing in your cloud is deleted — Orrery only forgets how to reach it."
          confirmLabel="Disconnect"
          danger
          onDone={done}
        />
      )}
    </div>
  );
}

function SectionHead({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="text-[20px] font-medium tracking-[-0.01em] text-ink">{title}</h2>
      <p className="mt-1 max-w-[70ch] text-[13px] text-ink-mute">{body}</p>
    </div>
  );
}

/* ------------------------------- environment ------------------------------ */

function EnvironmentCard({
  env,
  connection,
  connectionsLoaded,
  onBudget,
  onApproval,
}: {
  env: Environment;
  connection: CloudConnection | undefined;
  connectionsLoaded: boolean;
  onBudget: (value: number | null) => void;
  onApproval: (value: boolean) => void;
}) {
  const current = env.policies.budgetUsdMonthly;
  const [budget, setBudget] = useState(current ? String(current) : "");
  const parsed = budget.trim() === "" ? null : Number(budget);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed <= 0);
  const unchanged = (parsed ?? null) === (current ?? null);
  const isProd = env.class === "production";

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
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          label="Monthly budget"
          help="Estimates only. Budgets warn before a deploy; they never stop a running system."
          error={invalid ? "Enter a positive number, or leave it blank to remove the budget." : undefined}
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
              disabled={invalid || unchanged}
              disabledReason={
                invalid
                  ? "Enter a positive number, or leave it blank."
                  : "This is already the budget on this environment."
              }
              onClick={() => onBudget(parsed)}
            >
              {parsed === null ? "Remove" : "Set"}
            </Button>
          </div>
        </Field>

        <div>
          <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Deploy policy</p>
          <div className="mt-2.5 flex items-start gap-3">
            <Switch
              checked={env.policies.approvalRequired}
              onChange={onApproval}
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
          {env.policies.allowStatefulDeletion && (
            <Chip tone="warn" className="mt-3">
              stateful deletion allowed
            </Chip>
          )}
        </div>
      </div>
    </Card>
  );
}

function NewEnvironmentForm({
  connections,
  onSubmit,
}: {
  connections: CloudConnection[];
  onSubmit: (input: { name: string; class: EnvironmentClass; connectionId?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [klass, setKlass] = useState<EnvironmentClass>("staging");
  const [connectionId, setConnectionId] = useState(
    connections.find((c) => c.provider === "sandbox")?.id ?? ""
  );

  if (!open)
    return (
      <Button variant="quiet" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
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
        <Field label="Connection" help="Only the sandbox executes deployments today.">
          <Select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            placeholder="Sandbox (default)"
            options={connections.map((c) => ({
              value: c.id,
              label: `${c.label} · ${c.provider}`,
              disabled: c.provider !== "sandbox",
            }))}
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

/* ------------------------------- connection ------------------------------- */

function ConnectionCard({
  connection,
  onChecked,
  onDisconnect,
}: {
  connection: CloudConnection;
  onChecked: () => void;
  onDisconnect: () => void;
}) {
  const { run, busy } = useRunAction(onChecked);

  return (
    <Card
      title={
        <span className="flex items-center gap-2.5">
          <StatusDot status={CONN_DOT[connection.status]} label={connection.status} />
          {connection.label}
        </span>
      }
      subtitle={
        <>
          {connection.provider} · {connection.region} ·{" "}
          {connection.lastCheckedAt ? (
            <TimeAgo iso={connection.lastCheckedAt} prefix="checked" />
          ) : (
            "never checked"
          )}
        </>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="quiet"
            busy={busy}
            icon={<Plug className="h-3.5 w-3.5" />}
            onClick={() => run("connection.check", { input: { connectionId: connection.id } })}
          >
            Check
          </Button>
          <Button size="sm" variant="ghost" onClick={onDisconnect}>
            Disconnect
          </Button>
        </>
      }
    >
      <details>
        <summary className="cursor-pointer text-[12.5px] text-ink-mute select-none hover:text-ink">
          Exact permissions ({connection.grantedPermissions.length})
        </summary>
        <ul className="mt-2.5 space-y-1.5 border-l border-line pl-4 text-[12.5px] text-ink-mute">
          {connection.grantedPermissions.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
