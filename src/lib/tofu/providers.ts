/**
 * Provider pins for the OpenTofu engine (ADR-0005).
 *
 * Every provider is pinned to one EXACT version (`= x.y.z` in
 * `required_providers`). The versions below were chosen on 2026-09-30 as the
 * newest stable (no pre-release suffix) release published on
 * registry.opentofu.org that ships the four platforms we lock:
 * linux_amd64, linux_arm64, darwin_arm64, windows_amd64.
 *
 * A "provider set" is the unit a workspace is locked as: one committed
 * `.terraform.lock.hcl` per set (`src/lib/tofu/locks/<set>.terraform.lock.hcl`,
 * mirrored into `locks.generated.ts` so bundlers never need a runtime file
 * read). `init` runs with `-lockfile=readonly`, so a workspace can only ever
 * install the exact provider builds recorded in the lockfile.
 *
 * Changing a pin means: edit `PROVIDER_PINS`, run
 * `npx tsx src/lib/tofu/scripts/lock.ts`, review and commit the new lockfiles.
 * `tests/tofu/providers.test.ts` fails if a lockfile and a pin disagree.
 *
 * Honest limits: these pins have been resolved against the registry and their
 * lockfiles generated; only `hashicorp/random` (and the built-in
 * `terraform_data`) has been exercised by real plan/apply runs in this repo.
 * The cloud providers have not been run against a cloud account.
 */

export type ProviderLocalName = "aws" | "random" | "google" | "azurerm" | "oci" | "kubernetes";

export interface ProviderPin {
  /** registry address without the host, e.g. `hashicorp/aws` */
  source: string;
  /** exact version, no operators */
  version: string;
}

export const PROVIDER_PINS: Record<ProviderLocalName, ProviderPin> = {
  aws: { source: "hashicorp/aws", version: "6.66.0" },
  random: { source: "hashicorp/random", version: "3.9.1" },
  google: { source: "hashicorp/google", version: "8.5.0" },
  azurerm: { source: "hashicorp/azurerm", version: "5.7.0" },
  oci: { source: "oracle/oci", version: "9.7.1" },
  kubernetes: { source: "hashicorp/kubernetes", version: "3.2.1" },
};

/** Platforms every lockfile carries hashes for. */
export const LOCK_PLATFORMS = ["linux_amd64", "linux_arm64", "darwin_arm64", "windows_amd64"] as const;

export type ProviderSetName = "aws" | "gcp" | "azure" | "oci" | "kubernetes" | "random" | "builtin";

export interface ProviderSetSpec {
  /** lockfile identity; for committed sets this is the file basename */
  name: string;
  /** provider local names required by workspaces of this set */
  providers: readonly ProviderLocalName[];
  /** `.terraform.lock.hcl` contents pinned for this set */
  lockfile: string;
}

/**
 * Which providers each committed set locks. `random` rides along with the
 * cloud sets for `random_id`/`random_password` naming and secrets seeding.
 * `random` and `builtin` exist mainly so the engine can be exercised without
 * cloud access: `builtin` needs no provider at all (`terraform_data` ships
 * inside the tofu binary).
 */
export const PROVIDER_SET_PROVIDERS: Record<ProviderSetName, readonly ProviderLocalName[]> = {
  aws: ["aws", "random"],
  gcp: ["google", "random"],
  azure: ["azurerm", "random"],
  oci: ["oci", "random"],
  kubernetes: ["kubernetes"],
  random: ["random"],
  builtin: [],
};

export const PROVIDER_SET_NAMES = Object.keys(PROVIDER_SET_PROVIDERS) as ProviderSetName[];

/** Resource-type prefix → provider local name, for resource/data blocks. */
export function providerOfType(type: string): string {
  const i = type.indexOf("_");
  return i < 0 ? type : type.slice(0, i);
}

/** The header `tofu init` writes when there is nothing to lock. */
export const EMPTY_LOCKFILE = '# This file is maintained automatically by "tofu init".\n# Manual edits may be lost in future updates.\n';

/**
 * `terraform.required_providers` for a set, in `.tf.json` shape. The source
 * carries no hostname, so it always resolves to registry.opentofu.org.
 */
export function requiredProviders(providers: readonly ProviderLocalName[]): Record<string, { source: string; version: string }> {
  const out: Record<string, { source: string; version: string }> = {};
  for (const name of [...providers].sort()) {
    const pin = PROVIDER_PINS[name];
    out[name] = { source: pin.source, version: `= ${pin.version}` };
  }
  return out;
}

/** Fully-qualified registry source as it appears in a lockfile. */
export function lockfileSource(name: ProviderLocalName): string {
  return `registry.opentofu.org/${PROVIDER_PINS[name].source}`;
}
