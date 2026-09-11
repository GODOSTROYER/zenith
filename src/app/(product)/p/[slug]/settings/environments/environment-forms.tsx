"use client";
/**
 * The three forms a card opens inline — rename/move region, clone, and change
 * connection — and the frame they share. Each one only reports what the
 * operator chose; the section turns that into a plan-first confirm.
 */
import { useState, type ReactNode } from "react";
import type { CloudConnection, Environment } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { unusableReason, type ProviderInfo } from "../shared";

/* --------------------------------- forms ---------------------------------- */

export function InlineForm({
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

export function RenameForm({
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

export function CloneForm({
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

export function MoveForm({
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
