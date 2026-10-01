/** Structural EKS acceptance. These are compiler tests, not live AWS evidence. */
import { describe, expect, it } from "vitest";
import { eksClusterDriver as driver, EKS_LOG_TYPES } from "@/lib/providers/aws/drivers/eks/eks-cluster";
import { DriverCompileError, refLocalName, securityGroupLabel } from "@/lib/providers/aws/drivers/shared";
import { compileCtx, mkNode, networkNodes } from "../data/_helpers";

const cluster = (spec: Record<string, unknown> = {}) => mkNode("kubernetes_cluster/apps", "kubernetes_cluster", { version: "1.35", ...spec }, { dependsOn: ["subnet/private-a", "subnet/private-b"] });
const compile = (spec: Record<string, unknown> = {}) => { const n = cluster(spec); return driver.compile!(n, compileCtx([...networkNodes(), n])); };

describe("EKS secure declarative cluster", () => {
  it("lists its primary cluster first, pins the version, and uses a private endpoint", () => {
    const f = compile();
    expect(f.addresses[0]).toBe("aws_eks_cluster.kubernetes_cluster_apps");
    expect(f.resource!.aws_eks_cluster.kubernetes_cluster_apps).toMatchObject({ version: "1.35", vpc_config: [{ endpoint_private_access: true, endpoint_public_access: false }] });
  });
  it("encrypts secrets with a rotating KMS key and protects the key from destruction", () => {
    const f = compile();
    expect(f.resource!.aws_eks_cluster.kubernetes_cluster_apps.encryption_config).toEqual([{ provider: [{ key_arn: "${aws_kms_key.kubernetes_cluster_apps.arn}" }], resources: ["secrets"] }]);
    expect(f.resource!.aws_kms_key.kubernetes_cluster_apps).toMatchObject({ enable_key_rotation: true, deletion_window_in_days: 30, lifecycle: { prevent_destroy: true } });
  });
  it("can use an exact existing encryption key instead of creating a new one", () => {
    const kmsKeyArn = "arn:aws:kms:ap-south-1:123456789012:key/12345678-1234-1234-1234-123456789012";
    const f = compile({ kmsKeyArn });
    expect(f.resource!.aws_kms_key).toBeUndefined();
    expect(f.resource!.aws_eks_cluster.kubernetes_cluster_apps.encryption_config).toEqual([{ provider: [{ key_arn: kmsKeyArn }], resources: ["secrets"] }]);
  });
  it("restricts public access to an explicit sorted/deduplicated CIDR set while retaining private access", () => {
    const f = compile({ endpointPublicAccess: true, publicAccessCidrs: ["203.0.113.1/32", "192.0.2.0/24", "203.0.113.1/32"] });
    expect(f.resource!.aws_eks_cluster.kubernetes_cluster_apps.vpc_config).toMatchObject([{ endpoint_private_access: true, endpoint_public_access: true, public_access_cidrs: ["192.0.2.0/24", "203.0.113.1/32"] }]);
  });
  it("creates a managed node group in the same private subnets", () => {
    const f = compile();
    const g = f.resource!.aws_eks_node_group.kubernetes_cluster_apps;
    expect(g.subnet_ids).toEqual(["${local.ref_subnet_private_a__id}", "${local.ref_subnet_private_b__id}"]);
    expect(g).toMatchObject({ ami_type: "AL2023_x86_64_STANDARD", capacity_type: "ON_DEMAND", version: "1.35", scaling_config: [{ min_size: 1, desired_size: 2, max_size: 3 }] });
    expect(g.remote_access).toBeUndefined();
    expect(g.disk_size).toBeUndefined();
  });
  it("accepts explicit graph subnet addresses in native config without inferred dependencies", () => {
    const n = { ...cluster(), kind: "provider_native" as const, address: "provider_native/apps", dependsOn: [], spec: { type: "aws:eks_cluster", config: { version: "1.35", subnets: ["subnet/private-b", "subnet/private-a"] } } };
    const f = driver.compile!(n, compileCtx([...networkNodes(), n]));
    expect(f.resource!.aws_eks_node_group.provider_native_apps.subnet_ids).toEqual(["${local.ref_subnet_private_a__id}", "${local.ref_subnet_private_b__id}"]);
  });
  it("requires IMDSv2 and encrypted gp3 on managed nodes, without SSH keys", () => {
    const template = compile().resource!.aws_launch_template.kubernetes_cluster_apps;
    expect(template.metadata_options).toMatchObject([{ http_tokens: "required" }]);
    expect(template.block_device_mappings).toMatchObject([{ ebs: [{ encrypted: true, volume_type: "gp3" }] }]);
    expect(template.key_name).toBeUndefined();
  });
  it("installs the Pod Identity agent only after the managed group exists", () => {
    const f = compile({ podIdentityAddonVersion: "v1.3.7-eksbuild.2" });
    expect(f.resource!.aws_eks_addon.kubernetes_cluster_apps_pod_identity).toMatchObject({ addon_name: "eks-pod-identity-agent", addon_version: "v1.3.7-eksbuild.2", depends_on: ["aws_eks_node_group.kubernetes_cluster_apps"] });
  });
  it("enables all control-plane logs and creates the log group before the cluster", () => {
    const f = compile();
    const c = f.resource!.aws_eks_cluster.kubernetes_cluster_apps;
    expect(c.enabled_cluster_log_types).toEqual(EKS_LOG_TYPES);
    expect(c.depends_on).toContain("aws_cloudwatch_log_group.kubernetes_cluster_apps");
    expect(f.resource!.aws_cloudwatch_log_group.kubernetes_cluster_apps).toMatchObject({ name: "/aws/eks/zen-prod-apps/cluster", retention_in_days: 30 });
  });
  it("bounds both IAM roles and does not grant the cluster creator implicit admin", () => {
    const f = compile();
    for (const role of Object.values(f.resource!.aws_iam_role)) expect(role.permissions_boundary).toContain(":policy/ZenithWorkloadBoundary");
    expect(f.resource!.aws_eks_cluster.kubernetes_cluster_apps.access_config).toEqual([{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: false }]);
    for (const role of Object.values(f.resource!.aws_iam_role)) expect(String(role.assume_role_policy)).not.toMatch(/\*/);
  });
  it("uses the shared security-group labels and publishes the same ID to control plane/nodes", () => {
    const n = cluster(); const f = compile(); const label = securityGroupLabel(n.address);
    expect(Object.keys(f.resource!.aws_security_group)).toEqual([label]);
    expect(f.locals![refLocalName(n.address, "security_group_id")]).toBe(`\${aws_security_group.${label}.id}`);
    expect(f.resource!.aws_launch_template.kubernetes_cluster_apps.vpc_security_group_ids).toEqual([`\${aws_security_group.${label}.id}`]);
    const rules = Object.values(f.resource!.aws_vpc_security_group_ingress_rule);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ referenced_security_group_id: `\${aws_security_group.${label}.id}` });
    expect(rules[0].cidr_ipv4).toBeUndefined();
  });
  it("publishes endpoint, CA, name and OIDC issuer through non-secret locals", () => {
    const f = compile(); const address = cluster().address;
    expect(f.locals![refLocalName(address, "endpoint")]).toBe("${aws_eks_cluster.kubernetes_cluster_apps.endpoint}");
    expect(f.locals![refLocalName(address, "ca_data")]).toBe("${aws_eks_cluster.kubernetes_cluster_apps.certificate_authority[0].data}");
    expect(f.locals![refLocalName(address, "oidc_issuer")]).toBe("${aws_eks_cluster.kubernetes_cluster_apps.identity[0].oidc[0].issuer}");
    expect(f.locals![refLocalName(address, "cluster_name")]).toBe("${aws_eks_cluster.kubernetes_cluster_apps.name}");
    expect(JSON.stringify(f)).not.toMatch(/kubeconfig|access_key|secret_access|bearer|"token"/);
  });
  it.each([
    { version: undefined }, { version: "latest" }, { encryption: false },
    { endpointPublicAccess: true }, { endpointPublicAccess: true, publicAccessCidrs: ["0.0.0.0/0"] },
    { endpointPublicAccess: true, publicAccessCidrs: ["203.0.113.1/24"] },
    { endpointPublicAccess: true, publicAccessCidrs: ["${file(\"x\")}"] },
    { endpointPublicAccess: true, publicAccessCidrs: ["::/0"] }, { publicAccessCidrs: ["192.0.2.0/24"] },
    { nodeMin: 3 }, { nodeMax: 1 }, { nodeDesired: 0 }, { nodeDiskGb: 1 }, { nodeInstanceType: "t4g.medium" },
    { kmsKeyArn: "*" }, { kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012" },
    { config: { secret: "never-echo-this" } },
  ])("refuses invalid or unsafe desired configuration %j", (spec) => {
    expect(() => compile(spec)).toThrow(DriverCompileError);
  });
  it.each(["public", "same-zone", "different-network", "foreign-provider", "one-subnet"])("refuses unsuitable subnet topology: %s", (mode) => {
    const net = networkNodes();
    const n = cluster();
    if (mode === "public") net[1].spec.tier = "public";
    if (mode === "same-zone") net[2].spec.zone = "a";
    if (mode === "different-network") net[2].spec.network = "network/other";
    if (mode === "foreign-provider") net[1].provider = "gcp";
    if (mode === "one-subnet") n.dependsOn = ["subnet/private-a"];
    expect(() => driver.compile!(n, compileCtx([...net, n]))).toThrow(DriverCompileError);
  });
  it.each(["referenced", "external"] as const)("never creates resources for a %s cluster", (ownership) => {
    expect(driver.compile!({ ...cluster(), ownership }, compileCtx([]))).toEqual({ addresses: [] });
  });
  it("declares read implementations with contract evidence and keeps discovery unimplemented", () => {
    expect(driver.capabilities).toEqual({ compile: true, observe: true, runtime: true, verify: true, discover: false, operations: [], evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract" } });
    expect(driver.observe).toBeTypeOf("function");
    expect(driver.runtime).toBeTypeOf("function");
    expect(driver.verify).toBeTypeOf("function");
    expect(driver.discover).toBeUndefined();
  });
});
