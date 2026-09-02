"use client";
/** The "Add a service" panel — priced before it exists. */
import { useState } from "react";
import { Field, Input, Select } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import { KIND_OPTIONS, SizeField } from "./editor-parts";
import { nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { Service, ServiceSize } from "@/lib/domain/types";

export interface AddServiceFormProps {
  onCreated: (nodeId: string) => void;
}

export function AddServiceForm({ onCreated }: AddServiceFormProps) {
  const { project } = useProjectData();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Service["kind"]>("web");
  const [sourceMode, setSourceMode] = useState<"image" | "repo">("image");
  const [image, setImage] = useState("");
  const [repo, setRepo] = useState("");
  const [size, setSize] = useState<ServiceSize>("small");
  const [replicas, setReplicas] = useState("1");
  const [port, setPort] = useState("3000");
  const [schedule, setSchedule] = useState("0 * * * *");

  const input: Record<string, unknown> = { name: name.trim(), kind, size };
  if (sourceMode === "image" && image.trim()) input.image = image.trim();
  if (sourceMode === "repo" && repo.trim()) input.repo = repo.trim();
  if (kind !== "cron" && kind !== "static") input.replicas = Number(replicas) || 0;
  if (kind === "web" && port) input.port = Number(port);
  if (kind === "cron") input.schedule = schedule;

  // What this service will cost before it exists — the same number the editor
  // shows afterwards, priced through the same function.
  const monthlyUsd = nodeMonthlyCostUsd(
    {
      ...project.workingManifest,
      services: [
        {
          id: "draft",
          name: name.trim() || "draft",
          kind,
          source: { type: "image", image: image.trim() || "draft" },
          size,
          replicas: kind === "cron" || kind === "static" ? 1 : Number(replicas) || 0,
          env: [],
          ownership: "managed",
        },
      ],
    },
    "draft"
  );

  return (
    <div className="space-y-4">
      <Field label="Name" required help="Lowercase letters, digits and dashes.">
        <Input value={name} mono autoFocus placeholder="api" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Kind">
        <Select
          options={KIND_OPTIONS}
          value={kind}
          onChange={(e) => setKind(e.target.value as Service["kind"])}
        />
      </Field>
      <Field label="Source" help="Leave the image blank to start from the Orrery sample image.">
        <Select
          options={[
            { value: "image", label: "Container image" },
            { value: "repo", label: "Git repository" },
          ]}
          value={sourceMode}
          onChange={(e) => setSourceMode(e.target.value as "image" | "repo")}
        />
      </Field>
      {sourceMode === "image" ? (
        <Field label="Image">
          <Input
            value={image}
            mono
            placeholder="ghcr.io/acme/api:1.4.0"
            onChange={(e) => setImage(e.target.value)}
          />
        </Field>
      ) : (
        <Field label="Repository">
          <Input
            value={repo}
            mono
            placeholder="github.com/acme/api"
            onChange={(e) => setRepo(e.target.value)}
          />
        </Field>
      )}
      <SizeField value={size} onChange={setSize} monthlyUsd={monthlyUsd} />
      {kind !== "cron" && kind !== "static" && (
        <Field label="Replicas">
          <Input
            type="number"
            min={0}
            max={10}
            value={replicas}
            onChange={(e) => setReplicas(e.target.value)}
          />
        </Field>
      )}
      {kind === "web" && (
        <Field label="Port" help="A wrong port fails the health check at deploy time.">
          <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
      )}
      {kind === "cron" && (
        <Field label="Schedule">
          <Input value={schedule} mono onChange={(e) => setSchedule(e.target.value)} />
        </Field>
      )}
      <PlanFirst
        actionId="system.addService"
        input={input}
        label="Add service"
        disabled={!name.trim()}
        disabledReason="Give the service a name first."
        onDone={(r) => {
          const id = (r.data as { serviceId?: string } | undefined)?.serviceId;
          if (id) onCreated(id);
        }}
      />
    </div>
  );
}
