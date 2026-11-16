/**
 * Direct-session value delivery to one exact Secrets Manager ARN. Target tags
 * are checked before resolving. A keyed content token is stable across deploys
 * and lets DescribeSecret compare current content without GetSecretValue.
 * A previous matching version is promoted instead of creating duplicates.
 * Runner delivery is refused until secret request bodies have sealed transport.
 * Contract-tested SDK only; no live AWS claim.
 */
import { createHmac } from "node:crypto";
import { DescribeSecretCommand, PutSecretValueCommand, SecretsManagerClient, UpdateSecretVersionStageCommand } from "@aws-sdk/client-secrets-manager";
import type { AwsSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { assertAwsSecretResource } from "@/lib/credentials/aws/secret-policy";
import { SecretDeliveryError, secretFailure, type SecretTenant, type SecretWriteResult } from "@/lib/secrets/delivery";

export async function writeAwsSecret(session: AwsSession, input: SecretTenant & {
  node: ResourceNode; secretArn: string; fingerprintKey: string; resolve(): Promise<string | undefined>; signal?: AbortSignal;
}): Promise<SecretWriteResult> {
  let value: string | undefined;
  try {
    if (session.transport === "runner") throw new SecretDeliveryError("unsupported");
    if (input.node.ownership !== "managed" || input.node.provider !== "aws" || input.node.region !== session.region || input.fingerprintKey.length < 16) throw new SecretDeliveryError("denied");
    try { assertAwsSecretResource(input.secretArn, session.accountId, session.region, input.environmentId); }
    catch { throw new SecretDeliveryError("denied"); }
    const client = session.client(SecretsManagerClient);
    const options = { abortSignal: input.signal };
    const target = await client.send(new DescribeSecretCommand({ SecretId: input.secretArn }), options);
    const tags = Object.fromEntries((target.Tags ?? []).map((t) => [t.Key, t.Value]));
    if (target.ARN !== input.secretArn || target.DeletedDate || tags["zenith:managed"] !== "true" || tags["zenith:workspace"] !== input.workspaceId || tags["zenith:environment"] !== input.environmentId || tags["zenith:resource"] !== input.node.address) throw new SecretDeliveryError("denied");
    value = await input.resolve();
    if (value === undefined) throw new SecretDeliveryError("missing");
    if (!value.length || Buffer.byteLength(value, "utf8") > 65536) throw new SecretDeliveryError("invalid");
    const token = createHmac("sha256", input.fingerprintKey).update(`zenith.secret.content.v1\0${input.workspaceId}\0${input.environmentId}\0${input.secretArn}\0`).update(value).digest("hex");
    const versions = target.VersionIdsToStages ?? {};
    if (versions[token]?.includes("AWSCURRENT")) return { changed: false, versionId: token };
    if (versions[token]) {
      const prior = Object.keys(versions).find((id) => versions[id].includes("AWSCURRENT"));
      await client.send(new UpdateSecretVersionStageCommand({ SecretId: input.secretArn, VersionStage: "AWSCURRENT", MoveToVersionId: token, ...(prior ? { RemoveFromVersionId: prior } : {}) }), options);
    } else {
      await client.send(new PutSecretValueCommand({ SecretId: input.secretArn, SecretString: value, ClientRequestToken: token }), options);
    }
    return { changed: true, versionId: token };
  } catch (err) {
    throw secretFailure(err);
  } finally { value = undefined; }
}
