/**
 * The one `ManagedDatabaseProvider` adapter: Neon's public management API v2.
 *
 * EVIDENCE CONTRACT. Shapes below come from Neon's published OpenAPI document
 * (https://neon.com/api_spec/release/v2.json, read 2026-09-30) and were
 * exercised only against a fake HTTP server built from that shape
 * (tests/providers/zenith/neon.test.ts). Nothing here has talked to a real Neon
 * account: the evidence level is `contract`, never `real`. Facts relied on:
 *
 *   base URL        https://console.neon.tech/api/v2   (configurable, https only)
 *   auth            `Authorization: Bearer <API key>`
 *   create          POST /projects  { project: { name, region_id, pg_version,
 *                   org_id?, store_passwords, default_endpoint_settings:
 *                   { autoscaling_limit_min_cu, autoscaling_limit_max_cu },
 *                   branch: { name, role_name, database_name } } }
 *                   → 201 { project, connection_uris:[{ connection_uri,
 *                   connection_parameters }], roles, databases, operations,
 *                   branch, endpoints }
 *   list            GET /projects?search&limit(1..400)&cursor&org_id
 *                   → { projects, pagination?: { cursor }, unavailable_project_ids? }
 *   get / delete    GET|DELETE /projects/{project_id} → { project }
 *                   (a deleted project is recoverable for 7 days per Neon)
 *   connection URI  GET /projects/{id}/connection_uri?database_name&role_name
 *                   → { uri }
 *   compute state   GET /projects/{id}/endpoints → { endpoints: [{ current_state:
 *                   init | active | idle, disabled, ... }] }  (state only is read;
 *                   the endpoint host is never put in a result)
 *   errors          { request_id, code, message } with an HTTP status;
 *                   ~700 requests/minute per account, 429 when exceeded.
 *
 * There is NO idempotency key on project creation. Idempotency is therefore
 * built from a deterministic project NAME (`managedDatabaseName`): `create`
 * searches for it first and converges on the single match. Two concurrent
 * creators can still both miss and both create; the next `create`/`get` then
 * sees two matches and answers `ambiguous` rather than picking one. Callers
 * must serialize create per resource (the operations ledger's lease does), and
 * that is the documented limit, not something hidden here.
 *
 * Secret handling: the API key is resolved from its reference on every call and
 * dropped. The connection URI (which embeds the role password) is read from the
 * create response or the connection_uri endpoint, handed straight to the
 * `ConnectionSecretSink`, and never returned, logged or placed in an error;
 * every error text is scrubbed of the key and of URL credentials.
 *
 * Redirects are refused (`redirect: "error"`) so the bearer key can never be
 * forwarded to another host.
 */
import {
  dbError,
  managedDatabaseConnectionRef,
  managedDatabaseName,
  scrubText,
  type ComputeState,
  type DatabaseCallOptions,
  type DatabaseError,
  type DatabaseProviderDeps,
  type DatabaseResult,
  type DatabaseSize,
  type DatabaseTarget,
  type ManagedDatabaseInfo,
  type ManagedDatabaseProvider,
  type ManagedDatabaseSpec,
} from "./database";
import { isRecord } from "./k8s-port";
import type { ZenithSubstrate } from "./substrate";

type NeonConfig = NonNullable<ZenithSubstrate["database"]>;

/** Compute-unit ranges per portable size. Neon's minimum is 0.25 CU. */
export const NEON_SIZE_CU: Readonly<Record<DatabaseSize, { min: number; max: number }>> = {
  nano: { min: 0.25, max: 0.25 },
  small: { min: 0.25, max: 1 },
  standard: { min: 1, max: 2 },
  performance: { min: 2, max: 4 },
};

export const NEON_DATABASE_NAME = "app";
export const NEON_ROLE_NAME = "app_owner";
export const NEON_BRANCH_NAME = "main";

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY_CHARS = 2_000_000;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 5;
const PG_MIN = 14;
const PG_MAX = 19;

