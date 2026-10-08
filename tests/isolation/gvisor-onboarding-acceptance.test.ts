/* eslint-disable @typescript-eslint/no-explicit-any */
/** Real default provisioning/custody/TokenRequest on kind. Approval/product doubles are explicitly contract-level. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultManagedSubstrate } from "@/lib/platform/zenith-managed";
import { createIsolationCustody } from "@/lib/platform/zenith-isolation-custody";
import { createPlatformPorts } from "@/lib/execution/platform";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import { createEffectLedger } from "@/lib/effects/ledger";
import { vaultCipherFromEnv } from "@/lib/secrets";
import type { AsyncSecretsBackend, SecretRecord } from "@/lib/secrets/backend";
import type { ProductContext, ProductPort } from "@/lib/execution/ports";
import { prepareIsolation } from "@/lib/execution/tenant-isolation";
import type { TenantIsolationRequest } from "@/lib/providers/zenith/onboarding";
import { LANES, openLane, seedApprovedOperation } from "../controlplane/_support/harness";
import { Kube, randomSuffix } from "./support";

const enabled = process.env.ZENITH_TEST_GVISOR_ONBOARDING === "1";
describe.skipIf(!enabled)("default onboarding on real gVisor kind (needs Docker/kind)", () => {
  const kube = new Kube(process.env.KUBECONFIG ?? "");
  const run = randomSuffix(); const records = new Map<string, SecretRecord>();
  let ctx: Awaited<ReturnType<typeof openLane>>; let valid=false; let createdOperatorNamespace=false;
  const owned: ReturnType<typeof prepareIsolation>[]=[];
  beforeAll(async () => {
    expect(process.env.KUBECONFIG).toBeTruthy(); expect(kube.contextName()).toMatch(/^kind-zenith-life07-[a-z0-9]{1,20}$/);
    expect(kube.json<any>(["get","runtimeclass","zenith-gvisor"])?.handler).toBe("runsc"); valid=true;
    ctx=await openLane(LANES[0]);
    if (!kube.json(["get","namespace","zenith-system"])) {
      const r=kube.create({apiVersion:"v1",kind:"Namespace",metadata:{name:"zenith-system",labels:{"zenith.dev/j14-onboarding-run":run}}}); expect(r.code,r.stderr).toBe(0); createdOperatorNamespace=true;
    }
  },120_000);
  afterAll(async () => {
    if (valid) for (const p of owned) {
      const namespace=kube.json<any>(["get","namespace",p.namespace]);
      if (namespace) {
        expect(namespace.metadata.annotations["zenith.dev/environment"]).toBe(p.tenant.environmentId);
        kube.must(["delete","namespace",p.namespace,"--ignore-not-found","--wait=true","--timeout=120s"]);
      }
      for (const o of p.bundle.operatorAccess.filter(o=>["ServiceAccount","ClusterRole","ClusterRoleBinding"].includes(o.kind))) {
        const live=kube.json<any>(["get",o.kind,o.metadata.name,...(o.metadata.namespace?["-n",o.metadata.namespace]:[])]);
        if (!live) continue;
        expect(live.metadata.annotations["zenith.dev/environment"]).toBe(p.tenant.environmentId);
        kube.must(["delete",o.kind,o.metadata.name,...(o.metadata.namespace?["-n",o.metadata.namespace]:[]),"--ignore-not-found"]);
      }
    }
    if (valid && createdOperatorNamespace) kube.must(["delete","namespace","-l",`zenith.dev/j14-onboarding-run=${run}`,"--ignore-not-found","--wait=true","--timeout=120s"]);
    if (ctx) await ctx.close();
  },240_000);
  it("refuses unreviewed first provisioning, then issues independently scoped real tokens for two tenants",async () => {
    const flat=JSON.parse(kube.must(["config","view","--raw","--minify","--flatten","-o","json"]));
    const cluster=flat.clusters[0].cluster;
    const bootstrap=kube.must(["config","view","--raw","--minify","--flatten","-o","yaml"]);
    const env={ ZENITH_SECRET_KEY:randomBytes(32).toString("hex"),ZENITH_MANAGED_CLUSTER_SERVER:cluster.server,ZENITH_MANAGED_CLUSTER_CA_DATA:cluster["certificate-authority-data"],ZENITH_MANAGED_KUBECONFIG_REF:"vault:j14/bootstrap",ZENITH_MANAGED_APP_DOMAIN:"apps.isolation.test",ZENITH_MANAGED_GATEWAY_MODE:"ingress",ZENITH_MANAGED_INGRESS_CLASS:"j14-no-serving",ZENITH_MANAGED_FQDN_ENGINE:"cilium",ZENITH_MANAGED_RUNTIME_CLASS:"zenith-gvisor",ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX:"vault:j14/operators" };
    const backend:AsyncSecretsBackend={kind:"file",get:async(s,r)=>records.get(`${s}|${r}`),list:async()=>[...records.values()],put:async(s,r)=>{records.set(`${s}|${r.ref}`,r);},putIfAbsent:async(s,r)=>{const saved=records.get(`${s}|${r.ref}`)??r;records.set(`${s}|${r.ref}`,saved);return saved;},remove:async()=>undefined};
    const product:Pick<ProductPort,"loadContext">={loadContext:async({workspaceId,environmentId})=>({workspace:{id:workspaceId,slug:"j14"},project:{id:"proj_1"},environment:{id:environmentId}} as ProductContext)};
    const managed=createDefaultManagedSubstrate({env,product,db:ctx.db,operatorCredentialBackend:backend,readPlatformSecret:async(scope,ref)=>{
      if(ref===env.ZENITH_MANAGED_KUBECONFIG_REF)return bootstrap;
      const value=await backend.get(scope,ref);return value?vaultCipherFromEnv(env).open(scope,ref,value).value:undefined;
    }});
    const ports=createPlatformPorts(ctx.db);
    for(let i=0;i<2;i++) {
      const seeded=await seedApprovedOperation(ctx.db,`ws-j14-onboarding-${i}-${run}`,{proposal:{scope:{workspaceId:`ws-j14-onboarding-${i}-${run}`,projectId:"proj_1",environmentId:`env-j14-${i}-${run}`}}});
      const tenant=await managed.tenants.resolve({workspaceId:seeded.workspaceId,environmentId:seeded.operation.environmentId!});
      const lease=await ports.leases.acquire({workspaceId:tenant.workspaceId,scope:`env:${tenant.environmentId}`,holder:`j14:${i}`,ttlMs:300_000});if(!lease)throw new Error("lease missing");
      const request:TenantIsolationRequest=managed.onboarding!.request(tenant,seeded.operation.id,lease,false); owned.push(prepareIsolation(request));
      let approved=false;let reviewed="";
      const provisioner=managed.onboarding!.provisioner({d:{...ports,semantics:createPlatformSemanticsStore(ctx.db),effects:createEffectLedger(ctx.db),isolationCustody:createIsolationCustody({db:ctx.db,ops:ports.ops,leases:ports.leases,cipher:vaultCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:randomBytes(32).toString("hex")},{purpose:"enc:plan-artifacts"})}),broker:{approvalStatus:async()=>({approved,rejected:false,approvalId:approved?"human-contract":undefined,dispatchApproval:{planDigest:reviewed,proposalDigest:seeded.operation.proposalDigest,approvalIds:["human-contract"],approvalRound:1,requiredApprovalCount:1}})}} as any,emit:async()=>{},evidence:async()=>undefined,log:()=>{},now:()=>new Date()});
      const plan=await provisioner.plan(request);reviewed=plan.planDigest;
      await expect(provisioner.apply(request,reviewed)).rejects.toMatchObject({code:"approval_required"});
      expect(kube.json(["get","namespace",plan.namespace])).toBeUndefined();expect(records.size).toBe(i);
      approved=true;const result=await provisioner.apply(request,reviewed);expect(result.verified).toBe(plan.objects.length);
      const session=await managed.openSession({workspaceId:tenant.workspaceId,environmentId:tenant.environmentId});expect((session.kubernetes as any).namespaces).toEqual([plan.namespace]);
      const subject=`system:serviceaccount:zenith-system:${owned[i].bundle.operatorSubject.name}`;
      expect(kube.canI(subject,"create","deployments",plan.namespace)).toBe(true);
      expect(kube.canI(subject,"create","deployments",owned[0].namespace===plan.namespace?"kube-system":owned[0].namespace)).toBe(false);
      await ports.leases.release(lease);
    }
    expect(records.size).toBe(2);expect(new Set([...records.values()].map(r=>r.ref)).size).toBe(2);
  },240_000);
});
