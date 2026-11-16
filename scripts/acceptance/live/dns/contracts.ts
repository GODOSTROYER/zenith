import { z } from "zod";
import { digest } from "./guard";

export const Provider = z.enum(["azure", "gcp", "oci"]);
export type Provider = z.infer<typeof Provider>;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const https = z.string().url().refine((s) => {
  const u = new URL(s);
  return u.protocol === "https:" && !u.username && !u.password && !u.hash;
});
const path = z.string().regex(/^\/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]*$/);
export const Assertion = z.object({
  pointer: z.string().regex(/^(?:\/(?:[^~]|~[01])*)*$/),
  operator: z.enum(["equals", "contains", "nonempty", "absent"]),
  expected: z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(z.string())]).optional(),
}).strict().superRefine((a, c) => {
  if (["equals", "contains"].includes(a.operator) && a.expected === undefined)
    c.addIssue({ code: "custom", message: "Comparison needs an expected value" });
});
export const Probe = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloud"), url: https, assertions: z.array(Assertion).min(1) }).strict(),
  z.object({ kind: z.literal("control"), path, assertions: z.array(Assertion).min(1) }).strict(),
  z.object({ kind: z.literal("traffic"), url: https, nonce: z.string().min(16).max(100), assertions: z.array(Assertion).min(1) }).strict(),
  z.object({ kind: z.literal("dns"), name: z.string().regex(/^[a-z0-9.-]+$/), type: z.enum(["TXT", "A", "AAAA", "CNAME"]), expected: z.array(z.string()).min(1) }).strict(),
  z.object({ kind: z.literal("tls"), url: https, minValidityHours: z.number().min(1).max(2160) }).strict(),
]);
export type Probe = z.infer<typeof Probe>;
export function isCompleteGcpInventoryUrl(url: string): boolean {
  try {
    const query = new URL(url).searchParams;
    return !["fields", "$fields", "fieldMask", "readMask", "delimiter", "returnPartialSuccess"].some((key) => query.has(key));
  } catch { return false; }
}
export function gcpInventoryItemsPointer(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  if (/^(?:compute#[A-Za-z]+List|storage#(?:objects|buckets))$/.test(kind)) return "/items";
  if (kind === "dns#resourceRecordSetsListResponse") return "/rrsets";
  if (kind === "dns#managedZonesListResponse") return "/managedZones";
  return undefined;
}
export const Inventory = z.object({
  url: https,
  itemsPointer: z.string(),
  idPointer: z.string(),
  tagsPointer: z.string(),
  pagination: z.enum(["azure", "gcp", "oci"]),
  // GCP's documented typed lists may omit items when empty; unknown objects still fail closed.
  emptyListKind: z.string().refine((kind) => gcpInventoryItemsPointer(kind) !== undefined).optional(),
  parentOwnership: z.object({
    url: https, tagsPointer: z.string(),
    childIdPrefix: z.string().min(1).optional(),
    targetValuesPointer: z.string().optional(), itemValuesPointer: z.string().optional(),
    itemValuePointer: z.string().optional(),
  }).strict().superRefine((p, c) => {
    if (!p.childIdPrefix && !(p.targetValuesPointer !== undefined && p.itemValuesPointer !== undefined))
      c.addIssue({ code: "custom", message: "Parent ownership must bind child IDs or live target values" });
  }).optional(),
}).strict().superRefine((d, c) => {
  if (d.emptyListKind && (d.pagination !== "gcp" || d.itemsPointer !== gcpInventoryItemsPointer(d.emptyListKind)))
    c.addIssue({ code: "custom", message: "Typed GCP empty lists require the documented collection field" });
  if (d.pagination === "gcp" && !isCompleteGcpInventoryUrl(d.url))
    c.addIssue({ code: "custom", message: "Inventory cannot project fields or collapse object prefixes" });
});
export type Inventory = z.infer<typeof Inventory>;
export const Packet = z.object({
  schema: z.literal("zenith.live-clouds.v1"),
  provider: Provider,
  runId: z.string().regex(/^znlive-[a-f0-9]{16}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  account: z.string().min(1).max(200), region: id, workspaceId: id,
  environmentIds: z.array(id).min(1).max(20),
  apiOrigin: https,
  estimatedUsd: z.number().finite().positive(), durationHours: z.number().positive().max(24),
  estimateBasis: z.string().min(10).max(300),
  checks: z.array(z.object({ id, probes: z.array(Probe).min(1) }).strict()).min(1),
  inventory: z.array(Inventory).min(1).max(30),
}).strict().superRefine((p, c) => {
  if (new Set(p.checks.map((x) => x.id)).size !== p.checks.length || new Set(p.environmentIds).size !== p.environmentIds.length)
    c.addIssue({ code: "custom", message: "Duplicate check or environment" });
  if (new URL(p.apiOrigin).origin !== p.apiOrigin)
    c.addIssue({ code: "custom", message: "apiOrigin must be an origin" });
});
export type Packet = z.infer<typeof Packet>;
export const Permissions = z.object({
  schema: z.literal("zenith.live-cloud-permissions.v1"),
  approved: z.literal(true), approvedBy: z.literal("arnav.bule05@gmail.com"),
  expiresAt: z.string().datetime(),
  // A reviewed packet digest binds all paths, assertions, estimates and teardown targets.
  packetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  maxUsd: z.number().finite().positive(), maxHours: z.number().finite().positive().max(24),
  cloudOrigins: z.array(https).min(1), cloudPathPrefixes: z.array(z.string().min(2)).min(1),
  trafficOrigins: z.array(https), dnsSuffixes: z.array(z.string().regex(/^[a-z0-9.-]+$/)),
  retainedResourceIds: z.array(z.string().min(1)),
  allowTeardownReview: z.literal(true),
}).strict();
export type Permissions = z.infer<typeof Permissions>;

// Coverage names describe checks, not a claim that the requirement is verified.
// Wave 5 emits packets after operating its fixtures; missing clauses remain incomplete.
export const CASES: Readonly<Record<string, { requirements: string[]; providers: Provider[]; description: string }>> = {
  "azure-source-binding": { requirements: ["PROD-LIFE-04"], providers: ["azure"], description: "Trusted source digest and account/container binding preserved" },
  "azure-data-plane": { requirements: ["PROD-LIFE-04"], providers: ["azure"], description: "Resource-scoped Blob/Key Vault RBAC and successful data-plane reads" },
  "azure-source-build": { requirements: ["PROD-LIFE-04"], providers: ["azure"], description: "Real ACR source build digest independently read back" },
  "azure-sovereign": { requirements: ["PROD-LIFE-04"], providers: ["azure"], description: "Configured sovereign authority and ARM endpoint; public cloud cannot close this check" },
  "oci-runner-replacement": { requirements: ["PROD-LIFE-05"], providers: ["oci"], description: "Replacement process resumes inherited same-runner journal" },
  "oci-lost-response": { requirements: ["PROD-LIFE-05"], providers: ["oci"], description: "Lost launch response remains uncertain without relaunch" },
  "oci-deletion": { requirements: ["PROD-LIFE-05"], providers: ["oci"], description: "Independent family listing confirms deletion, not just a work-request receipt" },
  "oci-mysql-refusal": { requirements: ["PROD-LIFE-05"], providers: ["oci"], description: "Unsafe MySQL mutation remains unsupported" },
  "dns-owned": { requirements: ["PROD-LIFE-06"], providers: ["azure", "gcp", "oci"], description: "Owned record value and marker bind the reviewed digest" },
  "dns-foreign": { requirements: ["PROD-LIFE-06"], providers: ["azure", "gcp", "oci"], description: "Foreign record refuses an approvable destroy proposal" },
  "dns-unreadable": { requirements: ["PROD-LIFE-06"], providers: ["azure", "gcp", "oci"], description: "Unreadable ownership refuses an approvable destroy proposal" },
  "mixed-authorities": { requirements: ["PROD-MIX-01"], providers: ["azure", "gcp", "oci"], description: "Independent provider/account/region/backend/connection partitions" },
  "mixed-immutable-plans": { requirements: ["PROD-MIX-02"], providers: ["azure", "gcp", "oci"], description: "Immutable child set, human parent approval, ordered durable receipts and stable addresses" },
  "mixed-output-scope": { requirements: ["PROD-MIX-03"], providers: ["azure", "gcp", "oci"], description: "Output provenance and secret references; new effects receive exact review" },
  "mixed-failure-order": { requirements: ["PROD-MIX-04"], providers: ["azure", "gcp", "oci"], description: "Cycles, timeout, expiry, cancellation, outage, drift and migration fail safely" },
  "mixed-connectivity": { requirements: ["PROD-MIX-05"], providers: ["azure", "gcp", "oci"], description: "Network overlap, DNS/TLS/identity/secret binding; private DB or approved protected endpoint" },
  "mixed-traffic": { requirements: ["PROD-MIX-06"], providers: ["azure", "gcp", "oci"], description: "Nonce write/read traverses GCP compute, Azure PostgreSQL and AWS functions (or approved equivalent)" },
  "mixed-recovery-economics": { requirements: ["PROD-MIX-07"], providers: ["azure", "gcp", "oci"], description: "One-provider outage recovery plus measured latency, transfer and residency cost" },
  "managed-substrate": { requirements: ["PROD-MAN-01"], providers: ["azure", "gcp", "oci"], description: "Default session, source build and release on a real managed substrate" },
  "managed-serving": { requirements: ["PROD-MAN-02"], providers: ["azure", "gcp", "oci"], description: "Real registry/gateway/DNS/TLS/secret/storage/managed DB integration" },
  "domain-proof-renewal": { requirements: ["PROD-MAN-03"], providers: ["azure", "gcp", "oci"], description: "Actual DNS domain proof, renewal and trusted real ACME certificate" },
  "managed-data-catalog": { requirements: ["PROD-MAN-03"], providers: ["azure", "gcp", "oci"], description: "Tenant storage, database export/restore, autoscaling and promised catalog services" },
};

export function planner(packet: Packet) {
  for (const check of packet.checks) {
    if (!CASES[check.id]?.providers.includes(packet.provider)) throw new Error("Unknown or incompatible acceptance check");
  }
  const declared = new Set(packet.checks.map((x) => x.id));
  return {
    mode: "plan", credentialReads: 0, networkCalls: 0,
    packetSha256: digest(packet),
    estimatedUsd: packet.estimatedUsd, durationHours: packet.durationHours,
    estimateBasis: packet.estimateBasis,
    checks: packet.checks.map((c) => ({ id: c.id, ...CASES[c.id] })),
    missing: Object.entries(CASES).filter(([key, c]) => c.providers.includes(packet.provider) && !declared.has(key)).map(([key]) => key),
    teardown: [...packet.environmentIds].reverse(),
    limits: ["Estimate is operator supplied, must include egress and orphan time; budget alerts are not a spending cap", "Passing a selection of checks never verifies an entire requirement"],
  };
}
