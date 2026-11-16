/**
 * Ownership-safe decommissioning.
 *
 * Deleting is only legitimate for an object Zenith may destroy. The existing
 * guards already require a `managed` node, an explicit `deletionPolicy` for
 * stateful data and a human, digest-bound approval. This adds the question those
 * cannot answer: was this object ever adopted, and if so did the human who
 * claimed it allow its destruction?
 *
 *   - never adopted               created by Zenith: the existing guards decide
 *   - adopted, lifecycle manage   REFUSED. Zenith did not create it; release it
 *                                 (`resource.release`) instead of deleting it
 *   - adopted, manage_and_destroy allowed only while the claim is active and
 *                                 names exactly this object
 *   - claim released, or naming a different object   REFUSED
 *
 * Pure: facts in, verdicts out. The execution layer loads the facts from the
 * tenant-scoped store and calls this from every destroy path.
 */
import { PortabilityError } from "./types";

export interface AdoptionFact {
  address: string;
  externalId: string;
  status: "active" | "released";
  lifecycle: "manage" | "manage_and_destroy";
  approvalId: string;
}

export interface DecommissionTarget {
  address: string;
  kind: string;
  ownership: string;
  externalId?: string;
}

export type DecommissionRefusal = "not_managed" | "adopted_destroy_not_allowed" | "adoption_released" | "adoption_identity_mismatch" | "adoption_alias";

export interface DecommissionVerdict {
  address: string;
  allowed: boolean;
  code?: DecommissionRefusal;
  message?: string;
  /** allowed only because a human adoption claim explicitly permitted destruction */
  viaAdoptionClaim?: string;
}

export function assessDecommission(targets: readonly DecommissionTarget[], adoptions: readonly AdoptionFact[]): { allowed: boolean; verdicts: DecommissionVerdict[] } {
  const verdicts = targets.map((t): DecommissionVerdict => {
    if (t.ownership !== "managed") {
      return { address: t.address, allowed: false, code: "not_managed", message: `${t.address} is ${t.ownership}: Zenith reads it and never deletes it.` };
    }
    const own = adoptions.filter((a) => a.address === t.address);
    const active = own.find((a) => a.status === "active");
    if (!active) {
      if (own.some((a) => a.status === "released")) {
        return { address: t.address, allowed: false, code: "adoption_released", message: `${t.address} was released from management; it is not Zenith's to delete.` };
      }
      const alias = t.externalId ? adoptions.find((a) => a.status === "active" && a.externalId === t.externalId && a.address !== t.address) : undefined;
      if (alias) return { address: t.address, allowed: false, code: "adoption_alias", message: `${t.address} points at an object adopted under another address (${alias.address}); deleting it would delete the adopted object.` };
      return { address: t.address, allowed: true };
    }
    if (t.externalId && t.externalId !== active.externalId) {
      return { address: t.address, allowed: false, code: "adoption_identity_mismatch", message: `${t.address} points at a different object than the one its adoption claim names.` };
    }
    if (active.lifecycle !== "manage_and_destroy") {
      return { address: t.address, allowed: false, code: "adopted_destroy_not_allowed", message: `${t.address} was adopted, not created by Zenith, and its claim does not allow destruction. Release it instead, or adopt it again with lifecycle manage_and_destroy.` };
    }
    return { address: t.address, allowed: true, viaAdoptionClaim: active.approvalId };
  });
  return { allowed: verdicts.every((v) => v.allowed), verdicts };
}

export class DecommissionRefusedError extends PortabilityError {
  readonly verdicts: DecommissionVerdict[];
  constructor(verdicts: DecommissionVerdict[]) {
    super("ownership_unproven", verdicts.filter((v) => !v.allowed).map((v) => v.message).slice(0, 5).join(" "), { refused: verdicts.filter((v) => !v.allowed).map((v) => ({ address: v.address, code: v.code })) });
    this.name = "DecommissionRefusedError";
    this.verdicts = verdicts;
  }
}

export function assertDecommissionAllowed(targets: readonly DecommissionTarget[], adoptions: readonly AdoptionFact[]): DecommissionVerdict[] {
  const result = assessDecommission(targets, adoptions);
  if (!result.allowed) throw new DecommissionRefusedError(result.verdicts);
  return result.verdicts;
}
