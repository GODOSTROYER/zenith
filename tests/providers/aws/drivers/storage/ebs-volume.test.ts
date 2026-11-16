/** EC2 SDK mocks test reads, failures and tenant isolation; no live AWS use. */
import { DescribeVolumesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ebsVolumeDriver as driver } from "@/lib/providers/aws/drivers/storage/ebs-volume";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import { awsError, compileCtx, driverCtx, mkNode, networkNodes, tagList } from "../data/_helpers";

const ec2 = mockClient(EC2Client);
beforeEach(() => ec2.reset());
afterAll(() => ec2.restore());
const id = "vol-0123456789abcdef0";
const volume = (spec: Record<string, unknown> = {}) => mkNode("volume/data", "volume", { sizeGb: 64, availabilityZone: "ap-south-1a", ...spec });
const instance = mkNode("compute_instance/worker", "compute_instance", {}, { dependsOn: ["subnet/private-a"] });
const nodes = [...networkNodes(), instance];
const compile = (spec: Record<string, unknown> = {}) => { const n = volume(spec); return driver.compile!(n, compileCtx([...nodes, n])); };
const record = { VolumeId: id, Size: 64, Encrypted: true, VolumeType: "gp3" as const, AvailabilityZone: "ap-south-1a", Tags: tagList("volume/data"), State: "available" as const, Attachments: [] };

describe("EBS compile", () => {
  it("creates an encrypted standalone gp3 volume in the declared AZ", () => {
    const f = compile();
    expect(f.addresses).toEqual(["aws_ebs_volume.volume_data"]);
    expect(f.resource!.aws_ebs_volume.volume_data).toMatchObject({ encrypted: true, type: "gp3", size: 64, availability_zone: "ap-south-1a", lifecycle: { prevent_destroy: true } });
  });
  it.each(["deny", "approval", "allow"])("protects according to deletion policy %s", (deletionPolicy) => {
    expect(compile({ deletionPolicy }).resource!.aws_ebs_volume.volume_data.lifecycle).toEqual({ prevent_destroy: deletionPolicy !== "allow" });
  });
  it("resolves AZ from a single subnet when the node has no literal AZ", () => {
    const n = { ...volume({ availabilityZone: undefined }), dependsOn: ["subnet/private-a"] };
    const f = driver.compile!(n, compileCtx([...nodes, n]));
    expect(f.resource!.aws_ebs_volume.volume_data.availability_zone).toBe("${local.ref_subnet_private_a__availability_zone}");
  });
  it("attaches only to the graph-named instance and guards its AZ agreement at plan time", () => {
    const f = compile({ instance: instance.address });
    expect(f.resource!.aws_volume_attachment.volume_data_attachment).toMatchObject({ instance_id: "${local.ref_compute_instance_worker__id}", device_name: "/dev/sdf", force_detach: false, lifecycle: { prevent_destroy: true } });
    expect(f.resource!.aws_ebs_volume.volume_data.availability_zone).toBe("${local.ref_subnet_private_a__availability_zone}");
    expect(f.resource!.aws_ebs_volume.volume_data.lifecycle).toMatchObject({ precondition: [{ condition: '${local.ref_subnet_private_a__availability_zone == "ap-south-1a"}' }] });
  });
  it("never infers an attachment from a compute dependency", () => {
    const n = { ...volume(), dependsOn: [instance.address] };
    expect(driver.compile!(n, compileCtx([...nodes, n])).resource!.aws_volume_attachment).toBeUndefined();
  });
  it("protects detachment too and permits it only with deletionPolicy=allow", () => {
    expect(compile({ instance: instance.address, deletionPolicy: "allow" }).resource!.aws_volume_attachment.volume_data_attachment.lifecycle).toEqual({ prevent_destroy: false });
  });
  it.each([
    { sizeGb: 0 }, { sizeGb: 1.5 }, { sizeGb: "64" }, { sizeGb: 16385 }, { encrypted: false }, { encryption: false },
    { storageClass: "gp2" }, { availabilityZone: "us-east-1a" }, { availabilityZone: "${file(\"x\")}" },
    { availabilityZone: undefined }, { deletionPolicy: "invalid" }, { instance: "compute_instance/missing" },
    { deviceName: "/dev/sda" }, { config: { password: "secret-canary" } },
  ])("refuses invalid or unsafe spec %j", (spec) => {
    expect(() => compile(spec)).toThrow(DriverCompileError);
    expect(driver.expectedAttributes!(volume(spec))).not.toBeUndefined();
  });
  it("refuses placement that disagrees with the named instance's subnet", () => {
    const n = { ...volume({ instance: instance.address }), dependsOn: ["subnet/private-b"] };
    expect(() => driver.compile!(n, compileCtx([...nodes, n]))).toThrow(/same placement subnet/);
  });
  it("refuses attachment to a referenced instance", () => {
    const n = volume({ instance: instance.address });
    expect(() => driver.compile!(n, compileCtx([...networkNodes(), { ...instance, ownership: "referenced" }, n]))).toThrow(/managed EC2/);
  });
  it.each(["referenced", "external"] as const)("compiles no resources for %s volumes", (ownership) => {
    expect(driver.compile!({ ...volume(), ownership }, compileCtx([]))).toEqual({ addresses: [] });
    expect(driver.expectedAttributes!({ ...volume(), ownership })).toEqual({});
  });
});

