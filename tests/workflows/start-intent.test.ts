/** Owned real Temporal frontend plus actual SQL/Broker; transport faults are explicitly injected after actual acceptance/commit. */
import { randomBytes } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import { msToTs } from "@temporalio/common/lib/time";
import { encodeMapToPayloads, encodeToPayloadsWithContext } from "@temporalio/common/lib/internal-non-workflow/codec-helpers";
import { afterAll, expect, it, vi } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { migration0012WorkflowStartIntents } from "@/lib/controlplane/db/migrations/0012_workflow_start_intents";
import * as intents from "@/lib/controlplane/db/repos/workflow-start-intents";
import * as operations from "@/lib/controlplane/db/repos/operations";
import { createIsolatedWorkflowStarterForTests, startWorkflowIntent, WorkflowStartUnconfirmedError } from "@/lib/workflows/start-intent";
import { temporalConfigFromEnv } from "@/lib/workflows/config";
import { temporalDataConverterFromEnv } from "@/lib/workflows/codec";
import { startDayTwo } from "@/lib/workflows/client";
import type { WorkflowResult } from "@/lib/workflows/types";
import { approveAs, closeSharedPgliteAfterAll, makeHarness as brokerHarness, PG_URL, proposeOk, requestFor,
  requireApproval, scriptedEngine, user } from "../capabilities/support";
import { serverSuite, waitFor, type Harness as TemporalHarness } from "./support";

if (process.env.ZENITH_TEST_WORKFLOW_START_REQUIRED === "1" && !PG_URL) throw new Error("Workflow start acceptance requires an owned PostgreSQL database.");
closeSharedPgliteAfterAll();
const {scenario}=serverSuite("local");
let independentPg: Promise<PlatformDbHandle>|undefined;
let observerPg: Promise<PlatformDbHandle>|undefined;
afterAll(async()=>{await (await independentPg)?.close();await (await observerPg)?.close();});

async function fixture(t:TemporalHarness, encrypted=false) {
  const h=await brokerHarness({kind:PG_URL ? "postgres" : "pglite",engine:scriptedEngine("workflow-proposal-one",()=>requireApproval(1,"admin"))});
  const db=h.db!;await db.exec(migration0012WorkflowStartIntents.sql);
  const db2=PG_URL ? await (independentPg ??= openPlatformDb({kind:"postgres",url:PG_URL,max:2,migrate:false})) : db;
  const p=await proposeOk(h,requestFor(h,"service.restart","prod"),user("bob"));await approveAs(h,p.operation,"erin");
  await h.broker.beginExecution({workspaceId:h.ids.wsA,operationId:p.id,holder:`workflow:${p.id}`,audience:"worker",leaseMs:60_000});
  const input={workspaceId:h.ids.wsA,operationId:p.id,environmentId:h.ids.envAProd,capability:"service.restart"};
  const config=temporalConfigFromEnv({ZENITH_TEMPORAL_ADDRESS:t.server.env.address,ZENITH_TEMPORAL_NAMESPACE:t.server.env.namespace ?? "default"});
  const connection=await Connection.connect({address:config.address,connectTimeout:"2s"});
  const connection2=await Connection.connect({address:config.address,connectTimeout:"2s"});
  const converter=encrypted ? temporalDataConverterFromEnv({ZENITH_SECRET_KEY:randomBytes(32).toString("hex")}) : undefined;
  const client=new Client({connection,namespace:config.namespace,...(converter ? {dataConverter:converter} : {})});
  const client2=new Client({connection:connection2,namespace:config.namespace,...(converter ? {dataConverter:converter} : {})});
  const request:intents.StartRequest={kind:"dayTwo",arguments:input,namespace:config.namespace,
    endpointDigest:digest({address:config.address,tls:config.tls}),taskQueue:t.taskQueue};
  const starter=createIsolatedWorkflowStarterForTests(db,h.broker,client,config,t.taskQueue);
  const second=createIsolatedWorkflowStarterForTests(db2,h.broker,client2,config,t.taskQueue);
  return {h,db,db2,p,input,config,client,client2,request,starter,second,
    close:async()=>{vi.restoreAllMocks();await connection.close();await connection2.close();}};
}
const inventory=(f:Awaited<ReturnType<typeof fixture>>)=>intents.get(f.db2,f.h.ids.wsA,f.p.id);
type RawStartSettings = Pick<temporal.api.workflowservice.v1.StartWorkflowExecutionRequest.$Properties,"priority"|"timeSkippingConfig"|"continuedFailure"|"lastCompletionResult">;
type StartedAttributes = temporal.api.history.v1.WorkflowExecutionStartedEventAttributes.$Properties;
async function startRawOriginal(f:Awaited<ReturnType<typeof fixture>>,settings:RawStartSettings={}) {
  const store=intents.createIsolatedStartIntentStoreForTests(f.h.broker);
  await store.prepare(f.db,f.request);const intent=(await store.claim(f.db,f.request)).intent;
  const c={type:"workflow" as const,namespace:f.config.namespace,workflowId:intent.binding.workflowId};
  const payloads=await encodeToPayloadsWithContext(f.client.options.loadedDataConverter,c,[f.input]);
  const fields=await encodeMapToPayloads(f.client.options.loadedDataConverter,{zenithWorkflowStart:{format:"zenith.workflow-start.v1",
    bindingDigest:intent.binding_digest,attemptId:intent.attempt_id}},c);
  const e=temporal.api.enums.v1;
  const ack=await f.client.withDeadline(Date.now()+10_000,()=>f.client.workflowService.startWorkflowExecution({
    namespace:f.config.namespace,workflowId:intent.binding.workflowId,workflowType:{name:intent.binding.workflowType},
    taskQueue:{name:f.request.taskQueue,kind:1},input:{payloads},memo:{fields},identity:`zenith.workflow-start.v1:${intent.attempt_id}`,
    requestId:intent.attempt_id!,workflowTaskTimeout:msToTs("10s"),retryPolicy:{maximumAttempts:1},requestEagerExecution:false,
    workflowIdReusePolicy:e.WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    workflowIdConflictPolicy:e.WorkflowIdConflictPolicy.WORKFLOW_ID_CONFLICT_POLICY_FAIL,...settings,
  }));
  expect(ack.runId).toBeTruthy();
  const page=await f.client.withDeadline(Date.now()+10_000,()=>f.client.workflowService.getWorkflowExecutionHistory({
    namespace:f.config.namespace,execution:{workflowId:intent.binding.workflowId,runId:ack.runId},maximumPageSize:1,
  }));
  const attributes=page.history?.events?.[0]?.workflowExecutionStartedEventAttributes;
  if(!attributes)throw new Error("Owned Temporal original lacks its raw start event.");
  return {intent,runId:ack.runId,attributes};
}

