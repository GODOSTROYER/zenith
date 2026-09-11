"use client";
/**
 * One environment: what is live on it, what it deploys through, its budget and
 * its deploy policy. Every control raises a `Pending` action rather than
 * running anything — the section owns the plan-first dialogs.
 */
import { useState } from "react";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { useJson } from "@/lib/client/api";
import type { Role } from "@/lib/actions/core";
import type { CloudConnection, Deployment, Environment } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { TimeAgo } from "@/components/ui/time-ago";
import { useExternalValue } from "@/components/ui/use-external-value";
import type { RevisionMeta } from "@/components/screens/project-data";
import { ErrorNote, envTone } from "@/components/screens/shared";
import { useGate } from "../access";
import { CONN_DOT, unusableReason, type ProviderInfo } from "../shared";
import type { Pending } from "./index";
import { CloneForm, MoveForm, RenameForm } from "./environment-forms";

/** `/api/health/:envId` — synthetic for every provider, and says so. */
interface HealthPayload {
  simulated: boolean;
  provider: { id: string; displayName: string };
  generatedBy: string;
  services: Record<string, { status: "ok" | "degraded"; reason: string }>;
}

const BUDGET_MIN = 1;
const BUDGET_MAX = 1_000_000;

const budgetText = (usd: number | undefined) => (usd ? String(usd) : "");

export interface EnvironmentCardProps {
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
}

export function EnvironmentCard({
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
}: EnvironmentCardProps) {
  const gate = useGate();
  const current = env.policies.budgetUsdMonthly;
  // The budget can change under this form (another tab, the Navigator, another
  // member). Adopt the new value when the field is untouched; when it is not,
  // keep what is being typed and say what happened instead of silently losing
  // either one.
  const {
    draft: budget,
    setDraft: setBudget,
    movedUnderYou: movedWhileTyping,
    reset: takeTheirBudget,
  } = useExternalValue(current, budgetText);
  const [form, setForm] = useState<"rename" | "clone" | "move" | null>(null);

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
        <span className="flex flex-wrap items-center gap-2.5">
          <span className="break-words">{env.name}</span>
          <Chip tone={envTone(env.class)}>{env.class}</Chip>
        </span>
      }
      subtitle={
        <>
          {env.region} · routes under <span className="break-all font-mono">{env.baseDomain}</span>
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
          <p className="text-[13px] font-medium text-ink-mute">Deploys through</p>
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

      <div className="mt-6 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 sm:grid-cols-2">
        <Field
          label="Monthly budget"
          help={`Estimates only. Budgets warn before a deploy; they never stop a running system. $${BUDGET_MIN} to $${BUDGET_MAX.toLocaleString("en-US")}.`}
          error={
            invalid
              ? `Enter a number between $${BUDGET_MIN} and $${BUDGET_MAX.toLocaleString("en-US")}, or leave it blank to remove the budget.`
              : undefined
          }
        >
          <div className="flex min-w-0 flex-wrap gap-2">
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
                onClick={takeTheirBudget}
              >
                Use {current ? fmtUsd(current) : "no budget"}
              </button>
            </p>
          )}
        </Field>

        <div>
          <p className="text-[13px] font-medium text-ink-mute">Deploy policy</p>

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
      <p className="text-[13px] font-medium text-ink-mute">Deployed revision</p>
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
                title="Zenith no longer holds the deployment record that landed this revision, so this is when the revision was created."
              >
                {" · "}
                <TimeAgo iso={revision.createdAt} prefix="revision cut" />
              </span>
            ) : null}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {health.error ? (
              <div className="w-full space-y-2">
                <ErrorNote error={health.error} />
                <Button size="sm" variant="quiet" onClick={health.refresh}>Retry health check</Button>
              </div>
            ) : health.loading && !health.data ? (
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
