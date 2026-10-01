/**
 * `aws:secretsmanager_secret` driver (kind `secret`): the secret CONTAINER only.
 *
 * INVARIANT: no secret value ever passes through OpenTofu, its state or its
 * plan, and this driver never reads one. Concretely:
 *
 *   - compile emits `aws_secretsmanager_secret` and nothing else: no
 *     `aws_secretsmanager_secret_version`, no `random_password`, no value;
 *   - observe calls DescribeSecret only. The API that returns a secret's value
 *     (and its batch variant) is never called, anywhere in this module, and the
 *     tests assert the mock never receives it;
 *   - values are written by the execution worker's secret-sync activity from the
 *     Zenith vault through `syncSecretValue` (`secretsmanager-sync.ts`): the
 *     value passes through memory only.
 *
 * The container: name `zenith/<namePrefix>/<node name>` (the node name already
 * carries a digest of the vault reference, so distinct references never
 * collide), AWS-managed KMS key, a 7-day recovery window, Zenith tags.
 *
 * `referenced`/`external` secrets (a provider secret Zenith only points at)
 * compile to nothing; identity grants use the ARN in their `externalRef`.
 *
 * Expectation for drift/verify: the container exists, is not scheduled for
 * deletion, and (verify only) has a current version, i.e. the vault value was
 * synced. A secret without a value is reported, not assumed fine.
 *
 * Honest limits: whether the stored value equals the vault's cannot be checked
 * without reading it, which this driver refuses to do; a destroyed secret
 * keeps its name reserved for the 7-day recovery window, so destroying and
 * re-creating the same node within that window fails at apply (AWS refuses the
 * name; restore or wait); `contract` evidence only.
 */
import { DescribeSecretCommand, ListSecretsCommand, SecretsManagerClient, type DescribeSecretResponse } from "@aws-sdk/client-secrets-manager";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { cloudName, FragmentBuilder, isArnOf, nodeName, paginate, parseArn, REF, resourceTags, tfLabel } from "@/lib/providers/aws/drivers/shared";
import {
  attrCheck,
  Attributes,
  call,
  candidate,
  EMPTY_FRAGMENT,
  expectedFor,
  findByTags,
  guardObserve,
  isManaged,
  matchesExpectedCheck,
  scalars,
  tagMap,
  verificationOf,
  type AwsDriverContext,
  type ReadResult,
} from "./support";

export const SECRET_SOURCE = "aws.secretsmanager_secret@1";
export const RECOVERY_WINDOW_DAYS = 7;

/** Secret names and ids: Secrets Manager allows `[A-Za-z0-9/_+=.@-]`, up to 512; ARNs add a `-XXXXXX` suffix. */
const SECRET_ID = /^[A-Za-z0-9/_+=.@-]{1,512}$/;

/** `zenith/<namePrefix>/<node name>`: deterministic, valid, at most 512 characters. */
export function secretNameFor(ctx: Pick<CompileContext, "namePrefix">, address: string): string {
  return `zenith/${cloudName(ctx.namePrefix, nodeName(address), 200)}`;
}

export function compileSecretContainer(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return { ...EMPTY_FRAGMENT };
  const label = tfLabel(node.address);
  const name = secretNameFor(ctx, node.address);
  const b = new FragmentBuilder(node.address);
  b.resource("aws_secretsmanager_secret", label, {
    name,
    description: "Zenith managed secret container. The value is synced from the Zenith vault and is never part of OpenTofu state.",
    recovery_window_in_days: RECOVERY_WINDOW_DAYS,
    tags: resourceTags(ctx.tags, node.address),
  });
  b.expose(REF.arn, `aws_secretsmanager_secret.${label}.arn`);
  b.expose(REF.id, `aws_secretsmanager_secret.${label}.id`);
  b.expose("name", `aws_secretsmanager_secret.${label}.name`);
  b.output(`${label}_arn`, `\${aws_secretsmanager_secret.${label}.arn}`, { description: "Reference only; the value is never in state." });
  return b.build();
}

/* --------------------------------- reading --------------------------------- */

const EXPECTED_NAMES = ["pendingDeletion"] as const;
const INFORMATIONAL_NAMES = ["hasCurrentVersion", "versionCount", "kmsKey", "rotationEnabled", "lastChangedDate"] as const;
export const SECRET_ATTRIBUTE_NAMES: readonly string[] = [...EXPECTED_NAMES, ...INFORMATIONAL_NAMES];

export function expectedSecretAttributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => ({ pendingDeletion: false }));
}

