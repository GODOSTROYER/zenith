/** Offline fixture planning and independent content witnesses, not engine verification. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const DATA_KINDS = ["postgres", "mysql", "object_store"] as const;
export type DataKind = (typeof DATA_KINDS)[number];
export const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const Hex = z.string().regex(/^[a-f0-9]{64}$/);
export const WitnessSchema = z.object({
  count: z.number().int().min(0).max(100), digest: Hex,
  items: z.array(z.object({ identityDigest: Hex, contentDigest: Hex }).strict()).max(100),
}).strict().superRefine((w, ctx) => {
  if (w.count !== w.items.length || new Set(w.items.map(i => i.identityDigest)).size !== w.count
    || JSON.stringify(w.items) !== JSON.stringify([...w.items].sort((a, b) => a.identityDigest.localeCompare(b.identityDigest)))
    || w.digest !== hash(JSON.stringify(w.items))) ctx.addIssue({ code: "custom", message: "Invalid independent witness" });
});
export type Witness = z.infer<typeof WitnessSchema>;
export const DataProofSchema = z.object({
  source: WitnessSchema, target: WitnessSchema, otherTenant: WitnessSchema,
  exportedContentDigest: Hex, restoredContentDigest: Hex,
  tenantIsolation: z.literal(true), mysqlTls: z.enum(["verified_identity", "not_applicable"]),
}).strict().superRefine((p, ctx) => {
  if (!p.source.count || !p.otherTenant.count || JSON.stringify(p.source) !== JSON.stringify(p.target)
    || p.source.digest === p.otherTenant.digest || p.exportedContentDigest !== p.restoredContentDigest)
    ctx.addIssue({ code: "custom", message: "Roundtrip or tenant witness mismatch" });
});
export type DataProof = z.infer<typeof DataProofSchema>;
export interface FixtureRow { id: string; tenant: string; payload: string; note: string | null }
export interface FixtureObject { key: string; bytes: Buffer; contentType: string }
export function knownData(runId: string, tenant: "a" | "b"): { rows: FixtureRow[]; objects: FixtureObject[] } {
  if (!/^[a-z0-9][a-z0-9-]{3,19}$/.test(runId)) throw new Error("Invalid fixture run");
  const marker = `${runId}/${tenant}`;
  return {
    rows: [
      { id: "1", tenant: marker, payload: "line one\nline two\twith 'quotes'", note: null },
      { id: "2", tenant: marker, payload: "héllo ☃ 日本語", note: "" },
      { id: "3", tenant: marker, payload: "back\\slash and delimiters | ,", note: marker },
    ],
    objects: [
      { key: "nested/text.txt", bytes: Buffer.from(`${marker}\nhéllo ☃`), contentType: "text/plain" },
      { key: "binary.dat", bytes: Buffer.concat([Buffer.from([0, 255, 10, 13]), Buffer.from(marker)]), contentType: "application/octet-stream" },
      { key: "empty.dat", bytes: Buffer.alloc(0), contentType: "application/octet-stream" },
    ],
  };
}
function witness(entries: { identity: string; content: string }[]): Witness {
  const items = entries.map(e => ({ identityDigest: hash(e.identity), contentDigest: hash(e.content) }))
    .sort((a, b) => a.identityDigest.localeCompare(b.identityDigest));
  return WitnessSchema.parse({ count: items.length, digest: hash(JSON.stringify(items)), items });
}
export function rowWitness(rows: readonly FixtureRow[]): Witness {
  const parsed = z.array(z.object({ id: z.string(), tenant: z.string(), payload: z.string(), note: z.string().nullable() }).strict()).parse(rows);
  return witness(parsed.map(r => ({ identity: r.id, content: JSON.stringify([r.id, r.tenant, r.payload, r.note]) })));
}
export function objectWitness(objects: readonly FixtureObject[]): Witness {
  return witness(objects.map(o => ({ identity: o.key, content: JSON.stringify([o.key, o.bytes.length, hash(o.bytes), o.contentType]) })));
}
export function assertEqualContent(expected: Witness, actual: Witness): void {
  WitnessSchema.parse(expected); WitnessSchema.parse(actual);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Independent content readback mismatch");
}
/** Both the real hostname and the deliberately wrong TLS alias must be valid DNS labels. */
export function fixtureContainerName(runId: string, suffix: string, entropy: string): string {
  if (!/^[a-z0-9][a-z0-9-]{3,19}$/.test(runId) || !/^(postgres|mysql|minio)-(source|target)$/.test(suffix)
    || !/^[a-f0-9]{24}$/.test(entropy)) throw new Error("Invalid fixture container identity");
  const name = `zdrv4-${runId}-${suffix}-${entropy.slice(0, 12)}`;
  if ((name + "-wrong").length > 63) throw new Error("Fixture DNS label too long");
  return name;
}
export function pinnedFixtureImages(env: Readonly<Record<string, string | undefined>>): Record<DataKind, string> {
  const values = { postgres: env.ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE, mysql: env.ZENITH_LOCAL_EXPORT_MYSQL_IMAGE, object_store: env.ZENITH_LOCAL_EXPORT_MINIO_IMAGE };
  for (const value of Object.values(values)) if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value)) throw new Error("Native fixture image digest required");
  return values as Record<DataKind, string>;
}
