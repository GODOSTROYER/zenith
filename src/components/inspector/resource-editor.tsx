"use client";
/** One resource: config, connections, removal. */
import { useMemo, useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import { BindingList } from "./binding-list";
import { Facts, SizeField, StaleNotice, resourceCost, useUpstreamGuard } from "./editor-parts";
import type { Resource, ServiceSize } from "@/lib/domain/types";

const STATEFUL_KINDS = ["postgres", "redis", "object_store", "queue"];

export interface ResourceEditorProps {
  resource: Resource;
  onOpenBinding?: (bindingId: string) => void;
}

export function ResourceEditor({ resource, onOpenBinding }: ResourceEditorProps) {
  const { project } = useProjectData();
  const [tab, setTab] = useState("config");
  const [name, setName] = useState(resource.name);
  const [size, setSize] = useState<ServiceSize>(resource.size);

  const managed = resource.ownership === "managed";
  const { current, projected } = useMemo(
    () => resourceCost(project.workingManifest, resource.id, { size }),
    [project.workingManifest, resource.id, size]
  );

  const input: Record<string, unknown> = { resourceId: resource.id };
  // An emptied name is not a rename: the update action ignores "" and the form
  // would have offered to apply nothing at all.
  if (name.trim() && name.trim() !== resource.name) input.name = name.trim();
  if (size !== resource.size) input.size = size;
  const dirty = Object.keys(input).length > 1;
  const nameCleared = !name.trim();
  const guard = useUpstreamGuard(resource, dirty, () => {
    setName(resource.name);
    setSize(resource.size);
  });

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "config", label: "Config" },
          {
            value: "bindings",
            label: "Connections",
            badge:
              project.workingManifest.bindings.filter(
                (b) => b.from === resource.id || b.to === resource.id
              ).length || undefined,
          },
          { value: "danger", label: "Danger" },
        ]}
      />

      {tab === "config" && (
        <div className="space-y-4">
          {guard.stale && (
            <StaleNotice
              name={resource.name}
              onReload={guard.reload}
              onKeepMine={guard.keepMine}
            />
          )}
          {!managed && (
            <p className="rounded-ctl border border-line bg-bg1 p-2.5 text-[12.5px] text-ink-mute">
              This {resource.kind} is <strong className="text-ink">{resource.ownership}</strong>:
              Zenith reads it and connects to it, but never provisions, resizes or deletes it — and
              it is not part of the cost estimate.
            </p>
          )}
          <Field label="Name" help="Renaming changes the env vars injected into everything bound to it.">
            <Input value={name} mono onChange={(e) => setName(e.target.value)} />
          </Field>
          <SizeField
            value={size}
            onChange={setSize}
            monthlyUsd={managed ? projected : undefined}
            deltaUsd={managed ? projected - current : undefined}
          />
          <Facts
            rows={[
              ["Kind", resource.kind],
              ["Ownership", resource.ownership],
              ...(resource.externalRef
                ? ([["External ref", <span key="x" className="font-mono">{resource.externalRef}</span>]] as [
                    string,
                    React.ReactNode,
                  ][])
                : []),
            ]}
          />
          <PlanFirst
            actionId="system.updateResource"
            input={input}
            label="Apply change"
            disabled={!dirty || guard.stale || nameCleared}
            disabledReason={
              guard.stale
                ? `${resource.name} changed underneath this form. Load the new values, or keep yours, before applying.`
                : nameCleared
                  ? "A resource always has a name. Put one back, or remove it from the Danger tab."
                  : "Change a field first — there is nothing to apply yet."
            }
            onCancel={
              dirty
                ? () => {
                    setName(resource.name);
                    setSize(resource.size);
                  }
                : undefined
            }
          />
        </div>
      )}

      {tab === "bindings" && <BindingList nodeId={resource.id} onOpen={onOpenBinding} />}

      {tab === "danger" && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-mute">
            {STATEFUL_KINDS.includes(resource.kind) && managed
              ? `Deploying this removal destroys the data in ${resource.name}. Rollback restores the system definition, not the data.`
              : `Removing ${resource.name} takes it out of the working system. Nothing changes in a running environment until you deploy.`}
          </p>
          <PlanFirst
            actionId="system.removeResource"
            input={{ resourceId: resource.id }}
            label={`Remove ${resource.name}`}
            variant="danger"
            confirmName={
              STATEFUL_KINDS.includes(resource.kind) && managed ? resource.name : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
