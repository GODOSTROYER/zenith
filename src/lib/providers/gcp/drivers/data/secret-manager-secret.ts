/**
 * `gcp:secret_manager_secret` — a Secret Manager secret CONTAINER. Zenith
 * compiles the secret, never a value: there is no `google_secret_manager_secret_version`
 * in any fragment, so no secret value can be in a manifest, plan or state that
 * Zenith authored.
 *
 * Compile: one `google_secret_manager_secret` replicated to a single
 * user-managed location (the node's region, for data residency), with
 * `version_destroy_ttl = 30d` (a destroyed version is recoverable for 30 days),
 * `deletion_protection` and `deletion_policy = PREVENT` unless
 * `deletionPolicy: allow`.
 *
 * Reading: `observe` reads secret METADATA only (replication, labels) and
 * lists version METADATA (state) with `versions.list`; it never calls
 * `versions.access`, so it cannot return a value. The deploy service account
 * is granted `secretmanager.secrets/versions.add` on these secrets; the
 * workload service accounts get `secretAccessor` (see `gcp:service_account`).
 *
 * Writing a value is `syncSecretValue`: the control plane resolves the value
 * from its vault inside the call (`getValue`), sends it with a CRC32C
 * integrity check to `secrets.addVersion`, and returns only the version id.
 * The value is not placed in any operation input, result, log or error, and
 * the buffer is zeroed afterwards. Idempotency: the secret carries an
 * annotation with the last synced operation id; replaying the same operation
 * is a no-op. (A crash between `addVersion` and the annotation update can
 * leave one extra identical version on retry — at-least-once, never silent
 * loss.)
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { cloudName, labelsMatch, nodeLabels, tfLabel } from "../../naming";
import { contractCapabilities, deletionGuard, managedOnly, nameResolver, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment, safeRegion } from "../../hcl";
import { arr, fetchObject, makeReaders, num, rec, str, tail, type ReadSpec } from "../../read-kit";
import { gcpCall, gcpGet } from "../../rest";
import type { GcpDriverContext } from "../../types";

export const DRIVER_ID = "gcp.secret_manager_secret@1";
const SM = "https://secretmanager.googleapis.com/v1";
const DESTROY_TTL_SEC = 2592000;
export const SYNC_ANNOTATION = "zenith-sync-operation";
const MAX_SECRET_BYTES = 65536;

function desiredAttributes(node: ResourceNode): Record<string, unknown> {
  return { replication: `user_managed:${node.region}`, versionDestroyTtlSeconds: DESTROY_TTL_SEC };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") return dataFragment("google_secret_manager_secret", L, { secret_id: lastSegment(node.externalRef, node.address) });
  safeRegion(ctx.region);
  const guard = deletionGuard(specOf<{ deletionPolicy?: string }>(node));
  return {
    resource: {
      google_secret_manager_secret: {
        [L]: {
          secret_id: cloudName(ctx.namePrefix, node.address, { max: 255 }),
          labels: nodeLabels(ctx.tags, node),
          replication: [{ user_managed: [{ replicas: [{ location: ctx.region }] }] }],
          version_destroy_ttl: `${DESTROY_TTL_SEC}s`,
          deletion_protection: guard.protect,
          deletion_policy: guard.policy,
        },
      },
    },
    output: { [`${L}_secret_id`]: { value: expr(`google_secret_manager_secret.${L}.id`), description: "secret resource name (no value)" } },
    addresses: [`google_secret_manager_secret.${L}`],
  };
}

/* --------------------------------- reading --------------------------------- */

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:secret_manager_secret",
  kind: "secret",
  attributes: ["replication", "versionDestroyTtlSeconds", "hasEnabledVersion"],
  resolve: nameResolver((p) => `projects/${p}/secrets/[A-Za-z0-9_-]{1,255}`, SM, "secret"),
  list: {
    url: (ctx) => `${SM}/projects/${ctx.session.projectId}/secrets?pageSize=100`,
    itemsKey: "secrets",
    labelsOf: (item) => rec(item.labels),
  },
  extract(o) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    const replication = rec(o.replication);
    const replicas = arr(rec(replication.userManaged).replicas).map((r) => str(rec(r).location)).filter((x): x is string => !!x);
    const ttl = str(o.versionDestroyTtl);
    return {
      externalId: name,
      name: tail(name),
      attributes: {
        replication: replicas.length ? `user_managed:${replicas.join(",")}` : replication.automatic ? "automatic" : undefined,
        versionDestroyTtlSeconds: ttl ? num(ttl.replace(/s$/, "")) : undefined,
      },
      native: { createTime: str(o.createTime), rotationConfigured: !!o.rotation, topics: arr(o.topics).length },
    };
  },
  checks(_node, obs) {
    const v = obs.attributes.hasEnabledVersion;
    if (obs.presence !== "present") return [];
    return [
      {
        id: "has_enabled_version",
        description: "the secret has at least one enabled version (a value was synced)",
        passed: v?.state === "known" ? v.value === true : "unknown",
        ...(v?.state === "known" && v.value !== true ? { detail: "the secret container exists but holds no enabled version" } : {}),
      },
    ];
  },
};