scenario("independent SQL workers and SDK connections commit one exact accepted start and retain the same completed execution",async t=>{
  const f=await fixture(t);const spy=vi.spyOn(f.client.workflowService,"startWorkflowExecution"),spy2=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
  try {
    await t.run(async()=>{
      // A loser may read before the winner's acceptance; its only legal result is exact receipt or uncertainty.
      const results=await Promise.allSettled([f.starter.start("dayTwo",f.input),f.second.start("dayTwo",f.input)]);
      expect(spy.mock.calls.length+spy2.mock.calls.length).toBe(1);
      const original=results.find(r=>r.status === "fulfilled");expect(original?.status).toBe("fulfilled");
      if(original?.status !== "fulfilled")throw new Error("Owned Temporal original did not acknowledge.");
      expect(((await original.value.handle.result()) as WorkflowResult).status).toBe("succeeded");
      await operations.transition(f.db,{workspaceId:f.h.ids.wsA,id:f.p.id,from:["running"],to:"succeeded"});
      const recovered=await f.second.start("dayTwo",f.input);
      expect(recovered.runId).toBe(original.value.runId);expect(recovered.intent.phase).toBe("acknowledged");
      expect(spy.mock.calls.length+spy2.mock.calls.length).toBe(1);
    });
  } finally {await f.close();}
});

