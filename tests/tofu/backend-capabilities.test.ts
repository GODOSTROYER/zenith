/** PROD-DUR-06: per-backend capability matrix with explicit refusal where unsupported. Pure. */
import { describe, expect, it } from "vitest";
import { assertBackendAdmissible, assessBackend, restoreRefusals, type BackendProbeVerdict } from "@/lib/tofu/backend-capabilities";
import { backendForConnection } from "@/lib/tofu/backends";
import type { ProviderConnection } from "@/lib/credentials/types";

const ready = (over: Partial<BackendProbeVerdict> = {}): BackendProbeVerdict => ({
  backendKind: "s3", versioning: "enabled", encryption: "sse_s3", lockObject: "absent", currentVersionId: "v2", restoreReady: true, refusals: [], ...over,
});

describe("backend capability matrix", () => {
  it("AWS S3 locks and encrypts but versioning needs a live probe", () => {
    const caps = assessBackend({ kind: "s3", bucket: "state-bucket" });
    expect(caps).toMatchObject({ locking: "supported", encryption: "supported", versioning: "unverified", restoreAdapter: true });
  });
  it("OCI S3 compatibility is not claimed to lock and has no restore adapter (runner transport carries no object bytes)", () => {
    const caps = assessBackend({ kind: "s3", bucket: "b", endpoint: "https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com" });
    expect(caps).toMatchObject({ locking: "unverified", encryption: "provider_managed", restoreAdapter: false });
    expect(restoreRefusals(caps, ready()).join(" ")).toMatch(/restore adapter/);
    expect(restoreRefusals(caps, ready()).join(" ")).toMatch(/locking is not proven/);
    expect(caps.notes.join(" ")).toMatch(/runner transport/);
  });
  it("GCS has a brokered-session restore adapter; Azure has none (no brokered Blob access to a state account)", () => {
    const gcs = assessBackend({ kind: "gcs" });
    expect(gcs).toMatchObject({ locking: "provider_managed", encryption: "provider_managed", restoreAdapter: true });
    expect(restoreRefusals(gcs, ready())).toEqual([]);
    const azure = assessBackend({ kind: "azurerm" });
    expect(azure.restoreAdapter).toBe(false);
    expect(azure.notes.join(" ")).toMatch(/source-storage account/);
    expect(restoreRefusals(azure, ready()).join(" ")).toMatch(/restore adapter/);
    for (const kind of ["http", "local", "pg", "mystery"]) {
      const caps = assessBackend({ kind });
      expect(caps.restoreAdapter, kind).toBe(false);
      expect(restoreRefusals(caps, ready()).join(" "), kind).toMatch(/restore adapter/);
    }
    expect(assessBackend({ kind: "gcs", kmsEncryptionKey: "projects/p/locations/l/keyRings/r/cryptoKeys/k" }).encryption).toBe("supported");
  });
  it("the pg backend is classified explicitly: lockable, no object versions, never restorable here", () => {
    const caps = assessBackend({ kind: "pg" });
    expect(caps).toMatchObject({ locking: "supported", versioning: "unsupported", restoreAdapter: false });
    expect(caps.notes.join(" ")).toMatch(/connection string is a credential/);
    expect(restoreRefusals(caps, undefined).length).toBeGreaterThan(0);
  });
  it("hosted state refuses backends that definitely cannot lock or encrypt", () => {
    expect(() => assertBackendAdmissible({ kind: "local" })).toThrow(/cannot lock state/);
    expect(() => assertBackendAdmissible({ kind: "http", address: "https://example.test/state" })).toThrow(/cannot lock state/);
    expect(() => assertBackendAdmissible({ kind: "mystery" })).toThrow(/cannot lock state/);
    expect(assertBackendAdmissible({ kind: "http", address: "https://e.test/s", lockAddress: "https://e.test/l", unlockAddress: "https://e.test/u" }).encryption).toBe("unverified");
    for (const kind of ["s3", "gcs", "azurerm"]) expect(() => assertBackendAdmissible({ kind })).not.toThrow();
  });
  it("every backend the connection resolver can emit is admissible and classified", () => {
    const base = { id: "c1", workspaceId: "ws_1", status: "verified", createdBy: "u", createdAt: new Date().toISOString() } as const;
    const aws = { ...base, config: { provider: "aws", mode: "static_dev", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/o", deployRoleArn: "arn:aws:iam::123456789012:role/d", region: "us-east-1", stateBucket: "ws-state-bucket" } } as unknown as ProviderConnection;
    const out = backendForConnection(aws, { workspaceId: "ws_1", environmentId: "env_1" });
    expect(() => assertBackendAdmissible(out.backend)).not.toThrow();
    expect(out.stateKey).toBe("zenith/ws_1/env_1/terraform.tfstate");
  });
});

describe("restore refusals require a live probe", () => {
  const caps = assessBackend({ kind: "s3", bucket: "b" });
  it("passes only a proven, versioned, unlocked, encrypted bucket", () => {
    expect(restoreRefusals(caps, ready())).toEqual([]);
  });
  it("refuses with plain reasons otherwise", () => {
    expect(restoreRefusals(caps, undefined).join(" ")).toMatch(/probe/);
    expect(restoreRefusals(caps, ready({ versioning: "disabled" })).join(" ")).toMatch(/versioning is disabled/);
    expect(restoreRefusals(caps, ready({ versioning: "unknown" })).join(" ")).toMatch(/versioning is unknown/);
    expect(restoreRefusals(caps, ready({ lockObject: "present" })).join(" ")).toMatch(/lock is held/);
    expect(restoreRefusals(caps, ready({ lockObject: "unknown" })).join(" ")).toMatch(/lock could not be read/);
    expect(restoreRefusals(caps, ready({ encryption: "none" })).join(" ")).toMatch(/not encrypted/);
    expect(restoreRefusals(caps, ready({ currentVersionId: undefined })).join(" ")).toMatch(/current state object version/);
  });
});
