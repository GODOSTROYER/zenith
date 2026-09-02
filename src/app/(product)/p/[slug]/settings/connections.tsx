"use client";
/**
 * Connections — every one lists the exact access it holds, and every control
 * that changes one is admin-gated before it is pressed.
 */
import { useState } from "react";
import { Plug, Plus } from "lucide-react";
import type { Role } from "@/lib/actions/core";
import type { CloudConnection } from "@/lib/domain/types";
import {
  Button,
  Card,
  Field,
  Input,
  Select,
  Skeleton,
  StatusDot,
  TimeAgo,
} from "@/components/ui";
import { ActionConfirm, ErrorNote, useRunAction } from "@/components/screens/shared";
import { useGate } from "./access";
import { CONN_DOT, unusableReason, type ProviderInfo } from "./shared";

type Pending =
  | { kind: "create"; provider: ProviderInfo; input: { provider: string; label?: string; region?: string } }
  | { kind: "disconnect"; connection: CloudConnection };

export function ConnectionsSection({
  connections,
  providers,
  providerById,
  loaded,
  error,
  role,
  projectId,
  refresh,
}: {
  connections: CloudConnection[];
  providers: ProviderInfo[];
  providerById: Map<string, ProviderInfo>;
  loaded: boolean;
  error: unknown;
  role: Role | null | undefined;
  projectId: string;
  refresh: () => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const done = () => {
    setPending(null);
    refresh();
  };

  if (error) return <ErrorNote error={error} />;
  if (!loaded) return <Skeleton height={120} />;

  return (
    <div className="space-y-4">
      {connections.length === 0 ? (
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
              unusable={unusableReason(c, providerById)}
              role={role}
              onChecked={refresh}
              onDisconnect={() => setPending({ kind: "disconnect", connection: c })}
            />
          ))}
        </div>
      )}

      <NewConnectionForm
        providers={providers}
        role={role}
        onSubmit={(provider, input) => setPending({ kind: "create", provider, input })}
      />

      {pending?.kind === "create" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="connection.create"
          input={pending.input}
          scope={{ projectId }}
          title={`Connect ${pending.provider.displayName}`}
          description="The plan below lists the exact access this connection will hold — the same list the connection shows afterwards under Exact permissions."
          confirmLabel="Connect"
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
          // The plan says whether this can happen at all and what it costs;
          // this line only states the part that is true either way.
          description="Orrery forgets how to reach this cloud. Nothing inside it is created, changed or deleted."
          confirmLabel="Disconnect"
          danger
          onDone={done}
        />
      )}
    </div>
  );
}

function ConnectionCard({
  connection,
  unusable,
  role,
  onChecked,
  onDisconnect,
}: {
  connection: CloudConnection;
  /** why environments cannot deploy through it, when that is the case */
  unusable: string | undefined;
  role: Role | null | undefined;
  onChecked: () => void;
  onDisconnect: () => void;
}) {
  const gate = useGate();
  const { run, busy } = useRunAction(onChecked);
  const checkGate = gate(role, "connection.check");
  const disconnectGate = gate(role, "connection.disconnect");

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
            disabled={!!checkGate}
            disabledReason={checkGate}
            onClick={() => run("connection.check", { input: { connectionId: connection.id } })}
          >
            Check
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!disconnectGate}
            disabledReason={disconnectGate}
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        </>
      }
    >
      {unusable && (
        <p className="mb-3 text-[12.5px] text-ink-mute">
          Environments cannot deploy through this connection — {unusable}.
        </p>
      )}
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

function NewConnectionForm({
  providers,
  role,
  onSubmit,
}: {
  providers: ProviderInfo[];
  role: Role | null | undefined;
  onSubmit: (
    provider: ProviderInfo,
    input: { provider: string; label?: string; region?: string }
  ) => void;
}) {
  const gate = useGate();
  const [open, setOpen] = useState(false);
  const first = providers.find((p) => p.availability === "available") ?? providers[0];
  const [providerId, setProviderId] = useState(first?.id ?? "");
  const [label, setLabel] = useState("");
  const [region, setRegion] = useState(first?.regions[0]?.id ?? "");
  const createGate = gate(role, "connection.create");

  const provider = providers.find((p) => p.id === providerId);

  // No adapters registered means nothing to connect — don't offer the button.
  if (providers.length === 0) return null;

  if (!open)
    return (
      <Button
        variant="quiet"
        icon={<Plus className="h-3.5 w-3.5" />}
        disabled={!!createGate}
        disabledReason={createGate}
        onClick={() => setOpen(true)}
      >
        Connect a cloud
      </Button>
    );

  return (
    <Card
      title="Connect a cloud"
      subtitle="The preview lists the exact access the connection will hold before anything is saved."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Provider"
          help={provider ? provider.tagline : "No provider adapters are registered in this build."}
        >
          <Select
            value={providerId}
            onChange={(e) => {
              const next = providers.find((p) => p.id === e.target.value);
              setProviderId(e.target.value as ProviderInfo["id"]);
              setRegion(next?.regions[0]?.id ?? "");
            }}
            options={providers.map((p) => ({
              value: p.id,
              label:
                p.availability === "available"
                  ? `${p.displayName} · available`
                  : `${p.displayName} · ${p.availability}${p.availability === "planned" ? " — cannot be connected yet" : " — plans and exports only"}`,
              disabled: p.availability === "planned",
            }))}
          />
        </Field>
        <Field
          label="Region"
          help={provider?.regions.length ? "Where this connection operates." : "This provider exposes no regions."}
        >
          <Select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            disabled={!provider?.regions.length}
            placeholder="default"
            options={(provider?.regions ?? []).map((r) => ({
              value: r.id,
              label: `${r.id} · ${r.label}`,
            }))}
          />
        </Field>
        <Field label="Label" help="Optional. Defaults to the provider and region.">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={provider ? `${provider.displayName} ${region || "default"}` : ""}
          />
        </Field>
      </div>
      <div className="mt-4 flex gap-2">
        <Button
          disabled={!provider || provider.availability === "planned"}
          disabledReason={
            !provider
              ? "Pick a provider."
              : `${provider.displayName} is planned, not implemented — connecting it would do nothing.`
          }
          onClick={() =>
            provider &&
            onSubmit(provider, {
              provider: provider.id,
              label: label.trim() || undefined,
              region: region || undefined,
            })
          }
        >
          Preview and connect
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
