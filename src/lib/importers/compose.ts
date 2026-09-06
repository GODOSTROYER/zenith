/**
 * docker-compose.yml → Zenith.ai manifest.
 *
 * Two passes: classify every compose service as an Zenith.ai service or a
 * managed resource, then wire bindings from depends_on and from env values
 * that name another service. Every compose key we do not translate is
 * reported in `unmapped` with a reason and a fix — nothing is dropped
 * quietly.
 */
import { load } from "js-yaml";
import { id } from "@/lib/domain/types";
import { vaultRef } from "@/lib/secrets/refs";
import type {
  Binding,
  Manifest,
  Resource,
  ResourceKind,
  Service,
  ServiceSource,
} from "@/lib/domain/types";
import {
  emptyReport,
  inferCapability,
  SECRET_KEY_RE,
  slugify,
  uniqueName,
  type ImportReport,
} from "./types";

export interface ComposeImport {
  manifest: Manifest;
  report: ImportReport;
}

/** image name → managed resource kind. First match wins, order matters. */
const RESOURCE_IMAGES: { re: RegExp; kind: ResourceKind; exact: boolean; note: string }[] = [
  { re: /(^|\/)(postgres|postgis|timescale)/i, kind: "postgres", exact: true, note: "PostgreSQL image mapped to a managed Zenith.ai database." },
  { re: /(^|\/)(mysql|mariadb|percona)/i, kind: "postgres", exact: false, note: "Zenith.ai does not manage MySQL yet — mapped to a managed PostgreSQL. Check your SQL dialect before deploying, or keep MySQL in your own cloud and mark it 'referenced'." },
  { re: /(^|\/)(redis|valkey)/i, kind: "redis", exact: true, note: "Redis image mapped to a managed cache." },
  { re: /(^|\/)(minio|localstack|seaweedfs)/i, kind: "object_store", exact: false, note: "S3-compatible container mapped to a managed object store; bucket names are not carried over." },
  { re: /(^|\/)(rabbitmq|nats)/i, kind: "queue", exact: true, note: "Message broker mapped to a managed queue." },
  { re: /(^|\/)(kafka|redpanda|pulsar)/i, kind: "queue", exact: false, note: "Streaming platform mapped to a managed queue — Zenith.ai queues are not a log/streaming substitute. Verify your consumer semantics." },
  { re: /(^|\/)(mailhog|mailpit|maildev|inbucket|mailcatcher)/i, kind: "email", exact: false, note: "Local mail catcher mapped to a managed email sender. In a real environment this delivers mail — point it at a test inbox first." },
];

/** Per-service compose keys we translate. Everything else is reported. */
const HANDLED = new Set(["image", "build", "ports", "environment", "depends_on", "healthcheck"]);
/** A compose entry that became a managed resource translates far less. */
const HANDLED_ON_RESOURCE = new Set(["image", "environment", "depends_on"]);

const IGNORE_REASONS_ON_RESOURCE: Record<string, { reason: string; suggestion: string }> = {
  ports: {
    reason: "Managed resources are reachable only through bindings — Zenith.ai does not publish them on a host port.",
    suggestion: "Bind the services that need it; connection details are injected as env vars.",
  },
  healthcheck: {
    reason: "Zenith.ai health-checks managed resources itself.",
    suggestion: "Nothing to do — health appears in Observe.",
  },
  build: {
    reason: "This entry was imported as a managed resource, so Zenith.ai runs its own build of it.",
    suggestion: "If you meant to run your own image here, change the node to a service after import.",
  },
};

