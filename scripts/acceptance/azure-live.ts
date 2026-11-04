/**
 * Azure live acceptance harness (PROD-LIFE-04). PUBLIC AZURE ONLY.
 *
 * Nothing here runs by itself and nothing counts as passed unless a real Azure
 * subscription answered. The harness refuses to start unless ALL of these hold:
 *
 *   ZENITH_LIVE_AZURE=1                      explicit opt in
 *   ZENITH_LIVE_AZURE_CRED_FILE=<path>       a JSON FILE (never inline credentials) naming
 *                                            { tenantId, clientId, subscriptionId, region,
 *                                              assertionFile, dataPlane? }
 *   `assertionFile` is a file holding a fresh Zenith/Entra federated client assertion; it is
 *   re-read for every token exchange, so an operator or a sidecar can refresh it.
 *
 *   ZENITH_LIVE_AZURE_ALLOW_BUILD=1          additionally required for the one MUTATING check
 *                                            (an ACR Tasks source build that pushes one tag to
 *                                            the named registry).
 *
 * The cloud must be the public cloud: sovereign clouds (usgov, china) are contract-level
 * only and are refused here with a reason, never skipped silently as "passed".
 *
 * Output is a list of checks with status `passed_live`, `failed` or `skipped` (with a
 * reason). Any skipped check makes the verdict `incomplete`; a run with no live pass is
 * never `passed`. Credential values are never printed: the assertion and tokens stay
 * inside the AzureSession closure.
 *
 * Usage: npx tsx scripts/acceptance/azure-live.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { AzureConnectionConfig, AzureSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import { createAzureSession } from "@/lib/providers/azure/credentials";
import { armClient, safeText, sendJson, ArmError } from "@/lib/providers/azure/arm";
import { azureCloud } from "@/lib/providers/azure/cloud";
import { API } from "@/lib/providers/azure/platform";
import { awaitDataPlaneAccess, findRoleAssignment, DataPlanePropagationTimeoutError } from "@/lib/providers/azure/data-plane-rbac";
import { scheduleBuild } from "@/lib/providers/azure/release/acr-task";

export type LiveStatus = "passed_live" | "failed" | "skipped";
export interface LiveCheck { id: string; status: LiveStatus; detail: string }
export interface LiveReport { verdict: "passed" | "failed" | "incomplete" | "not_run"; checks: LiveCheck[] }

export interface AzureLiveDataPlane {
  /** ARM id of a storage account of the subscription and a container the identity should read (Storage Blob Data Reader or better) */
  storageAccountResourceId?: string;
  container?: string;
  /** Key Vault name whose secret METADATA the identity should list (Key Vault Secrets User or better) */
  keyVault?: string;
  /** object id of the identity, plus the resource scope and role whose exact assignment should be present */
  principalId?: string;
  roleScopeId?: string;
  roleName?: string;
  /** ACR to build into (needs ZENITH_LIVE_AZURE_ALLOW_BUILD=1) */
  registryId?: string;
  loginServer?: string;
  repository?: string;
}

export interface AzureLiveConfig {
  connection: AzureConnectionConfig;
  assertionFile: string;
  dataPlane: AzureLiveDataPlane;
  allowBuild: boolean;
}

