/**
 * Per-backend capability matrix for OpenTofu state (PROD-DUR-06). Pure and credential-free.
 *
 * Three questions are answered per backend kind before state is trusted or restored:
 *  - locking:    can two workers hold the state at once?
 *  - encryption: is state encrypted at rest, by whom?
 *  - versioning: can an earlier object version be restored?
 *
 * Verdicts are declared by what the backend CONFIG guarantees, never by what a provider is assumed to do:
 *   supported         the generated block turns it on and the provider contract provides it
 *   provider_managed  the provider always provides it; the block cannot weaken it
 *   unverified        depends on bucket/account settings or a provider feature this build cannot prove
 *                     (versioning is a bucket property: only a live probe can show it is enabled)
 *   unsupported       the backend cannot provide it; use of it for hosted state is refused
 * `assertBackendAdmissible` refuses only DEFINITE gaps (locking or encryption unsupported). `unverified`
 * never becomes a pass: restore additionally requires a live probe (state-backend-s3.ts) that proves versioning.
 * No live cloud backend is verified by this module; `kind` strings outside the union (for example `pg`)
 * are classified explicitly so the refusal is visible rather than an unknown-kind accident.
 */
import type { BackendConfig } from "@/lib/tofu/backend-config";
import { TofuWorkspaceError } from "@/lib/tofu/workspace-error";

export type Support = "supported" | "provider_managed" | "unverified" | "unsupported";
export type BackendKindName = BackendConfig["kind"] | "pg";

export interface BackendCapabilities {
  readonly kind: string;
  readonly locking: Support;
  readonly encryption: Support;
  readonly versioning: Support;
  /** Restore also needs a live probe that proves versioning; this only says whether a restore adapter (with conditional write) exists. */
  readonly restoreAdapter: boolean;
  /** Plain reasons for every non-supported verdict, safe to show to an operator. */
  readonly notes: readonly string[];
}

/** Persisted live probe verdict (state_backend_probes.verdict). Contains no credentials or object bytes. */
export interface BackendProbeVerdict {
  readonly backendKind: BackendKindName;
  readonly versioning: "enabled" | "suspended" | "disabled" | "unsupported" | "unknown";
  readonly encryption: "sse_kms" | "sse_s3" | "none" | "unknown";
  readonly lockObject: "absent" | "present" | "unknown";
  readonly currentVersionId?: string;
  readonly restoreReady: boolean;
  readonly refusals: readonly string[];
}

const frozen = (value: BackendCapabilities): BackendCapabilities => Object.freeze({ ...value, notes: Object.freeze([...value.notes]) });

