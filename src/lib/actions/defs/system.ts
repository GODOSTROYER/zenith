/**
 * Manifest edits. Every one of these mutates the project's WORKING copy —
 * never a running environment — so their plans are pure changeset previews
 * and their results say "deploy to apply it".
 */
import { z } from "zod";
import {
  defineAction,
  type ActionContext,
  type ActionResult,
  type Risk,
  type Role,
} from "@/lib/actions/core";
import {
  BindingCapability,
  id,
  Ownership,
  ResourceKind,
  ServiceKind,
  ServiceSize,
  type Binding,
  type Manifest,
  type Project,
  type Resource,
  type Route,
  type Service,
  type ServiceSource,
} from "@/lib/domain/types";
import { findNode, nodeName } from "@/lib/domain/graph";
import { inferCapability, SECRET_KEY_RE, slugify, uniqueName } from "@/lib/importers/types";
import {
  isVaultRef,
  parseVaultRef,
  putSecret,
  removeSecret as removeStoredSecret,
  secretStatus,
  secretStoreState,
  vaultRef,
} from "@/lib/secrets";
import { db, q } from "@/lib/db/store";
import {
  clone,
  commit,
  editSummary,
  planFromDiff,
  requireProject,
  requireResource,
  requireService,
  resolveNodeId,
} from "./_shared";

/* --------------------------- manifest-action shape ------------------------- */

interface Built {
  next: Manifest;
  /** what the change is, in one clause: "Adds web service \"api\"" */
  what: string;
  details?: string[];
  warnings?: string[];
  data?: unknown;
  /**
   * Set when this edit must not be applied at all — the reason and the fix.
   * Surfaces read it off the plan and disable their confirm control; execute
   * refuses with the same words. Used where an edit would destroy data.
   */
  blocked?: string;
  /**
   * Side effect outside the manifest, run on execute only — never on plan.
   * The secret actions are the only users: the value goes into the store
   * BEFORE the manifest is committed, so a failed write leaves the plaintext
   * where it was rather than replacing it with a reference to nothing.
   */
  apply?: () => void;
}

/**
 * Every system.* action is the same shape: build the next manifest
 * purely, preview it with a real diff, commit it on execute.
 */
export function manifestAction<I extends { projectId?: string }>(def: {
  id: string;
  title: string;
  risk: Risk;
  requiredRole?: Role;
  input: z.ZodType<I>;
  /** Pure apart from reads. `ctx` is here for the workspace-scoped secret store. */
  build(project: Project, input: I, ctx: ActionContext): Built;
}) {
  return defineAction<I>({
    id: def.id,
    title: def.title,
    category: "system",
    risk: def.risk,
    requiredRole: def.requiredRole ?? "editor",
    mutates: true,
    input: def.input,
    plan(ctx: ActionContext, input: I) {
      const project = requireProject(ctx, input.projectId);
      const built = def.build(project, input, ctx);
      const plan = planFromDiff(project.workingManifest, built.next, built.what, {
        details: built.details,
        warnings: built.warnings,
      });
      return built.blocked ? { ...plan, blocked: built.blocked } : plan;
    },
    execute(ctx: ActionContext, input: I): ActionResult {
      const project = requireProject(ctx, input.projectId);
      const before = clone(project.workingManifest);
      const built = def.build(project, input, ctx);
      if (built.blocked)
        return { ok: false, summary: `${def.title} was not applied.`, error: built.blocked };
      // Store first, manifest second: if this throws, nothing is committed.
      built.apply?.();
      commit(project, built.next);
      return { ok: true, summary: editSummary(before, built.next, built.what), data: built.data };
    },
  });
}

const takenNames = (m: Manifest) => [...m.services.map((s) => s.name), ...m.resources.map((r) => r.name)];

/** Drop every binding that touches a node id, and say which. */
function dropBindings(m: Manifest, nodeId: string): string[] {
  const doomed = m.bindings.filter((b) => b.from === nodeId || b.to === nodeId);
  m.bindings = m.bindings.filter((b) => !doomed.includes(b));
  return doomed.map((b) => `${nodeName(m, b.from)} → ${nodeName(m, b.to)}`);
}

/* ------------------------------- services --------------------------------- */

const AddService = z.object({
  projectId: z.string().optional(),
  name: z.string().min(1),
  kind: ServiceKind.optional(),
  image: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  dockerfile: z.string().optional(),
  size: ServiceSize.optional(),
  replicas: z.number().int().min(0).max(10).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  healthPath: z.string().optional(),
  schedule: z.string().optional(),
});
type AddService = z.infer<typeof AddService>;

const PLACEHOLDER_IMAGE = "ghcr.io/orrery/hello-web:1";