const IGNORE_REASONS: Record<string, { reason: string; suggestion: string }> = {
  volumes: { reason: "Bind mounts and named volumes have no Zenith.ai equivalent — managed resources carry their own storage.", suggestion: "For data, use a managed resource. For code mounts, they are a dev-only convenience and can be deleted." },
  volumes_from: { reason: "Volume sharing between containers is not modelled.", suggestion: "Share data through a managed resource instead." },
  networks: { reason: "Zenith.ai derives connectivity from bindings, not networks — a service can only reach what it is bound to.", suggestion: "Confirm each connection appears as an edge on the System Map; add missing ones with system.bind." },
  env_file: { reason: "The referenced file was not read (only the YAML was provided).", suggestion: "Add the values with system.setEnvVar, and anything sensitive with system.setSecret." },
  command: { reason: "Zenith.ai runs the image's own entrypoint.", suggestion: "Bake the command into your Dockerfile CMD, or keep it in the image you build." },
  entrypoint: { reason: "Zenith.ai runs the image's own entrypoint.", suggestion: "Bake it into your Dockerfile ENTRYPOINT." },
  deploy: { reason: "Compose deploy/placement settings do not map to Zenith.ai sizing.", suggestion: "Set size and replicas on the service in the Inspector — costs update live." },
  restart: { reason: "Zenith.ai restarts failed replicas automatically.", suggestion: "Nothing to do." },
  container_name: { reason: "Instance names are assigned per environment.", suggestion: "Nothing to do." },
  labels: { reason: "Container labels are not part of the Zenith.ai model.", suggestion: "Nothing to do, unless a tool of yours reads them." },
  logging: { reason: "Logs are collected by Zenith.ai and shown in Observe.", suggestion: "Nothing to do." },
  privileged: { reason: "Privileged containers are not supported.", suggestion: "Remove the privilege requirement, or keep this workload in your own cloud." },
  cap_add: { reason: "Extra Linux capabilities are not supported.", suggestion: "Remove the requirement, or run this workload yourself and reference it." },
  extra_hosts: { reason: "Custom host entries are not modelled.", suggestion: "Address other services through their binding-injected URLs." },
  profiles: { reason: "Compose profiles are a local-dev switch.", suggestion: "Use separate Zenith.ai environments instead." },
};

