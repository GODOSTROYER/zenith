/**
 * Static latency and geography tables for placement (ADR-0013).
 *
 * HONEST LIMITS
 * - Every RTT here is an APPROXIMATE round-trip time in milliseconds between
 *   two broad geographies, rounded from figures in the public cloud ping
 *   datasets and inter-region latency pages that cloud providers and
 *   community trackers publish (for example cloudping.info, the Azure network
 *   round-trip latency statistics page and Google Cloud's inter-region latency
 *   dashboard). It was written from those as remembered on 2026-09-30, NOT
 *   measured from Zenith infrastructure and NOT pulled from a feed. Real
 *   latency depends on the user's network, the exact metro and time of day.
 * - It is good enough to rank "Mumbai serves India better than Ireland" and
 *   to flag "no single region meets 80 ms for India and Singapore users". It is
 *   not good enough for SLOs. `latencyMs` on a candidate is an estimate.
 * - The p95 estimate is a fixed factor over the median-ish RTT
 *   (`P95_FACTOR`), an assumption, not a measurement.
 *
 * Geography is deliberately coarse: nine geos, each cloud region maps to one.
 * Residency tags describe the country and the political/legal groupings a
 * customer is likely to write in a residency constraint ("EU", "India"); they
 * are a convenience for matching, not legal advice about where data may live.
 */

/** User-facing regions a constraint may name (spec §29 vocabulary). */
export const USER_REGIONS = ["india", "singapore", "us-east", "us-west", "europe", "japan", "australia", "brazil"] as const;
export type UserRegion = (typeof USER_REGIONS)[number];

export const GEOS = [
  "india",
  "singapore",
  "us-east",
  "us-central",
  "us-west",
  "europe-west",
  "japan",
  "australia",
  "brazil",
] as const;
export type Geo = (typeof GEOS)[number];

/** p95 ~= median RTT x this factor (assumption). */
export const P95_FACTOR = 1.5;
/** Minimum added latency for a call that crosses providers inside the same metro (assumption). */
export const CROSS_CLOUD_SAME_METRO_MS = 10;

/** Approximate RTT (ms) inside one geography (user to a region in the same geo). */
const INTRA_GEO_MS: Record<Geo, number> = {
  india: 15,
  singapore: 8,
  "us-east": 15,
  "us-central": 20,
  "us-west": 15,
  "europe-west": 20,
  japan: 12,
  australia: 15,
  brazil: 15,
};

/** Symmetric approximate RTT (ms) between two different geographies. Keyed by "a|b" with a < b. */
const INTER_GEO_MS: Record<string, number> = {
  "india|singapore": 60,
  "india|us-east": 200,
  "india|us-central": 230,
  "india|us-west": 240,
  "europe-west|india": 130,
  "india|japan": 110,
  "australia|india": 150,
  "brazil|india": 300,
  "singapore|us-east": 230,
  "singapore|us-central": 210,
  "singapore|us-west": 170,
  "europe-west|singapore": 165,
  "japan|singapore": 70,
  "australia|singapore": 95,
  "brazil|singapore": 320,
  "us-central|us-east": 35,
  "us-east|us-west": 70,
  "europe-west|us-east": 75,
  "japan|us-east": 150,
  "australia|us-east": 200,
  "brazil|us-east": 120,
  "us-central|us-west": 40,
  "europe-west|us-central": 105,
  "japan|us-central": 130,
  "australia|us-central": 170,
  "brazil|us-central": 140,
  "europe-west|us-west": 140,
  "japan|us-west": 105,
  "australia|us-west": 150,
  "brazil|us-west": 170,
  "europe-west|japan": 220,
  "australia|europe-west": 270,
  "brazil|europe-west": 190,
  "australia|japan": 110,
  "brazil|japan": 260,
  "australia|brazil": 310,
};

/** Human-readable statement of what this table is; surfaced by explanations. */
export const LATENCY_TABLE_SOURCE =
  "Approximate inter-geography round-trip times rounded from public cloud ping datasets (as remembered 2026-09-30; not measured, not fetched). p95 is estimated as 1.5x these figures.";

const USER_REGION_TO_GEO: Record<UserRegion, Geo> = {
  india: "india",
  singapore: "singapore",
  "us-east": "us-east",
  "us-west": "us-west",
  europe: "europe-west",
  japan: "japan",
  australia: "australia",
  brazil: "brazil",
};

const USER_REGION_ALIASES: Record<string, UserRegion> = {
  eu: "europe",
  "europe-west": "europe",
  in: "india",
  sg: "singapore",
  jp: "japan",
  au: "australia",
  br: "brazil",
  "us east": "us-east",
  "us west": "us-west",
  useast: "us-east",
  uswest: "us-west",
};

/** The geography a user region maps to. */
export function userRegionGeo(user: UserRegion): Geo {
  return USER_REGION_TO_GEO[user];
}

/** Normalize a user-facing region name, or undefined if unknown. */
export function normalizeUserRegion(name: string): UserRegion | undefined {
  const k = name.trim().toLowerCase().replace(/_/g, "-");
  if ((USER_REGIONS as readonly string[]).includes(k)) return k as UserRegion;
  return USER_REGION_ALIASES[k];
}

export function geoRttMs(a: Geo, b: Geo): number {
  if (a === b) return INTRA_GEO_MS[a];
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const v = INTER_GEO_MS[key];
  if (v === undefined) throw new Error(`No latency entry for ${a} <-> ${b}.`);
  return v;
}

/* --------------------------- provider-region geography -------------------- */

