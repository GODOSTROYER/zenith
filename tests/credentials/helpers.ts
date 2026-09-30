/**
 * Shared fixtures for the credential tests. Everything here is synthetic:
 * keys are generated per run, account ids are the documentation account, and
 * the "AWS credentials" STS returns are fake values that merely LOOK like real
 * ones so the leak scanners have something realistic to find.
 */
import { generateSigningJwk, type GeneratedSigningKey } from "@/lib/credentials/signing";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { AwsConnectionConfig, ProviderConnection } from "@/lib/credentials/types";

export const ACCOUNT = "123456789012";
export const ISSUER = "https://zenith.test/api/oidc";

/** Fake, realistic-looking temporary credentials (AWS documentation example shapes). */
export const FAKE_CREDS = {
  AccessKeyId: "ASIAIOSFODNN7EXAMPLE",
  SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  SessionToken: `IQoJb3JpZ2luX2VjEXAMPLE${"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/".repeat(8)}==`,
} as const;
export const FAKE_SECRETS = [FAKE_CREDS.AccessKeyId, FAKE_CREDS.SecretAccessKey, FAKE_CREDS.SessionToken];

export interface Keys {
  rsa: GeneratedSigningKey;
  ed: GeneratedSigningKey;
}

export async function makeKeys(): Promise<Keys> {
  return { rsa: await generateSigningJwk("RS256"), ed: await generateSigningJwk("EdDSA") };
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export function grant(over: Partial<CapabilityGrantClaims> = {}): CapabilityGrantClaims {
  const iat = nowSec();
  return {
    jti: "grant_0001",
    iss: "zenith-control",
    aud: "worker",
    sub: "user_1",
    iat,
    exp: iat + 600,
    cap: "infrastructure.observe",
    op: "op_1234567890abcdef",
    digest: "sha256:abc",
    ws: "ws_1",
    env: "env1",
    ...over,
  };
}

export function awsConfig(over: Partial<AwsConnectionConfig> = {}): AwsConnectionConfig {
  return {
    provider: "aws",
    mode: "oidc_web_identity",
    accountId: ACCOUNT,
    observeRoleArn: `arn:aws:iam::${ACCOUNT}:role/ZenithObserveRole`,
    deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole`,
    region: "ap-south-1",
    ...over,
  };
}

export function connection(over: Partial<ProviderConnection> = {}, config: Partial<AwsConnectionConfig> = {}): ProviderConnection {
  return {
    id: "conn_1",
    workspaceId: "ws_1",
    config: awsConfig(config),
    status: "verified",
    createdBy: "user_1",
    createdAt: "2026-09-30T00:00:00.000Z",
    ...over,
  };
}
