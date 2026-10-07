/** Node-only transport boundary. SQL owns attempts; Temporal owns retained execution history. */
import type { Client, WorkflowHandle } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import type { Payload } from "@temporalio/common";
import { msToTs } from "@temporalio/common/lib/time";
import { decodeArrayFromPayloads, decodeMapFromPayloads, encodeMapToPayloads, encodeToPayloadsWithContext } from "@temporalio/common/lib/internal-non-workflow/codec-helpers";
import { isMemoryStoreEnabled, type Broker } from "@/lib/capabilities/platform";
import { digest } from "@/lib/controlplane/digest";
import { assertPlatformSchemaCurrent, openPlatformDb, platformDbConfigFromEnv, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as intents from "@/lib/controlplane/db/repos/workflow-start-intents";
import type { StartRequest, WorkflowStartIntent, WorkflowStartKind } from "@/lib/controlplane/db/repos/workflow-start-intents";
import { temporalConfigFromEnv, type TemporalConnectionConfig } from "./config";
import { workflowClient } from "./client";
import { TASK_QUEUE } from "./types";

const MEMO_KEY = "zenithWorkflowStart";
const RPC_MS = 10_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const enums = temporal.api.enums.v1;
export class WorkflowStartUnconfirmedError extends Error {
  readonly code = "workflow_start_unconfirmed";
  constructor() { super("The workflow start is unconfirmed. Preserve the operation's uncertainty and inspect its retained intent; another start is not authorized."); this.name="WorkflowStartUnconfirmedError"; }
}
function unconfirmed(): never { throw new WorkflowStartUnconfirmedError(); }
export interface ConfirmedWorkflowStart {
  readonly workflowId: string; readonly runId: string; readonly handle: WorkflowHandle;
  /** Evidence of an accepted original start, never approval or terminal provider quiescence. */
  readonly intent: WorkflowStartIntent;
}
const endpoint = (config: TemporalConnectionConfig): string => digest({ address: config.address, tls: config.tls });
function request(kind: WorkflowStartKind, value: unknown, config: TemporalConnectionConfig, taskQueue: string): StartRequest {
  return Object.freeze({ kind, arguments: intents.snapshotWorkflowArguments(kind,value), namespace:config.namespace,
    endpointDigest:endpoint(config), taskQueue });
}
function memo(intent: WorkflowStartIntent): Record<string,unknown> {
  return { [MEMO_KEY]: { format:"zenith.workflow-start.v1", bindingDigest:intent.binding_digest, attemptId:intent.attempt_id } };
}
function context(intent: WorkflowStartIntent) {
  return { type:"workflow" as const, namespace:intent.binding.namespace, workflowId:intent.binding.workflowId };
}
function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") return value.toNumber();
  return Number.NaN;
}
function seconds(duration: { seconds?: unknown; nanos?: number|null }|null|undefined): number {
  if (!duration) return 0;
  return (duration.seconds == null ? 0 : numeric(duration.seconds)) + (duration.nanos ?? 0)/1_000_000_000;
}
/** Pinned proto 1.24 defaults for an original, parentless, non-eager start. Message presence alone is significant for upgrade/fast-forward state. */
function originalStartDefaults(start: temporal.api.history.v1.WorkflowExecutionStartedEventAttributes.$Properties): boolean {
  if ((start.eagerExecutionAccepted ?? false) !== false || start.declinedTargetVersionUpgrade != null) return false;
  const priority=start.priority, skipping=start.timeSkippingConfig, propagated=start.timeSkippingStatePropagation;
  // Proto zero inherits/defaults; with no parent, the documented fairness default is 1.0.
  if (priority && ((priority.priorityKey ?? 0) !== 0 || (priority.fairnessKey ?? "") !== ""
    || ![0,1].includes(priority.fairnessWeight ?? 0))) return false;
  if (skipping && ((skipping.enabled ?? false) !== false || skipping.fastForwardConfig != null
    || (skipping.disablePropagation ?? false) !== false || (skipping.maxSessionSkipCount ?? 0) !== 0)) return false;
  if (propagated) {
    const skipped=propagated.initialSkippedDuration;
    // Check components separately: a malformed duration must not cancel to zero.
    if ((propagated.initialSkipCount ?? 0) !== 0 || propagated.fastForwardTargetTime != null
      || skipped && ((skipped.seconds == null ? 0 : numeric(skipped.seconds)) !== 0 || (skipped.nanos ?? 0) !== 0)) return false;
  }
  return true;
}
function timestamp(value: {seconds?:unknown;nanos?:number|null}|null|undefined): string {
  if (!value || value.seconds == null) return unconfirmed();
  const ms=numeric(value.seconds)*1000+Math.floor((value.nanos ?? 0)/1_000_000);
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 8_640_000_000_000_000) return unconfirmed();
  return new Date(ms).toISOString();
}
function boundedPayloads(payloads: readonly Payload[]): void {
  let bytes=0;
  if (payloads.length > 4) return unconfirmed();
  for (const p of payloads) {
    bytes += p.data?.byteLength ?? 0;
    for (const [key,value] of Object.entries(p.metadata ?? {})) bytes += key.length + value.byteLength;
  }
  if (bytes > 64_000) return unconfirmed();
}
/** Independent Describe plus the first history page, pinned to the actual original run. No workflow query/result or mutable memo read grants authority. */
async function readExact(client: Client, intent: WorkflowStartIntent, knownRunId?: string): Promise<intents.StartReadback> {
  if (client.options.namespace !== intent.binding.namespace || intent.phase === "prepared" || !intent.attempt_id) return unconfirmed();
  const workflowId=intent.binding.workflowId;
  const runId=intent.run_id ?? knownRunId;
  if (runId !== undefined && !UUID.test(runId)) return unconfirmed();
  const described=await client.withDeadline(Date.now()+RPC_MS,()=>client.workflowService.describeWorkflowExecution({
    namespace:intent.binding.namespace, execution:{workflowId,...(runId ? {runId} : {})},
  }));
  const info=described.workflowExecutionInfo, actual=info?.execution?.runId;
  if (!info || !actual || !UUID.test(actual) || info.execution?.workflowId !== workflowId || (runId && actual !== runId)
    || info.type?.name !== intent.binding.workflowType) return unconfirmed();
  // Fetch one page only. Never call handle.fetchHistory(), which loads the complete history.
  const history=await client.withDeadline(Date.now()+RPC_MS,()=>client.workflowService.getWorkflowExecutionHistory({
    namespace:intent.binding.namespace,execution:{workflowId,runId:actual}, maximumPageSize:1,
    waitNewEvent:false, historyEventFilterType:enums.HistoryEventFilterType.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT,
  }));
  const events=history.history?.events;
  if (!events?.length || events.length > 1000 || history.rawHistory?.length) return unconfirmed();
  const first=events[0], start=first.workflowExecutionStartedEventAttributes;
  if (numeric(first.eventId) !== 1 || first.eventType !== enums.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED || !start
    || start.workflowType?.name !== intent.binding.workflowType || start.workflowId !== workflowId
    || start.originalExecutionRunId !== actual || start.firstExecutionRunId !== actual || start.continuedExecutionRunId
    || start.parentWorkflowExecution || start.rootWorkflowExecution || start.parentWorkflowNamespace || start.parentWorkflowNamespaceId
    || start.continuedFailure != null || start.lastCompletionResult != null
    || (start.attempt ?? 1) !== 1 || start.retryPolicy?.maximumAttempts !== 1 || start.cronSchedule
    || seconds(start.firstWorkflowTaskBackoff) !== 0 || seconds(start.workflowTaskTimeout) !== 10
    || seconds(start.workflowExecutionTimeout) !== 0 || seconds(start.workflowRunTimeout) !== 0
    || start.taskQueue?.name !== intent.binding.taskQueue || (start.taskQueue.kind ?? 1) !== 1 || start.taskQueue.normalName
    || start.versioningOverride || start.inheritedBuildId || start.sourceVersionStamp || start.parentPinnedWorkerDeploymentVersion
    || start.inheritedPinnedVersion || start.inheritedAutoUpgradeInfo
    || !originalStartDefaults(start)
    || start.completionCallbacks?.length || start.header && Object.keys(start.header.fields ?? {}).length
    || start.identity !== `zenith.workflow-start.v1:${intent.attempt_id}`) return unconfirmed();
  const payloads=start.input?.payloads, memoFields=start.memo?.fields;
  if (!payloads || payloads.length !== 1 || !memoFields || Object.keys(memoFields).length !== 1 || !memoFields[MEMO_KEY]) return unconfirmed();
  boundedPayloads([...payloads,...Object.values(memoFields)]);
  const converter=client.options.loadedDataConverter, c=context(intent);
  const values=await decodeArrayFromPayloads(converter,payloads,c);
  const fields=await decodeMapFromPayloads(converter,memoFields,c);
  // Compare the complete decoded value before scalar validation: extra fields cannot be hidden by projection.
  if (values.length !== 1 || digest(values[0]) !== intent.binding.argumentsDigest || digest(fields) !== digest(memo(intent))) return unconfirmed();
  const typed=intents.snapshotWorkflowArguments(intent.binding.kind,values[0]);
  if (digest(typed) !== intent.binding.argumentsDigest) return unconfirmed();
  const startedAt=timestamp(first.eventTime);
  if (timestamp(info.startTime) !== startedAt) return unconfirmed();
  return Object.freeze({runId:actual,startedAt,evidenceDigest:digest({format:"zenith.workflow-start-readback.v1",
    bindingDigest:intent.binding_digest,attemptId:intent.attempt_id,runId:actual,startedAt})});
}
/** The sole transport write for a retained attempt. Same permanent requestId/identity/arguments on every send, so the server deduplicates a resend of an attempt it already accepted. An RPC error, including AlreadyExists, is evidence-readback only. */
async function sendStart(client: Client, intent: WorkflowStartIntent, payloads: Payload[]): Promise<string|undefined> {
  const c=context(intent), converter=client.options.loadedDataConverter;
  const fields=await encodeMapToPayloads(converter,memo(intent),c);
  boundedPayloads(Object.values(fields));
  try {
    const ack=await client.withDeadline(Date.now()+RPC_MS,()=>client.workflowService.startWorkflowExecution({
      namespace:intent.binding.namespace, workflowId:intent.binding.workflowId,
      workflowType:{name:intent.binding.workflowType}, taskQueue:{name:intent.binding.taskQueue,kind:1},
      input:{payloads}, memo:{fields}, identity:`zenith.workflow-start.v1:${intent.attempt_id}`,
      requestId:intent.attempt_id!, workflowTaskTimeout:msToTs("10s"), retryPolicy:{maximumAttempts:1},
      workflowIdReusePolicy:enums.WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
      workflowIdConflictPolicy:enums.WorkflowIdConflictPolicy.WORKFLOW_ID_CONFLICT_POLICY_FAIL,
      requestEagerExecution:false,
    }));
    if (!ack.runId || !UUID.test(ack.runId)) return undefined;
    return ack.runId;
  } catch { return undefined; }
}
type Store = Pick<typeof intents,"prepare"|"claim">;
async function start(db: PlatformDbHandle, store: Store, config: TemporalConnectionConfig,
  getClient: ()=>Promise<Client>, taskQueue: string, kind: WorkflowStartKind, input: unknown): Promise<ConfirmedWorkflowStart> {
  const desired=request(kind,input,config,taskQueue);
  let intent:WorkflowStartIntent;
  try { intent=await store.prepare(db,desired); } // Commits before connecting or issuing transport.
  catch { throw new intents.WorkflowStartIntentError(); }
  try {
    const client=await getClient();
    if(client.options.namespace !== config.namespace) return unconfirmed();
    const c=context(intent), converter=client.options.loadedDataConverter;
    // Serialization happens before consuming the sole attempt and carries exactly the existing workflow argument shape.
    const payloads=await encodeToPayloadsWithContext(converter,c,[intent.binding.arguments]);
    if (!payloads || payloads.length !== 1) return unconfirmed();
    boundedPayloads(payloads);
    let acceptedRun: string|undefined;
    if(intent.phase === "prepared") {
      const claim=await store.claim(db,desired);
      intent=claim.intent;
      if(claim.dispatch) {
        acceptedRun=await sendStart(client,intent,payloads);
      }
    }
    const observed=await readExact(client,intent,acceptedRun);
    const retained=await intents.acknowledge(db,intent,observed);
    return Object.freeze({workflowId:retained.binding.workflowId,runId:observed.runId,
      handle:client.workflow.getHandle(retained.binding.workflowId,observed.runId),intent:retained});
  } catch { return unconfirmed(); }
}
/** Canonical production route. Dedicated one-connection SQL handle prevents an enclosing application transaction from delaying intent commit until after transport. */
export async function startWorkflowIntent(kind: WorkflowStartKind, input: unknown): Promise<ConfirmedWorkflowStart> {
  // Capture the typed scalar input and validated destination before opening a store. There is no per-call client/config/broker/proof argument.
  const args=intents.snapshotWorkflowArguments(kind,input);
  const config=temporalConfigFromEnv();
  const dbConfig=platformDbConfigFromEnv();
  if (dbConfig.kind !== "postgres" || !dbConfig.url || isMemoryStoreEnabled()) throw new intents.WorkflowStartIntentError();
  const db=await openPlatformDb({kind:"postgres",url:dbConfig.url,max:1,migrate:false});
  try {
    await assertPlatformSchemaCurrent(db);
    return await start(db,intents,config,()=>workflowClient(config),TASK_QUEUE,kind,args);
  } finally { await db.close(); }
}
/**
 * Resend/readback window for an attempt whose acknowledgement was lost (PROD-DUR-01).
 * Far below the shortest Temporal retention, so "workflow not found" within it proves
 * the server never accepted the attempt rather than that a closed run was purged.
 */
