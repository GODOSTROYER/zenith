/**
 * `proposeArchitecture`: AppRequirements + intent -> a V1 Manifest and the
 * reasoning behind it.
 *
 * This is a PROPOSAL for a human or the plan pipeline to review; it decides
 * nothing that needs authority. Specifically it never invents:
 *  - secret values (secret-named variables become `vault:<NAME>` placeholders),
 *  - DNS names (routes use `<service>.example.invalid`, flagged in `unresolved`),
 *  - config values (only a non-secret default literally visible in code is
 *    carried; every other config name is listed for the user to supply).
 * Datastores the V1 manifest cannot express (MySQL, MongoDB, RabbitMQ, Kafka,
 * SQLite) are reported in `unresolved`, not silently mapped to something else.
 * The result is validated with `Manifest.parse` before it is returned.
 *
 * Ids are derived from names (`svc-web`, `res-db`) so the same requirements
 * always produce the same manifest.
 */
import { Manifest, type Binding, type BindingCapability, type EnvVar, type Resource, type ResourceKind, type Route, type Service, type ServiceSize } from "@/lib/domain/types";
import { slugify, uniqueName } from "@/lib/importers/types";
import { confidenceRank, minConfidence, sanitizeInline } from "./text";
import type { AppRequirements, ArchitectureProposal, BuildPlan, Confidence, DatastoreRequirement, Evidence, Inference, MigrationRequirement, PlacementHints, ProposalIntent, ServiceCandidate } from "./types";

const SAFE_PATH = /^[A-Za-z0-9._/@+~-]{1,240}$/;
const SAFE_REF = /^[A-Za-z0-9._/+@~-]{1,200}$/;
const SAFE_HEALTH = /^\/[A-Za-z0-9\-._~/]{0,100}$/;
const SAFE_REGION = /^[a-z0-9][a-z0-9-]{1,30}$/;
const PLATFORM_ENV = new Set(["PORT", "HOST", "NODE_ENV"]);
const MAX_ENV_PER_SERVICE = 200;

const RESOURCE_NAME: Record<ResourceKind, string> = { postgres: "db", redis: "cache", object_store: "storage", queue: "jobs", email: "mail" };
const CAPABILITY: Record<ResourceKind, BindingCapability> = { postgres: "sql", redis: "cache", object_store: "blob", queue: "queue_publish", email: "smtp" };
/** Why a service is bound to a resource, in words the System Map can show on the edge. */
const bindingSentence = (svc: string, res: string, kind: ResourceKind, cap: BindingCapability): string => {
  switch (kind) {
    case "postgres":
      return `${svc} reads and writes relational data in ${res} (${cap})`;
    case "redis":
      return `${svc} uses ${res} as a cache or job store (${cap})`;
    case "object_store":
      return `${svc} stores and serves files in ${res} (${cap})`;
    case "queue":
      return cap === "queue_consume" ? `${svc} receives background jobs from ${res} (${cap})` : `${svc} sends background jobs to ${res} (${cap})`;
    case "email":
      return `${svc} sends email through ${res} (${cap})`;
  }
};

const cite = (e: Evidence | undefined): string => (e ? `${e.path}${e.line ? `:${e.line}` : ""}` : "no location");
const V1_KINDS = new Set<string>(["postgres", "redis", "object_store", "queue", "email"]);

const isAncestor = (ancestor: string, dir: string): boolean => (ancestor === "" ? dir !== "" : dir.startsWith(`${ancestor}/`));

/** Manifest node names are `^[a-z][a-z0-9-]{1,30}$`; `slugify` can leave a trailing dash after truncation. */
const nodeName = (raw: string, fallback: string): string => {
  const s = slugify(raw, fallback).replace(/-+$/g, "");
  return s.length >= 2 ? s : fallback;
};

function sizeFor(kind: "service" | "resource", serviceKind: ServiceCandidate["kind"] | undefined, intent: ProposalIntent): ServiceSize {
  if (intent.environmentClass === "sandbox") return "nano";
  if (serviceKind === "cron" || serviceKind === "static") return "nano";
  if (intent.environmentClass === "production" && intent.availability === "high" && (kind === "resource" || serviceKind === "web")) return "standard";
  return "small";
}