export function importCompose(yamlText: string, projectId?: string): ComposeImport {
  const report = emptyReport();
  const manifest: Manifest = { version: 1, services: [], resources: [], routes: [], bindings: [] };
  const secretProjectId = projectId ?? id();

  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch (err) {
    throw new Error(
      `That file is not valid YAML (${err instanceof Error ? err.message.split("\n")[0] : "parse error"}). Fix the YAML syntax and import again.`
    );
  }
  if (!isRecord(doc)) {
    throw new Error("That file has no top-level compose object. Paste the contents of a docker-compose.yml.");
  }

  const rawServices = isRecord(doc.services) ? doc.services : undefined;
  if (!rawServices || Object.keys(rawServices).length === 0) {
    throw new Error("No `services:` block found. Import a docker-compose.yml that defines at least one service.");
  }

  // top-level keys
  for (const key of Object.keys(doc)) {
    if (key === "services") continue;
    if (key === "version" || key === "name") {
      report.mapped.push({
        source: key,
        result: "not carried over",
        confidence: "exact",
        note: "Compose file metadata; Zenith.ai manifests carry their own version and the project name is set on import.",
      });
    } else if (key === "volumes") {
      report.unmapped.push({ source: "volumes", ...IGNORE_REASONS.volumes });
    } else if (key === "networks") {
      report.unmapped.push({ source: "networks", ...IGNORE_REASONS.networks });
    } else {
      report.unmapped.push({
        source: key,
        reason: `Top-level compose key "${key}" has no Zenith.ai equivalent.`,
        suggestion: "Review it by hand — nothing from it was imported.",
      });
    }
  }

  /* ------------------------- pass 1: classify nodes ------------------------ */

  interface Placed {
    nodeId: string;
    kind: ResourceKind | "service";
    name: string;
  }
  const placed = new Map<string, Placed>(); // compose name -> node
  const taken: string[] = [];

  for (const [composeName, rawValue] of Object.entries(rawServices)) {
    const svc = isRecord(rawValue) ? rawValue : {};
    const name = uniqueName(slugify(composeName, "service"), taken);
    taken.push(name);
    const renamed = name !== composeName ? ` Renamed from "${composeName}" (names are lowercase letters, digits and dashes).` : "";
    const image = typeof svc.image === "string" ? svc.image : undefined;
    const match = image ? RESOURCE_IMAGES.find((r) => r.re.test(image)) : undefined;

    if (match) {
      const resource: Resource = {
        id: id(),
        name,
        kind: match.kind,
        config: versionConfig(image ?? ""),
        size: "small",
        ownership: "managed",
      };
      manifest.resources.push(resource);
      placed.set(composeName, { nodeId: resource.id, kind: match.kind, name });
      report.mapped.push({
        source: `services.${composeName}`,
        result: `resource ${name} (${match.kind})`,
        confidence: match.exact ? "exact" : "assumed",
        note: match.note + renamed,
      });
      if (!match.exact) report.warnings.push(`${composeName}: ${match.note}`);
      continue;
    }

    const ports = portsOf(svc.ports);
    const kind = ports.length > 0 ? "web" : "worker";
    const { source, sourceNote, sourceWarning } = sourceOf(svc, composeName);
    const service: Service = {
      id: id(),
      name,
      kind,
      source,
      size: "small",
      replicas: 1,
      port: ports[0],
      healthPath: healthPathOf(svc.healthcheck),
      env: [],
      ownership: "managed",
    };
    manifest.services.push(service);
    placed.set(composeName, { nodeId: service.id, kind: "service", name });
    report.mapped.push({
      source: `services.${composeName}`,
      result: `service ${name} (${kind})`,
      confidence: "assumed", // the service kind is inferred from ports, never declared

      note:
        (kind === "web"
          ? `Exposes a port, so it was imported as a web service listening on ${ports[0]}.`
          : "Publishes no ports, so it was imported as a background worker.") +
        ` ${sourceNote}` +
        renamed,
    });
    if (sourceWarning) report.warnings.push(sourceWarning);
    if (ports.length > 1) {
      report.unmapped.push({
        source: `services.${composeName}.ports[1..]`,
        reason: `An Zenith.ai service listens on one port; ${ports.length} were declared.`,
        suggestion: `Kept ${ports[0]}. If another port matters, split it into its own service.`,
      });
    }
  }

  /* --------------------- pass 2: env, bindings, leftovers ------------------ */

  const byComposeName = new Map([...placed.entries()].map(([k, v]) => [k, v] as const));
  const seenBinding = new Set<string>();

  const addBinding = (fromId: string, target: Placed, why: string) => {
    const key = `${fromId}->${target.nodeId}`;
    if (seenBinding.has(key)) return;
    seenBinding.add(key);
    const capability = inferCapability(target.kind);
    const from = manifest.services.find((s) => s.id === fromId);
    const binding: Binding = {
      id: id(),
      from: fromId,
      to: target.nodeId,
      capability,
      note: `${from?.name ?? "service"} → ${target.name} (${capability}); inferred from ${why}.`,
    };
    manifest.bindings.push(binding);
    report.mapped.push({
      source: why,
      result: `binding ${from?.name ?? fromId} → ${target.name} (${capability})`,
      confidence: "assumed",
      note: "Connections are inferred; check the edge on the System Map and remove it if it is wrong.",
    });
  };

  for (const [composeName, rawValue] of Object.entries(rawServices)) {
    const svc = isRecord(rawValue) ? rawValue : {};
    const self = placed.get(composeName);
    if (!self) continue;
    const service = manifest.services.find((s) => s.id === self.nodeId);

    // environment
    const envEntries = envOf(svc.environment);
    for (const { key, value } of envEntries) {
      if (!service) {
        report.unmapped.push({
          source: `services.${composeName}.environment.${key}`,
          reason: "Managed resources are configured by Zenith.ai; container env vars are not carried over.",
          suggestion: "If this changed database behaviour, set it in the resource config after import.",
        });
        continue;
      }
      if (value === undefined) {
        report.unmapped.push({
          source: `services.${composeName}.environment.${key}`,
          reason: "The entry has no value — compose would inherit it from your shell.",
          suggestion: `Set it with system.setEnvVar, or system.setSecret if it is sensitive.`,
        });
        continue;
      }
      if (SECRET_KEY_RE.test(key)) {
        const secretRef = vaultRef(secretProjectId, service.id, key);
        service.env.push({ key, secretRef });
        report.mapped.push({
          source: `services.${composeName}.environment.${key}`,
          result: `secret reference ${secretRef} on ${self.name}`,
          confidence: "exact",
          note: "Looks like a secret, so the value was NOT imported — only a reference. Secrets never live in a manifest.",
        });
        report.warnings.push(`${composeName}: ${key} was imported as a secret reference. Set its value with system.setSecret before deploying.`);
      } else {
        service.env.push({ key, value });
        if (/\$\{|\$[A-Z_]/.test(value)) {
          report.warnings.push(`${composeName}: ${key} contains a shell interpolation (${value}) that was imported literally. Replace it with a real value.`);
        }
      }
      // env value naming another compose service implies a connection
      for (const [otherName, other] of byComposeName) {
        if (otherName === composeName) continue;
        if (new RegExp(`(^|[^a-z0-9_-])${escapeRe(otherName)}([^a-z0-9_-]|$)`, "i").test(value)) {
          addBinding(self.nodeId, other, `services.${composeName}.environment.${key}`);
        }
      }
    }

    // depends_on
    for (const dep of dependsOn(svc.depends_on)) {
      const target = placed.get(dep);
      if (!target) {
        report.unmapped.push({
          source: `services.${composeName}.depends_on.${dep}`,
          reason: `"${dep}" is not defined in this compose file.`,
          suggestion: "Add the missing service, or drop the dependency.",
        });
        continue;
      }
      if (!service) {
        report.unmapped.push({
          source: `services.${composeName}.depends_on.${dep}`,
          reason: `${composeName} was imported as a managed resource, and resources do not connect outward.`,
          suggestion: "No action needed — Zenith.ai operates the resource for you.",
        });
        continue;
      }
      addBinding(self.nodeId, target, `services.${composeName}.depends_on`);
    }

    // everything else in this service
    const handled = service ? HANDLED : HANDLED_ON_RESOURCE;
    for (const key of Object.keys(svc)) {
      if (handled.has(key)) continue;
      const known = service
        ? IGNORE_REASONS[key]
        : IGNORE_REASONS_ON_RESOURCE[key] ?? IGNORE_REASONS[key];
      report.unmapped.push({
        source: `services.${composeName}.${key}`,
        reason: known?.reason ?? `Compose key "${key}" has no Zenith.ai equivalent.`,
        suggestion: known?.suggestion ?? "Review it by hand — nothing from it was imported.",
      });
    }
  }

  if (manifest.services.some((s) => s.kind === "web") && manifest.routes.length === 0) {
    const web = manifest.services.find((s) => s.kind === "web")!;
    report.warnings.push(`No public route was created. Add one to publish ${web.name} on a hostname.`);
  }

  return { manifest, report };
}

/* --------------------------------- helpers -------------------------------- */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function versionConfig(image: string): Record<string, string | number | boolean> {
  const tag = image.split(":")[1];
  return tag && /^[\d.]+$/.test(tag) ? { version: tag } : {};
}

function portsOf(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const entry of raw) {
    if (typeof entry === "number") out.push(entry);
    else if (typeof entry === "string") {
      const container = entry.split("/")[0].split(":").pop();
      const n = Number(container);
      if (Number.isInteger(n) && n > 0) out.push(n);
    } else if (isRecord(entry)) {
      const n = Number(entry.target);
      if (Number.isInteger(n) && n > 0) out.push(n);
    }
  }
  return out;
}

