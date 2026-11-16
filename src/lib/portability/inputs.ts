/**
 * The inputs of the four portability capabilities. They are strict and carry
 * references only: vault refs for credentials, ids and addresses for everything
 * else. The broker validates them at propose time (so a malformed request never
 * becomes an operation) and the worker validates again at execution.
 */
import { z } from "zod";
import { AdoptInputSchema, ReleaseInputSchema } from "./adoption";

export const PORTABILITY_CAPABILITIES = ["data.export", "data.import", "resource.adopt", "resource.release"] as const;
export type PortabilityCapability = (typeof PORTABILITY_CAPABILITIES)[number];
export const isPortabilityCapability = (name: string): name is PortabilityCapability => (PORTABILITY_CAPABILITIES as readonly string[]).includes(name);

const VaultRef = z.string().regex(/^vault:[A-Za-z0-9_./-]{1,300}$/, "must be a vault: reference");
const Address = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,200}$/, "must be a resource address such as object_store/backups");

/** Tenant-owned storage: an object_store resource of the environment plus the vault secret that reaches it. */
export const DestinationSchema = z.object({ resourceAddress: Address, credentialsRef: VaultRef }).strict();
export type Destination = z.infer<typeof DestinationSchema>;

export const ExportInputSchema = z.object({ destination: DestinationSchema, connectionRef: VaultRef.optional() }).strict();
export type ExportInput = z.infer<typeof ExportInputSchema>;

export const ImportInputSchema = z
  .object({
    exportId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    destination: DestinationSchema,
    connectionRef: VaultRef.optional(),
    /** a separate, ideally read-only credential for the readback; defaults to a fresh connection with the same one */
    readbackConnectionRef: VaultRef.optional(),
  })
  .strict();
export type ImportInput = z.infer<typeof ImportInputSchema>;

export { AdoptInputSchema, ReleaseInputSchema };
export type AdoptInput = z.infer<typeof AdoptInputSchema>;
export type ReleaseInput = z.infer<typeof ReleaseInputSchema>;

const SCHEMAS = { "data.export": ExportInputSchema, "data.import": ImportInputSchema, "resource.adopt": AdoptInputSchema, "resource.release": ReleaseInputSchema } as const;

export type ParsedPortabilityInput =
  | { capability: "data.export"; input: ExportInput }
  | { capability: "data.import"; input: ImportInput }
  | { capability: "resource.adopt"; input: AdoptInput }
  | { capability: "resource.release"; input: ReleaseInput };

/** Parse and normalize. Throws a ZodError whose issue paths (never values) the broker reports. */
export function parsePortabilityInput(capability: PortabilityCapability, raw: unknown): ParsedPortabilityInput {
  const parsed = SCHEMAS[capability].parse(raw ?? {});
  return { capability, input: parsed } as ParsedPortabilityInput;
}

/** Lines an approver sees, derived from the validated input only. */
export function portabilityDetails(p: ParsedPortabilityInput): string[] {
  switch (p.capability) {
    case "data.export":
      return [`Export: copies this service's content into tenant-owned storage ${p.input.destination.resourceAddress}; the source is only read.`];
    case "data.import":
      return [`Import: restores export ${p.input.exportId} into this resource, which must be empty, then reads it back to verify; storage ${p.input.destination.resourceAddress}.`];
    case "resource.adopt":
      return [
        `Adopt: claims the existing object ${p.input.claim.externalId} as Zenith-managed (lifecycle ${p.input.claim.lifecycle}).`,
        p.input.claim.lifecycle === "manage_and_destroy" ? "This claim ALLOWS a later approved destroy to delete the object." : "This claim does NOT allow Zenith to delete the object; release it instead.",
      ];
    case "resource.release":
      return [`Release: hands adopted resource claim ${p.input.adoptionId} back; Zenith stops managing the object and does not delete it.`];
  }
}