export const START_RECOVERY_WINDOW_MS = 30 * 60_000;
export type StartRecovery = "acknowledged" | "refused" | "retry";
function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown }; name?: string } | null;
  return !!e && (e.code === 5 || e.cause?.code === 5 || e.name === "WorkflowNotFoundError");
}
export interface StartRecoveryDeps {
  config?: TemporalConnectionConfig;
  getClient?: (config: TemporalConnectionConfig) => Promise<Client>;
  /** Test clock for the recovery window. */
  now?: () => number;
  /** Test-only isolated authority store (honoured only under NODE_ENV=test). */
  store?: Store;
}
/**
 * Relay entrypoint: bring ONE retained start intent to a confirmed state after a crash.
 *
 *  - prepared: the original request never reached the permanent attempt CAS; run the ordinary
 *    start path, which re-validates current authority and may refuse.
 *  - attempted: independent Describe + first-history readback first. Only when the workflow
 *    does not exist, the attempt is inside START_RECOVERY_WINDOW_MS and the operation is still
 *    running under a live lease, resend the IDENTICAL request (same requestId, workflow id,
 *    arguments, memo and identity), which Temporal deduplicates. Nothing new is authorized: no
 *    new attempt id, no new workflow id, no approval or lease is minted.
 *  - anything else (found-but-different workflow, expired window, lapsed operation) is
 *    "refused": the intent is kept as evidence and an operator inspects it.
 */
