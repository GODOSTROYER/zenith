/**
 * `aws:ecr_repository` — the container registry a built workload pushes to.
 *
 * Compile (OpenTofu): one `aws_ecr_repository` (scan on push, AES256
 * encryption, tag mutability from `spec.immutableTags`, `force_delete` so an
 * environment teardown is not blocked by images — they are build outputs that
 * a rebuild reproduces) and one `aws_ecr_lifecycle_policy` that expires
 * everything beyond the newest 30 images. The 30-image rule counts untagged
 * images too and is the ONLY rule: expiring untagged images by age would be
 * unsafe because a deployment pins an image by digest, and a re-pushed tag
 * leaves its previous digest untagged while it may still be running.
 *
 * Observe / verify / discover are read-only ECR calls; there are no day-two
 * operations and no runtime state for a registry.
 *
 * Evidence: `contract` — SDK calls are exercised against aws-sdk-client-mock
 * and `tofu validate`; nothing has run against a real AWS account.
 */
import { DescribeRepositoriesCommand, ECRClient, GetLifecyclePolicyCommand, ListTagsForResourceCommand, type Repository } from "@aws-sdk/client-ecr";
import type { DiscoveredResource, ResourceDriver } from "@/lib/drivers/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import type { ContainerRegistrySpec } from "@/lib/resources/specs";
import type { AwsSession } from "@/lib/credentials/types";
import { attributesOf, boundNative, cloudName, failedObservation, hasZenithManagedTag, nodeName, paginate, parseArn, standardVerification, tfLabel, unknownValue } from "@/lib/providers/aws/drivers/shared";
import { compileNode, specOf } from "./support/driver-util";
import { failureOf, findByTags, listByType, tagsOf, type AwsCtx } from "./support/sdk";
import { Frag, attr, renderJsonText, tagsFor, type TfText } from "./support/tf";
import { DRIVER_IDS } from "./types";

const ID = DRIVER_IDS.ecrRepository;

/** How many images the lifecycle policy keeps. */
export const ECR_KEEP_LAST = 30;

const ATTRIBUTES = ["scanOnPush", "tagMutability", "encryption", "lifecycleKeepLast"] as const;

/* --------------------------------- compile -------------------------------- */

export function lifecyclePolicyText(): TfText {
  return renderJsonText({
    rules: [
      {
        rulePriority: 1,
        description: `Keep the newest ${ECR_KEEP_LAST} images`,
        selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: ECR_KEEP_LAST },
        action: { type: "expire" },
      },
    ],
  });
}

const ecrCompile: NonNullable<ResourceDriver<AwsSession>["compile"]> = (node, ctx) =>
  compileNode(node, () => {
    const spec = specOf<ContainerRegistrySpec>(node);
    const label = tfLabel(node.address);
    const b = new Frag(node.address);
    const name = cloudName(ctx.namePrefix, nodeName(node.address), 256);
    const repo = b.resource("aws_ecr_repository", label, {
      name,
      image_tag_mutability: spec.immutableTags ? "IMMUTABLE" : "MUTABLE",
      force_delete: true,
      image_scanning_configuration: [{ scan_on_push: true }], // the spec pins scanOnPush: true
      encryption_configuration: [{ encryption_type: "AES256" }],
      tags: tagsFor(ctx, node, name),
    });
    b.resource("aws_ecr_lifecycle_policy", label, { repository: attr(repo, "name"), policy: lifecyclePolicyText() });
    b.expose("arn", attr(repo, "arn"));
    b.expose("repository_url", attr(repo, "repository_url"));
    b.expose("name", attr(repo, "name"));
    return b.build(repo);
  });

/* --------------------------------- expected ------------------------------- */

function expected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ContainerRegistrySpec>(node);
  return {
    scanOnPush: true,
    tagMutability: spec.immutableTags ? "IMMUTABLE" : "MUTABLE",
    encryption: "AES256",
    lifecycleKeepLast: ECR_KEEP_LAST,
  };
}

/* --------------------------------- observe -------------------------------- */

/** `arn:…:repository/acme/api` → `acme/api`; a bare name is returned as-is when it is a valid repository name. */
export function repositoryNameOf(externalId: string): string | undefined {
  const arn = parseArn(externalId);
  const name = arn ? (arn.service === "ecr" && arn.resource.startsWith("repository/") ? arn.resource.slice("repository/".length) : undefined) : externalId;
  return name !== undefined && /^[a-z0-9][a-z0-9._/-]{1,255}$/.test(name) ? name : undefined;
}

async function keepLast(ctx: AwsCtx, ecr: ECRClient, repositoryName: string): Promise<number | undefined> {
  try {
    const res = await ecr.send(new GetLifecyclePolicyCommand({ repositoryName }), { abortSignal: ctx.signal });
    const doc = JSON.parse(res.lifecyclePolicyText ?? "{}") as { rules?: { selection?: { countType?: string; countNumber?: number }; action?: { type?: string } }[] };
    const rule = (doc.rules ?? []).find((r) => r.selection?.countType === "imageCountMoreThan" && r.action?.type === "expire");
    return rule?.selection?.countNumber ?? 0;
  } catch (e) {
    const f = failureOf(ctx, e);
    if (f.kind === "missing") return 0; // the API said: no lifecycle policy
    return undefined;
  }
}

