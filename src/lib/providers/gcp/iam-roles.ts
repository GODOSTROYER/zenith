/**
 * Least-privilege role mapping for `IdentitySpec.grants`.
 *
 * A grant names a target node and portable access verbs. The mapping below is
 * closed: a verb or target kind not listed is a compile error, never a wider
 * role. Every role is a predefined, service-scoped role; primitive roles
 * (`owner`, `editor`, `viewer`) are refused by `assertPredefinedRole`, and no
 * binding is made at project level except where the API has no resource-level
 * IAM (Cloud SQL login, Cloud Logging writes), in which case Cloud SQL
 * bindings carry an IAM condition pinning the exact instance.
 *
 * Accepted verbs (case-insensitive), by target kind:
 *   object_store        read, get, list, download → objectViewer
 *                       write, put, upload, create, update, delete → objectUser
 *   queue, pubsub       publish, send → pubsub.publisher (on the topic)
 *   queue               consume, receive, subscribe, read → pubsub.subscriber (on the subscription)
 *   secret              read, get, access → secretmanager.secretAccessor
 *   postgres            connect, read, write, query, login, read_credentials
 *                       → cloudsql.client + cloudsql.instanceUser
 *                       (conditioned on the instance) and an IAM database user.
 *                       DB-level privileges (GRANT) are NOT created here; they
 *                       need SQL run inside the database.
 *                       read_credentials is the portable SQL-binding verb:
 *                       this driver uses IAM database authentication, so it
 *                       grants the same login access, never secret access.
 *   redis               connect, read, write → no IAM binding exists (Memorystore
 *                       for Redis has no IAM data-plane auth); access is the
 *                       network path (`gcp:firewall_rule`)
 *   container_registry  pull, read → artifactregistry.reader; push, write → artifactregistry.writer
 *   log_group           write, put, publish → logging.logWriter (project level)
 *   container_service   invoke, call, connect → run.invoker (on that service)
 */
import { GcpCompileError } from "./errors";

export const PRIMITIVE_ROLES: ReadonlySet<string> = new Set(["roles/owner", "roles/editor", "roles/viewer"]);

export function assertPredefinedRole(role: string): string {
  if (PRIMITIVE_ROLES.has(role) || !/^roles\/[a-zA-Z]+\.[a-zA-Z.]+$/.test(role)) {
    throw new GcpCompileError("forbidden_role", `Role "${role}" is not an allowed predefined service role.`);
  }
  return role;
}

export type GrantKind = "object_store" | "topic_publish" | "queue_consume" | "secret" | "cloudsql" | "redis" | "registry" | "log_write" | "run_invoke";

const V = (...v: string[]) => new Set(v);

/** verb sets per target kind → grant class and role */
export const VERBS: Record<string, { kind: GrantKind; verbs: Set<string>; role?: string }[]> = {
  object_store: [
    { kind: "object_store", verbs: V("read", "get", "list", "download"), role: "roles/storage.objectViewer" },
    { kind: "object_store", verbs: V("write", "put", "upload", "create", "update", "delete"), role: "roles/storage.objectUser" },
  ],
  queue: [
    { kind: "topic_publish", verbs: V("publish", "send"), role: "roles/pubsub.publisher" },
    { kind: "queue_consume", verbs: V("consume", "receive", "subscribe", "read"), role: "roles/pubsub.subscriber" },
  ],
  pubsub: [{ kind: "topic_publish", verbs: V("publish", "send"), role: "roles/pubsub.publisher" }],
  secret: [{ kind: "secret", verbs: V("read", "get", "access"), role: "roles/secretmanager.secretAccessor" }],
  postgres: [{ kind: "cloudsql", verbs: V("connect", "read", "write", "query", "login", "read_credentials") }],
  redis: [{ kind: "redis", verbs: V("connect", "read", "write") }],
  container_registry: [
    { kind: "registry", verbs: V("pull", "read"), role: "roles/artifactregistry.reader" },
    { kind: "registry", verbs: V("push", "write"), role: "roles/artifactregistry.writer" },
  ],
  log_group: [{ kind: "log_write", verbs: V("write", "put", "publish"), role: "roles/logging.logWriter" }],
  container_service: [{ kind: "run_invoke", verbs: V("invoke", "call", "connect"), role: "roles/run.invoker" }],
};

export interface MappedGrant {
  kind: GrantKind;
  /** predefined role, when the class binds one directly */
  role?: string;
}

/** Map a grant to the closed set of (class, role) bindings it needs. Unknown verbs throw. */
export function mapGrant(targetKind: string, access: readonly string[], where: string): MappedGrant[] {
  const rules = VERBS[targetKind];
  if (!rules) throw new GcpCompileError("unmapped_target", `${where}: grants on a ${targetKind} are not supported on GCP.`);
  if (access.length === 0) throw new GcpCompileError("empty_grant", `${where}: a grant must name at least one verb.`);
  const out = new Map<string, MappedGrant>();
  for (const raw of access) {
    const v = String(raw).trim().toLowerCase();
    const rule = rules.find((r) => r.verbs.has(v));
    if (!rule) throw new GcpCompileError("unmapped_verb", `${where}: access verb "${v.slice(0, 40)}" is not mapped for ${targetKind}; refusing to widen.`);
    const mapped: MappedGrant = { kind: rule.kind, ...(rule.role ? { role: assertPredefinedRole(rule.role) } : {}) };
    out.set(`${mapped.kind}|${mapped.role ?? ""}`, mapped);
  }
  return [...out.values()].sort((a, b) => `${a.kind}${a.role}`.localeCompare(`${b.kind}${b.role}`));
}
