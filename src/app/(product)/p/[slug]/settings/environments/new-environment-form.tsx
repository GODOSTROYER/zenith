"use client";
/**
 * Create an environment. Collapsed to a single button until it is wanted, and
 * it only reports the choice — the section previews and creates.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Role } from "@/lib/actions/core";
import type { CloudConnection, EnvironmentClass } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useGate } from "../access";
import { unusableReason, type ProviderInfo } from "../shared";

export function NewEnvironmentForm({
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
