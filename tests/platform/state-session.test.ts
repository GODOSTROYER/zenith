/** PROD-DUR-06: the session port hands the existing credential broker an in-process grant; policy and refusal helpers are pure. */
import { describe, expect, it } from "vitest";
import type { CredentialRequest, ProviderConnection } from "@/lib/credentials/types";
import { awsStateSessionPolicy, sessionRefusal, type StateSessionRequest } from "@/lib/platform/state-recovery";
import { createStateSessionPort } from "@/lib/platform/state-session";
import { validateSessionPolicy } from "@/lib/credentials/aws/policy";

const conn = (config: Record<string, unknown>, status: ProviderConnection["status"] = "verified"): ProviderConnection =>
  ({ id: "c1", workspaceId: "ws_1", status, createdBy: "u", createdAt: "2026-01-01T00:00:00Z", config } as unknown as ProviderConnection);
const request = (over: Partial<StateSessionRequest> = {}): StateSessionRequest => ({ workspaceId: "ws_1", projectId: "p1", environmentId: "env_1", connectionId: "c1",
  principalId: "user_1", purpose: "observe", correlation: "state-restore:r1", digest: "a".repeat(64), ...over });

describe("session port", () => {
  it("passes the broker an observe or deploy request with an in-process grant for the exact scope", async () => {
    const seen: CredentialRequest[] = [];
    const broker = { withSession: async <T,>(req: CredentialRequest, fn: (s: never) => Promise<T>): Promise<T> => { seen.push(req); return fn({} as never); } };
    const port = createStateSessionPort(broker as never, () => new Date("2026-06-01T00:00:00Z"));
    await port(request(), async () => 1);
    await port(request({ purpose: "deploy", sessionPolicy: { Version: "2012-10-17" } }), async () => 2);
    expect(seen[0]).toMatchObject({ connectionId: "c1", purpose: "observe", durationSec: 600 });
    expect(seen[0].grant).toMatchObject({ cap: "infrastructure.observe", op: "state-restore:r1", ws: "ws_1", proj: "p1", env: "env_1", sub: "user_1", aud: "worker", digest: "a".repeat(64) });
    expect(seen[0].grant.exp - seen[0].grant.iat).toBe(600);
    expect(seen[0].sessionPolicy).toBeUndefined();
    expect(seen[1]).toMatchObject({ purpose: "deploy", sessionPolicy: { Version: "2012-10-17" } });
    expect(seen[1].grant.cap).toBe("infrastructure.apply");
    expect(seen[0].grant.jti).not.toBe(seen[1].grant.jti);
  });
  it("propagates a broker denial untouched (revocation, custody mode, federation)", async () => {
    const broker = { withSession: async () => { throw new Error("denied by broker"); } };
    await expect(createStateSessionPort(broker as never)(request(), async () => 1)).rejects.toThrow("denied by broker");
  });
});

describe("session refusal", () => {
  const aws = { provider: "aws", mode: "oidc_web_identity", region: "us-east-1" };
  it("allows brokered AWS and GCP connections for their own backend kinds", () => {
    expect(sessionRefusal(conn(aws), { kind: "s3", bucket: "b" })).toBeUndefined();
    expect(sessionRefusal(conn({ provider: "gcp", mode: "oidc_web_identity" }), { kind: "gcs", bucket: "b" })).toBeUndefined();
  });
  it("refuses revoked, unverified, runner-custody and mismatched-provider connections", () => {
    expect(sessionRefusal(conn(aws, "revoked"), { kind: "s3", bucket: "b" })).toMatch(/revoked/);
    expect(sessionRefusal(conn(aws, "pending_verification"), { kind: "s3", bucket: "b" })).toMatch(/not verified/);
    expect(sessionRefusal(conn({ ...aws, mode: "runner" }), { kind: "s3", bucket: "b" })).toMatch(/custody mode runner/);
    expect(sessionRefusal(conn({ provider: "gcp", mode: "runner" }), { kind: "gcs", bucket: "b" })).toMatch(/custody mode runner/);
    expect(sessionRefusal(conn({ provider: "gcp" }), { kind: "s3", bucket: "b" })).toMatch(/AWS connection/);
    expect(sessionRefusal(conn(aws), { kind: "gcs", bucket: "b" })).toMatch(/GCP connection/);
  });
  it("refuses Azure Blob, OCI Object Storage and kinds without an adapter, naming why", () => {
    expect(sessionRefusal(conn({ provider: "azure" }), { kind: "azurerm", storageAccountName: "acct", containerName: "state" })).toMatch(/bound source-storage account/);
    expect(sessionRefusal(conn({ provider: "oci", mode: "runner" }), { kind: "s3", bucket: "b", endpoint: "https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com" })).toMatch(/runner transport/);
    expect(sessionRefusal(conn(aws), { kind: "http", address: "https://e.test/s" })).toMatch(/no restore adapter/);
    expect(sessionRefusal(conn(aws), { kind: "local" })).toMatch(/no restore adapter/);
  });
});

describe("AWS state session policy", () => {
  it("is a valid session policy scoped to the state object, its lock and nothing wider", () => {
    for (const purpose of ["observe", "deploy"] as const) {
      const policy = awsStateSessionPolicy({ kind: "s3", bucket: "state-bucket" }, "zenith/ws/env/terraform.tfstate", purpose);
      expect(() => validateSessionPolicy(policy)).not.toThrow();
      const text = JSON.stringify(policy);
      expect(text.includes("s3:PutObject")).toBe(purpose === "deploy");
      expect(text).not.toMatch(/s3:\*|"Action":"\*"|DeleteObject|PutBucket|PutObjectAcl/);
      expect(text).toContain("arn:aws:s3:::state-bucket/zenith/ws/env/terraform.tfstate.tflock");
      expect(text).not.toContain("kms:");
    }
  });
  it("adds only KMS data-key actions when the state is KMS encrypted", () => {
    const policy = awsStateSessionPolicy({ kind: "s3", bucket: "state-bucket", sseKmsKeyId: "alias/state" }, "k", "deploy");
    expect(JSON.stringify(policy)).toContain("kms:Decrypt");
    expect(JSON.stringify(policy)).not.toMatch(/kms:(?:Create|Schedule|Disable|Put)/);
    expect(() => validateSessionPolicy(policy)).not.toThrow();
  });
  it("refuses a non-S3 backend", () => {
    expect(() => awsStateSessionPolicy({ kind: "gcs", bucket: "b" }, "k", "observe")).toThrow();
  });
});
