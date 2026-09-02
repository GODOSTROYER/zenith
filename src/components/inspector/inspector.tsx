"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button, Chip, Drawer, EmptyState } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import {
  AddResourceForm,
  AddRouteForm,
  AddServiceForm,
  ResourceEditor,
  RouteEditor,
  ServiceEditor,
} from "./editors";

export type InspectorTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "add-service" }
  | { kind: "add-resource" }
  | { kind: "add-route" };

/**
 * Below this the map is too narrow to give up the panel, so it goes modal.
 * 1400px, not 1100: at 1100 the 400px panel clipped its own content, which is
 * worse than a drawer — the panel exists so a change and its consequence are
 * readable at once.
 */
export function useWideLayout(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1400px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

interface Head {
  title: string;
  description?: string;
  chip?: { tone: "signal" | "neutral" | "err"; text: string };
}

function InspectorBody({
  target,
  onSelectNode,
  onClose,
}: {
  target: InspectorTarget;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}) {
  const { project, changesets, selectedEnvId } = useProjectData();
  const m = project.workingManifest;

  if (target.kind === "add-service") return <AddServiceForm onCreated={onSelectNode} />;
  if (target.kind === "add-resource") return <AddResourceForm onCreated={onSelectNode} />;
  if (target.kind === "add-route") return <AddRouteForm onCreated={onSelectNode} />;

  const service = m.services.find((s) => s.id === target.nodeId);
  if (service) return <ServiceEditor service={service} />;
  const resource = m.resources.find((r) => r.id === target.nodeId);
  if (resource) return <ResourceEditor resource={resource} />;
  const route = m.routes.find((r) => r.id === target.nodeId);
  if (route) return <RouteEditor route={route} />;

  // The only way to land here is a node that exists in the environment but not
  // in the working copy — i.e. something staged for removal.
  const removing = changesets[selectedEnvId]?.items.find(
    (i) => i.nodeId === target.nodeId && i.op === "delete"
  );
  return (
    <EmptyState
      title={removing ? `${removing.nodeName} is staged for removal` : "That node is gone"}
      body={
        removing
          ? `${removing.explanation} Review it in the Changes panel, or deploy to apply it.`
          : "It is no longer part of the working system. The map has already caught up."
      }
      action={
        <Button variant="quiet" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    />
  );
}

function headFor(target: InspectorTarget, name: string | undefined, kind: string | undefined): Head {
  switch (target.kind) {
    case "add-service":
      return { title: "Add a service", description: "Something that runs your code." };
    case "add-resource":
      return { title: "Add a resource", description: "Managed infrastructure your services use." };
    case "add-route":
      return { title: "Publish a route", description: "A public hostname pointing at a service." };
    default:
      return { title: name ?? "Selection", description: kind };
  }
}

export interface InspectorProps {
  target: InspectorTarget | null;
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
}

/**
 * The right-hand panel. On a wide screen it sits beside the map so you can see
 * a change and its consequence at once; narrower, it becomes a drawer.
 */
export function Inspector({ target, onClose, onSelectNode }: InspectorProps) {
  const wide = useWideLayout();
  const { project, changesets, selectedEnvId } = useProjectData();

  if (!target) return null;

  const m = project.workingManifest;
  const node =
    target.kind === "node"
      ? (m.services.find((s) => s.id === target.nodeId) ??
        m.resources.find((r) => r.id === target.nodeId))
      : undefined;
  const route =
    target.kind === "node" ? m.routes.find((r) => r.id === target.nodeId) : undefined;

  const name = node?.name ?? route?.host;
  const kindLabel = node
    ? "kind" in node
      ? String(node.kind)
      : undefined
    : route
      ? "route"
      : undefined;
  const head = headFor(target, name, kindLabel);

  const diff =
    target.kind === "node"
      ? changesets[selectedEnvId]?.items.find((i) => i.nodeId === target.nodeId)
      : undefined;

  const body = (
    <InspectorBody target={target} onSelectNode={onSelectNode} onClose={onClose} />
  );

  const pendingChip = diff ? (
    <Chip tone={diff.op === "delete" ? "err" : "signal"} title={diff.explanation}>
      {diff.op === "create" ? "not deployed yet" : diff.op === "delete" ? "removing" : "changed"}
    </Chip>
  ) : null;

  if (!wide)
    return (
      <Drawer open onClose={onClose} title={head.title} description={head.description} actions={pendingChip}>
        {body}
      </Drawer>
    );

  return (
    <aside
      aria-label="Inspector"
      className="animate-enter flex w-[400px] shrink-0 flex-col border-l border-line bg-bg1"
    >
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-medium text-ink" title={head.title}>
            {head.title}
          </h2>
          {head.description && (
            <p className="mt-0.5 text-[12px] text-ink-mute">{head.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pendingChip}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close (Esc)"
            icon={<X className="h-4 w-4" aria-hidden="true" />}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{body}</div>
    </aside>
  );
}
