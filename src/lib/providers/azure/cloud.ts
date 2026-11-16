/**
 * Azure cloud environment abstraction (PROD-LIFE-04).
 *
 * Every Azure endpoint Zenith talks to differs between the public cloud and
 * the sovereign clouds (US Government, China/21Vianet): the ARM endpoint, the
 * Entra authority, the token audiences (resource scopes), the federation
 * audience of the workload-identity exchange, and the DNS suffixes of Blob
 * Storage, Key Vault and Container Registry. This module is the ONLY place
 * those literals live; credentials, ARM, Key Vault, Blob, ACR, Log Analytics
 * and the OpenTofu environment all derive them from an `AzureCloud`.
 *
 * Honest limit: the public cloud is the only one a live acceptance run can
 * target. The USGov and China values are taken from Microsoft's published
 * endpoint documentation and are exercised by contract tests (fake Entra,
 * fake ARM) only. A connection that names a sovereign cloud is accepted by
 * the contract; deploying into one live is deferred.
 *
 * A bearer token is only ever sent to a host this table derives. Nothing here
 * is user input: the cloud name comes from the validated connection config and
 * an unknown name is refused, never defaulted to a different cloud.
 */

export const AZURE_CLOUD_NAMES = ["public", "usgov", "china"] as const;
export type AzureCloudName = (typeof AZURE_CLOUD_NAMES)[number];

/** audiences a session can mint a token for (one Entra resource each) */
export type AzureTokenAudience = "arm" | "keyvault" | "loganalytics" | "monitor" | "storage";

export interface AzureCloud {
  readonly name: AzureCloudName;
  /** `https://management...` with no trailing slash */
  readonly armOrigin: string;
  readonly armHost: string;
  /** Entra authority, no trailing slash */
  readonly authorityHost: string;
  /** audience of the client assertion Zenith signs (the federated credential must list the same value) */
  readonly federationAudience: string;
  /** `<resource>/.default` scope per audience */
  readonly tokenScopes: Readonly<Record<AzureTokenAudience, string>>;
  /** `blob.core.windows.net` etc: the account host is `<account>.<suffix>` */
  readonly blobSuffix: string;
  readonly queueSuffix: string;
  /** Key Vault DNS suffix: `<vault>.<suffix>` */
  readonly keyVaultSuffix: string;
  /** Container Registry login-server suffix: `<registry>.<suffix>` */
  readonly acrSuffix: string;
  /** exact Log Analytics query hosts */
  readonly logAnalyticsHosts: readonly string[];
  /** Azure Monitor ingestion/data suffix: `<region>.<suffix>` style hosts */
  readonly monitorSuffix: string;
  /** value of `ARM_ENVIRONMENT` for azurerm / the azurerm backend */
  readonly tofuEnvironment: "public" | "usgovernment" | "china";
  /** private DNS zones used by private endpoints */
  readonly privateZones: Readonly<{ blob: string; queue: string; redis: string; keyVault: string; acr: string; web: string; postgres: string; mysql: string }>;
  /** whether live acceptance is in scope for this cloud (public only) */
  readonly liveAcceptance: boolean;
}

const PUBLIC: AzureCloud = {
  name: "public",
  armOrigin: "https://management.azure.com",
  armHost: "management.azure.com",
  authorityHost: "https://login.microsoftonline.com",
  federationAudience: "api://AzureADTokenExchange",
  tokenScopes: {
    arm: "https://management.azure.com/.default",
    storage: "https://storage.azure.com/.default",
    keyvault: "https://vault.azure.net/.default",
    loganalytics: "https://api.loganalytics.io/.default",
    monitor: "https://monitor.azure.com/.default",
  },
  blobSuffix: "blob.core.windows.net",
  queueSuffix: "queue.core.windows.net",
  keyVaultSuffix: "vault.azure.net",
  acrSuffix: "azurecr.io",
  logAnalyticsHosts: ["api.loganalytics.io", "api.loganalytics.azure.com"],
  monitorSuffix: "monitor.azure.com",
  tofuEnvironment: "public",
  privateZones: {
    blob: "privatelink.blob.core.windows.net",
    queue: "privatelink.queue.core.windows.net",
    redis: "privatelink.redis.cache.windows.net",
    keyVault: "privatelink.vaultcore.azure.net",
    acr: "privatelink.azurecr.io",
    web: "privatelink.azurewebsites.net",
    postgres: "private.postgres.database.azure.com",
    mysql: "mysql.database.azure.com",
  },
  liveAcceptance: true,
};

