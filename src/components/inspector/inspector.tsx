"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button, Chip, Drawer, EmptyState } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { ChangeRow } from "@/components/screens/shared";
import {
  AddResourceForm,
  AddRouteForm,
  AddServiceForm,
  BindingEditor,
  ResourceEditor,
  RouteEditor,
  ServiceEditor,
  nodeLabel,
} from "./editors";

export type InspectorTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "binding"; bindingId: string }
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
}

function InspectorBody({
  target,
  onSelect,
  onClose,
}: {
  target: InspectorTarget;
  onSelect: (target: InspectorTarget) => void;
  onClose: () => void;
}) {
  const { project, changesets, selectedEnvId } = useProjectData();
  const m = project.workingManifest;
  const onCreated = (nodeId: string) => onSelect({ kind: "node", nodeId });
  const onOpenBinding = (bindingId: string) => onSelect({ kind: "binding", bindingId });

  if (target.kind === "add-service") return <AddServiceForm onCreated={onCreated} />;
  if (target.kind === "add-resource") return <AddResourceForm onCreated={onCreated} />;
  if (target.kind === "add-route") return <AddRouteForm onCreated={onCreated} />;

  if (target.kind === "binding") {
    const binding = m.bindings.find((b) => b.id === target.bindingId);
    if (binding) return <BindingEditor binding={binding} />;
    const removing = changesets[selectedEnvId]?.items.find(
      (i) => i.nodeId === target.bindingId && i.op === "delete"
    );
    return (
      <EmptyState
        title={removing ? `${removing.nodeName} is staged for removal` : "That connection is gone"}
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

  const service = m.services.find((s) => s.id === target.nodeId);
  if (service) return <ServiceEditor service={service} onOpenBinding={onOpenBinding} />;
  const resource = m.resources.find((r) => r.id === target.nodeId);
  if (resource) return <ResourceEditor resource={resource} onOpenBinding={onOpenBinding} />;
  const route = m.routes.find((r) => r.id === target.nodeId);
  if (route) return <RouteEditor route={route} onOpenBinding={onOpenBinding} />;

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
  onSelect: (target: InspectorTarget) => void;
}

/**
 * The right-hand panel. On a wide screen it sits beside the map so you can see
 * a change and its consequence at once; narrower, it becomes a drawer.
 */
export function Inspector({ target, onClose, onSelect }: InspectorProps) {
  const wide = useWideLayout();
  const { project, changesets, selectedEnvId } = useProjectData();
  const heading = useRef<HTMLHeadingElement>(null);

  const targetKey = target
    ? target.kind === "node"
      ? `node:${target.nodeId}`
      : target.kind === "binding"
        ? `binding:${target.bindingId}`
        : target.kind
    : "";

  /* The panel appears beside the map without moving focus, so a keyboard user
     had to Tab through the whole graph to reach the form they just opened.
     Sending focus to the heading puts the next Tab inside the panel; the
     heading is not the first control, so nothing is triggered by accident.
     The drawer has its own focus trap and does not need this. */
  useEffect(() => {
    if (!wide || !targetKey) return;
    heading.current?.focus();
  }, [wide, targetKey]);

  if (!target) return null;

  const m = project.workingManifest;
  const node =
    target.kind === "node"
      ? (m.services.find((s) => s.id === target.nodeId) ??
        m.resources.find((r) => r.id === target.nodeId))
      : undefined;
  const route =
    target.kind === "node" ? m.routes.find((r) => r.id === target.nodeId) : undefined;
  const binding =
    target.kind === "binding" ? m.bindings.find((b) => b.id === target.bindingId) : undefined;

  const name = binding
    ? `${nodeLabel(m, binding.from)} → ${nodeLabel(m, binding.to)}`
    : (node?.name ?? route?.host);
  const kindLabel = binding
    ? `${binding.capability} connection`
    : node
      ? "kind" in node
        ? String(node.kind)
        : undefined
      : route
        ? "route"
        : undefined;
  const head = headFor(target, name, kindLabel);

  const diffId =
    target.kind === "node" ? target.nodeId : target.kind === "binding" ? target.bindingId : undefined;
  const diff = diffId
    ? changesets[selectedEnvId]?.items.find((i) => i.nodeId === diffId)
    : undefined;

  const body = (
    <>
      {/* Field-level detail, rendered by the same component the Changes panel
          and the deploy review use — the inspector may never describe a change
          differently from the list you are about to deploy. */}
      {diff && (
        <ul className="mb-4 overflow-hidden rounded-card border border-line bg-bg1">
          <ChangeRow item={diff} />
        </ul>
      )}
      <InspectorBody target={target} onSelect={onSelect} onClose={onClose} />
    </>
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
          <h2
            ref={heading}
            tabIndex={-1}
            className="truncate text-[15px] font-medium text-ink outline-none focus-visible:underline"
            title={head.title}
          >
            {head.title}
          </h2>
          {head.description && (
            <p className="mt-0.5 text-[12px] text-ink-mute">{head.description}</p>
          )}
          {/* Announced, not just drawn: nothing else tells a screen reader the
              panel opened or that it is now showing something different. */}
          <p role="status" className="sr-only">
            Inspector open: {head.title}
            {head.description ? `, ${head.description}` : ""}.
          </p>
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
