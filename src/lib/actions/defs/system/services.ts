/**
 * system.addService / updateService / removeService. Split out of the
 * single-file module; the code is unchanged.
 */
import { z } from "zod";
import {
  id,
  ServiceKind,
  ServiceSize,
  type Service,
  type ServiceSource,
} from "@/lib/domain/types";
import { slugify, uniqueName } from "@/lib/importers/types";
import {
  clone,
  requireService,
} from "../_shared";
import { dropBindings, manifestAction, takenNames } from "./shared";
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
      warnings.push(`No image or repository given, so ${name} points at the Zenith sample image (${PLACEHOLDER_IMAGE}). Set a real source with system.updateService before deploying anything you care about.`);
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
