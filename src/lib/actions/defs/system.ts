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
  build(project: Project, input: I): Built;
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
      const built = def.build(project, input);
      return planFromDiff(project.workingManifest, built.next, built.what, {
        details: built.details,
        warnings: built.warnings,
      });
    },
    execute(ctx: ActionContext, input: I): ActionResult {
      const project = requireProject(ctx, input.projectId);
      const before = clone(project.workingManifest);
      const built = def.build(project, input);
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
      warnings.push(`No image or repository given, so ${name} points at the Orrery sample image (${PLACEHOLDER_IMAGE}). Set a real source with system.updateService before deploying anything you care about.`);
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
  name: z.string().optional(),
  kind: ServiceKind.optional(),
  size: ServiceSize.optional(),
  replicas: z.number().int().min(0).max(10).optional(),
  port: z.number().int().min(1).max(65535).optional(),
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
    if (input.port !== undefined) service.port = input.port;
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
      throw new Error("A referenced resource needs the identifier it already has in your cloud. Pass externalRef (e.g. aws_db_instance.main), or leave ownership as 'managed' to let Orrery provision it.");

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
      details.push(`Marked "${ownership}": Orrery reads it and binds to it, but never provisions or deletes it — and it does not appear in the Orrery cost estimate.`);

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
    if (managedDns) details.push(`${host} is an Orrery-managed hostname — DNS and the TLS certificate are handled for you.`);
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
            ? `${route.host} is Orrery-managed, so the certificate is issued and renewed for you.`
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
    if (existing)
      return {
        next,
        what: `${nodeName(next, fromId)} is already connected to ${nodeName(next, toId)}`,
        details: [`Nothing to change — the ${existing.capability} connection already exists.`],
        data: { bindingId: existing.id },
      };

    const target = findNode(next, toId);
    if (!target) throw new Error(`Routes cannot be a connection target. Bind a route to a service instead (from: the route, to: the service).`);
    const isRoute = next.routes.some((r) => r.id === fromId);
    const capability = input.capability ?? (isRoute ? "http" : inferCapability(target.type === "resource" ? target.node.kind : "service"));

    if (isRoute && capability !== "http")
      throw new Error("A route can only serve HTTP. Leave capability unset, or use 'http'.");
    if (isRoute && target.type !== "service")
      throw new Error(`A route must point at a service. "${nodeName(next, toId)}" is a resource — put a service in front of it.`);
    if (target.type === "resource" && capability === "http")
      throw new Error(`"${nodeName(next, toId)}" is a ${target.node.kind}, which is not reached over HTTP. Leave capability unset and Orrery will pick the right one.`);

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
      if (!service.env.some((e) => e.key === input.key))
        throw new Error(`${service.name} has no variable "${input.key}". Nothing to remove.`);
      service.env = service.env.filter((e) => e.key !== input.key);
      return { next, what: `Removes ${input.key} from ${service.name}`, data: { serviceId: service.id } };
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

const SetSecret = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "use letters, digits and underscores, starting with a letter or underscore"),
  /**
   * Accepted so one call can carry the value the UI collected, and
   * deliberately never persisted. The field is named `secretValue` on
   * purpose: core's audit redactor redacts by field name, so this never
   * reaches the audit log either.
   */
  secretValue: z.string().optional(),
});
type SetSecret = z.infer<typeof SetSecret>;

manifestAction<SetSecret>({
  id: "system.setSecret",
  title: "Set secret",
  risk: "low",
  input: SetSecret,
  build(project, input) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    const secretRef = `vault:${input.key}`;
    const existing = service.env.find((e) => e.key === input.key);
    if (existing) {
      existing.secretRef = secretRef;
      delete existing.value;
    } else {
      service.env.push({ key: input.key, secretRef });
    }
    return {
      next,
      what: `Stores ${input.key} as a secret on ${service.name}`,
      details: [
        `The manifest records only the reference ${secretRef}. The value is never written to the manifest, the diff, the audit log or an export bundle.`,
      ],
      data: { serviceId: service.id, secretRef },
    };
  },
});
