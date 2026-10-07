/**
 * Stable resource addresses for mixed plans (PROD-MIX-02).
 *
 * A stable address names a resource by WHERE it lives (provider, region, a digest
 * of the account) and WHAT the graph calls it. It deliberately excludes every
 * value that can change while a plan is resumed, re-driven by another worker,
 * re-planned or have its connection rotated: partition ids, connection ids,
 * binding ids, ordinals, operation ids. The same graph therefore yields the same
 * addresses on every pass, and a registry row that no longer matches a fresh
 * derivation is `address_drift`, a refusal rather than a silent re-mapping.
 */
import { digest } from "@/lib/controlplane/digest";
import { MIXED_ADDRESS_FORMAT, MixedPlanError, type ChildSubplan, type StableAddressEntry } from "./types";

export function partitionKey(identity: { provider: string; accountId: string; region: string }): string {
  return `${identity.provider}:${identity.region}:${digest({ format: MIXED_ADDRESS_FORMAT, accountId: identity.accountId }).slice(0, 16)}`;
}

export function stableAddress(identity: { provider: string; accountId: string; region: string }, address: string): string {
  return `${partitionKey(identity)}::${address}`;
}

/** Deterministic, sorted registry for a set of children. */
export function deriveAddresses(children: readonly Pick<ChildSubplan, "partitionId" | "authority" | "nodes">[]): StableAddressEntry[] {
  const out: StableAddressEntry[] = [];
  for (const child of children) {
    for (const node of child.nodes) {
      out.push({ stableAddress: stableAddress(child.authority, node.address), address: node.address, partitionId: child.partitionId, specDigest: node.specDigest });
    }
  }
  out.sort((a, b) => (a.stableAddress < b.stableAddress ? -1 : a.stableAddress > b.stableAddress ? 1 : 0));
  const seen = new Set<string>();
  for (const entry of out) {
    if (seen.has(entry.stableAddress)) throw new MixedPlanError("address_drift", "Two resources derive the same stable address.");
    seen.add(entry.stableAddress);
  }
  return out;
}

/**
 * Compare a stored registry with a fresh derivation. Equal means every address
 * still names the same resource in the same partition with the same spec.
 * Any difference is refused: resuming must never re-map a resource.
 */
export function assertAddressesStable(stored: readonly StableAddressEntry[], fresh: readonly StableAddressEntry[]): void {
  const key = (e: StableAddressEntry): string => `${e.stableAddress}\0${e.address}\0${e.partitionId}\0${e.specDigest}`;
  const a = stored.map(key).sort();
  const b = fresh.map(key).sort();
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
    throw new MixedPlanError("address_drift", "The stored stable addresses no longer match the plan; resume is refused. Plan again.");
  }
}