/** An ARN, or a bare name, to the `SecretId` DescribeSecret takes. */
export function secretIdOf(externalId: string | undefined): string | undefined {
  if (externalId === undefined || externalId === "") return undefined;
  if (externalId.startsWith("arn:")) {
    if (!isArnOf(externalId, "secretsmanager", "secret")) return undefined;
    return SECRET_ID.test((parseArn(externalId)?.resource ?? "").slice("secret:".length)) ? externalId : undefined;
  }
  return SECRET_ID.test(externalId) ? externalId : undefined;
}

/** DescribeSecret for the node's secret; `missing` when absent; never reads a value. */
export async function describeNodeSecret(
  ctx: AwsDriverContext,
  node: ResourceNode,
  externalId: string | undefined
): Promise<{ secret: DescribeSecretResponse } | "missing" | { ambiguous: string }> {
  let id = secretIdOf(externalId);
  if (externalId !== undefined && externalId !== "" && id === undefined) return { ambiguous: "externalId is not a secret ARN or name" };
  if (id === undefined) {
    const { matches } = await findByTags(ctx, node, "secretsmanager:secret");
    const arns = matches.map((m) => m.arn).filter((a) => isArnOf(a, "secretsmanager", "secret"));
    if (arns.length === 0) return "missing";
    if (arns.length > 1) return { ambiguous: `${arns.length} secrets carry the Zenith tags for ${node.address}; refusing to choose one` };
    id = arns[0];
  }
  const sm = ctx.session.client(SecretsManagerClient);
  const SecretId = id;
  return { secret: await call(ctx, (o) => sm.send(new DescribeSecretCommand({ SecretId }), o)) };
}

async function observeSecret(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  return guardObserve(
    ctx,
    node,
    SECRET_SOURCE,
    SECRET_ATTRIBUTE_NAMES,
    externalId,
    async (): Promise<ReadResult> => {
      const found = await describeNodeSecret(ctx, node, externalId);
      if (found === "missing") return { kind: "missing" };
      if ("ambiguous" in found) return { kind: "ambiguous", detail: found.ambiguous };
      const s = found.secret;
      const stages = s.VersionIdsToStages ?? {};
      const a = new Attributes(ctx);
      a.set("pendingDeletion", s.DeletedDate !== undefined);
      a.set("hasCurrentVersion", Object.values(stages).some((st) => st.includes("AWSCURRENT")));
      a.set("versionCount", Object.keys(stages).length);
      a.set("kmsKey", s.KmsKeyId ?? "aws/secretsmanager");
      a.set("rotationEnabled", s.RotationEnabled === true);
      a.set("lastChangedDate", s.LastChangedDate?.toISOString?.());
      return {
        kind: "present",
        externalId: s.ARN ?? externalId ?? "",
        attributes: a.finish(SECRET_ATTRIBUTE_NAMES),
        native: { name: s.Name, tags: tagMap(s.Tags), ...(s.OwningService ? { owningService: s.OwningService } : {}) },
      };
    },
    ["tags", "name"]
  );
}

/* -------------------------------- discover --------------------------------- */

async function discoverSecrets(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const sm = ctx.session.client(SecretsManagerClient);
  const { items } = await paginate(
    async (token) => {
      const out = await call(ctx, (o) => sm.send(new ListSecretsCommand({ MaxResults: 100, ...(token ? { NextToken: token } : {}) }), o));
      return { items: out.SecretList ?? [], next: out.NextToken || undefined };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  const found: DiscoveredResource[] = [];
  for (const s of items) {
    // A secret another AWS service owns (an RDS master credential) is managed through that service, not imported alone.
    if (!s.ARN || !s.Name || s.OwningService) continue;
    found.push(
      candidate(ctx, {
        kind: "secret",
        nativeType: "aws:secretsmanager_secret",
        externalId: s.ARN,
        name: s.Name,
        tags: tagMap(s.Tags),
        attributes: scalars({ rotationEnabled: s.RotationEnabled === true, pendingDeletion: s.DeletedDate !== undefined }),
      })
    );
  }
  return found.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

export const secretsManagerSecretDriver: ResourceDriver<AwsSession> = {
  id: SECRET_SOURCE,
  provider: "aws",
  kind: "secret",
  nativeType: "aws:secretsmanager_secret",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    // Value writes are the execution worker's secret-sync activity (`syncSecretValue`), not a catalog capability.
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileSecretContainer,
  observe: observeSecret,
  expectedAttributes: expectedSecretAttributes,
  async verify(ctx, node, observation) {
    const checks = [
      attrCheck(observation, "not_pending_deletion", "the secret is not scheduled for deletion", "pendingDeletion", (v) => v === false),
      attrCheck(observation, "value_synced", "a current version exists (the vault value was synced)", "hasCurrentVersion", (v) => v === true),
      matchesExpectedCheck(expectedSecretAttributes(node), observation),
    ];
    return verificationOf(ctx, node, observation, checks);
  },
  discover: discoverSecrets,
};
