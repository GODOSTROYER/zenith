"use client";
/** One connection, opened on its own from the map or from a node's list. */
import { useState } from "react";
import { ArrowRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import { Facts } from "./editor-parts";
import { nodeLabel } from "./logic";
import { bindingEnv } from "@/lib/domain/graph";
import type { Binding } from "@/lib/domain/types";

const CAPABILITY_OPTIONS = [
  { value: "sql", label: "sql — relational database" },
  { value: "cache", label: "cache — key/value cache" },
  { value: "blob", label: "blob — object storage" },
  { value: "queue_publish", label: "queue_publish — sends work" },
  { value: "queue_consume", label: "queue_consume — takes work" },
  { value: "smtp", label: "smtp — transactional email" },
  { value: "http", label: "http — request/response" },
];

export interface BindingEditorProps {
  binding: Binding;
}

/**
 * A connection, opened on its own. There is no update action for a binding:
 * `system.bind` refuses an edge that already exists, so changing the capability
 * or the note is genuinely two changes — remove, then draw again — and the
 * panel says so rather than pretending one button does it.
 */
export function BindingEditor({ binding }: BindingEditorProps) {
  const { project } = useProjectData();
  const m = project.workingManifest;
  const [editing, setEditing] = useState(false);
  const [capability, setCapability] = useState<string>(binding.capability);
  const [note, setNote] = useState(binding.note ?? "");
  /** step 2 of the redraw: the old edge is gone, the new one is not there yet */
  const [removed, setRemoved] = useState(false);

  const injected = bindingEnv(m, binding);
  const changed = capability !== binding.capability || note !== (binding.note ?? "");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-card border border-line bg-bg1 px-3 py-2.5 text-[13px] text-ink">
        <span className="truncate">{nodeLabel(m, binding.from)}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
        <span className="truncate">{nodeLabel(m, binding.to)}</span>
        <Chip className="ml-auto">{binding.capability}</Chip>
      </div>

      <Facts
        rows={[
          ["Capability", binding.capability],
          ["Note", binding.note ?? "—"],
          [
            "Injects",
            injected.length ? (
              <span className="font-mono">{injected.map((e) => e.key).join(", ")}</span>
            ) : (
              "nothing"
            ),
          ],
        ]}
      />

      {removed ? (
        // Mid-way through a two-step redraw: the operator has to be told the
        // system is in the in-between state, not left to notice it.
        <Callout tone="warn" live="alert">
          <p className="text-[13px] text-ink">
            Step 2 of 2. The connection is out of the working copy right now — the Changes panel
            lists the removal. Draw it again with the new values, or leave it removed.
          </p>
          <PlanFirst
            className="mt-3"
            actionId="system.bind"
            input={{
              from: binding.from,
              to: binding.to,
              capability,
              note: note.trim() || undefined,
            }}
            label="Preview the new connection"
            onDone={() => {
              setRemoved(false);
              setEditing(false);
            }}
          />
        </Callout>
      ) : editing ? (
        <div className="space-y-3 rounded-card border border-line p-3">
          <p className="text-[12.5px] text-ink-mute">
            Orrery has no action that edits a connection in place, so this is two changes: the
            connection is removed, then drawn again with the values below. Both are previewed
            before anything happens, and neither touches a running environment until you deploy.
          </p>
          <Field label="Capability" help="Decides which environment variables get injected.">
            <Select
              options={CAPABILITY_OPTIONS}
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
            />
          </Field>
          <Field label="Note" help="Why this connection exists. Shown on the map and in the diff.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <PlanFirst
            actionId="system.unbind"
            input={{ bindingId: binding.id }}
            label="Step 1 — preview the removal"
            disabled={!changed}
            disabledReason="Change the capability or the note first — there is nothing to redraw yet."
            onDone={() => setRemoved(true)}
            onCancel={() => {
              setCapability(binding.capability);
              setNote(binding.note ?? "");
              setEditing(false);
            }}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="quiet"
            icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
            onClick={() => setEditing(true)}
          >
            Change capability or note
          </Button>
        </div>
      )}

      {!editing && !removed && (
        <div className="space-y-2 border-t border-line pt-4">
          <p className="text-[13px] text-ink-mute">
            {nodeLabel(m, binding.from)} loses its {binding.capability} configuration for{" "}
            {nodeLabel(m, binding.to)}. Nothing changes in a running environment until you deploy.
          </p>
          <PlanFirst
            actionId="system.unbind"
            input={{ bindingId: binding.id }}
            label="Disconnect"
            variant="danger"
          />
        </div>
      )}
    </div>
  );
}