manifestAction<AddService>({
  id: "system.addService",
  title: "Add service",
  risk: "low",
  input: AddService,
  build(project, input) {
    const next = clone(project.workingManifest);
    const kind = input.kind ?? "web";
    const name = uniqueName(slugify(input.name, "service"), takenNames(next));
    const details: string[] = [];
    const warnings: string[] = [];

    if (name !== input.name) details.push(`Named "${name}" — node names are lowercase letters, digits and dashes, and unique in a project.`);

    let source: ServiceSource;
    if (input.image) source = { type: "image", image: input.image };
    else if (input.repo) source = { type: "git", repo: input.repo, ref: input.ref ?? "main", dockerfile: input.dockerfile };
    else {
      source = { type: "image", image: PLACEHOLDER_IMAGE };
      warnings.push(`No image or repository given, so ${name} points at the Zenith.ai sample image (${PLACEHOLDER_IMAGE}). Set a real source with system.updateService before deploying anything you care about.`);
    }

    let port = input.port;
    if (kind === "web" && port === undefined) {
      port = 3000;
      details.push("No port given, so 3000 was assumed. A wrong port fails the health check at deploy time — set it if your app listens elsewhere.");
    }
    let schedule = input.schedule;
    if (kind === "cron" && !schedule) {
      schedule = "0 * * * *";
      details.push("No schedule given, so hourly (0 * * * *) was assumed.");
    }

    const service: Service = {
      id: id(),
      name,
      kind,
      source,
      size: input.size ?? "small",
      replicas: input.replicas ?? 1,
      port: kind === "static" ? undefined : port,
      healthPath: input.healthPath,
      schedule,
      env: [],
      ownership: "managed",
    };
    next.services.push(service);
    return { next, what: `Adds ${kind} service "${name}"`, details, warnings, data: { serviceId: service.id, name } };
  },
});

const UpdateService = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  /** min(1): "" used to pass, then build() skipped it — an edit that did nothing */
  name: z.string().min(1, "give the service a name, or leave the field out to keep the current one").optional(),
  kind: ServiceKind.optional(),
  size: ServiceSize.optional(),
  replicas: z.number().int().min(0).max(10).optional(),
  /** absent = leave it alone; null = clear it (a worker does not need a port) */
  port: z.number().int().min(1).max(65535).nullable().optional(),
  healthPath: z.string().optional(),
  schedule: z.string().optional(),
  image: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
});
type UpdateService = z.infer<typeof UpdateService>;

manifestAction<UpdateService>({
  id: "system.updateService",
  title: "Update service",
  risk: "low",
  input: UpdateService,
  build(project, input) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    const warnings: string[] = [];

    if (input.name && input.name !== service.name) {
      const name = uniqueName(slugify(input.name, service.name), takenNames(next).filter((n) => n !== service.name));
      warnings.push(`Renaming ${service.name} to ${name} changes the environment variables injected into everything bound to it. Redeploy dependents after this.`);
      service.name = name;
    }
    if (input.kind) service.kind = input.kind;
    if (input.size) service.size = input.size;
    if (input.replicas !== undefined) service.replicas = input.replicas;
    // Absent leaves the port alone; an explicit null clears it. Without the
    // distinction there was no way to un-set a port at all.
    if (input.port !== undefined) {
      if (input.port === null && service.port !== undefined && service.kind === "web")
        warnings.push(`Clearing the port on web service ${service.name} makes the system invalid — a web service must say what it listens on. Set a port, or change the kind to worker.`);
      service.port = input.port ?? undefined;
    }
    if (input.healthPath !== undefined) service.healthPath = input.healthPath;
    if (input.schedule !== undefined) service.schedule = input.schedule;
    if (input.image) service.source = { type: "image", image: input.image };
    else if (input.repo) service.source = { type: "git", repo: input.repo, ref: input.ref ?? "main" };

    if (service.replicas === 0)
      warnings.push(`${service.name} is scaled to 0 replicas — it will stop serving traffic when this is deployed.`);

    return { next, what: `Updates service "${service.name}"`, warnings, data: { serviceId: service.id } };
  },
});

const RemoveService = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
});
type RemoveService = z.infer<typeof RemoveService>;

manifestAction<RemoveService>({
  id: "system.removeService",
  title: "Remove service",
  risk: "medium",
  input: RemoveService,
  build(project, input) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    const dropped = dropBindings(next, service.id);
    next.services = next.services.filter((s) => s.id !== service.id);
    return {
      next,
      what: `Removes service "${service.name}"`,
      details: dropped.length ? [`Also removes ${dropped.length} connection(s): ${dropped.join(", ")}.`] : [],
      warnings: dropped.length ? [`Anything that depended on ${service.name} loses it. Check the map before deploying.`] : [],
      data: { serviceId: service.id },
    };
  },
});

/* ------------------------------- resources -------------------------------- */

const AddResource = z.object({
  projectId: z.string().optional(),
  name: z.string().min(1),
  kind: ResourceKind,
  size: ServiceSize.optional(),
  ownership: Ownership.optional(),
  externalRef: z.string().optional(),
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** optionally connect it to a service in the same step */
  bindTo: z.string().optional(),
});
type AddResource = z.infer<typeof AddResource>;

manifestAction<AddResource>({
  id: "system.addResource",
  title: "Add resource",
  risk: "low",
  input: AddResource,
  build(project, input) {
    const next = clone(project.workingManifest);
    const ownership = input.ownership ?? "managed";
    if (ownership === "referenced" && !input.externalRef)
      throw new Error("A referenced resource needs the identifier it already has in your cloud. Pass externalRef (e.g. aws_db_instance.main), or leave ownership as 'managed' to let Zenith.ai provision it.");

    const name = uniqueName(slugify(input.name, input.kind.replace("_", "-")), takenNames(next));
    const resource: Resource = {
      id: id(),
      name,
      kind: input.kind,
      config: input.config ?? {},
      size: input.size ?? "small",
      ownership,
      externalRef: input.externalRef,
    };
    next.resources.push(resource);

    const details: string[] = [];
    if (ownership !== "managed")
      details.push(`Marked "${ownership}": Zenith.ai reads it and binds to it, but never provisions or deletes it — and it does not appear in the Zenith.ai cost estimate.`);

    if (input.bindTo) {
      const fromId = resolveNodeId(next, input.bindTo);
      const capability = inferCapability(input.kind);
      next.bindings.push({
        id: id(),
        from: fromId,
        to: resource.id,
        capability,
        note: `${nodeName(next, fromId)} uses ${name} (${capability}).`,
      });
      details.push(`Connects ${nodeName(next, fromId)} to ${name}.`);
    }

    return { next, what: `Adds ${input.kind} "${name}"`, details, data: { resourceId: resource.id, name } };
  },
});