const USGOV: AzureCloud = {
  name: "usgov",
  armOrigin: "https://management.usgovcloudapi.net",
  armHost: "management.usgovcloudapi.net",
  authorityHost: "https://login.microsoftonline.us",
  federationAudience: "api://AzureADTokenExchangeUSGov",
  tokenScopes: {
    arm: "https://management.usgovcloudapi.net/.default",
    // the storage resource id is the same in every cloud
    storage: "https://storage.azure.com/.default",
    keyvault: "https://vault.usgovcloudapi.net/.default",
    loganalytics: "https://api.loganalytics.us/.default",
    monitor: "https://monitor.azure.us/.default",
  },
  blobSuffix: "blob.core.usgovcloudapi.net",
  queueSuffix: "queue.core.usgovcloudapi.net",
  keyVaultSuffix: "vault.usgovcloudapi.net",
  acrSuffix: "azurecr.us",
  logAnalyticsHosts: ["api.loganalytics.us"],
  monitorSuffix: "monitor.azure.us",
  tofuEnvironment: "usgovernment",
  privateZones: {
    blob: "privatelink.blob.core.usgovcloudapi.net",
    queue: "privatelink.queue.core.usgovcloudapi.net",
    redis: "privatelink.redis.cache.usgovcloudapi.net",
    keyVault: "privatelink.vaultcore.usgovcloudapi.net",
    acr: "privatelink.azurecr.us",
    web: "privatelink.azurewebsites.us",
    postgres: "private.postgres.database.usgovcloudapi.net",
    mysql: "mysql.database.usgovcloudapi.net",
  },
  liveAcceptance: false,
};

const CHINA: AzureCloud = {
  name: "china",
  armOrigin: "https://management.chinacloudapi.cn",
  armHost: "management.chinacloudapi.cn",
  authorityHost: "https://login.chinacloudapi.cn",
  federationAudience: "api://AzureADTokenExchangeChina",
  tokenScopes: {
    arm: "https://management.chinacloudapi.cn/.default",
    storage: "https://storage.azure.com/.default",
    keyvault: "https://vault.azure.cn/.default",
    loganalytics: "https://api.loganalytics.azure.cn/.default",
    monitor: "https://monitor.azure.cn/.default",
  },
  blobSuffix: "blob.core.chinacloudapi.cn",
  queueSuffix: "queue.core.chinacloudapi.cn",
  keyVaultSuffix: "vault.azure.cn",
  acrSuffix: "azurecr.cn",
  logAnalyticsHosts: ["api.loganalytics.azure.cn"],
  monitorSuffix: "monitor.azure.cn",
  tofuEnvironment: "china",
  privateZones: {
    blob: "privatelink.blob.core.chinacloudapi.cn",
    queue: "privatelink.queue.core.chinacloudapi.cn",
    redis: "privatelink.redis.cache.chinacloudapi.cn",
    keyVault: "privatelink.vaultcore.azure.cn",
    acr: "privatelink.azurecr.cn",
    web: "privatelink.chinacloudsites.cn",
    postgres: "private.postgres.database.chinacloudapi.cn",
    mysql: "mysql.database.chinacloudapi.cn",
  },
  liveAcceptance: false,
};

const CLOUDS: Readonly<Record<AzureCloudName, AzureCloud>> = Object.freeze({ public: PUBLIC, usgov: USGOV, china: CHINA });