describe("EBS observation and verification", () => {
  it("reads only observed fields and verifies encryption/size/type/AZ", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [record] });
    const obs = await driver.observe!(driverCtx(), volume(), id);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.encrypted).toMatchObject({ state: "known", value: true });
    expect((await driver.verify!(driverCtx(), volume(), obs)).status).toBe("passed");
    expect((ec2.commandCalls(DescribeVolumesCommand)[0].args as unknown[])[1]).toHaveProperty("abortSignal");
  });
  it("fails when the requested attachment is missing", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [record] });
    const n = volume({ instance: instance.address });
    const obs = await driver.observe!(driverCtx(), n);
    expect((await driver.verify!(driverCtx(), n, obs)).status).toBe("failed");
  });
  it("keeps attachment target verification unknown when the context cannot resolve a graph address", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [{ ...record, Attachments: [{ InstanceId: "i-0123456789abcdef0", Device: "/dev/sdf", State: "attached" }] }] });
    const n = volume({ instance: instance.address });
    const obs = await driver.observe!(driverCtx(), n);
    const result = await driver.verify!(driverCtx(), n, obs);
    expect(result.status).toBe("unknown");
    expect(result.checks.find((check) => check.id === "attachment_target")?.passed).toBe("unknown");
  });
  it("uses the three tenant tags when no identifier is known", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [record] });
    await driver.observe!(driverCtx(), volume());
    expect(ec2.commandCalls(DescribeVolumesCommand)[0].args[0].input.Filters).toEqual(expect.arrayContaining([
      { Name: "tag:zenith:workspace", Values: ["ws_test"] }, { Name: "tag:zenith:environment", Values: ["env_test"] }, { Name: "tag:zenith:resource", Values: ["volume/data"] },
    ]));
  });
  it.each([["AccessDenied", "inaccessible"], ["InvalidVolume.NotFound", "missing"], ["Throttling", "unknown"]])("classifies %s as %s", async (name, presence) => {
    ec2.on(DescribeVolumesCommand).rejects(awsError(name));
    expect((await driver.observe!(driverCtx(), volume(), id)).presence).toBe(presence);
  });
  it("reports a successful empty describe as missing", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [] });
    expect((await driver.observe!(driverCtx(), volume())).presence).toBe("missing");
  });
  it("keeps omitted encryption unknown and never verifies it as secure", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [{ ...record, Encrypted: undefined }] });
    const obs = await driver.observe!(driverCtx(), volume());
    expect(obs.attributes.encrypted.state).toBe("unknown");
    expect((await driver.verify!(driverCtx(), volume(), obs)).status).toBe("unknown");
  });
  it("fails verification of a plaintext volume", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [{ ...record, Encrypted: false }] });
    const obs = await driver.observe!(driverCtx(), volume());
    expect((await driver.verify!(driverCtx(), volume(), obs)).status).toBe("failed");
  });
  it.each([
    [{ ...record, Tags: tagList("volume/data", { "zenith:workspace": "other" }) }],
    [record, { ...record, VolumeId: "vol-abcdef01234567890" }],
  ])("refuses foreign or duplicate tagged results %j", async (...records) => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: records });
    expect((await driver.observe!(driverCtx(), volume(), id)).presence).toBe("unknown");
  });
  it("refuses an invalid identifier without a cloud call or secret echo", async () => {
    const canary = "sensitive-canary";
    const obs = await driver.observe!(driverCtx(), volume(), canary);
    expect(obs.presence).toBe("unknown");
    expect(JSON.stringify(obs)).not.toContain(canary);
    expect(ec2.calls()).toHaveLength(0);
  });
  it("does not declare uniqueness after pagination truncates", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [record], NextToken: "stuck" });
    expect((await driver.observe!(driverCtx(), volume())).presence).toBe("unknown");
  });
  it("reads the next page before resolving the lookup", async () => {
    ec2.on(DescribeVolumesCommand).resolvesOnce({ Volumes: [], NextToken: "next" }).resolves({ Volumes: [record] });
    expect((await driver.observe!(driverCtx(), volume())).presence).toBe("present");
    expect(ec2.commandCalls(DescribeVolumesCommand)[1].args[0].input.NextToken).toBe("next");
  });
  it("honours an already-aborted signal", async () => {
    const c = new AbortController(); c.abort();
    await expect(driver.observe!(driverCtx({ signal: c.signal }), volume())).rejects.toHaveProperty("name", "AbortError");
    expect(ec2.calls()).toHaveLength(0);
  });
});