const UpdateResource = z.object({
  projectId: z.string().optional(),
  resourceId: z.string().min(1),
  name: z.string().optional(),
  size: ServiceSize.optional(),
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
type UpdateResource = z.infer<typeof UpdateResource>;

manifestAction<UpdateResource>({
  id: "system.updateResource",
  title: "Update resource",
  risk: "medium",
  input: UpdateResource,
  build(project, input) {
    const next = clone(project.workingManifest);
    const resource = requireResource(next, input.resourceId);
    const warnings: string[] = [];
    if (input.name && input.name !== resource.name) {
      const name = uniqueName(slugify(input.name, resource.name), takenNames(next).filter((n) => n !== resource.name));
      warnings.push(`Renaming ${resource.name} to ${name} changes the env vars injected into every service bound to it. Redeploy those services after this.`);
      resource.name = name;
    }
    if (input.size && input.size !== resource.size)
      warnings.push(`Resizing ${resource.name} restarts it. Expect a short interruption for anything using it.`);
    if (input.size) resource.size = input.size;
    if (input.config) resource.config = { ...resource.config, ...input.config };
    return { next, what: `Updates ${resource.kind} "${resource.name}"`, warnings, data: { resourceId: resource.id } };
  },
});

const RemoveResource = z.object({
  projectId: z.string().optional(),
  resourceId: z.string().min(1),
});
type RemoveResource = z.infer<typeof RemoveResource>;

manifestAction<RemoveResource>({
  id: "system.removeResource",
  title: "Remove resource",
  risk: "high",
  input: RemoveResource,
  build(project, input) {
    const next = clone(project.workingManifest);
    const resource = requireResource(next, input.resourceId);
    const dropped = dropBindings(next, resource.id);
    next.resources = next.resources.filter((r) => r.id !== resource.id);
    const stateful = resource.ownership === "managed" && resource.kind !== "email";
    return {
      next,
      what: `Removes ${resource.kind} "${resource.name}"`,
      details: dropped.length ? [`Also removes ${dropped.length} connection(s): ${dropped.join(", ")}.`] : [],
      warnings: stateful
        ? [`Deploying this destroys the data in ${resource.name}. Rollback restores the manifest, not the data — export anything you need first.`]
        : [],
      data: { resourceId: resource.id },
    };
  },
});

/* --------------------------------- routes --------------------------------- */

const AddRoute = z.object({
  projectId: z.string().optional(),
  host: z.string().optional(),
  serviceId: z.string().optional(),
  pathPrefix: z.string().optional(),
  tls: z.boolean().optional(),
  managedDns: z.boolean().optional(),
});
type AddRoute = z.infer<typeof AddRoute>;

manifestAction<AddRoute>({
  id: "system.addRoute",
  title: "Add route",
  risk: "low",
  input: AddRoute,
  build(project, input) {
    const next = clone(project.workingManifest);
    const managedDns = input.managedDns ?? !input.host;
    const host = input.host ?? `app.${project.slug}.orrery.app`;
    if (next.routes.some((r) => r.host === host && r.pathPrefix === (input.pathPrefix ?? "/")))
      throw new Error(`${host}${input.pathPrefix ?? "/"} is already published. Pick another hostname or path prefix.`);

    const route: Route = {
      id: id(),
      host,
      pathPrefix: input.pathPrefix ?? "/",
      tls: input.tls ?? true,
      managedDns,
    };
    next.routes.push(route);

    const details: string[] = [];
    const warnings: string[] = [];
    if (managedDns) details.push(`${host} is an Zenith.ai-managed hostname — DNS and the TLS certificate are handled for you.`);
    else details.push(`${host} is your own hostname: point a CNAME at the environment before deploying, or the certificate will not issue.`);

    if (input.serviceId) {
      const target = requireService(next, input.serviceId);
      if (target.kind !== "web" && target.kind !== "static")
        throw new Error(`${target.name} is a ${target.kind} and cannot serve HTTP. Bind the route to a web or static service.`);
      next.bindings.push({
        id: id(),
        from: route.id,
        to: target.id,
        capability: "http",
        note: `Public traffic on ${host} reaches ${target.name}.`,
      });
      details.push(`Serves ${target.name}.`);
    } else {
      warnings.push(`This route serves nothing yet. Bind it to a web service with system.bind, or it will 404.`);
    }

    return { next, what: `Publishes ${host}`, details, warnings, data: { routeId: route.id, host } };
  },
});

/** Routes are looked up by id or by hostname, like every other node ref. */
function requireRoute(m: Manifest, routeId: string): Route {
  const route = m.routes.find((r) => r.id === routeId || r.host === routeId);
  if (!route)
    throw new Error(
      `No route "${routeId}". Known routes: ${m.routes.map((r) => r.host).join(", ") || "(none — publish one with system.addRoute)"}.`
    );
  return route;
}

const UpdateRoute = z.object({
  projectId: z.string().optional(),
  routeId: z.string().min(1),
  tls: z.boolean().optional(),
  pathPrefix: z.string().optional(),
});
type UpdateRoute = z.infer<typeof UpdateRoute>;

manifestAction<UpdateRoute>({
  id: "system.updateRoute",
  title: "Update route",
  risk: "medium",
  requiredRole: "editor",
  input: UpdateRoute,
  build(project, input) {
    const next = clone(project.workingManifest);
    const route = requireRoute(next, input.routeId);
    if (input.tls === undefined && input.pathPrefix === undefined)
      throw new Error(
        "Nothing to change — pass tls, pathPrefix, or both. A hostname is an identity, not a setting: publish the new one with system.addRoute and remove this route when you are ready."
      );

    const details: string[] = [];
    const warnings: string[] = [];

    if (input.pathPrefix !== undefined) {
      const prefix = input.pathPrefix.startsWith("/") ? input.pathPrefix : `/${input.pathPrefix}`;
      if (prefix !== route.pathPrefix) {
        if (next.routes.some((r) => r.id !== route.id && r.host === route.host && r.pathPrefix === prefix))
          throw new Error(`${route.host}${prefix} is already published by another route. Pick a different path prefix.`);
        details.push(`${route.host}${route.pathPrefix} stops being served here; ${route.host}${prefix} takes over once this is deployed.`);
        route.pathPrefix = prefix;
      }
    }

    if (input.tls !== undefined && input.tls !== route.tls) {
      route.tls = input.tls;
      if (input.tls)
        details.push(
          route.managedDns
            ? `${route.host} is Zenith.ai-managed, so the certificate is issued and renewed for you.`
            : `${route.host} is your own hostname: the certificate is issued after it resolves to this environment, so point the CNAME before deploying.`
        );
      else
        warnings.push(
          `${route.host} will serve plaintext HTTP. Anything on the network path can read or alter the traffic, including credentials and session cookies.`
        );
    }

    return {
      next,
      what: `Updates route ${route.host}`,
      details,
      warnings,
      data: { routeId: route.id, host: route.host },
    };
  },
});

const RemoveRoute = z.object({
  projectId: z.string().optional(),
  routeId: z.string().min(1),
});
type RemoveRoute = z.infer<typeof RemoveRoute>;

manifestAction<RemoveRoute>({
  id: "system.removeRoute",
  title: "Remove route",
  risk: "medium",
  input: RemoveRoute,
  build(project, input) {
    const next = clone(project.workingManifest);
    const route = requireRoute(next, input.routeId);
    dropBindings(next, route.id);
    next.routes = next.routes.filter((r) => r.id !== route.id);
    return {
      next,
      what: `Unpublishes ${route.host}`,
      warnings: [`${route.host} stops resolving once this is deployed. Anything pointing at it breaks.`],
      data: { routeId: route.id },
    };
  },
});

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
      throw new Error(`"${nodeName(next, toId)}" is a ${target.node.kind}, which is not reached over HTTP. Leave capability unset and Zenith.ai will pick the right one.`);

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

/* --------------------------- env vars and secrets -------------------------- */

const SetEnvVar = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "use letters, digits and underscores, starting with a letter or underscore"),
  /** null removes the variable */
  value: z.string().nullable(),
});
type SetEnvVar = z.infer<typeof SetEnvVar>;

