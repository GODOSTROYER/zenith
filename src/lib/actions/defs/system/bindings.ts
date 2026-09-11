/**
 * system.bind / unbind. Split out of the single-file module; the code is
 * unchanged.
 */
import { z } from "zod";
import {
  BindingCapability,
  id,
  type Binding,
} from "@/lib/domain/types";
import { findNode, nodeName } from "@/lib/domain/graph";
import { inferCapability } from "@/lib/importers/types";
import {
  clone,
  resolveNodeId,
} from "../_shared";
import { manifestAction } from "./shared";
/* -------------------------------- bindings -------------------------------- */

const Bind = z.object({
  projectId: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  capability: BindingCapability.optional(),
  note: z.string().optional(),
});
type Bind = z.infer<typeof Bind>;

manifestAction<Bind>({
  id: "system.bind",
  title: "Connect",
  risk: "low",
  input: Bind,
  build(project, input) {
    const next = clone(project.workingManifest);
    const fromId = resolveNodeId(next, input.from);
    const toId = resolveNodeId(next, input.to);
    if (fromId === toId) throw new Error("A node cannot be connected to itself. Pick two different nodes.");

    const existing = next.bindings.find((b) => b.from === fromId && b.to === toId);

    const target = findNode(next, toId);
    if (!target) throw new Error(`Routes cannot be a connection target. Bind a route to a service instead (from: the route, to: the service).`);
    const isRoute = next.routes.some((r) => r.id === fromId);
    // An existing edge keeps its capability unless the caller names a new one.
    const capability =
      input.capability ??
      existing?.capability ??
      (isRoute ? "http" : inferCapability(target.type === "resource" ? target.node.kind : "service"));

    if (isRoute && capability !== "http")
      throw new Error("A route can only serve HTTP. Leave capability unset, or use 'http'.");
    if (isRoute && target.type !== "service")
      throw new Error(`A route must point at a service. "${nodeName(next, toId)}" is a resource — put a service in front of it.`);
    if (target.type === "resource" && capability === "http")
      throw new Error(`"${nodeName(next, toId)}" is a ${target.node.kind}, which is not reached over HTTP. Leave capability unset and Zenith will pick the right one.`);

    // Editing an existing edge in place. Previously this returned "already
    // connected — nothing to change", so changing a capability meant an
    // unbind/bind pair: two audit rows and a moment with no connection at all.
    if (existing) {
      const capChanged = existing.capability !== capability;
      const noteChanged = input.note !== undefined && input.note !== existing.note;
      const label = `${nodeName(next, fromId)} → ${nodeName(next, toId)}`;
      if (!capChanged && !noteChanged)
        return {
          next,
          what: `${nodeName(next, fromId)} is already connected to ${nodeName(next, toId)}`,
          details: [`Nothing to change — the ${existing.capability} connection already exists.`],
          data: { bindingId: existing.id },
        };
      const before = existing.capability;
      existing.capability = capability;
      if (input.note !== undefined) existing.note = input.note;
      return {
        next,
        what: capChanged
          ? `Changes ${label} from ${before} to ${capability}`
          : `Updates the explanation on ${label}`,
        warnings: capChanged
          ? [`${nodeName(next, fromId)} loses the variables ${before} injected and gains the ${capability} ones. Redeploy it after this.`]
          : [],
        data: { bindingId: existing.id, capability },
      };
    }

    const binding: Binding = {
      id: id(),
      from: fromId,
      to: toId,
      capability,
      note: input.note ?? `${nodeName(next, fromId)} uses ${nodeName(next, toId)} (${capability}).`,
    };
    next.bindings.push(binding);
    return {
      next,
      what: `Connects ${nodeName(next, fromId)} to ${nodeName(next, toId)}`,
      data: { bindingId: binding.id, capability },
    };
  },
});

const Unbind = z.object({
  projectId: z.string().optional(),
  bindingId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
type Unbind = z.infer<typeof Unbind>;

manifestAction<Unbind>({
  id: "system.unbind",
  title: "Disconnect",
  risk: "medium",
  input: Unbind,
  build(project, input) {
    const next = clone(project.workingManifest);
    let binding: Binding | undefined;
    if (input.bindingId) binding = next.bindings.find((b) => b.id === input.bindingId);
    else if (input.from && input.to) {
      const fromId = resolveNodeId(next, input.from);
      const toId = resolveNodeId(next, input.to);
      binding = next.bindings.find((b) => b.from === fromId && b.to === toId);
    } else {
      throw new Error("Say which connection to remove: pass bindingId, or both from and to.");
    }
    if (!binding) throw new Error("That connection does not exist — it may already be gone. Reload the map to see the current connections.");

    const doomed = binding;
    const label = `${nodeName(next, doomed.from)} → ${nodeName(next, doomed.to)}`;
    next.bindings = next.bindings.filter((b) => b.id !== doomed.id);
    return {
      next,
      what: `Disconnects ${label}`,
      warnings: [`${nodeName(next, doomed.from)} loses its ${doomed.capability} configuration for ${nodeName(next, doomed.to)}. It will fail at runtime if it still uses it.`],
      data: { bindingId: doomed.id },
    };
  },
});