async function readTags(ctx: AwsCtx, ecr: ECRClient, arn: string): Promise<Record<string, string> | undefined> {
  try {
    const res = await ecr.send(new ListTagsForResourceCommand({ resourceArn: arn }), { abortSignal: ctx.signal });
    return tagsOf(res.tags);
  } catch (e) {
    failureOf(ctx, e);
    return undefined;
  }
}

const ecrObserve: NonNullable<ResourceDriver<AwsSession>["observe"]> = async (ctx, node, externalId): Promise<Observation> => {
  const source = ID;
  let id = externalId;
  let taggedLookup: Record<string, string> | undefined;
  if (!id) {
    try {
      const found = await findByTags(ctx, node, "ecr:repository");
      if (found.length > 1) {
        return failedObservation(ctx, node, source, ATTRIBUTES, { kind: "error", code: "Ambiguous", summary: `${found.length} repositories carry the tags of ${node.address}.` });
      }
      if (found.length === 0) {
        return failedObservation(ctx, node, source, ATTRIBUTES, { kind: "missing", code: "NotFoundByTags", summary: "No ECR repository carries this node's Zenith tags (the tag index is eventually consistent)." });
      }
      id = found[0].arn;
      taggedLookup = found[0].tags;
    } catch (e) {
      return failedObservation(ctx, node, source, ATTRIBUTES, failureOf(ctx, e));
    }
  }
  const name = repositoryNameOf(id);
  if (!name) return failedObservation(ctx, node, source, ATTRIBUTES, { kind: "error", code: "InvalidExternalId", summary: "externalId is not an ECR repository ARN or name." }, id);

  const ecr = ctx.session.client(ECRClient);
  let repo: Repository | undefined;
  try {
    const res = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [name] }), { abortSignal: ctx.signal });
    repo = res.repositories?.[0];
  } catch (e) {
    return failedObservation(ctx, node, source, ATTRIBUTES, failureOf(ctx, e), id);
  }
  if (!repo) return failedObservation(ctx, node, source, ATTRIBUTES, { kind: "missing", code: "RepositoryNotFound", summary: "DescribeRepositories returned no repository." }, id);

  const arn = repo.repositoryArn ?? id;
  const [keep, tags] = await Promise.all([keepLast(ctx, ecr, name), taggedLookup ? Promise.resolve(taggedLookup) : readTags(ctx, ecr, arn)]);
  const values: Record<string, unknown> = {
    scanOnPush: repo.imageScanningConfiguration?.scanOnPush ?? false,
    tagMutability: repo.imageTagMutability ?? "MUTABLE",
    encryption: repo.encryptionConfiguration?.encryptionType ?? "AES256",
    ...(keep !== undefined ? { lifecycleKeepLast: keep } : {}),
  };
  const attributes = attributesOf(ctx, ATTRIBUTES, values);
  if (keep === undefined) attributes.lifecycleKeepLast = unknownValue("error", "the lifecycle policy could not be read");
  return {
    address: node.address,
    externalId: arn,
    presence: "present",
    attributes,
    native: boundNative(
      { repositoryName: repo.repositoryName, repositoryUri: repo.repositoryUri, registryId: repo.registryId, createdAt: repo.createdAt?.toISOString?.(), ...(tags ? { tags } : {}) },
      { priority: ["repositoryUri", "tags"] }
    ),
    observedAt: ctx.now().toISOString(),
    source,
    simulated: false,
  };
};

/* --------------------------------- discover ------------------------------- */

const ecrDiscover: NonNullable<ResourceDriver<AwsSession>["discover"]> = async (ctx): Promise<DiscoveredResource[]> => {
  const ecr = ctx.session.client(ECRClient);
  const { items: repos } = await paginate<Repository>(
    async (token) => {
      const res = await ecr.send(new DescribeRepositoriesCommand({ maxResults: 100, ...(token ? { nextToken: token } : {}) }), { abortSignal: ctx.signal });
      return { items: res.repositories ?? [], next: res.nextToken };
    },
    { maxPages: 5, signal: ctx.signal }
  );
  // Tags come from one (bounded) tagging-API listing rather than one call per repository.
  const tagsByArn = new Map<string, Record<string, string>>();
  try {
    for (const r of (await listByType(ctx, "ecr:repository")).items) tagsByArn.set(r.arn, r.tags);
  } catch (e) {
    failureOf(ctx, e);
  }
  return repos
    .filter((r) => r.repositoryArn && r.repositoryName)
    .map((r) => {
      const tags = tagsByArn.get(r.repositoryArn!) ?? {};
      return {
        provider: "aws" as const,
        kind: "container_registry" as const,
        nativeType: "aws:ecr_repository",
        externalId: r.repositoryArn!,
        name: r.repositoryName!,
        region: ctx.region,
        zenithTagged: hasZenithManagedTag(tags),
        attributes: {
          scanOnPush: r.imageScanningConfiguration?.scanOnPush ?? false,
          tagMutability: r.imageTagMutability ?? "MUTABLE",
          encryption: r.encryptionConfiguration?.encryptionType ?? "AES256",
        },
      };
    })
    .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
};

/* --------------------------------- driver --------------------------------- */

export const ecrRepositoryDriver: ResourceDriver<AwsSession> = {
  id: ID,
  provider: "aws",
  kind: "container_registry",
  nativeType: "aws:ecr_repository",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: ecrCompile,
  observe: ecrObserve,
  expectedAttributes: expected,
  verify: async (ctx, node, observation) => standardVerification(ctx, node, observation, expected(node), "The ECR repository"),
  discover: ecrDiscover,
};