manifestAction<SetEnvVar>({
  id: "system.setEnvVar",
  title: "Set environment variable",
  risk: "low",
  input: SetEnvVar,
  build(project, input) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    if (input.value === null) {
      const doomed = service.env.find((e) => e.key === input.key);
      if (!doomed)
        throw new Error(`${service.name} has no variable "${input.key}". Nothing to remove.`);
      service.env = service.env.filter((e) => e.key !== input.key);
      return {
        next,
        what: `Removes ${input.key} from ${service.name}`,
        // Removing the reference does not remove what it points at. Saying so
        // is the difference between a tidy store and an orphan nobody knows about.
        warnings: doomed.secretRef
          ? [
              `This removes the reference ${doomed.secretRef} from the manifest. Any value stored under it stays in Zenith.ai's secret store — use system.removeSecret to take the reference and the value together, which also checks first that nothing else still reads it.`,
            ]
          : [],
        data: { serviceId: service.id },
      };
    }
    if (SECRET_KEY_RE.test(input.key))
      throw new Error(`"${input.key}" looks like a secret, and manifests are exported, diffed and audited. Use system.setSecret instead — it stores a reference and keeps the value out of the manifest.`);

    const existing = service.env.find((e) => e.key === input.key);
    if (existing) {
      existing.value = input.value;
      delete existing.secretRef;
    } else {
      service.env.push({ key: input.key, value: input.value });
    }
    return { next, what: `Sets ${input.key} on ${service.name}`, data: { serviceId: service.id } };
  },
});


/* --------------------------------- secrets --------------------------------- */

/**
 * Zenith.ai holds secret VALUES, encrypted, in `lib/secrets` — and records only
 * the REFERENCE (`vault:<projectId>/<serviceId>/<KEY>`) in the manifest. So
 * these three actions each touch two places, and every plan says which:
 *
 *   manifest  → the reference, which is diffed, revisioned, audited, exported
 *   store     → the value, which is none of those things
 *
 * Without `ORRERY_SECRET_KEY` there is no store, and a write is refused with
 * the variable's name and how to generate a key. It never half-works: a value
 * is never accepted and dropped, and a plaintext value is never replaced by a
 * reference to nothing.
 *
 * IDENTITY — a generated reference names the service that asked for it, so two
 * services that both read DATABASE_URL get two values, not one shared row that
 * a rotation on either would overwrite. `lib/secrets` owns the shape and the
 * reasoning; the rules THESE actions add on top are:
 *
 *   - an explicit `secretRef` always wins, which is how two services are
 *     deliberately pointed at one value;
 *   - a variable that already reads from Zenith.ai's store keeps the reference it
 *     has — including a legacy bare `vault:<KEY>` — because re-pointing it at
 *     a namespaced reference would leave the stored value behind with nothing
 *     naming it;
 *   - nothing deletes a stored value while anything else still references it.
 */

