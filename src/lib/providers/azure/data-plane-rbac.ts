/**
 * Azure data-plane RBAC (PROD-LIFE-04).
 *
 * Azure authorises two different planes with two different families of role:
 *
 *   control plane  resource actions         create, update or delete the
 *                                           resource through ARM
 *   data plane     `…/dataActions`          read or write what is INSIDE the
 *                                           resource (blobs, secrets, queue
 *                                           messages, image layers)
 *
 * A control-plane role such as Contributor never grants data access to a
 * storage account whose shared keys are disabled, and a data role such as
 * Storage Blob Data Reader never lets a caller change the account. Zenith
 * therefore keeps them apart:
 *
 *   - this catalog names every built-in role Zenith ever assigns or relies
 *     on, with its plane, the portable target kinds it may be granted on, the
 *     ARM resource types that are acceptable scopes, and a risk class;
 *   - workload identities receive DATA roles only, each scoped to ONE
 *     resource (identity.ts consults `assertRoleFitsTarget`);
 *   - the deploy identity's data permissions are bootstrap-time, condition
 *     constrained assignments (deploy/azure) and are verified here too;
 *   - Owner, Contributor, User Access Administrator and RBAC Administrator
 *     are never grantable (`isNeverGrantable`).
 *
 * Propagation. Entra and ARM accept a role assignment before every data-plane
 * endpoint honours it; a 403 for a minute or ten after assignment is normal.
 * `awaitDataPlaneAccess` retries ONLY a denial the caller classifies as an
 * RBAC denial (never a firewall or an unrelated 4xx), with bounded exponential
 * backoff and an overall deadline, and then fails with an explicit message
 * that names the missing role, not a bare 403.
 *
 * Honest limit: role GUIDs and data-action names come from Microsoft's
 * built-in role reference and are exercised by contract tests only.
 */
import type { AzureSession } from "@/lib/credentials/types";
import { armClient, ArmError, parseArmId, type ArmResource } from "@/lib/providers/azure/arm";
import { API, FORBIDDEN_ROLE_NAMES, ROLE } from "@/lib/providers/azure/platform";

export type RolePlane = "data" | "control";
export type RoleRisk = "read" | "write" | "admin";

export interface RoleDefinitionSpec {
  readonly guid: string;
  readonly name: string;
  readonly plane: RolePlane;
  readonly risk: RoleRisk;
  /** portable resource kinds (address prefix) this role may be granted on; `[]` = never granted by Zenith, only relied on */
  readonly targetKinds: readonly string[];
  /** lowercase ARM resource types acceptable as the assignment scope; data roles never accept a resource group or subscription */
  readonly scopeTypes: readonly string[];
  /** data actions that make the role a data-plane role (documentation and tests; ARM is the authority) */
  readonly dataActions: readonly string[];
}

const BLOB_SCOPES = ["microsoft.storage/storageaccounts", "microsoft.storage/storageaccounts/blobservices/containers"] as const;

