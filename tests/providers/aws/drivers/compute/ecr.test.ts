/**
 * `aws:ecr_repository`: compile structure and the read side against a mocked
 * ECR / tagging API. Contract evidence only.
 */
import { DescribeRepositoriesCommand, ECRClient, GetLifecyclePolicyCommand, ListTagsForResourceCommand } from "@aws-sdk/client-ecr";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { ECR_KEEP_LAST, ecrRepositoryDriver as driver } from "@/lib/providers/aws/drivers/compute/ecr-repository";
import { refLocalName } from "@/lib/providers/aws/drivers/compute/support/aws-shared";
import { buildFixture, mkCompileContext, mkDriverContext, zenithTagList, zenithTagMap } from "./fixtures";
import { ACCOUNT, REGISTRY_ARN } from "./ecs-mocks";

const ecr = mockClient(ECRClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => {
  ecr.restore();
  tagging.restore();
});
beforeEach(() => {
  ecr.reset();
  tagging.reset();
});

const fx = buildFixture();
const node = fx.byAddress.get("container_registry/web")!;
const res = (f: TofuFragment, type: string, label: string) => (f.resource as Record<string, Record<string, Record<string, unknown>>>)[type][label];

describe("compile", () => {
  it("scans on push, encrypts with AES256, keeps tags mutable, and expires beyond the newest 30 images", () => {
    const f = driver.compile!(node, mkCompileContext(fx.byAddress));
    expect(f.addresses).toEqual(["aws_ecr_repository.container_registry_web", "aws_ecr_lifecycle_policy.container_registry_web"]);
    expect(res(f, "aws_ecr_repository", "container_registry_web")).toMatchObject({
      name: "zn-acme-web",
      image_tag_mutability: "MUTABLE",
      force_delete: true,
      image_scanning_configuration: [{ scan_on_push: true }],
      encryption_configuration: [{ encryption_type: "AES256" }],
      tags: { "zenith:resource": "container_registry/web", "zenith:managed": "true", Name: "zn-acme-web" },
    });
    const policy = JSON.parse(res(f, "aws_ecr_lifecycle_policy", "container_registry_web").policy as string);
    expect(policy.rules).toEqual([{ rulePriority: 1, description: `Keep the newest ${ECR_KEEP_LAST} images`, selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 30 }, action: { type: "expire" } }]);
    expect(res(f, "aws_ecr_lifecycle_policy", "container_registry_web").repository).toBe("${aws_ecr_repository.container_registry_web.name}");
  });

  it("does NOT expire untagged images by age (a deployment pins by digest, and a re-pushed tag leaves its old digest untagged)", () => {
    const f = driver.compile!(node, mkCompileContext(fx.byAddress));
    expect(res(f, "aws_ecr_lifecycle_policy", "container_registry_web").policy).not.toContain("untagged");
    expect(res(f, "aws_ecr_lifecycle_policy", "container_registry_web").policy).not.toContain("sinceImagePushed");
  });

  it("publishes arn, repository_url and name for the workloads and the build pipeline", () => {
    const f = driver.compile!(node, mkCompileContext(fx.byAddress));
    expect(f.locals).toEqual({
      [refLocalName("container_registry/web", "arn")]: "${aws_ecr_repository.container_registry_web.arn}",
      [refLocalName("container_registry/web", "name")]: "${aws_ecr_repository.container_registry_web.name}",
      [refLocalName("container_registry/web", "repository_url")]: "${aws_ecr_repository.container_registry_web.repository_url}",
    });
  });

  it("honours immutableTags when the spec asks for it", () => {
    const n = { ...node, spec: { scanOnPush: true, immutableTags: true } };
    expect(res(driver.compile!(n, mkCompileContext(fx.byAddress)), "aws_ecr_repository", "container_registry_web").image_tag_mutability).toBe("IMMUTABLE");
    expect(driver.expectedAttributes!(n)).toMatchObject({ tagMutability: "IMMUTABLE" });
  });

  it("is deterministic, cuts over-long names with a hash, and compiles non-managed nodes to nothing", () => {
    const ctx = mkCompileContext(fx.byAddress);
    expect(JSON.stringify(driver.compile!(node, ctx))).toBe(JSON.stringify(driver.compile!(node, ctx)));
    const long = { ...node, address: `container_registry/${"x".repeat(300)}` };
    const repos = driver.compile!(long, ctx).resource!.aws_ecr_repository;
    const cloudName = Object.values(repos)[0].name as string;
    expect(cloudName.length).toBeLessThanOrEqual(256);
    expect(cloudName).toMatch(/^zn-acme-x+-[0-9a-f]{6}$/);
    expect(driver.compile!({ ...node, ownership: "referenced" }, ctx)).toEqual({ addresses: [] });
  });

  it("declares contract evidence, no operations and no runtime", () => {
    expect(driver.capabilities).toMatchObject({ compile: true, observe: true, runtime: false, verify: true, discover: true, operations: [] });
    expect(Object.values(driver.capabilities.evidence).every((v) => v === "contract")).toBe(true);
    expect(driver.runtime).toBeUndefined();
  });
});