export function assessBackend(backend: { kind: string } & Partial<Record<string, unknown>>): BackendCapabilities {
  switch (backend.kind) {
    case "s3": {
      const oci = typeof backend.endpoint === "string";
      return frozen({
        kind: oci ? "s3-oci" : "s3",
        // use_lockfile is always emitted by backendFile; OCI's S3 compatibility layer has no verified conditional-write support here.
        locking: oci ? "unverified" : "supported",
        encryption: oci ? "provider_managed" : "supported",
        versioning: "unverified",
        restoreAdapter: !oci,
        notes: [
          ...(oci ? ["OCI Object Storage S3 compatibility: lock-file conditional writes are not verified; state locking may not exclude concurrent writers.",
            "OCI restore is refused: the brokered OCI session is a runner transport that carries JSON for allowlisted bucket paths only, so object bytes cannot flow through it, and a control-plane held signing key is not an accepted path."] : []),
          "Bucket versioning is a bucket property; only a live probe can prove it is enabled.",
        ],
      });
    }
    case "gcs":
      return frozen({
        kind: "gcs", locking: "provider_managed", encryption: backend.kmsEncryptionKey === undefined ? "provider_managed" : "supported",
        versioning: "unverified", restoreAdapter: true,
        notes: ["GCS object versioning is a bucket property; only a live probe can prove it is enabled. Restore uses object generations with ifGenerationMatch through the brokered GCP session."],
      });
    case "azurerm":
      return frozen({
        kind: "azurerm", locking: "provider_managed", encryption: "provider_managed", versioning: "unverified", restoreAdapter: false,
        notes: ["Azure blob versioning is a storage account property. Restore is refused: the brokered Azure session authorizes Blob hosts only for a bound source-storage account, so it cannot reach a state storage account, and a stored SAS or key is not an accepted path."],
      });
    case "http": {
      const locked = typeof backend.lockAddress === "string" && typeof backend.unlockAddress === "string";
      return frozen({
        kind: "http", locking: locked ? "supported" : "unsupported", encryption: "unverified", versioning: "unsupported", restoreAdapter: false,
        notes: [...(locked ? [] : ["The http backend has no lock and unlock address, so concurrent workers are not excluded."]),
          "The http backend's at-rest encryption and versioning are not observable by Zenith."],
      });
    }
    case "pg":
      // OpenTofu's pg backend serializes with advisory locks, but Zenith emits no pg backend: its connection string is a credential.
      return frozen({
        kind: "pg", locking: "supported", encryption: "unverified", versioning: "unsupported", restoreAdapter: false,
        notes: ["A PostgreSQL state backend is not emitted: its connection string is a credential and cannot appear in a non-secret backend block.",
          "PostgreSQL state has no object versions; recover it from database backups or point-in-time recovery, not this path."],
      });
    case "local":
      return frozen({
        kind: "local", locking: "unsupported", encryption: "unsupported", versioning: "unsupported", restoreAdapter: false,
        notes: ["Local state is a file on one worker: no cross-worker lock, no encryption, no versions. Isolated single-worker use only."],
      });
    default:
      return frozen({
        kind: String(backend.kind), locking: "unsupported", encryption: "unsupported", versioning: "unsupported", restoreAdapter: false,
        notes: ["Unknown state backend kind."],
      });
  }
}

/** Hosted state must be lockable and encrypted. Refuses definite gaps with a plain reason; never claims `unverified` is proven. */
export function assertBackendAdmissible(backend: { kind: string } & Partial<Record<string, unknown>>): BackendCapabilities {
  const caps = assessBackend(backend);
  if (caps.locking === "unsupported") throw new TofuWorkspaceError("invalid_input", `The ${caps.kind} state backend cannot lock state, so concurrent workers are not excluded. ${caps.notes[0] ?? ""}`.trim());
  if (caps.encryption === "unsupported") throw new TofuWorkspaceError("invalid_input", `The ${caps.kind} state backend cannot encrypt state at rest. ${caps.notes[0] ?? ""}`.trim());
  return caps;
}

/**
 * Whether a restore may proceed given the static matrix and a live probe. Returns refusal reasons; empty means ready.
 * Versioning must be proven `enabled` by the probe, the lock object must be provably absent, and an adapter must exist.
 */
export function restoreRefusals(caps: BackendCapabilities, probe: BackendProbeVerdict | undefined): string[] {
  const out: string[] = [];
  if (!caps.restoreAdapter) out.push(`No restore adapter exists for the ${caps.kind} backend; restore is refused.`);
  if (caps.locking === "unverified" || caps.locking === "unsupported") out.push("State locking is not proven for this backend, so a restore could race a writer.");
  if (!probe) out.push("No live backend probe is recorded; run the probe first.");
  else {
    if (probe.versioning !== "enabled") out.push(`Bucket versioning is ${probe.versioning}; only an enabled versioned bucket can be restored without data loss.`);
    if (probe.lockObject !== "absent") out.push(probe.lockObject === "present" ? "A state lock is held; wait for it to clear. A lock is never removed by restore." : "The state lock could not be read.");
    if (probe.encryption === "none") out.push("The state object is not encrypted at rest.");
    if (!probe.currentVersionId) out.push("The current state object version is unknown.");
  }
  return out;
}