scenario("accepted start followed by connection loss is recovered by an independent reader without another Start RPC",async t=>{
  const f=await fixture(t);const realStart=f.client.workflowService.startWorkflowExecution.bind(f.client.workflowService);
  const spy=vi.spyOn(f.client.workflowService,"startWorkflowExecution").mockImplementation(async req=>{
    const ack=await realStart(req);expect(ack.runId).toBeTruthy();await f.client.connection.close();throw new Error("injected lost accepted response");
  });
  const spy2=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
  try {
    await t.run(async()=>{
      await expect(f.starter.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
      expect((await inventory(f))?.phase).toBe("attempted");
      await operations.transition(f.db2,{workspaceId:f.h.ids.wsA,id:f.p.id,from:["running"],to:"uncertain"});
      const late=await f.second.start("dayTwo",f.input);expect(late.intent.phase).toBe("acknowledged");
      expect(((await late.handle.result()) as WorkflowResult).status).toBe("succeeded");
      expect(spy).toHaveBeenCalledTimes(1);expect(spy2).not.toHaveBeenCalled();
      expect((await operations.get(f.db2,f.h.ids.wsA,f.p.id))?.status).toBe("uncertain");
    });
  } finally {await f.close();}
});

scenario("SQL claim commit acknowledgement loss prevents transport and remains unconfirmed when Temporal has no execution",async t=>{
  const f=await fixture(t);const spy=vi.spyOn(f.client.workflowService,"startWorkflowExecution"),spy2=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
  const db:PlatformDbHandle={kind:f.db.kind,identity:f.db.identity,query:f.db.query.bind(f.db),exec:f.db.exec.bind(f.db),close:async()=>{},
    tx:async fn=>{
      const committed=await f.db.tx(fn);
      if(committed && typeof committed === "object" && "dispatch" in committed && committed.dispatch === true)throw new Error("injected postcommit lost claim response");
      return committed;
    }};
  const losing=createIsolatedWorkflowStarterForTests(db,f.h.broker,f.client,f.config,t.taskQueue);
  try {
    await expect(losing.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
    const retained=await inventory(f);expect(retained?.phase).toBe("attempted");
    await expect(f.second.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
    expect((await inventory(f))?.attempt_id).toBe(retained?.attempt_id);
    expect(spy).not.toHaveBeenCalled();expect(spy2).not.toHaveBeenCalled();
  } finally {await f.close();}
});

scenario("a prepared-intent commit acknowledgement loss recovers that same row and permits only its first authorized transport",async t=>{
  const f=await fixture(t);const spy=vi.spyOn(f.client.workflowService,"startWorkflowExecution"),spy2=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
  const db:PlatformDbHandle={kind:f.db.kind,identity:f.db.identity,query:f.db.query.bind(f.db),exec:f.db.exec.bind(f.db),close:async()=>{},
    tx:async fn=>{
      const committed=await f.db.tx(fn);
      if(committed && typeof committed === "object" && "phase" in committed && committed.phase === "prepared")throw new Error("injected postcommit prepared intent response lost");
      return committed;
    }};
  const losing=createIsolatedWorkflowStarterForTests(db,f.h.broker,f.client,f.config,t.taskQueue);
  try {
    await expect(losing.start("dayTwo",f.input)).rejects.toBeInstanceOf(intents.WorkflowStartIntentError);
    const retained=await inventory(f);expect(retained?.phase).toBe("prepared");expect(spy).not.toHaveBeenCalled();
    const first=await f.second.start("dayTwo",f.input);
    expect(first.intent.binding_digest).toBe(retained?.binding_digest);expect(first.intent.phase).toBe("acknowledged");
    expect(spy2).toHaveBeenCalledTimes(1);
    expect((await f.second.start("dayTwo",f.input)).runId).toBe(first.runId);expect(spy2).toHaveBeenCalledTimes(1);
  } finally {await f.close();}
});

scenario("an accepted start whose readback cannot be committed recovers the retained original, never a new execution",async t=>{
  const f=await fixture(t);const spy=vi.spyOn(f.client.workflowService,"startWorkflowExecution"),spy2=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
  const originalAck=intents.acknowledge;
  const lost=vi.spyOn(intents,"acknowledge").mockImplementation(async(...args)=>{
    await originalAck(...args);throw new Error("injected acknowledgement response lost after actual SQL commit");
  });
  try {
    await expect(f.starter.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
    const retained=await inventory(f);expect(retained?.phase).toBe("acknowledged");lost.mockRestore();
    const recovered=await f.second.start("dayTwo",f.input);expect(recovered.runId).toBe(retained?.run_id);
    expect(spy).toHaveBeenCalledTimes(1);expect(spy2).not.toHaveBeenCalled();
  } finally {await f.close();}
});

scenario("foreign legacy execution with the same workflow ID is refused rather than adopted or restarted",async t=>{
  const f=await fixture(t);
  try {
    const foreign=await startDayTwo(f.input,{client:f.client2,taskQueue:t.taskQueue});
    const spy=vi.spyOn(f.client.workflowService,"startWorkflowExecution");
    await expect(f.starter.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
    expect((await inventory(f))?.phase).toBe("attempted");expect(spy).toHaveBeenCalledTimes(1);
    const spy2=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
    await expect(f.second.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
    expect((await foreign.handle.describe()).runId).toBe(foreign.runId);expect(spy2).not.toHaveBeenCalled();
  } finally {await f.close();}
});

scenario("mutated argument, type, namespace or queue requests cannot replace the retained writer",async t=>{
  const f=await fixture(t);
  try {
    const original=await f.starter.start("dayTwo",f.input);
    const spy=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
    await expect(f.second.start("dayTwo",{...f.input,capability:"service.scale"})).rejects.toThrow();
    await expect(f.second.start("destroy",f.input)).rejects.toThrow();
    const queue=createIsolatedWorkflowStarterForTests(f.db2,f.h.broker,f.client2,f.config,"another-queue");
    await expect(queue.start("dayTwo",f.input)).rejects.toThrow();
    const namespace=createIsolatedWorkflowStarterForTests(f.db2,f.h.broker,f.client2,{...f.config,namespace:"another"},t.taskQueue);
    await expect(namespace.start("dayTwo",f.input)).rejects.toThrow();
    // Temporal's mutable Memo is not used as the start binding.
    expect((await f.second.start("dayTwo",f.input)).runId).toBe(original.runId);expect(spy).not.toHaveBeenCalled();
  } finally {await f.close();}
});

for(const change of ["wrong type","wrong arguments","wrong memo"] as const) scenario(`actual Temporal original with ${change} cannot acknowledge a retained attempt`,async t=>{
  const f=await fixture(t);const store=intents.createIsolatedStartIntentStoreForTests(f.h.broker);
  try {
    await store.prepare(f.db,f.request);const intent=(await store.claim(f.db,f.request)).intent;
    const c={type:"workflow" as const,namespace:f.config.namespace,workflowId:intent.binding.workflowId};
    const payloads=await encodeToPayloadsWithContext(f.client.options.loadedDataConverter,c,[change === "wrong arguments" ? {...f.input,capability:"service.scale"} : f.input]);
    const fields=await encodeMapToPayloads(f.client.options.loadedDataConverter,{zenithWorkflowStart:{format:"zenith.workflow-start.v1",
      bindingDigest:change === "wrong memo" ? digest("foreign memo") : intent.binding_digest,attemptId:intent.attempt_id}},c);
    const e=temporal.api.enums.v1;
    await f.client.workflowService.startWorkflowExecution({namespace:f.config.namespace,workflowId:intent.binding.workflowId,
      workflowType:{name:change === "wrong type" ? "infrastructureDestroyWorkflow" : intent.binding.workflowType},taskQueue:{name:t.taskQueue,kind:1},
      input:{payloads},memo:{fields},identity:`zenith.workflow-start.v1:${intent.attempt_id}`,requestId:intent.attempt_id!,
      workflowTaskTimeout:msToTs("10s"),retryPolicy:{maximumAttempts:1},
      workflowIdReusePolicy:e.WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
      workflowIdConflictPolicy:e.WorkflowIdConflictPolicy.WORKFLOW_ID_CONFLICT_POLICY_FAIL});
    const spy=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
    await expect(f.second.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
    expect((await inventory(f))?.phase).toBe("attempted");expect(spy).not.toHaveBeenCalled();
  } finally {await f.close();}
});

const nondefaultStarts:readonly {name:string;settings:RawStartSettings}[]=[
  {name:"priority key",settings:{priority:{priorityKey:1}}},
  {name:"fairness key",settings:{priority:{fairnessKey:"isolated-nondefault"}}},
  {name:"fairness weight",settings:{priority:{fairnessWeight:2}}},
  {name:"enabled time skipping",settings:{timeSkippingConfig:{enabled:true}}},
  {name:"disabled propagation",settings:{timeSkippingConfig:{enabled:false,disablePropagation:true}}},
  {name:"skip-count override",settings:{timeSkippingConfig:{enabled:false,maxSessionSkipCount:1}}},
  {name:"continued failure",settings:{continuedFailure:{message:"isolated prior-run failure"}}},
  {name:"last completion result",settings:{lastCompletionResult:{payloads:[{metadata:{encoding:Buffer.from("json/plain")},data:Buffer.from('"isolated prior-run result"')}]}}},
];
for(const {name,settings} of nondefaultStarts) scenario(`actual Temporal raw Start with ${name} is not the retained canonical configuration`,async t=>{
  const f=await fixture(t);
  try {
    const original=await startRawOriginal(f,settings);
    // The real server must retain the altered field. A dropped/unsupported setting is not a passing refusal test.
    if(settings.priority)expect(original.attributes.priority).toMatchObject(settings.priority);
    if(settings.timeSkippingConfig)expect(original.attributes.timeSkippingConfig).toMatchObject(settings.timeSkippingConfig);
    if(settings.continuedFailure)expect(original.attributes.continuedFailure).toMatchObject(settings.continuedFailure);
    if(settings.lastCompletionResult) {
      const actual=original.attributes.lastCompletionResult?.payloads?.[0];
      expect(actual?.data).toBeDefined();
      expect(Buffer.from(actual!.data!)).toEqual(Buffer.from(settings.lastCompletionResult.payloads![0].data!));
      expect(Buffer.from(actual!.metadata!.encoding).toString()).toBe("json/plain");
    }
    const retained=await inventory(f),spy=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
    await expect(f.second.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
    expect(await inventory(f)).toEqual(retained);expect(retained?.phase).toBe("attempted");expect(spy).not.toHaveBeenCalled();
  } finally {await f.close();}
});

scenario("actual Temporal raw Start with explicit parentless priority and disabled time-skipping defaults confirms the same original",async t=>{
  const f=await fixture(t);
  try {
    const original=await startRawOriginal(f,{priority:{priorityKey:0,fairnessKey:"",fairnessWeight:1},
      timeSkippingConfig:{enabled:false,disablePropagation:false,maxSessionSkipCount:0}});
    expect(original.attributes.continuedFailure ?? null).toBeNull();expect(original.attributes.lastCompletionResult ?? null).toBeNull();
    const spy=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
    const confirmed=await f.second.start("dayTwo",f.input);
    expect(confirmed.runId).toBe(original.runId);expect(confirmed.intent.phase).toBe("acknowledged");expect(spy).not.toHaveBeenCalled();
  } finally {await f.close();}
});

// Supplementary pinned-wire response models, not provider acceptance receipts.
// Start cannot directly select inherited propagation/declined-upgrade fields.
// Each model changes only these fields on an independently fetched real original;
// protobuf encode/decode retains exact 1.24 message presence and scalar defaults.
const rawDefaultModels:readonly {name:string;patch:StartedAttributes}[]=[
  {name:"omitted",patch:{eagerExecutionAccepted:undefined,priority:undefined,timeSkippingConfig:undefined,timeSkippingStatePropagation:undefined,declinedTargetVersionUpgrade:undefined,continuedFailure:undefined,lastCompletionResult:undefined}},
  {name:"null",patch:{eagerExecutionAccepted:null,priority:null,timeSkippingConfig:null,timeSkippingStatePropagation:null,declinedTargetVersionUpgrade:null,continuedFailure:null,lastCompletionResult:null}},
  {name:"empty nested messages",patch:{eagerExecutionAccepted:false,priority:{},timeSkippingConfig:{},timeSkippingStatePropagation:{}}},
  {name:"explicit zero knobs",patch:{eagerExecutionAccepted:false,priority:{priorityKey:0,fairnessKey:"",fairnessWeight:0},
    timeSkippingConfig:{enabled:false,disablePropagation:false,maxSessionSkipCount:0},
    timeSkippingStatePropagation:{initialSkippedDuration:msToTs("0s"),initialSkipCount:0}}},
  {name:"documented unit fairness weight",patch:{priority:{priorityKey:0,fairnessKey:"",fairnessWeight:1}}},
];
const rawRefusalModels:readonly {name:string;patch:StartedAttributes}[]=[
  {name:"eager acceptance",patch:{eagerExecutionAccepted:true}},
  {name:"priority key",patch:{priority:{priorityKey:1}}},
  {name:"fairness key",patch:{priority:{fairnessKey:"different"}}},
  {name:"fairness weight",patch:{priority:{fairnessWeight:2}}},
  {name:"time skipping enabled",patch:{timeSkippingConfig:{enabled:true}}},
  {name:"empty fast-forward wrapper",patch:{timeSkippingConfig:{fastForwardConfig:{}}}},
  {name:"propagation disabled",patch:{timeSkippingConfig:{disablePropagation:true}}},
  {name:"skip-count override",patch:{timeSkippingConfig:{maxSessionSkipCount:1}}},
  {name:"propagated skipped seconds",patch:{timeSkippingStatePropagation:{initialSkippedDuration:msToTs("1s")}}},
  {name:"propagated skipped nanos",patch:{timeSkippingStatePropagation:{initialSkippedDuration:{...msToTs("0s"),nanos:1}}}},
  {name:"invalid duration cancelling to zero",patch:{timeSkippingStatePropagation:{initialSkippedDuration:{...msToTs("1s"),nanos:-1_000_000_000}}}},
  {name:"propagated skip count",patch:{timeSkippingStatePropagation:{initialSkipCount:1}}},
  {name:"empty fast-forward target wrapper",patch:{timeSkippingStatePropagation:{fastForwardTargetTime:{}}}},
  {name:"declined unversioned target wrapper",patch:{declinedTargetVersionUpgrade:{}}},
  {name:"empty continued-failure wrapper",patch:{continuedFailure:{}}},
  {name:"empty last-completion-result wrapper",patch:{lastCompletionResult:{}}},
];
for(const {name,patch} of [...rawDefaultModels,...rawRefusalModels]) {
  const allowed=rawDefaultModels.some(model=>model.patch === patch);
  scenario(`pinned raw response model ${name} ${allowed ? "accepts defaults" : "refuses confirmation"} without another Start`,async t=>{
    const f=await fixture(t);
    try {
      const original=await startRawOriginal(f),retained=await inventory(f);
      const real=f.client2.workflowService.getWorkflowExecutionHistory.bind(f.client2.workflowService);
      const shape=vi.spyOn(f.client2.workflowService,"getWorkflowExecutionHistory").mockImplementation(async req=>{
        const page=await real(req),events=page.history?.events;
        if(!events?.[0]?.workflowExecutionStartedEventAttributes)throw new Error("Owned Temporal original start event is absent.");
        const response=temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse;
        return response.decode(response.encode({...page,history:{...page.history,events:[{...events[0],
          workflowExecutionStartedEventAttributes:{...events[0].workflowExecutionStartedEventAttributes,...patch}},...events.slice(1)]}}).finish());
      });
      const spy=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
      if(allowed) {
        const confirmed=await f.second.start("dayTwo",f.input);
        expect(confirmed.runId).toBe(original.runId);expect(confirmed.intent.phase).toBe("acknowledged");
        shape.mockRestore();
        expect((await f.second.start("dayTwo",f.input)).intent.evidence_digest).toBe(confirmed.intent.evidence_digest);
      } else {
        await expect(f.second.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
        expect(await inventory(f)).toEqual(retained);expect(retained?.phase).toBe("attempted");
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {await f.close();}
  });
}

if(PG_URL) for(const change of ["unchanged","demoted approver","raised approval count","current policy deny"] as const)
  scenario(`real PostgreSQL final lock waiter ${change} permits only a fresh canonical Temporal dispatch`,async t=>{
    const f=await fixture(t),store=intents.createIsolatedStartIntentStoreForTests(f.h.broker);
    try {
    await store.prepare(f.db,f.request);
    const observer=await (observerPg ??= openPlatformDb({kind:"postgres",url:PG_URL!,max:1,migrate:false}));
    await observer.query("update platform.operations set expires_at=clock_timestamp()+interval '60 seconds',lease_until=clock_timestamp()+interval '60 seconds' where workspace_id=$1 and id=$2",[f.h.ids.wsA,f.p.id]);
    await observer.query("update platform.approvals set expires_at=clock_timestamp()+interval '60 seconds' where workspace_id=$1 and operation_id=$2",[f.h.ids.wsA,f.p.id]);
    let entered!:()=>void,release!:()=>void,backendReady!:()=>void,pid=0,claimantPid=0;
    const locked=new Promise<void>(resolve=>{entered=resolve;}),unlock=new Promise<void>(resolve=>{release=resolve;});
    const ready=new Promise<void>(resolve=>{backendReady=resolve;});
    const claimant:PlatformDbHandle={kind:f.db2.kind,identity:f.db2.identity,query:f.db2.query.bind(f.db2),exec:f.db2.exec.bind(f.db2),close:async()=>{},
      tx:async fn=>f.db2.tx(async tx=>{
        claimantPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
        backendReady();return fn(tx);
      })};
    const waiting=createIsolatedWorkflowStarterForTests(claimant,f.h.broker,f.client2,f.config,t.taskQueue);
    const blocker=f.db.tx(async tx=>{
      pid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
      await tx.query("select operation_id from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2 for update",[f.h.ids.wsA,f.p.id]);
      entered();await unlock;
    });
    await Promise.race([locked,blocker.then(()=>{throw new Error("Blocker exited before acquiring the owned intent-row lock.");})]);
    const spy=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
    let settled=false;
    const starting=waiting.start("dayTwo",f.input).then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
    let observationFailure:unknown;
    try {
      await Promise.race([ready,starting.then(()=>{throw new Error("Start completed before its PostgreSQL backend was observed.");})]);
      expect(claimantPid).toBeGreaterThan(0);expect(claimantPid).not.toBe(pid);
      await waitFor("actual final intent-row waiter",async()=>{
        const state=await observer.tx(async fresh=>{
          await fresh.query("select pg_stat_clear_snapshot()");
          return (await fresh.query<{blocked:boolean;observer_pid:number}>(`select pg_backend_pid() as observer_pid,
            exists (select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'
              and query=$3 and $2::integer=any(pg_blocking_pids(pid))) as blocked`,[claimantPid,pid,
              "select * from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2 for update"]))[0];
        });
        expect(state.observer_pid).not.toBe(claimantPid);expect(state.observer_pid).not.toBe(pid);
        return state.blocked;
      },5000);
      expect(settled).toBe(false);expect(spy).not.toHaveBeenCalled();
      expect((await intents.get(observer,f.h.ids.wsA,f.p.id))?.phase).toBe("prepared");
      if(change === "demoted approver")f.h.world.members.set(`${f.h.ids.wsA}|erin`,"viewer");
      if(change === "raised approval count")f.h.setEngine(scriptedEngine("locked-two",()=>requireApproval(2,"admin")));
      if(change === "current policy deny")f.h.setEngine(scriptedEngine("locked-deny",()=>({outcome:"deny",reasons:[]})));
      expect(await observer.query("select id from platform.operations where workspace_id=$1 and id=$2 and lease_until>clock_timestamp() and expires_at>clock_timestamp()",[f.h.ids.wsA,f.p.id])).toHaveLength(1);
    } catch(error) {observationFailure=error;} finally {release();await blocker;}
    const completed=await starting;
    if(observationFailure)throw observationFailure;
    if(change === "unchanged") {expect(completed).toHaveProperty("value.intent.phase","acknowledged");expect(spy).toHaveBeenCalledTimes(1);}
    else {expect(completed).toHaveProperty("error");expect((await inventory(f))?.phase).toBe("prepared");expect(spy).not.toHaveBeenCalled();}
    } finally {await f.close();}
  });

scenario("retention-equivalent deletion of this owned closed Temporal history preserves the SQL tombstone and never authorizes replay",async t=>{
  const f=await fixture(t);
  try {
    await t.run(async()=>{
      const original=await f.starter.start("dayTwo",f.input);await original.handle.result();
      await f.client.workflowService.deleteWorkflowExecution({namespace:f.config.namespace,workflowExecution:{workflowId:original.workflowId,runId:original.runId}});
      await waitFor("owned history removal",async()=>{
        try {await f.client2.workflow.getHandle(original.workflowId,original.runId).describe();return false;}
        catch(error){return error instanceof Error && error.name === "WorkflowNotFoundError";}
      },5000);
      const spy=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
      await expect(f.second.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
      expect((await inventory(f))?.phase).toBe("acknowledged");expect((await inventory(f))?.run_id).toBe(original.runId);
      expect(spy).not.toHaveBeenCalled();
    });
  } finally {await f.close();}
});

scenario("encrypted original input and memo round-trip through the configured codecs on independent readers",async t=>{
  const f=await fixture(t,true);
  try {
    const first=await f.starter.start("dayTwo",f.input);const second=await f.second.start("dayTwo",f.input);
    expect(second.runId).toBe(first.runId);expect(second.intent.evidence_digest).toBe(first.intent.evidence_digest);
    const page=await f.client.workflowService.getWorkflowExecutionHistory({namespace:f.config.namespace,
      execution:{workflowId:first.workflowId,runId:first.runId},maximumPageSize:1});
    const payload=page.history?.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
    expect(Buffer.from(payload!.metadata!.encoding).toString()).toBe("binary/zenith.temporal.v1");
    expect(Buffer.from(payload!.data!).toString()).not.toContain(f.input.operationId);
  } finally {await f.close();}
});

scenario("cancelled operation keeps an exact late accepted-start receipt and denies a new attempted writer",async t=>{
  const f=await fixture(t);const real=f.client.workflowService.startWorkflowExecution.bind(f.client.workflowService);
  const spy=vi.spyOn(f.client.workflowService,"startWorkflowExecution").mockImplementation(async req=>{
    const ack=await real(req);
    await operations.transition(f.db2,{workspaceId:f.h.ids.wsA,id:f.p.id,from:["running"],to:"cancelled"});
    return ack;
  });
  try {
    const late=await f.starter.start("dayTwo",f.input);expect(late.intent.phase).toBe("acknowledged");
    expect((await operations.get(f.db2,f.h.ids.wsA,f.p.id))?.status).toBe("cancelled");
    const spy2=vi.spyOn(f.client2.workflowService,"startWorkflowExecution");
    expect((await f.second.start("dayTwo",f.input)).runId).toBe(late.runId);
    expect(spy).toHaveBeenCalledTimes(1);expect(spy2).not.toHaveBeenCalled();
  } finally {await f.close();}
});

scenario("current role or policy revocation refuses a prepared intent before any Temporal Start call",async t=>{
  const f=await fixture(t);const store=intents.createIsolatedStartIntentStoreForTests(f.h.broker);
  try {
    await store.prepare(f.db,f.request);f.h.world.members.set(`${f.h.ids.wsA}|erin`,"viewer");
    const spy=vi.spyOn(f.client.workflowService,"startWorkflowExecution");
    await expect(f.starter.start("dayTwo",f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
    expect((await inventory(f))?.phase).toBe("prepared");expect(spy).not.toHaveBeenCalled();
    const old=process.env.NODE_ENV;
    try {vi.stubEnv("NODE_ENV","production");expect(()=>f.starter.start("dayTwo",f.input)).toThrow();}
    finally {vi.stubEnv("NODE_ENV",old);}
  } finally {await f.close();}
});

it("own scalar snapshot rejects accessors before store or SDK and strips extra serialization hooks",()=>{
  let reads=0;const input={workspaceId:"ws",operationId:"op",environmentId:"env",capability:"service.restart",
    toJSON:()=>{throw new Error("must not run");}};
  expect(intents.snapshotWorkflowArguments("dayTwo",input)).toEqual({workspaceId:"ws",operationId:"op",environmentId:"env",capability:"service.restart"});
  const accessor={...input};Object.defineProperty(accessor,"operationId",{get(){reads++;return "op";}});
  expect(()=>intents.snapshotWorkflowArguments("dayTwo",accessor)).toThrow();expect(reads).toBe(0);
});
it("production start refuses missing durable store and test seam is unavailable in production",async()=>{
  const old={NODE_ENV:process.env.NODE_ENV,ZENITH_PLATFORM_DB:process.env.ZENITH_PLATFORM_DB,ZENITH_PLATFORM_DB_URL:process.env.ZENITH_PLATFORM_DB_URL,
    SUPABASE_DB_URL:process.env.SUPABASE_DB_URL,ZENITH_SECRET_KEY:process.env.ZENITH_SECRET_KEY,ZENITH_PLATFORM_BROKER_MEMORY:process.env.ZENITH_PLATFORM_BROKER_MEMORY};
  try {
    vi.stubEnv("NODE_ENV","production");process.env.ZENITH_PLATFORM_DB="pglite";process.env.ZENITH_SECRET_KEY=randomBytes(32).toString("hex");
    delete process.env.ZENITH_PLATFORM_DB_URL;delete process.env.SUPABASE_DB_URL;
    await expect(startWorkflowIntent("dayTwo",{workspaceId:"ws",operationId:"op",environmentId:"env",capability:"service.restart"})).rejects.toBeInstanceOf(intents.WorkflowStartIntentError);
    process.env.ZENITH_PLATFORM_DB="postgres";process.env.ZENITH_PLATFORM_DB_URL="postgres://127.0.0.1:1/workflow-start-refusal";
    process.env.ZENITH_PLATFORM_BROKER_MEMORY="1";
    await expect(startWorkflowIntent("dayTwo",{workspaceId:"ws",operationId:"op",environmentId:"env",capability:"service.restart"})).rejects.toBeInstanceOf(intents.WorkflowStartIntentError);
    expect(()=>createIsolatedWorkflowStarterForTests(null as never,null as never,null as never,null as never,"queue")).toThrow();
  } finally {for(const [key,value] of Object.entries(old)){if(value === undefined)delete process.env[key];else process.env[key]=value;}}
});
