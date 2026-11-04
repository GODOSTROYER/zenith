import type { TenantBuildProfile } from "@/lib/providers/kubernetes/build/custody";
import { buildTenantKey } from "@/lib/providers/kubernetes/build/custody";
import type { BuildRequest, IsolatedBuildConfig } from "@/lib/providers/kubernetes/build";
export const config: IsolatedBuildConfig = {
 namespace: "zenith-build", builderImage: "example.invalid/builder@sha256:"+"1".repeat(64),
 runtimeClass:"userns",seccompProfile:"zenith-build.json",appArmorProfile:"zenith-build",
 proxy:{namespace:"zenith-build-proxy",ip:"10.96.0.100",port:3128,image:"example.invalid/proxy@sha256:"+"2".repeat(64),
 destinations:[{host:"registry.test",ip:"10.96.0.101",port:5000,tls:false}]},
 nodeIsolation:{tenant:"test",profileDigest:"7".repeat(64),systemDaemonSets:[]},
 timeoutSec:1800,
};
export const request: BuildRequest={workspaceId:"ws",environmentId:"env",operationId:"op",serviceAddress:"container_service/web",pipelineAddress:"build_pipeline/web",
 sourceSecret:"zsrc-"+"3".repeat(40),sourceDigest:"4".repeat(64),image:"registry.test:5000/web:zn-"+"5".repeat(40),dockerfile:"apps/web/Dockerfile",contextDir:"apps/web",idempotencyKey:"once"};

export const ref = { workspaceId: "ws-j6", environmentId: "env-j6", provider: "kubernetes" as const };
export const key = buildTenantKey(ref);
export const profile: TenantBuildProfile = {
  ...ref, server: "https://cluster.example.test",
  credentialRef: "vault:j6/controller", verifierCredentialRef: "vault:j6/verifier",
  registryRepositoryRoot: "registry.test:5000/" + key,
  config: { ...config, namespace: "zb-" + key, proxy: { ...config.proxy, namespace: "zp-" + key }, nodeIsolation: { ...config.nodeIsolation, tenant: key } },
};
