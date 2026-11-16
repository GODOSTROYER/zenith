/**
 * Build provenance fixtures (PROD-LIFE-09): a real Ed25519 control-style key
 * generated at run time (never a fixture literal) and provider attestations
 * that satisfy, or deliberately violate, the per-provider isolation profile.
 */
import { generateKeyPairSync } from "node:crypto";
import { LocalJwkSigner } from "@/lib/credentials/signing/local";
import type { JwtSigner, PublicJwk } from "@/lib/credentials/signing/types";
import type { BuildAttestation, ObservedBuildIsolation } from "@/lib/execution/build-isolation";
import { BUILD_ISOLATION_PROFILES, allowlistDigest } from "@/lib/execution/build-isolation";
import type { BuildProvenanceAuthority } from "@/lib/execution/ports";

export interface TestProvenanceKeys extends BuildProvenanceAuthority {
  readonly signerObject: JwtSigner;
  readonly publicKeys: PublicJwk[];
}

export function newProvenanceKeys(): TestProvenanceKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  const signer = LocalJwkSigner.fromJwk("TEST_PROVENANCE_KEY", jwk, { alg: "EdDSA" });
  const publicKeys = [signer.publicJwk()];
  return { signerObject: signer, publicKeys, signer: async () => signer, keys: async () => publicKeys };
}

/** An observation that satisfies the AWS profile. */
export function awsIsolation(over: Partial<ObservedBuildIsolation> = {}): ObservedBuildIsolation {
  const hosts = ["registry.npmjs.org", "pypi.org"];
  return {
    profileId: BUILD_ISOLATION_PROFILES.aws.id,
    identity: { principal: "arn:aws:iam::123456789012:role/zenith-api-build", dedicated: true, deployCredentials: "absent" },
    metadata: { exposes: "build_identity_only", mechanism: "forward chain rejects the metadata addresses" },
    network: { egress: "allowlisted", verifiedBy: "provider_read", allowlistDigest: allowlistDigest(hosts), mechanism: "host firewall" },
    dependencies: { downloads: "allowlisted" },
    filesystem: { sourceMount: "read_only" },
    resources: { timeoutSec: 1800, computeClass: "BUILD_GENERAL1_MEDIUM" },
    ...over,
  };
}

export function awsAttestation(over: Partial<ObservedBuildIsolation> = {}): BuildAttestation {
  return {
    builderId: "arn:aws:codebuild:us-east-1:123456789012:project/zenith-api",
    invocationId: "zenith-api:00000000-0000-4000-8000-000000000000",
    builderImage: "aws/codebuild/standard:7.0",
    startedOn: "2026-09-30T11:50:00.000Z",
    finishedOn: "2026-09-30T11:58:00.000Z",
    isolation: awsIsolation(over),
  };
}
