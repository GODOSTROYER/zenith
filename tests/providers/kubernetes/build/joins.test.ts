/** Pure contracts only. These receipts are test data, never local-engine isolation evidence. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReleasePorts } from "@/lib/platform/release";
import { createDefaultManagedSubstrate } from "@/lib/platform/zenith-managed";
import { readBuildProfiles, tenantBuildProfile, buildProfileDigest, assertBuildRules } from "@/lib/providers/kubernetes/build/custody";
import { verifyBuildNodes } from "@/lib/providers/kubernetes/build/nodes";
import { BUILD_NODE_LABEL, BUILD_PROFILE_LABEL, BUILD_TAINT, renderJob } from "@/lib/providers/kubernetes/build/render";
import { renderBuildCustody } from "@/lib/providers/kubernetes/build/rbac";
import { assertBuildIsolation, BUILD_ISOLATION_PROFILES } from "@/lib/execution/build-isolation";
import { normalizedComponent } from "@/lib/execution/semantics/digest";
import type { ExecutableSemanticsInputs } from "@/lib/execution/semantics/digest";
import type { DriverContext } from "@/lib/drivers/types";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { config, request, ref, key, profile } from "./fixtures";

const environment = () => ({ ZENITH_ISOLATED_BUILD_PROFILES: JSON.stringify([profile]) });
const node = () => ({
  metadata: { name: "build-node", uid: "node-uid", labels: {
    [BUILD_NODE_LABEL]: key, [BUILD_PROFILE_LABEL]: profile.config.nodeIsolation.profileDigest.slice(0, 63), "kubernetes.io/hostname": "build-node" } },
  spec: { taints: ["NoSchedule", "NoExecute"].map(effect => ({ key: BUILD_TAINT, value: key, effect })) },
  status: { conditions: [{ type: "Ready", status: "True" }] },
});
afterEach(() => vi.unstubAllEnvs());

describe("tenant build joins", () => {
  it("binds native custody to exactly one environment with no shared namespace fallback", () => {
    expect(tenantBuildProfile(ref, environment())).toEqual(profile);
    expect(() => tenantBuildProfile({ ...ref, workspaceId: "other" }, environment())).toThrow(/no provisioned tenant/);
    const shared = structuredClone(profile); shared.config.namespace = config.namespace;
    expect(() => readBuildProfiles({ ZENITH_ISOLATED_BUILD_PROFILES: JSON.stringify([shared]) })).toThrow(/tenant-derived/);
    expect(() => readBuildProfiles({ ZENITH_ISOLATED_BUILD_PROFILES: JSON.stringify([profile, profile]) })).toThrow(/duplicate/);
  });
  it("does not allow a deployment credential reference to stand in for build verification", () => {
    const shared = { ...profile, verifierCredentialRef: profile.credentialRef };
    expect(() => readBuildProfiles({ ZENITH_ISOLATED_BUILD_PROFILES: JSON.stringify([shared]) })).toThrow(/separate credentials/);
  });
  it.each(["credentialRef", "verifierCredentialRef", "server", "registryRepositoryRoot"] as const)("moves the reviewed build profile when %s changes", field => {
    expect(buildProfileDigest({ ...profile, [field]: profile[field] + "-changed" })).not.toBe(buildProfileDigest(profile));
  });
  it("includes the runtime/node/allowlist profile in the DUR-B provenance component", () => {
    const inputs = { provenance: { pipelines: [], buildProfileDigest: buildProfileDigest(profile) } } as unknown as ExecutableSemanticsInputs;
    expect(normalizedComponent("provenance", inputs)).toEqual({ pipelines: [], buildProfileDigest: buildProfileDigest(profile) });
    const changed = structuredClone(profile); changed.config.nodeIsolation.profileDigest = "8".repeat(64);
    expect(buildProfileDigest(changed)).not.toBe(buildProfileDigest(profile));
  });
  it.each(["kubernetes", "zenith"] as const)("default factory refuses unprovisioned %s builds with the actionable profile reason", async provider => {
    vi.stubEnv("ZENITH_ISOLATED_BUILD_PROFILES", "");
    const managed = {} as ManagedSubstratePort;
    const port = createReleasePorts({ managed }).build;
    await expect(port.startBuild({ ...ref, provider, session: { provider } } as DriverContext, {} as never)).rejects.toThrow(/ZENITH_ISOLATED_BUILD_PROFILES/);
  });
  it("managed status exposes the new custody prerequisite before opening a credential", () => {
    vi.stubEnv("ZENITH_ISOLATED_BUILD_PROFILES", "");
    const status = createDefaultManagedSubstrate({ env: {} }).status();
    expect(status.build.available).toBe(false);
  });
  it("requires dedicated ready nodes and rejects co-located tenant/control-plane workloads", () => {
    expect(verifyBuildNodes(profile.config, [node()], [], "build-node")).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyBuildNodes(profile.config, [], [])).toThrow(/No tenant-dedicated/);
    const intruder = { metadata: { namespace: "another-tenant" }, spec: { nodeName: "build-node" }, status: { phase: "Running" } };
    expect(() => verifyBuildNodes(profile.config, [node()], [intruder])).toThrow(/unapproved workload/);
    const wrong = node(); wrong.spec.taints = [];
    expect(() => verifyBuildNodes(profile.config, [wrong], [])).toThrow(/isolation/);
    const moved = node(); moved.metadata.labels[BUILD_PROFILE_LABEL] = "changed";
    expect(() => verifyBuildNodes(profile.config, [moved], [])).toThrow(/runtime profile/);
  });
  it("uses scheduler selectors and taints for both proof and build, never bypassing admission with nodeName", () => {
    const job = renderJob(profile.config, request, false, "build-node");
    expect(job.spec?.template).toMatchObject({ spec: { nodeSelector: { [BUILD_NODE_LABEL]: key, "kubernetes.io/hostname": "build-node" }, tolerations: expect.arrayContaining([{ key: BUILD_TAINT, operator: "Equal", value: key, effect: "NoExecute" }]) } });
    expect(JSON.stringify(job.spec)).not.toContain('"nodeName"');
  });
  it("renders custody without granting either controller cluster writes, pod exec or secret access to the verifier", () => {
    const roles = renderBuildCustody(profile.config);
    const global = roles.find(r => r.kind === "ClusterRole")!;
    expect(JSON.stringify(global.rules)).not.toMatch(/create|patch|delete|secrets|exec/);
    expect(() => assertBuildRules([{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "create"] }], profile.config.namespace, profile.config)).not.toThrow();
    expect(() => assertBuildRules([{ apiGroups: ["apps"], resources: ["deployments"], verbs: ["patch"] }], profile.config.namespace, profile.config)).toThrow(/deployment/);
    expect(() => assertBuildRules([{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }], profile.config.namespace, profile.config)).toThrow();
  });
  it("native provenance cannot use the open-egress policy exception or metadata build identity", () => {
    const isolation = { profileId: BUILD_ISOLATION_PROFILES.kubernetes.id,
      identity: { principal: "system:serviceaccount:" + profile.config.namespace + ":zenith-builder", dedicated: true, deployCredentials: "absent" as const },
      metadata: { exposes: "none" as const, mechanism: "probe" }, network: { egress: "allowlisted" as const, verifiedBy: "provider_read" as const, allowlistDigest: "a".repeat(64), mechanism: "probe" },
      filesystem: { sourceMount: "read_only" as const }, dependencies: { downloads: "allowlisted" as const }, resources: { timeoutSec: 1800, computeClass: "k8s-2cpu-4gi" } };
    expect(assertBuildIsolation("kubernetes", isolation, { allowOpenEgress: false })).toEqual({ exceptions: [] });
    expect(() => assertBuildIsolation("kubernetes", { ...isolation, network: { ...isolation.network, egress: "unrestricted" } }, { allowOpenEgress: true })).toThrow(/do not allow/);
    expect(() => assertBuildIsolation("kubernetes", { ...isolation, metadata: { ...isolation.metadata, exposes: "build_identity_only" } }, { allowOpenEgress: false })).toThrow(/deny all/);
  });
});