/** True for references this Zenith.ai is responsible for (as opposed to your Vault). */
const isOurs = isVaultRef;

/**
 * The reference a variable writes to, and where that came from — the plan says
 * so, because "this is scoped to this service" and "this is the reference you
 * asked for" are different promises.
 */
function resolveRef(
  project: Project,
  service: Service,
  key: string,
  explicit: string | undefined
): { ref: string; source: "explicit" | "existing" | "generated" } {
  if (explicit) return { ref: explicit, source: "explicit" };
  const current = service.env.find((e) => e.key === key)?.secretRef;
  // Only inherit one of ours: an external ref (aws:…) is a value Zenith.ai cannot
  // write, so a set-with-value there must still fall through to the default and
  // be refused by name rather than silently retargeted.
  if (current && isOurs(current)) return { ref: current, source: "existing" };
  return { ref: vaultRef(project.id, service.id, key), source: "generated" };
}

/** One variable, somewhere in the workspace, that reads from a reference. */
interface RefConsumer {
  projectId: string;
  /** absent only when a live revision's manifest could not be read */
  serviceId?: string;
  key?: string;
  /** "atlas/api.DATABASE_URL", or the same with "(live in staging)" */
  label: string;
  /** true when this consumer is a deployed revision, not the working copy */
  live: boolean;
}

/** Is this consumer the very variable an action is editing? */
const isSelf = (c: RefConsumer, projectId: string, serviceId: string, key: string): boolean =>
  c.projectId === projectId && c.serviceId === serviceId && c.key === key;

const envHits = (m: Manifest, ref: string) =>
  m.services.flatMap((s) => s.env.filter((e) => e.secretRef === ref).map((e) => ({ s, e })));

/**
 * Everything in this workspace that still points at `ref`. The reverse index
 * the store deliberately does not keep: manifests are the truth about who reads
 * what, so this reads them rather than maintaining a second copy that can drift.
 *
 * Two sources, both honest about a value that is still needed:
 *   - the working manifest of every project in the workspace (the current
 *     project's is supplied by the caller, so an edit in progress counts);
 *   - the manifest of each environment's LIVE revision — a redeploy or a
 *     rollback of what is running reads the value again.
 *
 * Cost: one pass over the working manifests already in memory, plus one cold
 * manifest per deployed environment (bounded by environments, not by history).
 */
function refConsumers(
  ctx: ActionContext,
  ref: string,
  view: { projectId: string; manifest: Manifest }
): RefConsumer[] {
  const out: RefConsumer[] = [];
  const seen = new Set<string>();
  const push = (c: RefConsumer) => {
    if (seen.has(c.label)) return;
    seen.add(c.label);
    out.push(c);
  };

  for (const p of db().projects) {
    if (p.workspaceId !== ctx.workspaceId) continue;
    const working = p.id === view.projectId ? view.manifest : p.workingManifest;
    for (const { s, e } of envHits(working, ref))
      push({
        projectId: p.id,
        serviceId: s.id,
        key: e.key,
        label: `${p.name}/${s.name}.${e.key}`,
        live: false,
      });

    for (const environment of q.environmentsOf(p.id)) {
      const revisionId = environment.deployedRevisionId;
      if (!revisionId) continue;
      let deployed: Manifest | undefined;
      // A missing side file throws rather than pretending the revision is
      // empty. Not knowing is not a reason to delete somebody's credential, so
      // treat it as "cannot rule out a consumer" and say so.
      try {
        deployed = q.revisionManifest(revisionId);
      } catch {
        push({
          projectId: p.id,
          label: `${p.name}/${environment.name} (live revision unreadable)`,
          live: true,
        });
        continue;
      }
      if (!deployed) continue;
      for (const { s, e } of envHits(deployed, ref))
        push({
          projectId: p.id,
          serviceId: s.id,
          key: e.key,
          label: `${p.name}/${s.name}.${e.key} (live in ${environment.name})`,
          live: true,
        });
    }
  }
  return out;
}

/** "a/api.DB_URL, b/worker.DB_URL and 2 more" — a list a person can act on. */
function listConsumers(consumers: RefConsumer[], max = 4): string {
  const shown = consumers.slice(0, max).map((c) => c.label);
  const rest = consumers.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** How a generated reference explains itself, once, in the same words. */
const SCOPED_NOTE =
  "It is scoped to this service, so another service's variable of the same name is a different secret. " +
  "To share one value between services, pass that service's secretRef explicitly instead of letting Zenith.ai generate one.";

/** How a plan describes what the store currently holds at a reference. */
function heldLine(ctx: ActionContext, ref: string): string {
  if (!isOurs(ref))
    return `${ref} is not Zenith.ai's to resolve — your provider reads it at deploy time. Zenith.ai only records the name.`;
  const held = secretStatus(ctx.workspaceId, ref);
  return held.exists
    ? `The store already holds a value for ${ref} (v${held.version}, updated ${held.updatedAt} by ${held.updatedBy}). Applying this points at it; the value itself is unchanged.`
    : `Nothing is stored at ${ref} yet. Add the value in the same step, or with system.rotateSecret, before you deploy — a service whose secret is missing starts without it.`;
}

const REDEPLOY_NOTE =
  "Services already running keep the copy they were given at deploy time. They pick this up on the next deploy, not now.";

const SetSecret = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "use letters, digits and underscores, starting with a letter or underscore"),
  /**
   * The value to store. Named `secretValue` so core's audit redactor masks it
   * by field name — it must never reach the audit log, even on a refusal.
   */
  secretValue: z.string().min(1).optional(),
  /**
   * Where the value lives. Left out, it is Zenith.ai's own store under a
   * reference scoped to this project and service —
   * `vault:<projectId>/<serviceId>/<KEY>` — unless the variable already reads
   * from a reference of Zenith.ai's, which it keeps. Pass one explicitly to point
   * this variable at a value another service already uses.
   */
  secretRef: z.string().min(1).optional(),
  /**
   * Take the plaintext value this key already has, put it in the store, and
   * replace it with the reference — one action, so the value is never briefly
   * nowhere. This is what the "Move to the secret store" security fix runs.
   */
  moveExistingValue: z.boolean().optional(),
});
type SetSecret = z.infer<typeof SetSecret>;

