"use client";
/** The "Add a resource" panel — priced before it exists, optionally connected. */
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import { SizeField } from "./editor-parts";
import { nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { Resource, ServiceSize } from "@/lib/domain/types";

const RESOURCE_OPTIONS = [
  { value: "postgres", label: "PostgreSQL — relational database" },
  { value: "redis", label: "Redis — cache and ephemeral state" },
  { value: "object_store", label: "Object store — files and blobs" },
  { value: "queue", label: "Queue — work between services" },
  { value: "email", label: "Email — transactional sending" },
];

export interface AddResourceFormProps {
  onCreated: (nodeId: string) => void;
}

export function AddResourceForm({ onCreated }: AddResourceFormProps) {
  const { project } = useProjectData();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Resource["kind"]>("postgres");
  const [size, setSize] = useState<ServiceSize>("small");
  const [bindTo, setBindTo] = useState("");

  const input: Record<string, unknown> = { name: name.trim(), kind, size };
  if (bindTo) input.bindTo = bindTo;

  const resourceMonthlyUsd = nodeMonthlyCostUsd(
    {
      ...project.workingManifest,
      resources: [
        {
          id: "draft",
          name: name.trim() || "draft",
          kind,
          size,
          ownership: "managed",
          config: {},
        },
      ],
    },
    "draft"
  );

  return (
    <div className="space-y-4">
      <Field label="Name" required help="Lowercase letters, digits and dashes.">
        <Input
          value={name}
          mono
          autoFocus
          placeholder="postgres"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Kind">
        <Select
          options={RESOURCE_OPTIONS}
          value={kind}
          onChange={(e) => setKind(e.target.value as Resource["kind"])}
        />
      </Field>
      <SizeField value={size} onChange={setSize} monthlyUsd={resourceMonthlyUsd} />
      <Field
        label="Connect to"
        help="Optional — connecting now injects the configuration into that service straight away."
      >
        <Select
          placeholder="Nothing yet"
          value={bindTo}
          onChange={(e) => setBindTo(e.target.value)}
          options={[
            { value: "", label: "Nothing yet" },
            ...project.workingManifest.services.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      </Field>
      <PlanFirst
        actionId="system.addResource"
        input={input}
        label="Add resource"
        disabled={!name.trim()}
        disabledReason="Give the resource a name first."
        onDone={(r) => {
          const id = (r.data as { resourceId?: string } | undefined)?.resourceId;
          if (id) onCreated(id);
        }}
      />
    </div>
  );
}
