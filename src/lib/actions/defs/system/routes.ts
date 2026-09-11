/**
 * system.addRoute / updateRoute / removeRoute. Split out of the single-file
 * module; the code is unchanged.
 */
import { z } from "zod";
import {
  id,
  type Manifest,
  type Route,
} from "@/lib/domain/types";
import {
  clone,
  requireService,
} from "../_shared";
import { dropBindings, manifestAction } from "./shared";
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
    const host = input.host ?? `app.${project.slug}.zenith.app`;
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
    if (managedDns) details.push(`${host} is a Zenith-managed hostname — DNS and the TLS certificate are handled for you.`);
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
            ? `${route.host} is Zenith-managed, so the certificate is issued and renewed for you.`
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