manifestAction<SetSecret>({
  id: "system.setSecret",
  title: "Set secret",
  risk: "low",
  input: SetSecret,
  build(project, input, ctx) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    const { ref, source } = resolveRef(project, service, input.key, input.secretRef);
    /** what dropping secretRef would give you — named in every refusal below */
    const generated = vaultRef(project.id, service.id, input.key);
    const existing = service.env.find((e) => e.key === input.key);
    const plaintext = existing?.value;
    const store = secretStoreState();
    const what = `Stores ${input.key} as a secret on ${service.name}`;

    /** Who else reads this reference once this edit lands — sharing, out loud. */
    const others = (): RefConsumer[] =>
      refConsumers(ctx, ref, { projectId: project.id, manifest: next }).filter(
        (c) => !isSelf(c, project.id, service.id, input.key)
      );

    /** The line that says which reference this is and why it is that one. */
    const refLine = (): string => {
      if (source === "generated")
        return `The reference ${ref} was generated from this project and service. ${SCOPED_NOTE}`;
      if (source === "existing")
        return (
          `${service.name}.${input.key} already reads from ${ref}` +
          `${parseVaultRef(ref)?.legacy ? ", a reference from before Zenith.ai scoped them to one service" : ""}, ` +
          `so that is where this goes — Zenith.ai does not re-point a variable at a new reference, which would leave the value it has behind with nothing naming it.`
        );
      return `${ref} is the reference you named. Anything else pointing at it reads the same value — that is what sharing a secret between services means here.`;
    };

    const point = (): void => {
      if (existing) {
        existing.secretRef = ref;
        delete existing.value;
      } else {
        service.env.push({ key: input.key, secretRef: ref });
      }
    };

    /* Move: the working copy's plaintext becomes the stored value. */
    if (input.moveExistingValue) {
      if (plaintext === undefined)
        return {
          next,
          what,
          blocked:
            `${service.name}.${input.key} has no plaintext value to move${existing ? ` (it already reads from ${existing.secretRef})` : " — there is no such variable"}. ` +
            `Nothing was changed. To store a new value, run this action with the value instead.`,
        };
      if (!isOurs(ref))
        return {
          next,
          what,
          blocked:
            `Zenith.ai can only move a value into its own store, and ${ref} is somewhere else. ` +
            `Drop secretRef to use ${generated}, or copy the value into ${ref} yourself and then point at it.`,
        };
      if (!store.configured)
        return {
          next,
          what,
          blocked:
            `${store.reason} ${service.name}.${input.key} still holds its plaintext value and was left exactly as it is — moving it now would delete the only copy. ${store.fix}`,
        };
      point();
      const shared = others();
      return {
        next,
        what: `Moves ${input.key} on ${service.name} into the secret store`,
        details: [
          `The value moves from the manifest into Zenith.ai's store under ${ref}, encrypted with this server's ORRERY_SECRET_KEY. The manifest keeps only the reference.`,
          refLine(),
          `The store is written first: if that fails, the plaintext stays where it is and nothing is committed.`,
        ],
        warnings: [
          ...(shared.length
            ? [
                `${listConsumers(shared)} also read ${ref}. This writes the value they will get on their next deploy — check that is the credential you mean for all of them.`,
              ]
            : []),
          `Revisions already recorded still contain the plaintext — this cannot change the past. Rotate the credential at its source if it has been exposed.`,
          REDEPLOY_NOTE,
        ],
        apply: () => putSecret(ctx.workspaceId, ref, plaintext, ctx.actor.name),
        data: { serviceId: service.id, secretRef: ref },
      };
    }

    /* A value was supplied: store it, record the reference. */
    if (input.secretValue !== undefined) {
      if (!store.configured)
        return {
          next,
          what,
          blocked:
            `${store.reason} ${store.fix} ` +
            `Nothing was saved, and the value you typed was not written to the manifest, the store or the audit log. ` +
            `Until then you can still record a reference to a value you keep elsewhere: run this action with secretRef and no value.`,
        };
      if (!isOurs(ref))
        return {
          next,
          what,
          blocked:
            `${ref} is not Zenith.ai's store, and Zenith.ai cannot write into someone else's. ` +
            `Drop secretRef to store the value at ${generated}, or put it in ${ref} yourself and run this action with secretRef and no value.`,
        };

      const held = secretStatus(ctx.workspaceId, ref);
      const value = input.secretValue;
      point();
      const shared = others();
      return {
        next,
        what: held.exists ? `Replaces the stored value for ${input.key} on ${service.name}` : what,
        details: [
          `The value is encrypted with AES-256-GCM under this server's ORRERY_SECRET_KEY and written to the secret store as ${ref}${held.exists ? ` (v${held.version} → v${held.version + 1})` : " (v1)"}.`,
          `The manifest records only ${ref}. No value reaches the manifest, the diff, a revision, the audit log or an export bundle.`,
          refLine(),
        ],
        warnings: [
          ...(shared.length
            ? [
                `${listConsumers(shared)} also read ${ref}, so this replaces the value for ${shared.length === 1 ? "it" : "them"} too, at their next deploy. Store it under a reference of its own instead if that is not what you mean.`,
              ]
            : []),
          ...(plaintext !== undefined
            ? [
                `${input.key} currently holds a plaintext value on ${service.name}. Applying this replaces it with the reference — the value you typed is what gets stored, and the old one survives only in revisions already recorded.`,
              ]
            : []),
          REDEPLOY_NOTE,
        ],
        apply: () => putSecret(ctx.workspaceId, ref, value, ctx.actor.name),
        data: { serviceId: service.id, secretRef: ref },
      };
    }

    /* Reference only: point at a value that already exists somewhere. */
    if (plaintext !== undefined)
      return {
        next,
        what,
        blocked:
          `${input.key} currently holds a plaintext value on ${service.name}, and replacing it with ${ref} would delete the only copy in the working manifest. ` +
          (store.configured
            ? `Run this action again with moveExistingValue: true to put that value in Zenith.ai's store and swap in the reference in one step — nothing is lost.`
            : `${store.reason} ${store.fix} Or copy the value into your own secret manager, remove it here with system.setEnvVar (value: null), and then add the reference.`),
      };

    point();
    const shared = others();
    return {
      next,
      what: `Points ${input.key} at the secret ${ref} on ${service.name}`,
      details: [
        `The manifest records only the reference ${ref}. No value is written to the manifest, the diff, the audit log or an export bundle.`,
        refLine(),
        heldLine(ctx, ref),
        ...(shared.length
          ? [
              `${listConsumers(shared)} read the same reference, so ${service.name}.${input.key} shares one value with ${shared.length === 1 ? "it" : "them"} — rotating it changes what they all read.`,
            ]
          : []),
      ],
      data: { serviceId: service.id, secretRef: ref },
    };
  },
});