export class AzureLiveConfigError extends Error {
  readonly code = "azure_live_config_invalid";
  constructor(message: string) {
    super(message);
    this.name = "AzureLiveConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the gate and the credential FILE. Returns `undefined` plus a reason when the harness must not run. */
export function loadAzureLiveConfig(env: Env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): { config?: AzureLiveConfig; skipReason?: string } {
  if (env.ZENITH_LIVE_AZURE !== "1") return { skipReason: "ZENITH_LIVE_AZURE=1 is not set; live Azure acceptance was not requested." };
  const credFile = env.ZENITH_LIVE_AZURE_CRED_FILE;
  if (!credFile) return { skipReason: "ZENITH_LIVE_AZURE_CRED_FILE (a path to a credential JSON file) is not set." };
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(credFile));
  } catch {
    throw new AzureLiveConfigError("ZENITH_LIVE_AZURE_CRED_FILE could not be read as JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new AzureLiveConfigError("The credential file must hold a JSON object.");
  const f = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = f[k];
    if (typeof v !== "string" || !v) throw new AzureLiveConfigError(`The credential file needs a string "${k}".`);
    return v;
  };
  for (const k of ["tenantId", "clientId", "subscriptionId"]) if (!GUID.test(str(k))) throw new AzureLiveConfigError(`"${k}" must be a GUID.`);
  if (f.cloud !== undefined && f.cloud !== "public") throw new AzureLiveConfigError("Live acceptance is public Azure only; sovereign clouds are contract-level and are never run live.");
  if (!/^[a-z0-9]{2,40}$/.test(str("region"))) throw new AzureLiveConfigError('"region" must be an Azure region name.');
  const dp = f.dataPlane === undefined ? {} : (f.dataPlane as AzureLiveDataPlane);
  if (dp === null || typeof dp !== "object" || Array.isArray(dp)) throw new AzureLiveConfigError('"dataPlane" must be an object.');
  return {
    config: {
      connection: { provider: "azure", mode: "oidc_web_identity", tenantId: str("tenantId"), clientId: str("clientId"), subscriptionId: str("subscriptionId"), region: str("region") },
      assertionFile: str("assertionFile"),
      dataPlane: dp,
      allowBuild: env.ZENITH_LIVE_AZURE_ALLOW_BUILD === "1",
    },
  };
}

/* ------------------------------ tiny tar.gz writer ------------------------------ */

/** A one-file ustar archive (gzip-compressed): enough for an ACR Tasks source upload, no dependency. */
export function tarGz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

/* ----------------------------------- checks ----------------------------------- */

export interface AzureLiveDeps {
  readFile?: (path: string) => string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

export async function runAzureLive(config: AzureLiveConfig, deps: AzureLiveDeps = {}): Promise<LiveReport> {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const log = deps.log ?? (() => undefined);
  const checks: LiveCheck[] = [];
  const record = (id: string, status: LiveStatus, detail: string): void => {
    checks.push({ id, status, detail: safeText(detail, 300) });
    log(`${status.padEnd(11)} ${id}: ${safeText(detail, 200)}`);
  };
  const cloud = azureCloud(config.connection.cloud);
  const dp0 = config.dataPlane;
  let session: AzureSession;
  try {
    session = await createAzureSession({
      connection: config.connection,
      purpose: "deploy",
      mintClientAssertion: async () => readFile(config.assertionFile).trim(),
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      durationSec: 1800,
      ...(dp0.storageAccountResourceId && dp0.container ? { sourceStorage: { accountResourceId: dp0.storageAccountResourceId, container: dp0.container, resourceAddress: "object_store/live-check" } } : {}),
    });
  } catch (e) {
    record("session", "failed", e instanceof Error ? e.message : "session could not be created");
    return { verdict: "failed", checks };
  }
  const signal = AbortSignal.timeout(20 * 60_000);
  const dp = config.dataPlane;

  // 1. Control plane: the federated exchange works and the subscription is the configured one.
  try {
    const sub = await armClient(session, signal).get<{ subscriptionId?: string }>(`/subscriptions/${session.subscriptionId}`, { apiVersion: "2022-12-01" });
    record("control-plane-subscription", String(sub.body.subscriptionId).toLowerCase() === session.subscriptionId.toLowerCase() ? "passed_live" : "failed", `ARM ${cloud.armHost} answered for the configured subscription`);
  } catch (e) {
    record("control-plane-subscription", "failed", e instanceof Error ? e.message : "ARM call failed");
    return { verdict: "failed", checks };
  }

  // 2. Data plane, Blob: list one blob name with the Storage audience, waiting out role propagation.
  if (dp.storageAccountResourceId && dp.container) {
    try {
      const url = `https://${dp.storageAccountResourceId.split("/").at(-1)}.${cloud.blobSuffix}/${dp.container}?restype=container&comp=list&maxresults=1`;
      const { attempts } = await awaitDataPlaneAccess(
        async () => {
          const res = await session.authorizedFetch(url, { headers: { "x-ms-version": "2023-11-03" }, redirect: "error", signal });
          await res.body?.cancel().catch(() => undefined);
          if (res.status === 403 && [null, "AuthorizationPermissionMismatch"].includes(res.headers.get("x-ms-error-code"))) throw new ArmError("forbidden", 403, "blob denied");
          if (!res.ok) throw new Error(`blob list returned HTTP ${res.status}`);
          return res.status;
        },
        (error) => error instanceof ArmError && error.kind === "forbidden",
        { timeoutMs: 5 * 60_000, signal }
      );
      record("data-plane-blob-read", "passed_live", `container listed with Entra authorization after ${attempts} attempt(s)`);
    } catch (e) {
      record("data-plane-blob-read", "failed", e instanceof DataPlanePropagationTimeoutError ? e.message : e instanceof Error ? e.message : "blob read failed");
    }
  } else record("data-plane-blob-read", "skipped", "dataPlane.storageAccountResourceId and dataPlane.container are not configured.");

  // 3. Data plane, Key Vault: list secret METADATA (never a value).
  if (dp.keyVault) {
    try {
      const url = `https://${dp.keyVault}.${cloud.keyVaultSuffix}/secrets?api-version=${API.keyVaultData}&maxresults=1`;
      const { attempts } = await awaitDataPlaneAccess(
        () => sendJson(session, signal, "GET", url),
        (error) => error instanceof ArmError && error.kind === "forbidden" && error.armCode?.toLowerCase() !== "forbiddenbyfirewall",
        { timeoutMs: 5 * 60_000, signal }
      );
      record("data-plane-keyvault-metadata", "passed_live", `secret metadata listed after ${attempts} attempt(s); no value was read`);
    } catch (e) {
      record("data-plane-keyvault-metadata", "failed", e instanceof Error ? e.message : "Key Vault read failed");
    }
  } else record("data-plane-keyvault-metadata", "skipped", "dataPlane.keyVault is not configured.");

  // 4. Least privilege: the intended role is assigned at exactly the resource scope.
  if (dp.principalId && dp.roleScopeId && dp.roleName) {
    try {
      const found = await findRoleAssignment(session, signal, { scopeId: dp.roleScopeId, principalId: dp.principalId, roleName: dp.roleName });
      record("role-assignment-exact-scope", found.state === "present" ? "passed_live" : "failed", `${dp.roleName}: ${found.state}`);
    } catch (e) {
      record("role-assignment-exact-scope", "failed", e instanceof Error ? e.message : "role assignment read failed");
    }
  } else record("role-assignment-exact-scope", "skipped", "dataPlane.principalId, roleScopeId and roleName are not configured.");

  // 5. ACR Tasks source build (MUTATING: pushes one operation tag). Needs the explicit second opt in.
  if (!config.allowBuild) record("acr-source-build", "skipped", "ZENITH_LIVE_AZURE_ALLOW_BUILD=1 is not set; the mutating build check was not requested.");
  else if (!dp.registryId || !dp.loginServer) record("acr-source-build", "skipped", "dataPlane.registryId and dataPlane.loginServer are not configured.");
  else {
    try {
      const tag = `zn-${createHash("sha256").update(randomBytes(32)).digest("hex")}`;
      const ctx = { provider: "azure", region: config.connection.region, workspaceId: "live", environmentId: "live", operationId: "live", session, signal, log: () => undefined, tags: {}, now: deps.now ?? (() => new Date()) } as unknown as DriverContext<AzureSession>;
      const runId = await scheduleBuild(ctx as Parameters<typeof scheduleBuild>[0], {
        registryId: dp.registryId,
        loginServer: dp.loginServer,
        repository: dp.repository ?? "zenith-live-check",
        source: tarGz({ Dockerfile: `FROM scratch\nLABEL zenith.live.check="${tag.slice(0, 16)}"\n` }),
        tag,
      });
      let status = "";
      const deadline = Date.now() + 15 * 60_000;
      let digest: string | undefined;
      while (Date.now() < deadline) {
        const run = (await armClient(session, signal).get<Record<string, unknown>>(`${dp.registryId}/runs/${runId}`, { apiVersion: API.containerRegistryRuns })).body;
        const props = (run.properties ?? {}) as Record<string, unknown>;
        status = String(props.status ?? "");
        if (status === "Succeeded") {
          const out = (Array.isArray(props.outputImages) ? props.outputImages : []).find((i: unknown) => (i as Record<string, unknown>).tag === tag) as Record<string, unknown> | undefined;
          digest = typeof out?.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(out.digest) ? out.digest : undefined;
          break;
        }
        if (["Failed", "Canceled", "Error", "Timeout"].includes(status)) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      record("acr-source-build", digest ? "passed_live" : "failed", digest ? `run ${runId} pushed ${dp.repository ?? "zenith-live-check"}:${tag.slice(0, 11)}... with digest ${digest.slice(0, 19)}...` : `run ${runId} ended as ${status || "unknown"}`);
    } catch (e) {
      record("acr-source-build", "failed", e instanceof Error ? e.message : "build failed");
    }
  }

  const failed = checks.some((c) => c.status === "failed");
  const skipped = checks.some((c) => c.status === "skipped");
  const passed = checks.some((c) => c.status === "passed_live");
  return { verdict: failed ? "failed" : !passed ? "not_run" : skipped ? "incomplete" : "passed", checks };
}

/* ------------------------------------- CLI ------------------------------------ */

async function main(): Promise<number> {
  let loaded: ReturnType<typeof loadAzureLiveConfig>;
  try {
    loaded = loadAzureLiveConfig(process.env);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : "invalid live configuration"}\n`);
    return 2;
  }
  if (!loaded.config) {
    process.stdout.write(`SKIPPED (not counted as passed): ${loaded.skipReason}\n`);
    return 0;
  }
  const report = await runAzureLive(loaded.config, { log: (l) => process.stdout.write(`${l}\n`) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.verdict === "failed" ? 1 : 0;
}

if (process.argv[1] && /azure-live\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  void main().then((code) => process.exit(code));
}