interface ResourcePlan {
  resource: Resource;
  reqs: Inference<DatastoreRequirement>[];
}

export function proposeArchitecture(req: AppRequirements, intent: ProposalIntent): ArchitectureProposal {
  const explanations: string[] = [];
  const unresolved: string[] = [];
  const addUnresolved = (s: string): void => {
    if (!unresolved.includes(s)) unresolved.push(s);
  };
  let confidence: Confidence = "high";
  const lower = (c: Confidence): void => {
    confidence = minConfidence(confidence, c);
  };

  const high = intent.availability === "high";
  const replicasFor = (kind: ServiceCandidate["kind"]): number => (high && (kind === "web" || kind === "worker") ? 2 : 1);

  /* ------------------------------- services ------------------------------- */

  const deployable = req.services.filter((s) => !s.value.inProcess);
  const taken: string[] = [];
  const services: { svc: Service; cand: Inference<ServiceCandidate> }[] = [];
  /** One "no Dockerfile" note per project root, however many services it hosts. */
  const buildNotes = new Map<string, { names: string[]; plan: BuildPlan }>();
  const repo = req.source.repo && /^https:\/\/[A-Za-z0-9._\-/]{1,200}$/.test(req.source.repo) ? req.source.repo : undefined;
  const ref = [req.source.ref, req.source.commit, "main"].find((r): r is string => r !== undefined && SAFE_REF.test(r)) ?? "main";
  if (!repo && deployable.some((s) => !s.value.image)) {
    addUnresolved("The source repository location is not known (an uploaded archive): services use the local path \".\" as their git source. Provide a repository URL or a built image before deploying.");
  }

  for (const cand of deployable) {
    const v = cand.value;
    const name = uniqueName(nodeName(v.name, "app"), taken);
    taken.push(name);
    const build = req.builds.find((b) => b.value.root === v.root);
    const dockerfile = build?.value.strategy === "dockerfile" && build.value.dockerfile && SAFE_PATH.test(build.value.dockerfile) && !build.value.dockerfile.split("/").includes("..") ? build.value.dockerfile : undefined;
    const source: Service["source"] = v.image ? { type: "image", image: sanitizeInline(v.image, 200) } : { type: "git", repo: repo ?? ".", ref, ...(dockerfile ? { dockerfile } : {}) };
    const port = v.kind === "web" ? v.port?.value : undefined;
    const healthPath = v.kind === "web" && v.healthPath && SAFE_HEALTH.test(v.healthPath.value) ? v.healthPath.value : undefined;
    const svc: Service = {
      id: `svc-${name}`,
      name,
      kind: v.kind,
      source,
      size: sizeFor("service", v.kind, intent),
      replicas: replicasFor(v.kind),
      ...(port !== undefined ? { port } : {}),
      ...(healthPath ? { healthPath } : {}),
      ...(v.kind === "cron" && v.schedule ? { schedule: v.schedule.value } : {}),
      env: [],
      ownership: "managed",
    };
    services.push({ svc, cand });

    lower(cand.confidence);
    if (v.kind === "web") lower(v.port?.confidence ?? "low");
    if (build && !v.image) {
      lower(build.confidence);
      if (build.value.strategy === "unknown" || build.value.strategy === "buildpack") {
        const note = buildNotes.get(v.root) ?? { names: [], plan: build.value };
        note.names.push(name);
        buildNotes.set(v.root, note);
      }
    }

    explanations.push(
      `Service ${name} (${v.kind}): ${cand.evidence.length > 0 ? `evidence ${cite(cand.evidence[0])}` : "inferred"}; size ${svc.size} for ${intent.environmentClass}, ${svc.replicas} replica${svc.replicas === 1 ? "" : "s"}${svc.replicas === 2 ? " because high availability was requested" : ""}.`
    );
    if (port !== undefined) explanations.push(`${name} listens on ${port} (${v.port!.confidence} confidence, from ${cite(v.port!.evidence[0])}).`);
    if (v.kind === "web" && !healthPath) addUnresolved(`No health endpoint was found for ${name}: add one (for example /healthz) or accept an unverified deploy.`);
    else if (healthPath) explanations.push(`${name} health check path ${healthPath} (from ${cite(v.healthPath!.evidence[0])}).`);
    if (v.startCommand) explanations.push(`${name} start command is recorded in the requirements (from ${cite(v.startCommand.evidence[0])}, ${v.startCommand.confidence} confidence); the V1 manifest has no start-command field, so it must live in the image (Dockerfile CMD) or the build step.`);
    if (v.kind === "cron" && v.target) explanations.push(`${name} calls ${v.target} on its web service on its schedule.`);
  }

  for (const [root, note] of [...buildNotes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const where = root === "" ? "the repository root" : root;
    const names = note.names.join(", ");
    if (note.plan.strategy === "unknown") addUnresolved(`No Dockerfile and no build recipe could be inferred for ${names} (${where}): add a Dockerfile.`);
    else {
      const steps = [note.plan.installCommand, note.plan.buildCommand].filter((c): c is string => c !== undefined).map((c) => sanitizeInline(c, 60));
      addUnresolved(`${names} (${where}) ${note.names.length === 1 ? "has" : "have"} no Dockerfile; the build would use the inferred ${note.plan.language ?? "language"} recipe (${steps.join("; ")}). Confirm it or add a Dockerfile.`);
    }
  }

  const inProcess = req.services.filter((s) => s.value.inProcess);
  for (const s of inProcess) {
    addUnresolved(`A scheduler runs inside a service process (${cite(s.evidence[0])}); with ${high ? "2 replicas" : "more than one replica"} each job fires once per replica. Move it to a cron service or add leader election.`);
    explanations.push(`In-process scheduler at ${cite(s.evidence[0])} was not made a separate service: it lives inside another service's process.`);
  }
  if (services.length === 0) {
    lower("low");
    addUnresolved("No deployable service was detected, so the manifest is empty.");
  }
  if (services.length > 0 && intent.environmentClass === "production" && !high) explanations.push("Production without high availability: services run one replica, so a single failure is an outage. Ask for availability \"high\" to get two replicas.");

  /* ------------------------------- resources ------------------------------- */

  const resourcePlans = new Map<ResourceKind, ResourcePlan>();
  const dsByKind = new Map<string, Inference<DatastoreRequirement>[]>();
  for (const d of req.datastores) dsByKind.set(d.value.kind, [...(dsByKind.get(d.value.kind) ?? []), d]);
  for (const kind of [...dsByKind.keys()].sort()) {
    const list = dsByKind.get(kind)!;
    const top = list.reduce((a, b) => (confidenceRank(b.confidence) > confidenceRank(a.confidence) ? b : a));
    if (!V1_KINDS.has(kind)) {
      lower("medium");
      const roots = [...new Set(list.map((d) => d.value.root))].sort().map((r) => (r === "" ? "." : r));
      addUnresolved(`${kind} is required (${roots.join(", ")}; evidence ${cite(top.evidence[0])}) but the V1 manifest has no ${kind} resource kind: ${top.value.note ?? "keep it external."}`);
      continue;
    }
    if (top.confidence === "low") {
      addUnresolved(`A ${kind} may be needed (low confidence; evidence ${cite(top.evidence[0])}): confirm before adding it.`);
      continue;
    }
    lower(top.confidence);
    const name = uniqueName(RESOURCE_NAME[kind as ResourceKind], [...taken, ...[...resourcePlans.values()].map((p) => p.resource.name)]);
    const resource: Resource = { id: `res-${name}`, name, kind: kind as ResourceKind, config: {}, size: sizeFor("resource", undefined, intent), ownership: "managed" };
    resourcePlans.set(kind as ResourceKind, { resource, reqs: list });
    const terraform = list.some((d) => d.evidence.some((e) => e.rule.startsWith("terraform:")));
    explanations.push(
      `Managed ${kind} resource ${name}: needed because of ${cite(top.evidence[0])} (${top.confidence} confidence).${terraform ? " The repository's Terraform also declares one; consider marking it referenced instead of provisioning a second." : ""}`
    );
  }
  if (req.datastores.some((d) => d.value.kind === "postgres") && ![...resourcePlans.keys()].includes("postgres")) lower("medium");

  /* ------------------------------- bindings -------------------------------- */

  const bindings: Binding[] = [];
  const addBinding = (from: string, to: string, capability: BindingCapability, note: string): void => {
    const id = `bind-${from.replace(/^(?:svc|rt)-/, "")}-${to.replace(/^(?:svc|res|rt)-/, "")}-${capability}`;
    if (!bindings.some((b) => b.id === id)) bindings.push({ id, from, to, capability, note });
  };
  const serviceRoots = new Set(services.map((s) => s.cand.value.root));
  const inScope = (dataRoot: string, svcRoot: string): boolean => dataRoot === svcRoot || (isAncestor(dataRoot, svcRoot) && !serviceRoots.has(dataRoot));
  const bound = new Set<ResourceKind>();
  for (const [kind, plan] of [...resourcePlans.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const { svc, cand } of services) {
      if (cand.value.kind === "static") continue;
      const reqs = plan.reqs.filter((d) => inScope(d.value.root, cand.value.root));
      if (reqs.length === 0) continue;
      const top = reqs.reduce((a, b) => (confidenceRank(b.confidence) > confidenceRank(a.confidence) ? b : a));
      const roles = new Set(reqs.map((d) => d.value.role).filter((r): r is NonNullable<typeof r> => r !== undefined));
      const capabilities: BindingCapability[] = [];
      if (kind === "queue") {
        const hasWorker = services.some((s) => s.cand.value.root === cand.value.root && s.cand.value.kind === "worker");
        const consumes = roles.has("consume") || roles.has("both");
        const publishes = roles.has("publish") || roles.has("both") || roles.size === 0;
        if (cand.value.kind === "worker") capabilities.push("queue_consume");
        else {
          if (publishes) capabilities.push("queue_publish");
          if (consumes && !hasWorker) capabilities.push("queue_consume");
        }
      } else capabilities.push(CAPABILITY[kind]);
      for (const cap of capabilities) {
        addBinding(svc.id, plan.resource.id, cap, `${bindingSentence(svc.name, plan.resource.name, kind, cap)}; inferred from ${cite(top.evidence[0])}.`);
        bound.add(kind);
      }
    }
    if (!bound.has(kind)) addUnresolved(`${plan.resource.name} (${kind}) was found in the repository but no deployable service was matched to it (evidence ${cite(plan.reqs[0].evidence[0])}): bind it manually.`);
  }

  /* --------------------------------- routes -------------------------------- */

  const routes: Route[] = [];
  for (const { svc, cand } of services) {
    if (cand.value.kind !== "web" && cand.value.kind !== "static") continue;
    const host = `${svc.name}.example.invalid`;
    routes.push({ id: `rt-${svc.name}`, host, pathPrefix: "/", tls: true, managedDns: false });
    addBinding(`rt-${svc.name}`, svc.id, "http", `Public traffic to ${host}${"/"} is routed to ${svc.name}.`);
    addUnresolved(`Public hostname for ${svc.name} is the placeholder ${host}: supply a real DNS name (DNS is not configured by analysis).`);
  }
  for (const { svc, cand } of services) {
    if (cand.value.kind !== "cron" || !cand.value.target) continue;
    const web = services.find((s) => s.cand.value.root === cand.value.root && s.cand.value.kind === "web");
    if (web) addBinding(svc.id, web.svc.id, "http", `${svc.name} calls ${cand.value.target} on ${web.svc.name} on its schedule.`);
  }

  /* ------------------------------ env variables ---------------------------- */

  const envGroups = new Map<string, { names: string[]; secrets: string[]; configWithout: string[] }>();
  for (const { svc, cand } of services) {
    const secrets: string[] = [];
    const configWithout: string[] = [];
    const env: EnvVar[] = [];
    for (const e of req.envVars) {
      const v = e.value;
      if (!v.roots.some((r) => inScope(r, cand.value.root))) continue;
      if (env.length >= MAX_ENV_PER_SERVICE) break;
      if (PLATFORM_ENV.has(v.name)) continue;
      if (v.classification === "secret") {
        env.push({ key: v.name, secretRef: `vault:${v.name}` });
        secrets.push(v.name);
      } else if (v.defaultValue !== undefined) env.push({ key: v.name, value: v.defaultValue });
      else configWithout.push(v.name);
    }
    svc.env = env;
    // services that read the same variables share one note
    const key = JSON.stringify([secrets, configWithout]);
    const group = envGroups.get(key) ?? { names: [], secrets, configWithout };
    group.names.push(svc.name);
    envGroups.set(key, group);
    if (secrets.length > 0) explanations.push(`${svc.name}: ${secrets.length} secret-named variable(s) became vault references (no values); ${env.length - secrets.length} config variable(s) carry a default that is visible in code.`);
  }
  const listNames = (names: string[]): string => `${names.slice(0, 30).join(", ")}${names.length > 30 ? `, +${names.length - 30} more` : ""}`;
  for (const group of envGroups.values()) {
    const who = group.names.join(", ");
    if (group.secrets.length > 0) addUnresolved(`${who} need${group.names.length === 1 ? "s" : ""} ${group.secrets.length} secret value(s) set in the vault: ${listNames(group.secrets)}. Only the names are in the manifest.`);
    if (group.configWithout.length > 0) addUnresolved(`${who} read${group.names.length === 1 ? "s" : ""} ${group.configWithout.length} config variable(s) with no default in code: ${listNames(group.configWithout)}. Provide values if they are needed.`);
  }

  /* ------------------------- migrations, findings, unknowns ----------------- */

  const migrationGroups = new Map<string, Inference<MigrationRequirement>[]>();
  for (const m of req.migrations) {
    if (services.length > 0 && !services.some((s) => inScope(m.value.root, s.cand.value.root))) continue;
    migrationGroups.set(m.value.command, [...(migrationGroups.get(m.value.command) ?? []), m]);
  }
  for (const [command, group] of [...migrationGroups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const tools = [...new Set(group.map((m) => m.value.tool))].sort().join(", ");
    const note = group.find((m) => m.value.note)?.value.note;
    addUnresolved(`Run the migration command \`${sanitizeInline(command, 120)}\` (${tools}; from ${cite(group[0].evidence[0])}) as a release step before traffic. Analysis never runs it.${note ? ` ${sanitizeInline(note, 200)}.` : ""}`);
  }
  for (const f of req.findings) addUnresolved(`Security: ${f.value.detail}`);
  for (const u of req.unknowns) addUnresolved(u);
  if (req.truncated) {
    lower("low");
    addUnresolved("The repository exceeded an intake limit, so requirements may be incomplete.");
  }

  /* ------------------------------ placement hints -------------------------- */

  const placementHints: PlacementHints = {};
  if (intent.provider) placementHints.providerPreference = [sanitizeInline(intent.provider, 30)];
  const regions = (intent.regions ?? []).filter((r) => SAFE_REGION.test(r)).slice(0, 10);
  if ((intent.regions ?? []).length !== regions.length) addUnresolved("Some requested regions were ignored because they are not simple region names.");
  if (regions.length > 0) placementHints.regions = regions;
  if (intent.availability === "high") {
    placementHints.availabilityTarget = 99.95;
    placementHints.tolerateSingleFailure = true;
  } else if (intent.availability === "standard") {
    placementHints.availabilityTarget = 99.5;
    placementHints.tolerateSingleFailure = false;
  }
  if (high) explanations.push("High availability: two replicas for web and worker services, and the placement solver is asked to tolerate the loss of one instance (99.95 is a design target, not an SLA).");

  /* -------------------------------- manifest -------------------------------- */

  const draft = {
    version: 1 as const,
    services: services.map((s) => s.svc),
    resources: [...resourcePlans.values()].map((p) => p.resource).sort((a, b) => (a.id < b.id ? -1 : 1)),
    routes,
    bindings,
  };
  let manifest: Manifest;
  try {
    manifest = Manifest.parse(draft);
  } catch (err) {
    lower("low");
    addUnresolved(`The proposal did not validate against the V1 manifest (${err instanceof Error ? sanitizeInline(err.message, 160) : "unknown error"}); it was replaced with an empty manifest.`);
    manifest = Manifest.parse({ version: 1 });
  }
  return { manifest, explanations, placementHints, confidence, unresolved };
}