function sourceOf(
  svc: Record<string, unknown>,
  composeName: string
): { source: ServiceSource; sourceNote: string; sourceWarning?: string } {
  if (typeof svc.image === "string") {
    return { source: { type: "image", image: svc.image }, sourceNote: `Runs image ${svc.image}.` };
  }
  const build = svc.build;
  const dockerfile = isRecord(build) && typeof build.dockerfile === "string" ? build.dockerfile : undefined;
  const context = typeof build === "string" ? build : isRecord(build) && typeof build.context === "string" ? build.context : ".";
  if (build !== undefined) {
    return {
      source: { type: "git", repo: context, ref: "main", dockerfile },
      sourceNote: `Built from local context "${context}" — that is not a repository Zenith.ai can fetch.`,
      sourceWarning: `${composeName}: set a git repository (or a published image) on this service before deploying; the imported source is the local build context "${context}".`,
    };
  }
  return {
    source: { type: "image", image: `${slugify(composeName)}:latest` },
    sourceNote: "No image or build was declared, so a placeholder image name was used.",
    sourceWarning: `${composeName}: no image or build in the compose file. Set a real image or repository before deploying.`,
  };
}

function healthPathOf(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const test = Array.isArray(raw.test) ? raw.test.join(" ") : typeof raw.test === "string" ? raw.test : "";
  const m = /https?:\/\/[^/\s"']+(\/[^\s"']*)/.exec(test);
  return m?.[1];
}

function envOf(raw: unknown): { key: string; value: string | undefined }[] {
  const out: { key: string; value: string | undefined }[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq === -1) out.push({ key: entry.trim(), value: undefined });
      else out.push({ key: entry.slice(0, eq).trim(), value: entry.slice(eq + 1) });
    }
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      out.push({
        key,
        value: value === null || value === undefined ? undefined : String(value),
      });
    }
  }
  return out.filter((e) => e.key.length > 0);
}

function dependsOn(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((d): d is string => typeof d === "string");
  if (isRecord(raw)) return Object.keys(raw);
  return [];
}