const repo = (over: Record<string, unknown> = {}) => ({
  repositoryArn: REGISTRY_ARN,
  repositoryName: "zn-acme-web",
  registryId: ACCOUNT,
  repositoryUri: `${ACCOUNT}.dkr.ecr.eu-west-1.amazonaws.com/zn-acme-web`,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  imageTagMutability: "MUTABLE" as const,
  imageScanningConfiguration: { scanOnPush: true },
  encryptionConfiguration: { encryptionType: "AES256" as const },
  ...over,
});
const policyText = (n = 30) => JSON.stringify({ rules: [{ rulePriority: 1, selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: n }, action: { type: "expire" } }] });
const tagsList = () => zenithTagList("container_registry/web");

function installPresent() {
  ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [repo()] });
  ecr.on(GetLifecyclePolicyCommand).resolves({ lifecyclePolicyText: policyText() });
  ecr.on(ListTagsForResourceCommand).resolves({ tags: tagsList() });
}

describe("observe", () => {
  it("reads the configuration by ARN and keeps the provider identifiers and tags", async () => {
    installPresent();
    const obs = await driver.observe!(mkDriverContext(), node, REGISTRY_ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: REGISTRY_ARN, source: "aws.ecr_repository@1", simulated: false });
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, (v as { value: unknown }).value]))).toEqual({ scanOnPush: true, tagMutability: "MUTABLE", encryption: "AES256", lifecycleKeepLast: 30 });
    expect(obs.native).toMatchObject({ repositoryName: "zn-acme-web", repositoryUri: `${ACCOUNT}.dkr.ecr.eu-west-1.amazonaws.com/zn-acme-web`, tags: zenithTagMap("container_registry/web") });
    expect(ecr.commandCalls(DescribeRepositoriesCommand)[0].args[0].input).toEqual({ repositoryNames: ["zn-acme-web"] });
    expect(Object.keys(obs.attributes).sort()).toEqual(Object.keys(driver.expectedAttributes!(node)).sort());
  });

  it("finds the repository by tags when no externalId is known", async () => {
    installPresent();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: REGISTRY_ARN, Tags: tagsList() }] });
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs.presence).toBe("present");
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input.ResourceTypeFilters).toEqual(["ecr:repository"]);
    // tags came with the lookup: no second call for them
    expect(ecr.commandCalls(ListTagsForResourceCommand)).toHaveLength(0);
  });

  it("reports drift-relevant facts as they are: a repository with scanning off and a different lifecycle count", async () => {
    installPresent();
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [repo({ imageScanningConfiguration: { scanOnPush: false }, imageTagMutability: "IMMUTABLE" })] });
    ecr.on(GetLifecyclePolicyCommand).resolves({ lifecyclePolicyText: policyText(5) });
    const obs = await driver.observe!(mkDriverContext(), node, REGISTRY_ARN);
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v.status).toBe("failed");
    expect(v.checks.filter((c) => c.passed === false).map((c) => c.id).sort()).toEqual(["attr:lifecycleKeepLast", "attr:scanOnPush", "attr:tagMutability"]);
  });

  it("a missing lifecycle policy (the API said so) is 0 images kept, i.e. drift, not an unknown", async () => {
    installPresent();
    ecr.on(GetLifecyclePolicyCommand).rejects(Object.assign(new Error("none"), { name: "LifecyclePolicyNotFoundException" }));
    const obs = await driver.observe!(mkDriverContext(), node, REGISTRY_ARN);
    expect(obs.attributes.lifecycleKeepLast).toMatchObject({ state: "known", value: 0 });
  });

  it("an unreadable lifecycle policy degrades that one attribute", async () => {
    installPresent();
    ecr.on(GetLifecyclePolicyCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }));
    const obs = await driver.observe!(mkDriverContext(), node, REGISTRY_ARN);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.lifecycleKeepLast).toMatchObject({ state: "unknown", reason: "error" });
    expect(obs.attributes.scanOnPush.state).toBe("known");
    expect((await driver.verify!(mkDriverContext(), node, obs)).status).toBe("unknown");
  });

  it("missing: RepositoryNotFoundException, nothing by tags", async () => {
    ecr.on(DescribeRepositoriesCommand).rejects(Object.assign(new Error("not found"), { name: "RepositoryNotFoundException" }));
    expect((await driver.observe!(mkDriverContext(), node, REGISTRY_ARN)).presence).toBe("missing");
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs.presence).toBe("missing");
    expect(Object.values(obs.attributes).every((a) => a.state === "unknown")).toBe(true);
  });

  it("inaccessible on access denied; unknown on throttling or a bad externalId; a hit with no repositories is missing", async () => {
    ecr.on(DescribeRepositoriesCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    expect((await driver.observe!(mkDriverContext(), node, REGISTRY_ARN)).presence).toBe("inaccessible");
    ecr.reset();
    ecr.on(DescribeRepositoriesCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }));
    expect((await driver.observe!(mkDriverContext(), node, REGISTRY_ARN)).presence).toBe("unknown");
    ecr.reset();
    expect((await driver.observe!(mkDriverContext(), node, "Not A Repo")).presence).toBe("unknown");
    expect(ecr.commandCalls(DescribeRepositoriesCommand)).toHaveLength(0);
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [] });
    expect((await driver.observe!(mkDriverContext(), node, REGISTRY_ARN)).presence).toBe("missing");
  });

  it("unknown when two repositories carry the node's tags", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: REGISTRY_ARN, Tags: tagsList() }, { ResourceARN: `${REGISTRY_ARN}-2`, Tags: tagsList() }] });
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs.presence).toBe("unknown");
  });

  it("re-throws an abort", async () => {
    const ac = new AbortController();
    ecr.on(DescribeRepositoriesCommand).callsFake(() => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(driver.observe!(mkDriverContext({ signal: ac.signal }), node, REGISTRY_ARN)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("verify", () => {
  it("passes a matching repository and is failed (only `exists`) for a missing one", async () => {
    installPresent();
    const obs = await driver.observe!(mkDriverContext(), node, REGISTRY_ARN);
    expect((await driver.verify!(mkDriverContext(), node, obs)).status).toBe("passed");
    ecr.reset();
    ecr.on(DescribeRepositoriesCommand).rejects(Object.assign(new Error("nf"), { name: "RepositoryNotFoundException" }));
    const missing = await driver.observe!(mkDriverContext(), node, REGISTRY_ARN);
    expect(await driver.verify!(mkDriverContext(), node, missing)).toMatchObject({ status: "failed", checks: [{ id: "exists", passed: false }] });
  });
});

describe("discover", () => {
  it("lists repositories with their tags, marks Zenith-created ones, and never reports adoption", async () => {
    const other = repo({ repositoryArn: `arn:aws:ecr:eu-west-1:${ACCOUNT}:repository/legacy`, repositoryName: "legacy", imageTagMutability: "IMMUTABLE" });
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [repo(), other] });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: REGISTRY_ARN, Tags: tagsList() }] });
    const found = await driver.discover!(mkDriverContext());
    expect(Object.fromEntries(found.map((f) => [f.name, f.zenithTagged]))).toEqual({ "zn-acme-web": true, legacy: false });
    expect(found.find((f) => f.name === "legacy")).toMatchObject({ kind: "container_registry", nativeType: "aws:ecr_repository", attributes: { tagMutability: "IMMUTABLE" } });
  });

  it("is bounded to five pages of repositories", async () => {
    let pages = 0;
    ecr.on(DescribeRepositoriesCommand).callsFake(() => {
      pages += 1;
      return { repositories: [], nextToken: `p${pages}` };
    });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    await driver.discover!(mkDriverContext());
    expect(pages).toBe(5);
  });

  it("still lists repositories when the tag index is unreadable (they are then simply untagged)", async () => {
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [repo()] });
    tagging.on(GetResourcesCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    const found = await driver.discover!(mkDriverContext());
    expect(found).toHaveLength(1);
    expect(found[0].zenithTagged).toBe(false);
  });
});
