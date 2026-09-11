"use client";
/**
 * Environments — what a revision runs on, and everything about it that can be
 * changed without a deploy.
 *
 * Every control here is plan-first and role-gated at the point it is pressed,
 * not after a dialog has already been walked through. The cards also say what
 * is actually true of each environment right now: which revision is live, when
 * it landed, and how the (simulated) health of that revision reads.
 *
 * This file is the section itself: the list, the one pending action, and the
 * plan-first dialog that runs it. The card, its forms and the create form are
 * next door.
 */
import { useState } from "react";
import type { Role } from "@/lib/actions/core";
import type {
  CloudConnection,
  Deployment,
  Environment,
  EnvironmentClass,
} from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import type { RevisionMeta } from "@/components/screens/project-data";
import { ActionConfirm } from "@/components/screens/shared";
import type { ProviderInfo } from "../shared";
import { EnvironmentCard } from "./environment-card";
import { NewEnvironmentForm } from "./new-environment-form";

/**
 * The one action waiting for a plan-first confirm. Every control on a card
 * raises one of these instead of running anything itself, so the dialogs live
 * in one place and the cards stay presentational.
 */
export type Pending =
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