interface NeonProject {
  id: string;
  name: string;
  region_id: string;
  pg_version: number;
  created_at?: string;
  deleted_at?: string;
  history_retention_seconds?: number;
  store_passwords?: boolean;
  provisioner?: string;
}

function asProject(v: unknown): NeonProject | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.id !== "string" || !PROJECT_ID_RE.test(v.id) || typeof v.name !== "string" || typeof v.region_id !== "string") return undefined;
  const pg = typeof v.pg_version === "number" ? v.pg_version : Number.NaN;
  return {
    id: v.id,
    name: v.name,
    region_id: v.region_id,
    pg_version: pg,
    created_at: typeof v.created_at === "string" ? v.created_at : undefined,
    deleted_at: typeof v.deleted_at === "string" ? v.deleted_at : undefined,
    history_retention_seconds: typeof v.history_retention_seconds === "number" ? v.history_retention_seconds : undefined,
    store_passwords: typeof v.store_passwords === "boolean" ? v.store_passwords : undefined,
    provisioner: typeof v.provisioner === "string" ? v.provisioner : undefined,
  };
}

const QUOTA_RE = /limit|quota|exceed/i;

function statusError(status: number, body: unknown, secrets: readonly string[], retryAfterHeader: string | null): DatabaseError {
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
  const rawMessage = isRecord(body) && typeof body.message === "string" ? body.message : `HTTP ${status}`;
  const requestId = isRecord(body) && typeof body.request_id === "string" ? scrubText(body.request_id, secrets, 80) : undefined;
  const message = scrubText(`${code ? `${code}: ` : ""}${rawMessage}`, secrets);
  const base = { status, ...(requestId ? { requestId } : {}) };
  const retryAfter = retryAfterHeader !== null && /^\d{1,5}$/.test(retryAfterHeader.trim()) ? Number(retryAfterHeader.trim()) : undefined;
  if (status === 401) return { code: "unauthorized", message: "The database provider rejected the API key (401). Check the credential behind the configured reference.", retryable: false, ...base };
  if (status === 403) return { code: QUOTA_RE.test(`${code} ${rawMessage}`) ? "quota_exceeded" : "forbidden", message, retryable: false, ...base };
  if (status === 404) return { code: "not_found", message, retryable: false, ...base };
  if (status === 409) return { code: "conflict", message, retryable: false, ...base };
  if (status === 423) return { code: "conflict", message, retryable: true, ...base };
  if (status === 429) return { code: "rate_limited", message, retryable: true, ...base, ...(retryAfter !== undefined ? { retryAfterSec: retryAfter } : {}) };
  if (status === 400 || status === 412 || status === 422) return { code: QUOTA_RE.test(`${code} ${rawMessage}`) ? "quota_exceeded" : "invalid_request", message, retryable: false, ...base };
  if (status >= 500) return { code: "provider_error", message, retryable: true, ...base };
  return { code: "provider_error", message, retryable: false, ...base };
}

function thrownError(e: unknown): { ok: false; error: DatabaseError } {
  const name = e instanceof Error ? e.name : "";
  const causeName = e instanceof Error ? (e as { cause?: { name?: string } }).cause?.name : undefined;
  if (name === "AbortError" || causeName === "AbortError") return dbError("aborted", "The database provider call was aborted.", false);
  if (name === "TimeoutError" || causeName === "TimeoutError") return dbError("timeout", "The database provider did not answer in time.", true);
  if (e instanceof TypeError || (e instanceof Error && (e as { cause?: unknown }).cause !== undefined)) return dbError("unreachable", "Cannot reach the database provider API.", true);
  return dbError("provider_error", "Unexpected error calling the database provider.", false);
}

interface Reply {
  status: number;
  body: unknown;
}