export interface RegionInfo {
  provider: string;
  region: string;
  geo: Geo;
  /** ISO 3166-1 alpha-2, upper case */
  country: string;
  city: string;
  /**
   * Availability zones (OCI: availability domains) the region offers, as
   * remembered on 2026-09-30 and NOT read from a feed; the zenith placeholder
   * regions assume 2. Multi-AZ placement requires at least 2.
   */
  zones: number;
  /** lower-case tokens a residency constraint may use to match this region: country code, name, groupings */
  residencyTags: readonly string[];
}

const IN = ["in", "india"] as const;
const SG = ["sg", "singapore"] as const;
const US = ["us", "usa", "united states", "united states of america"] as const;
const EU = ["eu", "eea", "european union", "european economic area"] as const;
const IE = ["ie", "ireland", ...EU] as const;
const BE = ["be", "belgium", ...EU] as const;
const NL = ["nl", "netherlands", ...EU] as const;

function info(provider: string, region: string, geo: Geo, country: string, city: string, zones: number, tags: readonly string[]): RegionInfo {
  return { provider, region, geo, country, city, zones, residencyTags: tags };
}

const REGION_INFOS: readonly RegionInfo[] = [
  info("aws", "ap-south-1", "india", "IN", "Mumbai", 3, IN),
  info("aws", "ap-southeast-1", "singapore", "SG", "Singapore", 3, SG),
  info("aws", "us-east-1", "us-east", "US", "N. Virginia", 6, US),
  info("aws", "eu-west-1", "europe-west", "IE", "Ireland", 3, IE),
  info("gcp", "asia-south1", "india", "IN", "Mumbai", 3, IN),
  info("gcp", "asia-southeast1", "singapore", "SG", "Singapore", 3, SG),
  info("gcp", "us-central1", "us-central", "US", "Iowa", 4, US),
  info("gcp", "europe-west1", "europe-west", "BE", "Belgium", 3, BE),
  info("azure", "centralindia", "india", "IN", "Pune", 3, IN),
  info("azure", "southeastasia", "singapore", "SG", "Singapore", 3, SG),
  info("azure", "eastus", "us-east", "US", "Virginia", 3, US),
  info("azure", "westeurope", "europe-west", "NL", "Netherlands", 3, NL),
  info("oci", "ap-mumbai-1", "india", "IN", "Mumbai", 1, IN),
  info("oci", "ap-singapore-1", "singapore", "SG", "Singapore", 1, SG),
  info("oci", "us-ashburn-1", "us-east", "US", "Ashburn", 3, US),
  // Zenith managed tier: placeholder regions, see the catalog source for the caveat.
  info("zenith", "ap-south", "india", "IN", "Mumbai", 2, IN),
  info("zenith", "ap-southeast", "singapore", "SG", "Singapore", 2, SG),
  info("zenith", "us-east", "us-east", "US", "N. Virginia", 2, US),
  info("zenith", "eu-west", "europe-west", "IE", "Ireland", 2, IE),
];

const REGION_INDEX = new Map(REGION_INFOS.map((r) => [`${r.provider}|${r.region}`, r]));

export function regionInfo(provider: string, region: string): RegionInfo | undefined {
  return REGION_INDEX.get(`${provider}|${region}`);
}

/** All known provider regions, sorted by provider then region. */
export function knownRegions(): readonly RegionInfo[] {
  return [...REGION_INFOS].sort((a, b) => (a.provider + a.region < b.provider + b.region ? -1 : 1));
}

/** Normalize a free-text residency token ("European_Union", " EU ") for matching. */
export function normalizeResidencyToken(token: string): string {
  return token.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/** True when any residency token matches the region's country, name or grouping. Empty/undefined residency allows everything. */
export function regionSatisfiesResidency(info: RegionInfo, residency: readonly string[] | undefined): boolean {
  if (!residency || residency.length === 0) return true;
  const tags = new Set(info.residencyTags);
  return residency.some((t) => tags.has(normalizeResidencyToken(t)));
}

/* ------------------------------- latency lookups -------------------------- */

/** Approximate RTT in ms from a user region to a provider region; throws for an unknown region. */
export function userToRegionRttMs(user: UserRegion, provider: string, region: string): number {
  const ri = regionInfo(provider, region);
  if (!ri) throw new Error(`Unknown region ${provider}/${region} in the latency table.`);
  return geoRttMs(USER_REGION_TO_GEO[user], ri.geo);
}

/** Estimated p95 latency in ms: RTT x `P95_FACTOR`, rounded. */
export function estimateP95Ms(rttMs: number): number {
  return Math.round(rttMs * P95_FACTOR);
}

export interface RegionRef {
  provider: string;
  region: string;
}

/**
 * Approximate RTT between two deployed locations. Different providers in the
 * same geography cost at least `CROSS_CLOUD_SAME_METRO_MS` (interconnect over
 * the public internet or an IXP); the same provider in the same region is
 * treated as intra-region (1 ms, assumption).
 */
export function regionToRegionRttMs(a: RegionRef, b: RegionRef): number {
  const ia = regionInfo(a.provider, a.region);
  const ib = regionInfo(b.provider, b.region);
  if (!ia || !ib) throw new Error(`Unknown region in latency lookup: ${a.provider}/${a.region} <-> ${b.provider}/${b.region}.`);
  if (a.provider === b.provider && a.region === b.region) return 1;
  if (ia.geo === ib.geo) return a.provider === b.provider ? INTRA_GEO_MS[ia.geo] : CROSS_CLOUD_SAME_METRO_MS;
  return geoRttMs(ia.geo, ib.geo);
}