/* --------------------------- rotate: value only ---------------------------- */

/**
 * Which reference an input names: an explicit one, or the one the service's
 * variable already points at. Throws with the fix when neither resolves.
 */
function requireRef(
  project: Project,
  input: { serviceId?: string; key?: string; secretRef?: string }
): string {
  if (input.secretRef) return input.secretRef;
  if (!input.serviceId || !input.key)
    throw new Error(
      "Say which secret: pass secretRef, or both serviceId and key so Zenith.ai can read the reference off the variable."
    );
  const service = requireService(project.workingManifest, input.serviceId);
  const entry = service.env.find((e) => e.key === input.key);
  if (!entry)
    throw new Error(`${service.name} has no variable "${input.key}". Add it with system.setSecret first.`);
  if (!entry.secretRef)
    throw new Error(
      `${service.name}.${input.key} holds a plaintext value, not a secret reference. Move it into the store with system.setSecret (moveExistingValue: true) before rotating it.`
    );
  return entry.secretRef;
}

const RotateSecret = z.object({
  projectId: z.string().optional(),
  /** name the secret directly… */
  secretRef: z.string().min(1).optional(),
  /** …or name the variable that points at it */
  serviceId: z.string().optional(),
  key: z.string().optional(),
  secretValue: z.string().min(1),
});
type RotateSecret = z.infer<typeof RotateSecret>;

/**
 * A new value under the same reference. The manifest does not change at all —
 * which is the point, and why this is not a manifestAction: there is no diff
 * to preview, so the plan describes the store instead.
 */
defineAction<RotateSecret>({
  id: "system.rotateSecret",
  title: "Rotate secret",
  category: "secrets",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: RotateSecret,
  plan(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    const ref = requireRef(project, input);
    const store = secretStoreState();
    const base = {
      summary: `Replaces the stored value for ${ref}.`,
      details: [] as string[],
      warnings: [] as string[],
      costDeltaUsd: 0,
      risk: "medium" as const,
      requiresApproval: false,
    };

    if (!store.configured) return { ...base, blocked: `${store.reason} ${store.fix}` };
    if (!isOurs(ref))
      return {
        ...base,
        blocked:
          `${ref} is not held by Zenith.ai — it names a value in your own secret manager, which Zenith.ai cannot write to. ` +
          `Rotate it there, then redeploy so the services pick it up.`,
      };
    const held = secretStatus(ctx.workspaceId, ref);
    if (!held.exists)
      return {
        ...base,
        blocked:
          `Nothing is stored at ${ref}, so there is nothing to rotate. ` +
          `Set the first value with system.setSecret on the variable that references it.`,
      };

    // Everything that reads this reference gets the new value. Usually that is
    // one variable — a generated reference names one service — but a shared
    // reference, or a legacy `vault:<KEY>` from before references carried
    // identity, can be several, and a rotation is the moment to say so.
    const readers = refConsumers(ctx, ref, {
      projectId: project.id,
      manifest: project.workingManifest,
    });

    return {
      ...base,
      details: [
        `${ref} goes from v${held.version} to v${held.version + 1}. The new value is encrypted under this server's ORRERY_SECRET_KEY and replaces the old one, which is not recoverable afterwards.`,
        `The manifest, the working copy and every revision are untouched — they hold the reference, never the value.`,
        readers.length <= 1
          ? `${readers.length === 1 ? readers[0].label : "Nothing in this workspace"} reads ${ref}, so nothing else changes.`
          : `${readers.length} variables read ${ref} and all of them get the new value: ${listConsumers(readers)}.`,
      ],
      warnings: [
        ...(readers.length > 1
          ? [
              `${ref} is shared. Rotating it re-credentials ${listConsumers(readers)} together — if only one of them should change, give that one its own reference with system.setSecret first.`,
            ]
          : []),
        REDEPLOY_NOTE,
      ],
    };
  },
  execute(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    const ref = requireRef(project, input);
    const store = secretStoreState();
    if (!store.configured)
      return { ok: false, summary: "The secret was not rotated.", error: `${store.reason} ${store.fix}` };
    if (!isOurs(ref))
      return {
        ok: false,
        summary: "The secret was not rotated.",
        error: `${ref} lives in your own secret manager. Rotate it there, then redeploy.`,
      };
    if (!secretStatus(ctx.workspaceId, ref).exists)
      return {
        ok: false,
        summary: "The secret was not rotated.",
        error: `Nothing is stored at ${ref}. Set the first value with system.setSecret.`,
      };

    const meta = putSecret(ctx.workspaceId, ref, input.secretValue, ctx.actor.name);
    return {
      ok: true,
      summary: `${ref} is now v${meta.version}. ${REDEPLOY_NOTE}`,
      data: { secretRef: ref, version: meta.version },
    };
  },
});