/** The Neon adapter. Everything it needs comes through `deps`; it reads no environment and holds no state. */
export function createNeonProvider(cfg: NeonConfig, deps: DatabaseProviderDeps): ManagedDatabaseProvider {
  const base = cfg.apiBase.replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? 20_000;

  async function request(key: string, method: "GET" | "POST" | "DELETE", path: string, o: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal }): Promise<DatabaseResult<Reply>> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await deps.fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        signal,
        redirect: "error",
      });
    } catch (e) {
      return thrownError(e);
    }
    let text = "";
    try {
      text = await res.text();
    } catch (e) {
      return thrownError(e);
    }
    let body: unknown;
    if (text.length > 0 && text.length <= MAX_BODY_CHARS) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    if (res.status >= 200 && res.status < 300) {
      if (body === undefined) return dbError("provider_error", "The database provider returned a response that is not valid JSON.", false, { status: res.status });
      return { ok: true, value: { status: res.status, body } };
    }
    return { ok: false, error: statusError(res.status, body, [key], res.headers.get("retry-after")) };
  }

  async function withKey<T>(fn: (key: string) => Promise<DatabaseResult<T>>): Promise<DatabaseResult<T>> {
    let key: string | null | undefined;
    try {
      key = await deps.resolveSecret(cfg.apiKeyRef);
    } catch {
      key = undefined;
    }
    if (typeof key !== "string" || key === "") {
      return dbError("unavailable", `The database provider API key could not be resolved from ${cfg.apiKeyRef}. Check that the vault reference exists and is readable by the platform.`, false);
    }
    return fn(key);
  }

  const infoOf = (p: NeonProject, t: Pick<DatabaseTarget, "environmentId" | "address">): ManagedDatabaseInfo => ({
    provider: "neon",
    externalId: p.id,
    name: p.name,
    regionId: p.region_id,
    engineVersion: p.pg_version,
    ...(p.created_at ? { createdAt: p.created_at } : {}),
    connectionSecretRef: managedDatabaseConnectionRef(t.environmentId, t.address),
    settings: {
      ...(p.history_retention_seconds !== undefined ? { historyRetentionSeconds: p.history_retention_seconds } : {}),
      ...(p.provisioner ? { provisioner: p.provisioner } : {}),
    },
  });

  async function findByName(key: string, name: string, signal?: AbortSignal): Promise<DatabaseResult<NeonProject[]>> {
    const matches: NeonProject[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const r = await request(key, "GET", "/projects", { query: { search: name, limit: String(LIST_PAGE_SIZE), org_id: cfg.orgId, cursor }, signal });
      if (!r.ok) return r;
      const body = r.value.body;
      const projects = isRecord(body) && Array.isArray(body.projects) ? body.projects : undefined;
      if (!projects) return dbError("provider_error", "The database provider's project list had an unexpected shape.", false);
      for (const raw of projects) {
        const p = asProject(raw);
        if (p && p.name === name && !p.deleted_at) matches.push(p);
      }
      const next = isRecord(body) && isRecord(body.pagination) && typeof body.pagination.cursor === "string" ? body.pagination.cursor : undefined;
      if (next === undefined || projects.length === 0) return { ok: true, value: matches };
      cursor = next;
    }
    return dbError("provider_error", "The database provider's project list did not finish within the page bound.", false);
  }

  async function computeStateOf(key: string, projectId: string, signal?: AbortSignal): Promise<ComputeState> {
    const r = await request(key, "GET", `/projects/${encodeURIComponent(projectId)}/endpoints`, { signal });
    if (!r.ok) return "unknown";
    const eps = isRecord(r.value.body) && Array.isArray(r.value.body.endpoints) ? r.value.body.endpoints.filter(isRecord) : undefined;
    if (!eps) return "unknown";
    if (eps.length === 0) return "none";
    if (eps.some((e) => e.disabled === true)) return "disabled";
    const states = eps.map((e) => e.current_state);
    if (states.includes("active")) return "active";
    if (states.includes("idle")) return "idle";
    if (states.includes("init")) return "init";
    return "unknown";
  }

  async function connectionUri(key: string, projectId: string, signal?: AbortSignal): Promise<DatabaseResult<string>> {
    const r = await request(key, "GET", `/projects/${encodeURIComponent(projectId)}/connection_uri`, {
      query: { database_name: NEON_DATABASE_NAME, role_name: NEON_ROLE_NAME },
      signal,
    });
    if (!r.ok) return r;
    const uri = isRecord(r.value.body) && typeof r.value.body.uri === "string" ? r.value.body.uri : undefined;
    return validUri(uri) ? { ok: true, value: uri } : dbError("provider_error", "The database provider returned no usable connection URI.", false);
  }

  const validUri = (u: unknown): u is string => typeof u === "string" && u.length <= 2048 && /^postgres(ql)?:\/\//.test(u);

  async function storeUri(ref: string, uri: string): Promise<DatabaseResult<true>> {
    try {
      await deps.sink.put(ref, uri);
      return { ok: true, value: true };
    } catch {
      // the error deliberately carries nothing from the sink: it may echo the value
      return dbError("secret_store_failed", "The database exists but its connection secret could not be stored; retry to converge.", true);
    }
  }

  async function ensureSecret(key: string, p: NeonProject, t: Pick<DatabaseTarget, "environmentId" | "address">, signal?: AbortSignal): Promise<DatabaseResult<true>> {
    const ref = managedDatabaseConnectionRef(t.environmentId, t.address);
    let present = false;
    try {
      present = await deps.sink.exists(ref);
    } catch {
      return dbError("secret_store_failed", "The connection secret store could not be read.", true);
    }
    if (present) return { ok: true, value: true };
    const uri = await connectionUri(key, p.id, signal);
    if (!uri.ok) return uri;
    return storeUri(ref, uri.value);
  }

  return {
    id: "neon",
    availability: () => ({ available: true }),

    connectionSecretRef: (t) => managedDatabaseConnectionRef(t.environmentId, t.address),

    async create(spec: ManagedDatabaseSpec, opts: DatabaseCallOptions = {}) {
      if (!Number.isInteger(spec.engineVersion) || spec.engineVersion < PG_MIN || spec.engineVersion > PG_MAX) {
        return dbError("invalid_request", `Postgres major version ${spec.engineVersion} is outside the provider's supported range (${PG_MIN}-${PG_MAX}).`, false);
      }
      const sizing = NEON_SIZE_CU[spec.size];
      if (!sizing) return dbError("invalid_request", `Unknown database size "${String(spec.size).slice(0, 40)}".`, false);
      const name = managedDatabaseName(spec);
      return withKey<ManagedDatabaseInfo & { created: boolean }>(async (key) => {
        const existing = await findByName(key, name, opts.signal);
        if (!existing.ok) return existing;
        if (existing.value.length > 1) return dbError("ambiguous", `${existing.value.length} provider projects carry the name Zenith derived for this database; refusing to pick one. A concurrent create probably raced: remove the duplicate by hand.`, false);
        if (existing.value.length === 1) {
          const p = existing.value[0];
          const ok = await ensureSecret(key, p, spec, opts.signal);
          if (!ok.ok) return ok;
          return { ok: true, value: { ...infoOf(p, spec), created: false } };
        }
        const res = await request(key, "POST", "/projects", {
          signal: opts.signal,
          body: {
            project: {
              name,
              region_id: cfg.regionId,
              pg_version: spec.engineVersion,
              ...(cfg.orgId ? { org_id: cfg.orgId } : {}),
              store_passwords: true,
              default_endpoint_settings: { autoscaling_limit_min_cu: sizing.min, autoscaling_limit_max_cu: sizing.max },
              branch: { name: NEON_BRANCH_NAME, role_name: NEON_ROLE_NAME, database_name: NEON_DATABASE_NAME },
            },
          },
        });
        if (!res.ok) return res;
        const body = res.value.body;
        const p = isRecord(body) ? asProject(body.project) : undefined;
        if (!p) return dbError("provider_error", "The database provider's create response had no usable project.", false);
        // the project exists from here on; every failure below is retryable and converges on the find-by-name path
        const ref = managedDatabaseConnectionRef(spec.environmentId, spec.address);
        const first = isRecord(body) && Array.isArray(body.connection_uris) && isRecord(body.connection_uris[0]) ? body.connection_uris[0].connection_uri : undefined;
        let uri: string | undefined = validUri(first) ? first : undefined;
        if (uri === undefined) {
          const fetched = await connectionUri(key, p.id, opts.signal);
          if (!fetched.ok) return { ok: false, error: { ...fetched.error, retryable: true } };
          uri = fetched.value;
        }
        const stored = await storeUri(ref, uri);
        uri = undefined;
        if (!stored.ok) return stored;
        return { ok: true, value: { ...infoOf(p, spec), created: true } };
      });
    },

    async get(target: DatabaseTarget, opts: DatabaseCallOptions = {}) {
      const name = managedDatabaseName(target);
      return withKey<ManagedDatabaseInfo | null>(async (key) => {
        if (target.externalId !== undefined) {
          if (!PROJECT_ID_RE.test(target.externalId)) return dbError("invalid_request", "The recorded database id is not a valid provider project id.", false);
          const r = await request(key, "GET", `/projects/${encodeURIComponent(target.externalId)}`, { signal: opts.signal });
          if (!r.ok) return r.error.code === "not_found" ? { ok: true, value: null } : r;
          const p = isRecord(r.value.body) ? asProject(r.value.body.project) : undefined;
          if (!p) return dbError("provider_error", "The database provider's project response had an unexpected shape.", false);
          if (p.deleted_at) return { ok: true, value: null };
          if (p.name !== name) return dbError("conflict", "A provider project with that id exists but is not the database Zenith created for this resource; it is not treated as managed.", false);
          return { ok: true, value: { ...infoOf(p, target), computeState: await computeStateOf(key, p.id, opts.signal) } };
        }
        const found = await findByName(key, name, opts.signal);
        if (!found.ok) return found;
        if (found.value.length > 1) return dbError("ambiguous", `${found.value.length} provider projects carry the name Zenith derived for this database.`, false);
        if (found.value.length === 0) return { ok: true, value: null };
        return { ok: true, value: { ...infoOf(found.value[0], target), computeState: await computeStateOf(key, found.value[0].id, opts.signal) } };
      });
    },

    async delete(target: DatabaseTarget, opts: DatabaseCallOptions = {}) {
      const name = managedDatabaseName(target);
      return withKey<{ deleted: boolean; alreadyAbsent: boolean }>(async (key) => {
        let id = target.externalId;
        if (id !== undefined && !PROJECT_ID_RE.test(id)) return dbError("invalid_request", "The recorded database id is not a valid provider project id.", false);
        if (id === undefined) {
          const found = await findByName(key, name, opts.signal);
          if (!found.ok) return found;
          if (found.value.length > 1) return dbError("ambiguous", `${found.value.length} provider projects carry the name Zenith derived for this database; nothing was deleted.`, false);
          if (found.value.length === 0) return { ok: true, value: { deleted: false, alreadyAbsent: true } };
          id = found.value[0].id;
        } else {
          // never delete by id alone: confirm the project is the one Zenith made for this tuple
          const r = await request(key, "GET", `/projects/${encodeURIComponent(id)}`, { signal: opts.signal });
          if (!r.ok) return r.error.code === "not_found" ? { ok: true, value: { deleted: false, alreadyAbsent: true } } : r;
          const p = isRecord(r.value.body) ? asProject(r.value.body.project) : undefined;
          if (!p) return dbError("provider_error", "The database provider's project response had an unexpected shape.", false);
          if (p.deleted_at) return { ok: true, value: { deleted: false, alreadyAbsent: true } };
          if (p.name !== name) return dbError("conflict", "Refusing to delete: that provider project is not the database Zenith created for this resource.", false);
        }
        const d = await request(key, "DELETE", `/projects/${encodeURIComponent(id)}`, { signal: opts.signal });
        if (!d.ok) return d.error.code === "not_found" ? { ok: true, value: { deleted: false, alreadyAbsent: true } } : d;
        return { ok: true, value: { deleted: true, alreadyAbsent: false } };
      });
    },
  };
}