const readers = makeReaders(spec, expectedAttributes);

/** Add version metadata (state only) to the observation; never reads a payload. */
const observe: NonNullable<ResourceDriver<GcpSession>["observe"]> = async (ctx, node, externalId) => {
  const obs = await readers.observe(ctx, node, externalId);
  if (obs.presence !== "present" || !obs.externalId) return obs;
  const res = await gcpGet(ctx, `${SM}/${obs.externalId}/versions?pageSize=10&filter=${encodeURIComponent("state:ENABLED")}`);
  const at = ctx.now().toISOString();
  const value =
    res.outcome === "ok"
      ? ({ state: "known", value: arr(res.json.versions).length > 0, observedAt: at } as const)
      : ({ state: "unknown", reason: res.outcome === "inaccessible" ? "access_denied" : "error", detail: res.detail } as const);
  return { ...obs, attributes: { ...obs.attributes, hasEnabledVersion: value } };
};

/* ------------------------------- value sync --------------------------------- */

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC32C (Castagnoli), as Secret Manager's `dataCrc32c`. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC32C_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface SyncSecretInput {
  /** the secret's resource name, when known; else found by Zenith labels */
  externalId?: string;
  /** resolves the value inside this call; never logged, never returned */
  getValue(): Promise<string | Uint8Array>;
}

export interface SyncSecretResult {
  ok: boolean;
  summary: string;
  /** `projects/<p>/secrets/<id>/versions/<n>` — a reference, not a value */
  version?: string;
  changed: boolean;
  requestIds: string[];
}

export async function syncSecretValue(ctx: GcpDriverContext, node: ResourceNode, input: SyncSecretInput): Promise<SyncSecretResult> {
  const fail = (summary: string, requestIds: string[] = []): SyncSecretResult => ({ ok: false, summary, changed: false, requestIds });
  const op = ctx.operationId;
  if (!op || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/.test(op)) return fail("secret sync needs an operation id (≤ 60 characters) so a retry cannot add a second version.");
  const f = await fetchObject(spec, ctx, node, input.externalId);
  if (f.kind === "invalid") return fail(`secret sync: ${f.error}`);
  if (f.kind === "none") return fail(`secret sync: the secret could not be read (${f.outcome}).`);
  if (!labelsMatch(rec(f.obj.labels), nodeLabels(ctx.tags, node))) return fail(`secret sync: refusing; the secret does not carry this environment's Zenith labels for ${node.address}.`);
  const name = str(f.obj.name);
  if (!name) return fail("secret sync: the secret response had no name.");
  const annotations = rec(f.obj.annotations);
  if (annotations[SYNC_ANNOTATION] === op) return { ok: true, summary: "This operation already synced the secret; nothing to do.", changed: false, requestIds: [] };

  let value: string | Uint8Array;
  try {
    value = await input.getValue();
  } catch {
    // the resolver's error text is not trusted to be value-free
    return fail("secret sync: the value could not be resolved from the vault.");
  }
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  try {
    if (bytes.length === 0 || bytes.length > MAX_SECRET_BYTES) return fail(`secret sync: the value must be 1-${MAX_SECRET_BYTES} bytes.`);
    const add = await gcpCall(ctx, "POST", `${SM}/${name}:addVersion`, { payload: { data: bytes.toString("base64"), dataCrc32c: String(crc32c(bytes)) } });
    if (add.outcome !== "ok") return fail(`secret sync: Secret Manager rejected the new version (${add.outcome}${add.detail ? `: ${add.detail}` : ""}).`, add.requestId ? [add.requestId] : []);
    const version = str(add.json.name);
    const requestIds = [add.requestId, version].filter((x): x is string => !!x);
    const mark = await gcpCall(ctx, "PATCH", `${SM}/${name}?updateMask=annotations`, { annotations: { ...annotations, [SYNC_ANNOTATION]: op } });
    if (mark.requestId) requestIds.push(mark.requestId);
    return {
      ok: true,
      summary: mark.outcome === "ok" ? "Added a new secret version." : "Added a new secret version; recording the operation marker failed, so a retry may add another identical version.",
      ...(version ? { version } : {}),
      changed: true,
      requestIds,
    };
  } finally {
    bytes.fill(0);
    if (typeof value !== "string") value.fill(0);
  }
};

export const secretManagerSecretDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "secret",
  nativeType: "gcp:secret_manager_secret",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
