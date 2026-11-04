import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { createPlatformPorts } from "@/lib/execution/platform";
import { createIsolationCustody } from "@/lib/platform/zenith-isolation-custody";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { prepareIsolation } from "@/lib/execution/tenant-isolation";
import type { TenantIsolationRequest } from "@/lib/providers/zenith/onboarding";
import { LANES, openLane, seedApprovedOperation } from "../controlplane/_support/harness";
import { FULL_ENV, substrate } from "../providers/zenith/support";

describe.each(LANES)("authenticated isolation custody ($name)",lane => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx=await openLane(lane); },120_000);
  afterAll(async () => { await ctx.close(); });
  async function fixture() {
    const seeded=await seedApprovedOperation(ctx.db);
    const ports=createPlatformPorts(ctx.db);
    const tenant={ workspaceId:seeded.workspaceId,environmentId:seeded.operation.environmentId!,workspaceSlug:"acme",environmentSlug:"prod",planTier:"starter" as const };
    const lease=await ports.leases.acquire({ workspaceId:tenant.workspaceId,scope:`env:${tenant.environmentId}`,holder:"custody-test",ttlMs:300_000 });
    if (!lease) throw new Error("test lease missing");
    const request:TenantIsolationRequest={ tenant,operationId:seeded.operation.id,lease,substrate:substrate({ ...FULL_ENV,ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX:"vault:zenith-managed/operators" }) };
    const prepared=prepareIsolation(request);
    const plan={ planDigest:digest({ bundle:prepared.bundleDigest,actions:"create" }),bundleDigest:prepared.bundleDigest,namespace:prepared.namespace,notes:[],objects:prepared.objects.map(o => ({kind:o.kind,name:o.metadata.name,namespace:o.metadata.namespace,action:"create" as const})) };
    const value={ review:{planDigest:plan.planDigest,semanticsDigest:digest("review")},isolationSemanticsDigest:digest("isolation-semantics"),plan,objects:prepared.objects };
    const cipher=vaultCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY:randomBytes(32).toString("hex") },{purpose:"enc:plan-artifacts"});
    const custody=createIsolationCustody({ db:ctx.db,ops:ports.ops,leases:ports.leases,cipher });
    return { ports,request,plan,value,cipher,custody };
  }
  it("encrypts a write-once artifact and authenticates exact scope on reopen",async () => {
    const f=await fixture(); await f.custody.publish(f.request,f.value); await f.custody.publish(f.request,f.value);
    const rows=await ctx.db.query<{ciphertext:string;artifact_digest:string}>("select ciphertext,artifact_digest from platform.isolation_plan_custody where workspace_id=$1 and operation_id=$2",[f.request.tenant.workspaceId,f.request.operationId]);
    expect(rows).toHaveLength(1); expect(rows[0].ciphertext).not.toContain(f.plan.namespace);
    await expect(f.custody.inspect(f.request,f.plan.planDigest,async a => a.plan)).resolves.toEqual(f.plan);
    await expect(f.custody.publish(f.request,{ ...f.value,isolationSemanticsDigest:digest("different") })).rejects.toThrow();
    await expect(ctx.db.query("update platform.isolation_plan_custody set ciphertext=$3 where workspace_id=$1 and operation_id=$2",[f.request.tenant.workspaceId,f.request.operationId,randomBytes(10).toString("base64")])).rejects.toThrow(/write-once/);
    await expect(ctx.db.query("delete from platform.isolation_plan_custody where workspace_id=$1 and operation_id=$2",[f.request.tenant.workspaceId,f.request.operationId])).rejects.toThrow(/write-once/);
  });
  it("rejects a wrong decryption key and never invokes the callback",async () => {
    const f=await fixture(); await f.custody.publish(f.request,f.value); const callback=vi.fn();
    const other=createIsolationCustody({ db:ctx.db,ops:f.ports.ops,leases:f.ports.leases,cipher:vaultCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY:randomBytes(32).toString("hex") },{purpose:"enc:plan-artifacts"}) });
    await expect(other.inspect(f.request,f.plan.planDigest,callback)).rejects.toThrow(/unavailable/); expect(callback).not.toHaveBeenCalled();
  });
  it.each(["workspace","environment","lease","expiry","terminal"])("refuses changed %s authority before opening custody",async reason => {
    const f=await fixture(); await f.custody.publish(f.request,f.value); const callback=vi.fn();
    const request=structuredClone(f.request);
    if (reason==="workspace") request.tenant.workspaceId="foreign-workspace";
    if (reason==="environment") request.tenant.environmentId="foreign-environment";
    if (reason==="lease") await f.ports.leases.release(f.request.lease as Parameters<typeof f.ports.leases.release>[0]);
    if (reason==="terminal") await f.ports.ops.transition({ workspaceId:request.tenant.workspaceId,operationId:request.operationId,to:"cancelled" });
    const custody=reason==="expiry" ? createIsolationCustody({ db:ctx.db,ops:f.ports.ops,leases:f.ports.leases,cipher:f.cipher,now:() => new Date("2100-01-01") }) : f.custody;
    await expect(custody.inspect(request,f.plan.planDigest,callback)).rejects.toThrow(); expect(callback).not.toHaveBeenCalled();
  });
});
