/**
 * Read surface for the versioned offered capability catalog (PROD-LIFE-02).
 *
 * The data is the committed, generated `offered-catalog.json`. It is parsed
 * with the schema and its structural invariants (rollup, digest, version) are
 * re-checked once per process, so a hand-edited or corrupted file fails loudly
 * instead of being served. It never imports a provider or a driver: that work
 * happens in `scripts/docs/offered-catalog.ts`, and the drift check keeps the
 * file equal to what that derivation produces.
 */
import raw from "./offered-catalog.json";
import {
  OfferedCatalogSchema,
  PROVIDER_ORDER,
  DOMAINS,
  SUPPORT_LEVELS,
  checkCatalogInvariants,
  type Domain,
  type Entry,
  type OfferedCatalog,
  type Rollup,
  type SupportLevel,
} from "./schema";
import type { PortableKind, ProviderKey } from "@/lib/resources/types";

export * from "./schema";

export const OFFERED_CATALOG_PATH = "src/lib/offered-catalog/offered-catalog.json";

let cached: OfferedCatalog | undefined;

/** The validated catalog. Throws if the committed file is malformed or internally inconsistent. */
export function getOfferedCatalog(): OfferedCatalog {
  if (cached) return cached;
  const parsed = OfferedCatalogSchema.parse(raw as unknown);
  const problems = checkCatalogInvariants(parsed);
  if (problems.length > 0) throw new Error(`The offered capability catalog is inconsistent: ${problems.slice(0, 5).join("; ")}`);
  cached = parsed;
  return parsed;
}

export interface CatalogFilter {
  provider?: ProviderKey;
  domain?: Domain;
  kind?: PortableKind;
  level?: SupportLevel;
}

/** Entries matching every given filter; filters narrow, they never widen. */
export function queryOfferedCatalog(filter: CatalogFilter = {}): Entry[] {
  return getOfferedCatalog().entries.filter(
    (e) => (!filter.provider || e.provider === filter.provider) && (!filter.domain || e.domain === filter.domain) && (!filter.kind || e.kind === filter.kind) && (!filter.level || e.level === filter.level)
  );
}

/** Parse query-string style filters; returns an error message naming the bad field, never the value. */
export function parseCatalogFilter(params: { get(name: string): string | null }): { ok: true; filter: CatalogFilter } | { ok: false; error: string } {
  const filter: CatalogFilter = {};
  const provider = params.get("provider");
  if (provider !== null) {
    if (!(PROVIDER_ORDER as readonly string[]).includes(provider)) return { ok: false, error: "provider is not a known provider" };
    filter.provider = provider as ProviderKey;
  }
  const domain = params.get("domain");
  if (domain !== null) {
    if (!(DOMAINS as readonly string[]).includes(domain)) return { ok: false, error: "domain is not a known domain" };
    filter.domain = domain as Domain;
  }
  const level = params.get("level");
  if (level !== null) {
    if (!(SUPPORT_LEVELS as readonly string[]).includes(level)) return { ok: false, error: "level must be supported, preview or unsupported" };
    filter.level = level as SupportLevel;
  }
  const kind = params.get("kind");
  if (kind !== null) {
    const known = new Set(getOfferedCatalog().entries.map((e) => e.kind as string));
    if (!known.has(kind)) return { ok: false, error: "kind is not a known portable kind" };
    filter.kind = kind as PortableKind;
  }
  return { ok: true, filter };
}

export interface OfferedCatalogSummary {
  schemaVersion: number;
  catalogVersion: string;
  contentDigest: string;
  levelPolicy: OfferedCatalog["levelPolicy"];
  /** per provider, per domain: the best level offered, with the reason when none is */
  providers: { provider: ProviderKey; domains: { domain: Domain; level: SupportLevel; reason?: string }[]; counts: Record<SupportLevel, number> }[];
}

/** Compact view for MCP and list screens: rollups and entry counts, no per-cell detail. */
export function offeredCatalogSummary(): OfferedCatalogSummary {
  const catalog = getOfferedCatalog();
  return {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    contentDigest: catalog.contentDigest,
    levelPolicy: catalog.levelPolicy,
    providers: catalog.providers.map((provider) => {
      const counts: Record<SupportLevel, number> = { supported: 0, preview: 0, unsupported: 0 };
      for (const e of catalog.entries) if (e.provider === provider) counts[e.level] += 1;
      const domains = catalog.rollup.filter((r: Rollup) => r.provider === provider).map((r) => ({ domain: r.domain, level: r.level, ...(r.reason ? { reason: r.reason } : {}) }));
      return { provider, domains, counts };
    }),
  };
}

/** The level offered for one provider x kind x lifecycle or day-two operation; unknown combinations are unsupported, never assumed. */
export function offeredSupport(provider: ProviderKey, kind: PortableKind, operation?: string): { level: SupportLevel; reason?: string } {
  const entry = getOfferedCatalog().entries.find((e) => e.provider === provider && e.kind === kind);
  if (!entry) return { level: "unsupported", reason: "No catalog entry for this provider and kind." };
  if (operation === undefined) return { level: entry.level, ...(entry.reason ? { reason: entry.reason } : {}) };
  if (entry.status === "not_offered") return { level: "unsupported", ...(entry.reason ? { reason: entry.reason } : {}) };
  const cell = (entry.lifecycle as Record<string, { level: SupportLevel; reason?: string }> | undefined)?.[operation] ?? entry.dayTwo?.[operation];
  if (!cell) return { level: "unsupported", reason: "This operation is not part of the catalog." };
  return { level: cell.level, ...(cell.reason ? { reason: cell.reason } : {}) };
}