export async function recoverWorkflowStartIntent(db: PlatformDbHandle, workspaceId: string, operationId: string,
  deps: StartRecoveryDeps = {}): Promise<StartRecovery> {
  const intent=await intents.get(db,workspaceId,operationId);
  if (!intent) return "refused";
  if (intent.phase === "acknowledged") return "acknowledged";
  let config: TemporalConnectionConfig;
  try { config=deps.config ?? temporalConfigFromEnv(); } catch { return "retry"; }
  const binding=intent.binding;
  if (endpoint(config) !== binding.endpointDigest || config.namespace !== binding.namespace) return "refused";
  const getClient=()=>(deps.getClient ?? workflowClient)(config);
  const now=deps.now ?? Date.now;
  try {
    if (intent.phase === "prepared") {
      const store=process.env.NODE_ENV === "test" && deps.store ? deps.store : intents;
      await start(db,store,config,getClient,binding.taskQueue,binding.kind,binding.arguments);
      return "acknowledged";
    }
    const client=await getClient();
    if (client.options.namespace !== config.namespace) return "retry";
    let exists=true;
    try {
      await client.withDeadline(Date.now()+RPC_MS,()=>client.workflowService.describeWorkflowExecution({
        namespace:binding.namespace, execution:{workflowId:binding.workflowId} }));
    } catch (error) { if (!isNotFound(error)) return "retry"; exists=false; }
    let accepted: string|undefined;
    if (!exists) {
      const age=now()-Date.parse(intent.attempted_at ?? "");
      if (!(age >= 0 && age <= START_RECOVERY_WINDOW_MS)) return "refused";
      const live=await db.query("select 1 from platform.operations where workspace_id=$1 and id=$2 and status='running' and lease_holder is not null and lease_until>clock_timestamp()",
        [workspaceId,operationId]);
      if (!live.length) return "refused";
      const c=context(intent);
      const payloads=await encodeToPayloadsWithContext(client.options.loadedDataConverter,c,[binding.arguments]);
      if (!payloads || payloads.length !== 1) return "retry";
      boundedPayloads(payloads);
      accepted=await sendStart(client,intent,payloads);
    }
    let observed: intents.StartReadback;
    try { observed=await readExact(client,intent,accepted); }
    catch (error) { return exists && error instanceof WorkflowStartUnconfirmedError ? "refused" : "retry"; }
    await intents.acknowledge(db,intent,observed);
    return "acknowledged";
  } catch (error) {
    return error instanceof intents.WorkflowStartIntentError ? "refused" : "retry";
  }
}
/** Test isolation captures real SDK client and actual canonical Broker once. No per-call approval callback or production override. */
export function createIsolatedWorkflowStarterForTests(db: PlatformDbHandle, broker: Broker, client: Client,
  config: TemporalConnectionConfig, taskQueue: string) {
  const guard=()=>{if(process.env.NODE_ENV !== "test") throw new intents.WorkflowStartIntentError();};
  guard();
  const captured=Object.freeze({...config});
  const store=intents.createIsolatedStartIntentStoreForTests(broker);
  return Object.freeze({ start: (kind:WorkflowStartKind,input:unknown)=>{
    guard(); return start(db,store,captured,async()=>client,taskQueue,kind,input);
  } });
}
