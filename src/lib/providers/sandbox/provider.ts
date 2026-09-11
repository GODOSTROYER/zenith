/**
 * Sandbox provider — a fully simulated cloud that behaves like a real one.
 *
 * Honesty rule: everything this adapter produces is labeled simulated. The log
 * stream is invented-but-credible Zenith Sandbox output; it never impersonates
 * AWS or any other vendor. Health reported is health computed.
 */
import {
  fnv1a,
  type CloudConnection,
  type Environment,
  type Manifest,
  type Resource,
  type ResourceKind,
  type Route,
  type Service,
  type ServiceSize,
} from "@/lib/domain/types";
import { SIZE_SPECS } from "@/lib/cost/pricing";
import { q } from "@/lib/db/store";
import { expectedAttributes } from "@/lib/drift";
import { secretStatus, secretStoreState } from "@/lib/secrets";
import {
  stepBudgetMs,
  type Discovery,
  type ExportBundle,
  type LiveResource,
  type LiveState,
  type PreflightReport,
  type ProviderAdapter,
  type ProviderPlanStep,
  type StepRuntime,
} from "@/lib/providers/types";

/* --------------------------- deterministic jitter -------------------------- */

/** Stable pseudo-jitter so `planSteps` stays pure across calls. */
function jitter(seed: string, min: number, max: number): number {
  return Math.round(min + ((fnv1a(seed) % 1000) / 1000) * (max - min));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* -------------------------------- secrets --------------------------------- */

/**
 * Resolve each of a service's secret references at release time, and say what
 * happened — by reference, never by value. The sandbox starts no container, so
 * nothing actually receives these; the line says that too, because a log that
 * reads like a real injection is exactly the kind of lie this adapter must not
 * tell. What is real is the lookup: a reference with nothing behind it is
 * reported here, which is the last place before a deploy where that is cheap
 * to notice.
 */
function injectSecrets(rt: StepRuntime, service: Service): void {
  const refs = service.env.filter((e) => e.secretRef !== undefined);
  if (!refs.length) return;

  const workspaceId = q.project(rt.env.projectId)?.workspaceId;
  const store = secretStoreState();
  const missing: string[] = [];

  for (const e of refs) {
    const ref = e.secretRef!;
    if (!ref.startsWith("vault:")) {
      rt.log(`inject ${e.key} ← ${ref} (your secret manager; Zenith does not resolve it)`, "provider");
      continue;
    }
    if (!store.configured || !workspaceId) {
      missing.push(e.key);
      continue;
    }
    const held = secretStatus(workspaceId, ref);
    if (held.exists)
      rt.log(`inject ${e.key} ← ${ref} (v${held.version}, from the Zenith secret store)`, "provider");
    else missing.push(e.key);
  }

  rt.log(
    `${service.name}: secrets are resolved by reference and injected as environment at start — simulated, like the rest of this deployment. The sandbox runs no container, so no value left the server.`,
    "info"
  );

  if (missing.length)
    rt.log(
      `${service.name} has no stored value for ${missing.join(", ")}. ` +
        (store.configured
          ? `Set it on the service's Variables panel (or with system.setSecret) before deploying somewhere real — a service that starts without its credential fails at first use, not at start.`
          : `${store.reason} ${store.fix}`),
      "info"
    );
}

/* --------------------------------- naming --------------------------------- */

/** Pretty (simulated) hostname for a service in an environment. */
export function sandboxHost(env: Environment, service: Service, m: Manifest): string {
  const route = boundRoute(m, service.id);
  if (route) return `${route.tls ? "https" : "http"}://${route.host}${route.pathPrefix === "/" ? "" : route.pathPrefix}`;
  return `https://${service.name}--${env.name}.${env.baseDomain}`;
}

function boundRoute(m: Manifest, serviceId: string): Route | undefined {
  const b = m.bindings.find(
    (x) => x.capability === "http" && x.to === serviceId && m.routes.some((r) => r.id === x.from)
  );
  return b ? m.routes.find((r) => r.id === b.from) : undefined;
}

const exposed = (s: Service) => s.kind === "web" || s.kind === "static";

/* ------------------------------ chaos tracking ----------------------------- */

type ChaosGlobals = typeof globalThis & { __orreryChaosBurned?: Set<string> };

function burned(): Set<string> {
  const g = globalThis as ChaosGlobals;
  if (!g.__orreryChaosBurned) g.__orreryChaosBurned = new Set();
  return g.__orreryChaosBurned;
}

/** `ORRERY_CHAOS` on a service: "fail_once" | "degrade". */
export function chaosFlag(s: Service): string | undefined {
  return s.env.find((e) => e.key === "ORRERY_CHAOS")?.value;
}

/* -------------------------------- planning -------------------------------- */

function planSteps(env: Environment, next: Manifest, previous?: Manifest): ProviderPlanStep[] {
  const steps: ProviderPlanStep[] = [];
  const had = (nodeId: string) =>
    !!previous &&
    [...previous.services, ...previous.resources, ...previous.routes].some((n) => n.id === nodeId);

  steps.push({
    phase: "prepare",
    title: "Resolve the system graph",
    targetId: "",
    estMs: jitter(`resolve:${env.id}`, 700, 1200),
    detail: "sandbox.graph.resolve --validate --lock-revision",
  });

  for (const s of next.services) {
    if (s.ownership !== "managed") continue;
    const what =
      s.source.type === "image" ? `Pull image for ${s.name}` : `Build ${s.name}`;
    steps.push({
      phase: "prepare",
      title: what,
      targetId: s.id,
      estMs: jitter(`build:${s.id}`, 1600, 3000),
      detail:
        s.source.type === "image"
          ? `sandbox.image.pull ref=${s.source.image}`
          : `sandbox.build.run repo=${s.source.type === "git" ? s.source.repo : s.source.blueprint} target=${s.name}`,
    });
  }

  for (const r of next.resources) {
    if (r.ownership !== "managed") {
      steps.push({
        phase: "provision",
        title: `Verify access to referenced ${r.name}`,
        targetId: r.id,
        estMs: jitter(`ref:${r.id}`, 500, 900),
        detail: `sandbox.resource.probe kind=${r.kind} ref=${r.externalRef ?? "unset"}`,
      });
      continue;
    }
    steps.push({
      phase: "provision",
      title: `${had(r.id) ? "Reconcile" : "Provision"} ${r.kind} "${r.name}"`,
      targetId: r.id,
      estMs: jitter(`res:${r.id}`, 1400, 2600),
      detail: `sandbox.resource.apply kind=${r.kind} size=${r.size} name=${r.name}`,
    });
  }

  for (const route of next.routes) {
    steps.push({
      phase: "provision",
      title: route.tls
        ? `Issue certificate for ${route.host}`
        : `Configure edge for ${route.host} (no TLS)`,
      targetId: route.id,
      estMs: jitter(`route:${route.id}`, 900, 1600),
      detail: `sandbox.edge.route host=${route.host} path=${route.pathPrefix} tls=${route.tls}`,
    });
  }

  for (const s of next.services) {
    if (s.ownership !== "managed") continue;
    steps.push({
      phase: "release",
      title: `Release ${s.name} (${s.replicas} × ${s.size})`,
      targetId: s.id,
      estMs: jitter(`rel:${s.id}`, 900, 1700),
      detail: `sandbox.release.rollout service=${s.name} strategy=surge replicas=${s.replicas}`,
    });
  }

  for (const s of next.services) {
    if (s.ownership !== "managed" || !exposed(s)) continue;
    steps.push({
      phase: "verify",
      title: `Health check ${s.name}`,
      targetId: s.id,
      estMs: jitter(`hc:${s.id}`, 600, 1100),
      detail: `sandbox.health.probe service=${s.name} path=${s.healthPath ?? "/"}`,
    });
  }
  steps.push({
    phase: "verify",
    title: "Verify system health",
    targetId: "",
    estMs: jitter(`sys:${env.id}`, 500, 900),
    detail: "sandbox.health.summary --all",
  });

  return steps;
}

/* -------------------------------- execution ------------------------------- */

async function paced(rt: StepRuntime, lines: [string, "info" | "provider"][]): Promise<void> {
  const slice = stepBudgetMs(rt) / Math.max(1, lines.length);
  for (const [line, stream] of lines) {
    await sleep(slice);
    rt.log(line, stream);
  }
}

async function executeStep(rt: StepRuntime): Promise<void> {
  const m = rt.revision.manifest;
  const { step, env } = rt;
  const service = m.services.find((s) => s.id === step.targetId);
  const resource = m.resources.find((r) => r.id === step.targetId);
  const route = m.routes.find((r) => r.id === step.targetId);
  const region = env.region;

  if (step.phase === "prepare" && !service) {
    await paced(rt, [
      [`graph: ${m.services.length} services, ${m.resources.length} resources, ${m.routes.length} routes`, "provider"],
      [`graph: ${m.bindings.length} bindings resolved, no cycles`, "provider"],
      [`revision r${rt.revision.number} locked for ${env.name} (${region})`, "info"],
    ]);
    return;
  }

  if (step.phase === "prepare" && service) {
    const digest = `sha256:${fnv1a(`${service.id}:${rt.revision.id}`).toString(16).padStart(8, "0")}${fnv1a(service.name).toString(16).padStart(8, "0")}`;
    const seed = `${service.id}:${rt.revision.id}`;
    if (service.source.type === "image") {
      const layers = jitter(`layers:${seed}`, 4, 16);
      const cached = jitter(`cached:${seed}`, 0, layers);
      const mb = (jitter(`bytes:${seed}`, 900, 240_000) / 1000).toFixed(1);
      await paced(rt, [
        [`pull ${service.source.image}`, "provider"],
        [`layers: ${cached} cached, ${layers - cached} downloaded (${mb} MB)`, "provider"],
        [`digest ${digest}`, "provider"],
      ]);
    } else {
      const spec = SIZE_SPECS[service.size];
      const total = jitter(`steps:${seed}`, 4, 9);
      await paced(rt, [
        [`builder: sandbox-buildkit v0.14 (${spec.vcpu} vCPU)`, "provider"],
        [`step 1/${total} detect runtime`, "provider"],
        [`step ${Math.max(2, Math.round(total / 2))}/${total} install dependencies`, "provider"],
        [`step ${total}/${total} export image`, "provider"],
        [`digest ${digest}`, "provider"],
      ]);
    }
    rt.log(`Image for ${service.name} is ready.`, "info");
    return;
  }

  if (step.phase === "provision" && resource) {
    const endpoint = `${resource.name}.${env.name}.${env.baseDomain}`;
    if (resource.ownership !== "managed") {
      // No probe happens: the sandbox holds no credentials and contacts
      // nothing. Saying "reachable, credentials valid" here asserted the
      // result of a check that was never performed.
      await paced(rt, [
        [`probe ${resource.kind} ref=${resource.externalRef ?? "unset"} — simulated`, "provider"],
        [
          `no check performed: the sandbox has no credentials for ${resource.name} and contacted nothing`,
          "provider",
        ],
        [`no changes made — referenced resources are never mutated`, "provider"],
      ]);
      rt.log(
        `${resource.name} is referenced, not managed — Zenith reads it and never mutates it.`,
        "info"
      );
      return;
    }
    const port =
      resource.kind === "postgres" ? 5432 : resource.kind === "redis" ? 6379 : 443;
    const attempts = jitter(`attempts:${resource.id}:${rt.deployment.id}`, 1, 3);
    await paced(rt, [
      [`allocate ${resource.kind}/${resource.size} in ${region}`, "provider"],
      [
        attempts === 1
          ? `waiting for endpoint (ready on first attempt)`
          : `waiting for endpoint (ready on attempt ${attempts} of ${attempts})`,
        "provider",
      ],
      [`endpoint ${endpoint}:${port} ready`, "provider"],
      [`snapshot policy: daily, 7 day retention (simulated)`, "provider"],
    ]);
    rt.output({ simulated: true,
      key: `conn:${resource.id}`,
      label: `${resource.name} — ${endpoint}:${port}`,
      value: `${endpoint}:${port}`,
      kind: "connection",
      targetId: resource.id,
    });
    return;
  }

  if (step.phase === "provision" && route) {
    if (route.tls) {
      await paced(rt, [
        [`edge: claim host ${route.host}`, "provider"],
        [`acme: order placed, dns-01 challenge`, "provider"],
        [`acme: certificate issued, 90 day validity (simulated)`, "provider"],
        [`edge: listener :443 → ${route.pathPrefix}`, "provider"],
      ]);
    } else {
      await paced(rt, [
        [`edge: claim host ${route.host}`, "provider"],
        [`edge: listener :80 → ${route.pathPrefix} (plaintext)`, "provider"],
      ]);
      rt.log(
        `${route.host} serves plaintext HTTP. Enable TLS on the route to encrypt traffic.`,
        "info"
      );
    }
    return;
  }

  if (step.phase === "release" && service) {
    const spec = SIZE_SPECS[service.size];
    await paced(rt, [
      [`rollout ${service.name}: surge 1, maxUnavailable 0`, "provider"],
      [
        `scheduling ${service.replicas} replica(s) @ ${spec.vcpu} vCPU / ${spec.memoryMb} MB`,
        "provider",
      ],
    ]);
    injectSecrets(rt, service);
    await paced(rt, [[`replica 1/${Math.max(1, service.replicas)} started`, "provider"]]);

    if (chaosFlag(service) === "fail_once") {
      const key = `${env.id}:${service.id}`;
      if (!burned().has(key)) {
        burned().add(key);
        rt.log(`replica 1 exited (code 1) — restarting`, "provider");
        rt.log(`replica 1 exited (code 1) — CrashLoopBackOff`, "provider");
        throw new Error(
          `${service.name} failed its startup probe: the container exited with code 1 three times in 42s. ` +
            `Last line on stderr: "Error: connect ECONNREFUSED — dependency unreachable". ` +
            `Fix: check ${service.name}'s bindings and env vars on the System Map, then deploy again — or roll back to the previous revision from this deployment.`
        );
      }
      rt.log(`previous failure cleared on retry`, "info");
    }

    if (service.replicas > 1)
      rt.log(`replica ${service.replicas}/${service.replicas} started`, "provider");
    rt.log(`traffic shifted to the new revision`, "provider");

    if (exposed(service)) {
      const host = sandboxHost(env, service, m);
      rt.output({ simulated: true,
        key: `url:${service.id}`,
        label: `${service.name} — ${host}`,
        value: `/preview/${rt.deployment.id}/${service.id}`,
        kind: "url",
        targetId: service.id,
      });
      rt.log(`${service.name} is reachable at ${host} (simulated).`, "info");
    }
    return;
  }

  if (step.phase === "verify" && service) {
    const path = service.healthPath ?? "/";
    const latency = 8 + (fnv1a(`${service.id}:${rt.deployment.id}`) % 90);
    await paced(rt, [
      [`probe GET ${path} → 200 in ${latency}ms`, "provider"],
      [`probe GET ${path} → 200 in ${latency + 3}ms`, "provider"],
      [
        `${Math.max(1, service.replicas)}/${Math.max(1, service.replicas)} replicas ready`,
        "provider",
      ],
    ]);
    if (chaosFlag(service) === "degrade")
      rt.log(
        `${service.name} is reporting degraded: one replica is failing its probe. Restart the service or scale it up on the Observe page.`,
        "info"
      );
    return;
  }

  // verify, whole system
  const ready = m.services.filter((s) => s.ownership === "managed").length;
  await paced(rt, [
    [`summary: ${ready} service(s) ready, ${m.resources.length} resource(s) healthy`, "provider"],
    [`edge: ${m.routes.length} route(s) serving`, "provider"],
  ]);
  rt.log(`Simulated deployment complete — this is the Zenith Sandbox, not real cloud infrastructure.`, "info");
}

/* --------------------------------- export --------------------------------- */

function exportBundle(env: Environment, manifest: Manifest): ExportBundle {
  const services = manifest.services
    .map((s) => {
      const image =
        s.source.type === "image" ? s.source.image : `${s.name}:local`;
      const spec = SIZE_SPECS[s.size];
      const envLines = s.env
        .filter((e) => e.value !== undefined)
        .map((e) => `      ${e.key}: "${e.value}"`);
      const secretLines = s.env
        .filter((e) => e.secretRef !== undefined)
        .map((e) => `      ${e.key}: "\${${e.key}}" # from secret ${e.secretRef}`);
      const ports = s.port ? `    ports:\n      - "${s.port}:${s.port}"\n` : "";
      const build =
        s.source.type === "git"
          ? `    build:\n      context: ${s.source.repo}\n`
          : "";
      const envBlock =
        envLines.length + secretLines.length
          ? `    environment:\n${[...envLines, ...secretLines].join("\n")}\n`
          : "";
      return `  ${s.name}:\n    image: ${image}\n${build}${ports}${envBlock}    deploy:\n      replicas: ${s.replicas}\n      resources:\n        limits:\n          cpus: "${spec.vcpu}"\n          memory: ${spec.memoryMb}M\n`;
    })
    .join("");

  const resources = manifest.resources
    .filter((r) => r.ownership === "managed")
    .map((r) => {
      const images: Record<string, string> = {
        postgres: "postgres:16-alpine",
        redis: "redis:7-alpine",
        object_store: "minio/minio:latest",
        queue: "redis:7-alpine",
        email: "axllent/mailpit:latest",
      };
      return `  ${r.name}:\n    image: ${images[r.kind]}\n    restart: unless-stopped\n`;
    })
    .join("");

  return {
    files: [
      {
        path: "docker-compose.yml",
        content: `# Generated by Zenith from ${env.name} — a local stand-in for the sandbox.\nservices:\n${services}${resources}`,
      },
      { path: "orrery.manifest.json", content: JSON.stringify(manifest, null, 2) },
    ],
    readme: `# Sandbox export — ${env.name}

The sandbox is **simulated**. Nothing was provisioned in a real cloud, so
there is no infrastructure state to hand over. What this bundle gives you is
the system itself, in two portable forms:

- \`orrery.manifest.json\` — the canonical Zenith model. Every service,
  resource, route and binding, exactly as the System Map shows it.
- \`docker-compose.yml\` — a runnable local approximation, so you can bring the
  same topology up on your laptop with \`docker compose up\`.

To get real infrastructure-as-code, point the environment at the AWS provider
and export again: that bundle is genuine Terraform you can \`terraform apply\`
with your own credentials, with or without Zenith.
`,
  };
}

/* ---------------------------- observe / discover --------------------------- */

const SIZES: ServiceSize[] = ["nano", "small", "standard", "performance"];

/** Stable pick from a list — the same environment always drifts the same way. */
function pick<T>(xs: T[], seed: string): T | undefined {
  return xs.length ? xs[fnv1a(seed) % xs.length] : undefined;
}

/** A value that plainly differs from the manifest's, without pretending to be data. */
function driftedValue(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== "" ? String(n + 1) : `${v}-changed-outside-orrery`;
}

/**
 * Simulated read-back.
 *
 * Everything managed is reported present with exactly the attributes the
 * deployed revision asks for, then two seeded differences are introduced — one
 * resource a size up, one plain env var altered — so the Drift screen has
 * something true-to-shape to render. It is a demonstration of what drift looks
 * like, not a measurement: `simulated: true` says so on the wire, and the UI
 * repeats it in words.
 *
 * Deterministic: same environment and same revision, same drift, every call.
 */
async function observe(env: Environment, deployed: Manifest): Promise<LiveState> {
  const observedAt = new Date().toISOString();
  const managedResources = deployed.resources.filter((r) => r.ownership === "managed");
  const managedServices = deployed.services.filter((s) => s.ownership === "managed");

  const sizeVictim = pick(managedResources, `${env.id}:size`);
  const envVictim = pick(
    managedServices.filter((s) => s.env.some((e) => e.value !== undefined)),
    `${env.id}:env`
  );
  const envKey = envVictim
    ? pick(
        envVictim.env.filter((e) => e.value !== undefined).map((e) => e.key),
        `${env.id}:${envVictim.id}:key`
      )
    : undefined;

  const report = (node: Resource | Service, kind: string): LiveResource => {
    const attributes = expectedAttributes(node);
    if (sizeVictim && node.id === sizeVictim.id)
      attributes.size = SIZES[(SIZES.indexOf(node.size) + 1) % SIZES.length];
    if (envVictim && envKey && node.id === envVictim.id)
      attributes[`env:${envKey}`] = driftedValue(String(attributes[`env:${envKey}`] ?? ""));
    return { nodeId: node.id, kind, exists: true, attributes, observedAt };
  };

  return {
    simulated: true,
    observedAt,
    resources: [
      ...managedServices.map((s) => report(s, s.kind)),
      ...managedResources.map((r) => report(r, r.kind)),
    ],
  };
}

/** Shape of the invented findings. Named so they cannot be mistaken for real. */
const SIMULATED_FINDS: { kind: ResourceKind; base: string; note: string }[] = [
  { kind: "object_store", base: "legacy-uploads", note: "bucket, unmanaged" },
  { kind: "queue", base: "billing-events", note: "queue, unmanaged" },
  { kind: "postgres", base: "reporting-replica", note: "database, unmanaged" },
];

/**
 * A small, stable, invented set. `simulated: true` and the `sim://` prefix on
 * every `externalRef` mean an imported reference stays legible as a simulation
 * for anyone who later reads the manifest.
 */
async function discover(conn: CloudConnection, region?: string): Promise<Discovery> {
  const where = region ?? conn.region;
  const tag = fnv1a(`${conn.id}:${where}`).toString(36).slice(0, 5);
  return {
    simulated: true,
    resources: SIMULATED_FINDS.map((f) => ({
      externalRef: `sim://${where}/${f.kind}/${f.base}-${tag}`,
      kind: f.kind,
      name: `${f.base}-${tag}`,
      attributes: { region: where, detail: f.note, simulated: "yes" },
    })),
  };
}

/* -------------------------------- adapter --------------------------------- */

export const sandboxProvider: ProviderAdapter = {
  id: "sandbox",
  displayName: "Zenith Sandbox",
  availability: "available",
  tagline:
    "Simulated cloud. Deploys run end-to-end in seconds with real timings and logs, but nothing is provisioned anywhere.",
  regions: [
    { id: "sim-a", label: "Simulated region A" },
    { id: "sim-b", label: "Simulated region B" },
  ],

  accessExplanation: () => ({
    summary:
      "The sandbox runs entirely inside Zenith. It never touches a cloud account and needs no credentials.",
    permissions: ["No cloud access requested", "No credentials stored"],
  }),

  async preflight(_conn: CloudConnection): Promise<PreflightReport> {
    return {
      ok: true,
      checks: [
        {
          id: "sandbox.reachable",
          label: "Sandbox scheduler reachable",
          status: "pass",
          detail: "In-process simulator, always available.",
        },
        {
          id: "sandbox.simulated",
          label: "Deployments are simulated",
          status: "warn",
          detail: "Nothing is provisioned in a real cloud account.",
          fix: "Connect AWS to generate real Terraform for the same system.",
        },
      ],
      permissions: ["No cloud access requested"],
    };
  },

  planSteps,
  executeStep,
  observe,
  discover,
  exportBundle,
};