export const PUBLIC_AZURE_CLOUD: AzureCloud = PUBLIC;

export class UnknownAzureCloudError extends Error {
  readonly code = "azure_cloud_unknown";
  constructor() {
    super("Unknown Azure cloud; expected public, usgov or china.");
    this.name = "UnknownAzureCloudError";
  }
}

export function isAzureCloudName(value: unknown): value is AzureCloudName {
  return typeof value === "string" && Object.hasOwn(CLOUDS, value);
}

/** The cloud for a configured name; `undefined` means the public cloud. An unknown name is refused. */
export function azureCloud(name?: string): AzureCloud {
  if (name === undefined) return PUBLIC;
  if (!isAzureCloudName(name)) throw new UnknownAzureCloudError();
  return CLOUDS[name];
}

/** The cloud a session was created for (sessions made before this field existed are public). */
export function cloudOf(session: { readonly cloud?: AzureCloudName }): AzureCloud {
  return azureCloud(session.cloud);
}

/* ------------------------------- host helpers ------------------------------ */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** `<labels>.<suffix>` with min..max DNS-safe labels. */
export function isSubdomainOf(host: string, suffix: string, minLabels: number, maxLabels: number): boolean {
  if (!host.endsWith(`.${suffix}`)) return false;
  const labels = host.slice(0, host.length - suffix.length - 1).split(".");
  return labels.length >= minLabels && labels.length <= maxLabels && labels.every((l) => LABEL.test(l));
}

/** Which token audience a host is entitled to in this cloud; `undefined` when not allowed. */
export function audienceForCloudHost(cloud: AzureCloud, hostname: string, trustedSourceHost?: string): AzureTokenAudience | undefined {
  const h = hostname.toLowerCase();
  if (trustedSourceHost && h === trustedSourceHost) return "storage";
  if (h === cloud.armHost) return "arm";
  if (cloud.logAnalyticsHosts.includes(h)) return "loganalytics";
  if (isSubdomainOf(h, cloud.keyVaultSuffix, 1, 1)) return "keyvault";
  if (isSubdomainOf(h, cloud.monitorSuffix, 1, 3)) return "monitor";
  return undefined;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `<registry>.azurecr.io` (or the cloud's suffix) */
export function acrLoginServerPattern(cloud: AzureCloud): RegExp {
  return new RegExp(`^[a-z0-9]{5,50}\\.${escapeRe(cloud.acrSuffix)}$`);
}

/** Any cloud's ACR login server. For stored receipts whose cloud is checked against the session separately. */
export const ANY_ACR_LOGIN_SERVER = new RegExp(`^[a-z0-9]{5,50}\\.(?:${Object.values(CLOUDS).map((c) => escapeRe(c.acrSuffix)).join("|")})$`);

/** `<account>.blob.core...` of a storage account in this cloud */
export function blobHostPattern(cloud: AzureCloud): RegExp {
  return new RegExp(`^[a-z0-9]{3,24}\\.${escapeRe(cloud.blobSuffix)}$`);
}

export function blobHost(cloud: AzureCloud, account: string): string {
  if (!/^[a-z0-9]{3,24}$/.test(account)) throw new Error("Invalid storage account name.");
  return `${account}.${cloud.blobSuffix}`;
}

/** `https://<vault>.<suffix>/` (trailing slash optional) */
export function keyVaultUriPattern(cloud: AzureCloud): RegExp {
  return new RegExp(`^https://([a-z0-9][a-z0-9-]{1,22}[a-z0-9])\\.${escapeRe(cloud.keyVaultSuffix)}/?$`);
}

export function keyVaultUri(cloud: AzureCloud, vaultName: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(vaultName)) throw new Error("Invalid Key Vault name.");
  return `https://${vaultName}.${cloud.keyVaultSuffix}/`;
}

/** The `Microsoft.Resources` URL of a resource id in this cloud. */
export function armUrl(cloud: AzureCloud, path: string): string {
  return `${cloud.armOrigin}${path}`;
}