/* ------------------------- remove: reference + value ------------------------ */

const RemoveSecret = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  key: z.string().min(1),
});
type RemoveSecret = z.infer<typeof RemoveSecret>;

manifestAction<RemoveSecret>({
  id: "system.removeSecret",
  title: "Remove secret",
  risk: "medium",
  input: RemoveSecret,
  build(project, input, ctx) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    const entry = service.env.find((e) => e.key === input.key);
    if (!entry)
      throw new Error(
        `${service.name} has no variable "${input.key}". It may already be gone — reload the service to see what it has.`
      );
    if (!entry.secretRef)
      throw new Error(
        `${service.name}.${input.key} is a plain value, not a secret. Remove it with system.setEnvVar (value: null).`
      );

    const ref = entry.secretRef;
    const held = isOurs(ref) ? secretStatus(ctx.workspaceId, ref) : { exists: false as const, ref };
    service.env = service.env.filter((e) => e.key !== input.key);

    /*
     * WHO ELSE STILL NEEDS THIS VALUE.
     *
     * `next` already has this variable removed, so what comes back is exactly
     * who would be left reading the stored value after this edit lands: other
     * services and other projects in the workspace, and the live revisions a
     * rollback would replay. The variable being removed counts only through a
     * live revision — that copy is still deployed and would be read again.
     *
     * Policy when there IS someone left: remove the reference, KEEP the value.
     *
     * Refusing the whole edit was the alternative and it is the worse one. The
     * manifest half is per-service and reversible (every revision has it); the
     * store half is shared and unrecoverable, so those two halves do not
     * deserve the same answer. A refusal would also be theatre: `setEnvVar
     * (value: null)` already drops the same reference and leaves the value, so
     * blocking here would only push people onto a path that says less. What is
     * never allowed is the destructive half — a value another service is still
     * declared to read is not deleted here on any path.
     */
    const remaining = isOurs(ref)
      ? refConsumers(ctx, ref, { projectId: project.id, manifest: next }).filter(
          (c) => c.live || !isSelf(c, project.id, service.id, input.key)
        )
      : [];
    const keepsValue = remaining.length > 0;

    return {
      next,
      what: keepsValue
        ? `Removes ${input.key} from ${service.name} and keeps the value ${remaining.length === 1 ? "its other reader" : "its other readers"} still need`
        : `Removes the secret ${input.key} from ${service.name}`,
      details: [
        `The reference ${ref} is removed from the manifest.`,
        held.exists && keepsValue
          ? `The stored value (v${held.version}) STAYS in Zenith.ai's secret store: ${listConsumers(remaining)} still read ${ref}, and deleting it would take the credential out from under ${remaining.length === 1 ? "it" : "them"} with no copy to restore. It is deleted by whichever removal takes the last reference to it.`
          : held.exists
            ? `Nothing else in this workspace references ${ref}, so the stored value (v${held.version}) is deleted from Zenith.ai's secret store too. It cannot be recovered — Zenith.ai keeps no copy and no backup of it.`
            : isOurs(ref)
              ? `Zenith.ai's store holds no value for ${ref}, so only the reference goes.`
              : `${ref} lives in your own secret manager; Zenith.ai does not touch it. Remove it there if nothing else uses it.`,
      ],
      warnings: [
        `${service.name} loses ${input.key} at the next deploy and will fail at runtime if it still reads it.`,
        `Anything already running keeps the value it was given at deploy time until it is redeployed — removing it here does not pull it out of a live container.`,
        ...(held.exists && keepsValue && remaining.every((c) => c.live)
          ? [
              `The only thing left reading ${ref} is a revision that is still deployed (${listConsumers(remaining)}). The value is kept so a rollback or a redeploy of it still works; to delete it once that revision is gone, point a variable at ${ref} with system.setSecret and remove that.`,
            ]
          : []),
      ],
      apply:
        isOurs(ref) && !keepsValue ? () => void removeStoredSecret(ctx.workspaceId, ref) : undefined,
      data: { serviceId: service.id, secretRef: ref, valueKept: keepsValue },
    };
  },
});