export const ROLE_CATALOG: readonly RoleDefinitionSpec[] = [
  { guid: "4633458b-17de-408a-b874-0445c86b69e6", name: ROLE.keyVaultSecretsUser, plane: "data", risk: "read", targetKinds: ["secret"], scopeTypes: ["microsoft.keyvault/vaults"], dataActions: ["Microsoft.KeyVault/vaults/secrets/getSecret/action", "Microsoft.KeyVault/vaults/secrets/readMetadata/action"] },
  { guid: "b86a8fe4-44ce-4948-aee5-eccb2c155cd7", name: ROLE.keyVaultSecretsOfficer, plane: "data", risk: "write", targetKinds: [], scopeTypes: ["microsoft.keyvault/vaults"], dataActions: ["Microsoft.KeyVault/vaults/secrets/*"] },
  { guid: "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1", name: ROLE.blobReader, plane: "data", risk: "read", targetKinds: ["object_store"], scopeTypes: BLOB_SCOPES, dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"] },
  { guid: "ba92f5b4-2d11-453d-a403-e96b0029c9fe", name: ROLE.blobContributor, plane: "data", risk: "write", targetKinds: ["object_store"], scopeTypes: BLOB_SCOPES, dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write", "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete"] },
  // Function host account only: granted by the Function App driver on the account it owns, never by a portable grant.
  { guid: "b7e6dc6d-f1e8-4753-8033-0f276bb0955b", name: ROLE.blobOwner, plane: "data", risk: "admin", targetKinds: [], scopeTypes: ["microsoft.storage/storageaccounts"], dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/*"] },
  { guid: "974c5e8b-45b9-4653-ba55-5f855dd0fb88", name: ROLE.storageQueueContributor, plane: "data", risk: "write", targetKinds: [], scopeTypes: ["microsoft.storage/storageaccounts"], dataActions: ["Microsoft.Storage/storageAccounts/queueServices/queues/messages/*"] },
  { guid: "69a216fc-b8fb-44d8-bc22-1f3c2cd27a39", name: ROLE.serviceBusSender, plane: "data", risk: "write", targetKinds: ["queue", "pubsub"], scopeTypes: ["microsoft.servicebus/namespaces", "microsoft.servicebus/namespaces/queues", "microsoft.servicebus/namespaces/topics"], dataActions: ["Microsoft.ServiceBus/*/Send/action"] },
  { guid: "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0", name: ROLE.serviceBusReceiver, plane: "data", risk: "read", targetKinds: ["queue", "pubsub"], scopeTypes: ["microsoft.servicebus/namespaces", "microsoft.servicebus/namespaces/queues", "microsoft.servicebus/namespaces/subscriptions"], dataActions: ["Microsoft.ServiceBus/*/Receive/action"] },
  { guid: "7f951dda-4ed3-4680-a7ca-43fe172d538d", name: ROLE.acrPull, plane: "data", risk: "read", targetKinds: ["container_registry"], scopeTypes: ["microsoft.containerregistry/registries"], dataActions: ["Microsoft.ContainerRegistry/registries/pull/read"] },
  { guid: "8311e382-0749-4cb8-b61a-304f252e45ec", name: ROLE.acrPush, plane: "data", risk: "write", targetKinds: ["container_registry"], scopeTypes: ["microsoft.containerregistry/registries"], dataActions: ["Microsoft.ContainerRegistry/registries/pull/read", "Microsoft.ContainerRegistry/registries/push/write"] },
  // Control-plane roles Zenith's bootstrap relies on (never assigned to a workload identity).
  { guid: "acdd72a7-3385-48ef-bd42-f606fba81ae7", name: "Reader", plane: "control", risk: "read", targetKinds: [], scopeTypes: [], dataActions: [] },
  { guid: "43d0d8ad-25c7-4714-9337-8ba259a9fe05", name: "Monitoring Reader", plane: "control", risk: "read", targetKinds: [], scopeTypes: [], dataActions: [] },
  { guid: "73c42c96-874c-492b-b04d-ab87d138a893", name: "Log Analytics Reader", plane: "control", risk: "read", targetKinds: [], scopeTypes: [], dataActions: [] },
  { guid: "21090545-7ca7-4776-b22c-e363652d74d2", name: "Key Vault Reader", plane: "control", risk: "read", targetKinds: [], scopeTypes: [], dataActions: [] },
  { guid: "4c8d0bbc-75d3-4935-991f-5f3c56d81508", name: "Container Registry Tasks Contributor", plane: "control", risk: "write", targetKinds: [], scopeTypes: [], dataActions: [] },
];

const BY_NAME = new Map(ROLE_CATALOG.map((r) => [r.name.toLowerCase(), r]));
const BY_GUID = new Map(ROLE_CATALOG.map((r) => [r.guid, r]));

export const roleByName = (name: string): RoleDefinitionSpec | undefined => BY_NAME.get(name.toLowerCase());
export const roleByGuid = (guid: string): RoleDefinitionSpec | undefined => BY_GUID.get(guid.toLowerCase());

export function isNeverGrantable(roleName: string): boolean {
  return FORBIDDEN_ROLE_NAMES.some((n) => n.toLowerCase() === roleName.toLowerCase());
}

export class RoleGrantRefusedError extends Error {
  readonly code = "azure_role_grant_refused";
  constructor(message: string) {
    super(message);
    this.name = "RoleGrantRefusedError";
  }
}

/**
 * A workload grant is acceptable only for a catalogued DATA role that is meant for the target's kind.
 * Throws with a message that names the role and kind (never a value from a resource).
 */
export function assertRoleFitsTarget(roleName: string, targetKind: string): RoleDefinitionSpec {
  if (isNeverGrantable(roleName)) throw new RoleGrantRefusedError(`role ${roleName} is never granted by Zenith.`);
  const role = roleByName(roleName);
  if (!role) throw new RoleGrantRefusedError(`role ${roleName} is not in the Zenith role catalog.`);
  if (role.plane !== "data") throw new RoleGrantRefusedError(`role ${roleName} is a control-plane role; workload identities receive data-plane roles only.`);
  if (role.targetKinds.length > 0 && !role.targetKinds.includes(targetKind)) throw new RoleGrantRefusedError(`role ${roleName} cannot be granted on a ${targetKind}.`);
  return role;
}

/** Split any list of `{ role }` items into data-plane and control-plane groups; an uncatalogued role is reported, never guessed. */
export function splitByPlane<T extends { role: string }>(items: readonly T[]): { data: T[]; control: T[]; unknown: T[] } {
  const out = { data: [] as T[], control: [] as T[], unknown: [] as T[] };
  for (const item of items) {
    const spec = roleByName(item.role);
    (spec ? (spec.plane === "data" ? out.data : out.control) : out.unknown).push(item);
  }
  return out;
}

/**
 * Is `scopeId` an acceptable scope for `role`? Data roles accept only the
 * resource types in their catalog entry: never a resource group, a
 * subscription, or a resource of another service.
 */
export function scopeFitsRole(role: RoleDefinitionSpec, scopeId: string, subscriptionId: string): boolean {
  const parsed = parseArmId(scopeId);
  if (!parsed || parsed.subscriptionId !== subscriptionId.toLowerCase() || !parsed.provider || parsed.segments.length === 0) return false;
  if (/[\s%?#\\*]/.test(scopeId) || scopeId.includes("..") || scopeId.includes("//")) return false;
  const type = `${parsed.provider}/${parsed.segments.map((s) => s.type).join("/")}`.toLowerCase();
  return role.scopeTypes.includes(type);
}

/* -------------------------------- assignments ------------------------------- */

export type AssignmentState = "present" | "missing" | "broader_than_required" | "unreadable";

export interface AssignmentCheck {
  state: AssignmentState;
  /** scopes of matching assignments, for the report */
  scopes: string[];
}

/**
 * Read the role assignments one principal has at (and above) a scope and decide whether the intended role is
 * there at EXACTLY that scope. An assignment at a parent scope (resource group, subscription) is reported as
 * `broader_than_required` and does not count as present: least privilege is part of the contract.
 */
export async function findRoleAssignment(session: AzureSession, signal: AbortSignal | undefined, input: { scopeId: string; principalId: string; roleName: string }): Promise<AssignmentCheck> {
  const role = roleByName(input.roleName);
  if (!role) throw new RoleGrantRefusedError(`role ${input.roleName} is not in the Zenith role catalog.`);
  if (!scopeFitsRole(role, input.scopeId, session.subscriptionId)) throw new RoleGrantRefusedError(`scope is not an acceptable scope for ${role.name}.`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.principalId)) throw new RoleGrantRefusedError("principalId is not a GUID.");
  let items: ArmResource[];
  try {
    items = (await armClient(session, signal).list<ArmResource>(`${input.scopeId}/providers/Microsoft.Authorization/roleAssignments`, { apiVersion: API.authorization, query: { $filter: `principalId eq '${input.principalId}'` } }, 3)).items;
  } catch (e) {
    if (e instanceof ArmError) return { state: "unreadable", scopes: [] };
    throw e;
  }
  const matching = items.filter((ra) => {
    const props = (ra.properties ?? {}) as Record<string, unknown>;
    const def = typeof props.roleDefinitionId === "string" ? (props.roleDefinitionId.split("/").pop() ?? "").toLowerCase() : "";
    return def === role.guid && String(props.principalId ?? "").toLowerCase() === input.principalId.toLowerCase();
  });
  const scopes = matching.map((ra) => String(((ra.properties ?? {}) as Record<string, unknown>).scope ?? "")).filter(Boolean);
  if (scopes.some((s) => s.toLowerCase() === input.scopeId.toLowerCase())) return { state: "present", scopes };
  return { state: scopes.length > 0 ? "broader_than_required" : "missing", scopes };
}

/* ------------------------------ propagation wait ----------------------------- */

export interface PropagationOptions {
  /** overall deadline, default 5 minutes, max 15 */
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  onWait?: (info: { attempt: number; waitedMs: number; nextDelayMs: number }) => void;
}

export class DataPlanePropagationTimeoutError extends Error {
  readonly code = "azure_data_plane_propagation_timeout";
  constructor(
    readonly attempts: number,
    readonly waitedMs: number,
    detail: string
  ) {
    super(`The data-plane permission was still denied after ${Math.round(waitedMs / 1000)}s and ${attempts} attempts: ${detail}`);
    this.name = "DataPlanePropagationTimeoutError";
  }
}

export const DEFAULT_PROPAGATION_MS = 5 * 60_000;
export const MAX_PROPAGATION_MS = 15 * 60_000;

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Run `probe`; when it throws something `isPropagationDenial` accepts, wait (bounded exponential backoff with an
 * overall deadline) and run it again. Any other error is thrown at once: a firewall denial, a 404 or a bad
 * request is not a propagation delay. On timeout the LAST denial is wrapped with how long was waited.
 */
export async function awaitDataPlaneAccess<T>(probe: () => Promise<T>, isPropagationDenial: (error: unknown) => boolean, options: PropagationOptions = {}): Promise<{ result: T; attempts: number; waitedMs: number }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const timeoutMs = Math.min(Math.max(Math.trunc(options.timeoutMs ?? DEFAULT_PROPAGATION_MS), 0), MAX_PROPAGATION_MS);
  const initial = Math.max(1, Math.trunc(options.initialDelayMs ?? 2000));
  const maxDelay = Math.max(initial, Math.trunc(options.maxDelayMs ?? 30_000));
  const started = now();
  let delay = initial;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      return { result: await probe(), attempts, waitedMs: now() - started };
    } catch (error) {
      if (!isPropagationDenial(error)) throw error;
      if (options.signal?.aborted) throw error;
      const waited = now() - started;
      const remaining = timeoutMs - waited;
      if (remaining <= 0) throw new DataPlanePropagationTimeoutError(attempts, waited, error instanceof Error ? error.message.slice(0, 200) : "denied");
      const next = Math.min(delay, remaining);
      options.onWait?.({ attempt: attempts, waitedMs: waited, nextDelayMs: next });
      await sleep(next, options.signal);
      if (options.signal?.aborted) throw error;
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}
