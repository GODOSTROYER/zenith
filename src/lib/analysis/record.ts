/**
 * Recording helpers: the only way detectors add datastores, environment
 * variables, health routes and findings to the run, so the rules (names only,
 * defaults only when plainly safe, caps on volume) live in one place.
 */
import type { Ctx } from "./model";
import { RUNTIME_ENV, confidenceRank, isEnvName, isPlainDefault, isSecretName, sanitizeInline } from "./text";
import type { Confidence, DatastoreKind, DatastoreRequirement, Evidence, Language, RepoFinding, RuntimeRequirement } from "./types";

export const ev = (path: string, rule: string, line?: number): Evidence => (line === undefined ? { path, rule } : { path, line, rule });

const MAX_ENV_NAMES = 500;
const MAX_ENV_EVIDENCE = 3;

/* ------------------------------- datastores ------------------------------ */

const SUPPORT: Record<DatastoreKind, { supported: boolean; note?: string }> = {
  postgres: { supported: true },
  redis: { supported: true },
  object_store: { supported: true },
  queue: { supported: true },
  email: { supported: true },
  mysql: {
    supported: false,
    note: "The V1 manifest has no mysql resource kind. Keep MySQL as an external or referenced database, or move to PostgreSQL if the SQL dialect allows.",
  },
  mongodb: {
    supported: false,
    note: "MongoDB is not a V1 resource kind. Use an external managed MongoDB and provide its connection string as a secret.",
  },
  rabbitmq: {
    supported: false,
    note: "RabbitMQ (AMQP) is not a V1 resource kind; V1 queues are SQS-style. Keep an external broker or port the producer/consumer.",
  },
  kafka: {
    supported: false,
    note: "Kafka is not a V1 resource kind. Use an external managed Kafka and provide its bootstrap servers and credentials as secrets.",
  },
  sqlite: {
    supported: false,
    note: "SQLite is a local file and is lost when a container is replaced; V1 has no volumes. Use PostgreSQL for anything that must persist.",
  },
};

export function addDatastore(
  ctx: Ctx,
  root: string,
  kind: DatastoreKind,
  confidence: Confidence,
  evidence: Evidence,
  extra: { engine?: string; role?: DatastoreRequirement["role"] } = {}
): void {
  const sup = SUPPORT[kind];
  const value: DatastoreRequirement = {
    kind,
    supportedInV1: sup.supported,
    root,
    ...(extra.engine ? { engine: extra.engine } : {}),
    ...(extra.role ? { role: extra.role } : {}),
    ...(sup.note ? { note: sup.note } : {}),
  };
  ctx.datastores.add(`${kind}\u0000${root}`, value, confidence, evidence, (old, next) => {
    const role = old.role && next.role && old.role !== next.role ? "both" : (old.role ?? next.role);
    const engine = old.engine ?? next.engine;
    return { ...old, ...(role ? { role } : {}), ...(engine ? { engine } : {}) };
  });
  if (!sup.supported) ctx.risks.add(`Unsupported datastore ${kind} (used under ${root === "" ? "." : root}): ${sup.note}`);
}

/* ------------------------------ environment ------------------------------ */

/**
 * Record that `name` is read under `root`. A default is kept only for a
 * non-secret name and only when it is a short plain literal; two different
 * defaults for one name cancel each other out.
 */
export function addEnv(ctx: Ctx, name: string, root: string, confidence: Confidence, evidence: Evidence, defaultValue?: string): void {
  if (!isEnvName(name) || RUNTIME_ENV.has(name)) return;
  let entry = ctx.envs.get(name);
  if (!entry) {
    if (ctx.envs.size >= MAX_ENV_NAMES) return;
    entry = {
      acc: { name, secret: isSecretName(name), roots: new Set(), defaults: new Set(), conflicted: false },
      evidence: new Map(),
      confidence,
    };
    ctx.envs.set(name, entry);
  }
  entry.acc.roots.add(root);
  if (entry.evidence.size < MAX_ENV_EVIDENCE) entry.evidence.set(`${evidence.path}\u0000${evidence.line ?? 0}\u0000${evidence.rule}`, evidence);
  if (confidence === "high" || (confidence === "medium" && entry.confidence === "low")) entry.confidence = confidence;
  if (defaultValue !== undefined && !entry.acc.secret && isPlainDefault(defaultValue)) {
    entry.acc.defaults.add(defaultValue);
    if (entry.acc.defaults.size > 1) entry.acc.conflicted = true;
  }
}

/* -------------------------------- findings ------------------------------- */

export function addFinding(ctx: Ctx, finding: RepoFinding, evidence: Evidence, confidence: Confidence = "high"): void {
  ctx.findings.add(`${finding.code}\u0000${finding.path}\u0000${finding.detail}`, finding, confidence, evidence);
}

/* -------------------------------- runtimes ------------------------------- */

/** One runtime per (language, root); a version beats no version, higher confidence beats lower. */
export function addRuntime(ctx: Ctx, root: string, language: Language, version: string | undefined, confidence: Confidence, evidence: Evidence): void {
  const clean = version === undefined ? undefined : sanitizeInline(version, 40);
  const value: RuntimeRequirement = { language, root, ...(clean ? { version: clean } : {}) };
  ctx.runtimes.add(`${language}\u0000${root}`, value, confidence, evidence, (old, next, oc, nc) => {
    if (!next.version) return old;
    if (!old.version) return next;
    return confidenceRank(nc) > confidenceRank(oc) ? next : old;
  });
}
