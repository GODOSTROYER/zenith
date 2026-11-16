/**
 * Azure-specific vocabulary shared by several drivers: API versions, the
 * landing-zone CIDR carving, Container Apps sizing, SKU tables and built-in
 * role names. Pure data and pure functions.
 */
import { AzureCompileError } from "@/lib/providers/azure/compile-util";

/* ------------------------------- API versions ------------------------------ */

/** ARM api-versions per resource type, taken from Microsoft's published REST references. */
export const API = {
  network: "2024-05-01",
  containerApps: "2024-03-01",
  postgres: "2024-08-01",
  redis: "2024-11-01",
  storage: "2023-05-01",
  serviceBus: "2022-10-01-preview",
  keyVault: "2023-07-01",
  logAnalytics: "2023-09-01",
  containerRegistry: "2023-07-01",
  /** schedule runs and source upload use the preview surface Microsoft documents for them */
  containerRegistryRuns: "2019-06-01-preview",
  identity: "2023-01-31",
  authorization: "2022-04-01",
  privateDns: "2024-06-01",
  dns: "2018-05-01",
  monitorMetrics: "2023-10-01",
  keyVaultData: "7.4",
} as const;

/* --------------------------------- CIDR math ------------------------------- */

const ipToInt = (ip: string): number => ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

export function parseCidr(cidr: string, where?: string): { base: number; bits: number } {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) throw new AzureCompileError(`"${cidr}" is not an IPv4 CIDR.`, where);
  const bits = Number(m[5]);
  const base = Math.floor(ipToInt(cidr.split("/")[0]) / 2 ** (32 - bits)) * 2 ** (32 - bits);
  return { base, bits };
}

/** RFC1918 / link-local private ranges: a CIDR entirely inside one is not "the internet". */
export function isPrivateCidr(cidr: string): boolean {
  const { base, bits } = parseCidr(cidr);
  const ranges: [string, number][] = [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]];
  return ranges.some(([ip, b]) => bits >= b && Math.floor(base / 2 ** (32 - b)) === Math.floor(ipToInt(ip) / 2 ** (32 - b)));
}

export interface LandingZoneCidrs {
  /** Container Apps infrastructure subnet (dedicated, delegated) */
  aca: string;
  /** PostgreSQL flexible server subnet (dedicated, delegated) */
  pg: string;
  /** private endpoints (Redis, Storage) */
  pe: string;
}

/**
 * Carve the platform subnets from the TOP of the VNet range. The portable
 * subnets (`subnet/public-*`, `subnet/private-*`) are carved by expansion from
 * the BOTTOM (/24 slices at indices 0..2 and 10..12 of a /16; /28 slices of a
 * /20), so the two never meet for any network between /8 and /20.
 *   aca  /23  (512 addresses; zone redundancy needs a /23 subnet)
 *   pg   /26  (delegated subnets need ≥ /28)
 *   pe   /26
 */
export function landingZoneCidrs(vnetCidr: string, where?: string): LandingZoneCidrs {
  const { base, bits } = parseCidr(vnetCidr, where);
  if (bits > 20 || bits < 8) throw new AzureCompileError(`the VNet CIDR ${vnetCidr} must be between /8 and /20 so platform subnets fit above the portable subnets.`, where);
  const size = 2 ** (32 - bits);
  const top = base + size;
  return {
    aca: `${intToIp(top - 512)}/23`,
    pg: `${intToIp(top - 512 - 64)}/26`,
    pe: `${intToIp(top - 512 - 128)}/26`,
  };
}

/* ------------------------------- Container Apps ---------------------------- */

export interface AcaSize {
  cpu: number;
  /** Gi */
  memoryGi: number;
  memoryMb: number;
  /** true when the request had to be rounded up to a valid combination */
  adjusted: boolean;
}

/**
 * The Consumption workload profile accepts cpu in 0.25 steps (0.25–4) with
 * memory exactly 2 Gi per vCPU. Round the portable (vcpu, memoryMb) UP to the
 * smallest valid pair that satisfies both.
 */
export function acaSize(vcpu: number, memoryMb: number, where?: string): AcaSize {
  if (!(vcpu > 0) || !(memoryMb > 0)) throw new AzureCompileError("vcpu and memoryMb must be positive.", where);
  const memGi = memoryMb / 1024;
  const cpu = Math.max(0.25, Math.ceil(Math.max(vcpu, memGi / 2) * 4) / 4);
  if (cpu > 4) throw new AzureCompileError(`${vcpu} vCPU / ${memoryMb} MB exceeds the Container Apps Consumption profile limit of 4 vCPU / 8 Gi.`, where);
  const memoryGi = cpu * 2;
  return { cpu, memoryGi, memoryMb: memoryGi * 1024, adjusted: cpu !== vcpu || memoryGi * 1024 !== memoryMb };
}

/** Container Apps wants `0.5Gi`-style strings. */
export const acaMemory = (gi: number): string => `${gi}Gi`;

/* ---------------------------------- SKUs ----------------------------------- */

export const POSTGRES_SKU_BY_SIZE: Readonly<Record<string, string>> = {
  nano: "B_Standard_B1ms",
  small: "B_Standard_B2s",
  standard: "GP_Standard_D2ds_v5",
  performance: "GP_Standard_D4ds_v5",
};

export const POSTGRES_STORAGE_MB_BY_SIZE: Readonly<Record<string, number>> = {
  nano: 32768,
  small: 32768,
  standard: 65536,
  performance: 131072,
};

/** Azure Cache for Redis capacity (C-family) per portable size. */
export const REDIS_CAPACITY_BY_SIZE: Readonly<Record<string, number>> = { nano: 0, small: 1, standard: 2, performance: 3 };

/* ------------------------------ built-in roles ----------------------------- */

/** Built-in role names used for grants. None of them is Owner, Contributor or User Access Administrator. */
export const ROLE = {
  keyVaultSecretsUser: "Key Vault Secrets User",
  keyVaultSecretsOfficer: "Key Vault Secrets Officer",
  blobReader: "Storage Blob Data Reader",
  blobContributor: "Storage Blob Data Contributor",
  blobOwner: "Storage Blob Data Owner",
  storageQueueContributor: "Storage Queue Data Contributor",
  serviceBusSender: "Azure Service Bus Data Sender",
  serviceBusReceiver: "Azure Service Bus Data Receiver",
  acrPull: "AcrPull",
  acrPush: "AcrPush",
} as const;

/** Names that must never be granted by a Zenith-compiled role assignment. */
export const FORBIDDEN_ROLE_NAMES: readonly string[] = ["Owner", "Contributor", "User Access Administrator", "Role Based Access Control Administrator"];

/* --------------------------------- defaults -------------------------------- */

/** Log Analytics retention the expansion asks for; also the workspace default here. */
export const DEFAULT_LOG_RETENTION_DAYS = 30;
