/**
 * Every `ZENITH_*` variable the hosted subsystem reads, validated in one place
 * — the same discipline as `@/lib/env` for `ORRERY_*`.
 *
 * Secrets are presence-only here: `ZENITH_CF_API_TOKEN`, `E2B_API_KEY`,
 * `ZENITH_BACKUP_KEY` and `ZENITH_POLICY_SHARED_SECRET` are read by exactly
 * one call site each, never through this module.
 *
 * Parsed on every call, not memoised: tests set variables before importing.
 *
 * SPINE FILE — owned by the integrator.
 */
import path from "node:path";
import { z } from "zod";
import { env } from "@/lib/env";

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const Schema = z.object({
  /** "1" turns on hosted admission rules: no claim re-grant, fail-closed auth, gateway on. */
  ZENITH_HOSTED_MODE: z.enum(["0", "1"]).default("0"),
  /** Where the control app is reached by browsers; the exchange redirects come back here. */
  ZENITH_CONTROL_ORIGIN: z.string().url().default("http://localhost:3400"),
  /** Registrable domain under which every app gets `<slug>.<domain>`. */
  ZENITH_APP_DOMAIN: z
    .string()
    .regex(HOST_RE, "must be a bare hostname such as apps.localhost or apps.example.com")
    .default("apps.localhost"),
  /** Scheme app hosts are served on. http only makes sense for *.localhost. */
  ZENITH_APP_SCHEME: z.enum(["http", "https"]).default("http"),
  ZENITH_RUNTIME: z.enum(["local", "cloudflare"]).default("local"),
  /** Which build runner may run. `none` refuses every build and says why. */
  ZENITH_BUILD_RUNNER: z.enum(["none", "recipe-local", "e2b", "docker"]).default("none"),
  ZENITH_ARTIFACT_DIR: z.string().min(1).optional(),
  ZENITH_BACKUP_TARGET: z.enum(["none", "filesystem", "s3"]).default("none"),
  ZENITH_BACKUP_DIR: z.string().min(1).optional(),
  ZENITH_BACKUP_S3_BUCKET: z.string().min(1).optional(),
  ZENITH_BACKUP_S3_ENDPOINT: z.string().url().optional(),
  ZENITH_CF_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  ZENITH_CF_NAMESPACE: z.string().regex(/^[a-z0-9-]{1,63}$/).optional(),
  /** Monthly envelope the 50/75/90 % spending alerts are measured against. */
  ZENITH_SPEND_ENVELOPE_USD: z.coerce.number().nonnegative().default(0),
  /** Comma-separated subjects excluded from activation metrics as founder/test actors. */
  ZENITH_FOUNDER_SUBJECTS: z.string().default(""),
  /** From address for app invitations; falls back to ORRERY_ALERT_FROM. */
  ZENITH_INVITE_FROM: z.string().optional(),
});

export type HostedConfig = Omit<z.infer<typeof Schema>, "ZENITH_HOSTED_MODE"> & {
  hostedMode: boolean;
  artifactDir: string;
  backupDir: string;
  founderSubjects: Set<string>;
};

const present = (key: string): string | undefined => {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v;
};

export function hostedConfig(): HostedConfig {
  const parsed = Schema.safeParse(
    Object.fromEntries(Object.keys(Schema.shape).map((k) => [k, present(k)]))
  );
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${String(i.path[0])}=${JSON.stringify(process.env[String(i.path[0])] ?? "")} — ${i.message}`
    );
    throw new Error(`Invalid hosted environment:\n${lines.join("\n")}\n\nFix these in .env.local, then start again.`);
  }
  const d = parsed.data;
  const data = env().ORRERY_DATA;
  return {
    ...d,
    hostedMode: d.ZENITH_HOSTED_MODE === "1",
    artifactDir: d.ZENITH_ARTIFACT_DIR ?? path.join(data, "artifacts"),
    backupDir: d.ZENITH_BACKUP_DIR ?? path.join(data, "backups"),
    founderSubjects: new Set(
      d.ZENITH_FOUNDER_SUBJECTS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  };
}

/** True when hosted admission rules apply to this process. Safe anywhere. */
export const hostedMode = (): boolean => present("ZENITH_HOSTED_MODE") === "1";

/** Which hosted integrations this process has secrets for. Never the values. */
export function hostedConfigured(): {
  cloudflare: boolean;
  e2b: boolean;
  backupKey: boolean;
  policySecret: boolean;
  smtp: boolean;
} {
  return {
    cloudflare: !!present("ZENITH_CF_API_TOKEN") && !!present("ZENITH_CF_ACCOUNT_ID") && !!present("ZENITH_CF_NAMESPACE"),
    e2b: !!present("E2B_API_KEY"),
    backupKey: !!present("ZENITH_BACKUP_KEY"),
    policySecret: !!present("ZENITH_POLICY_SHARED_SECRET"),
    smtp: !!present("ORRERY_SMTP_URL"),
  };
}

/** Absolute path of the control authority database. */
export const controlDatabasePath = (): string => path.join(env().ORRERY_DATA, "control.sqlite");

/** Per-app data directory (local runtime): database, test database, logs. */
export const appDataDir = (appId: string): string =>
  path.join(env().ORRERY_DATA, "apps", encodeURIComponent(appId));

/** The stable app hostname for a slug, e.g. `tracker.apps.localhost`. */
export function appHostname(slug: string): string {
  return `${slug}.${hostedConfig().ZENITH_APP_DOMAIN}`;
}

/** The browser-facing origin of an app, including the control port when not standard. */
export function appOrigin(slug: string): string {
  const cfg = hostedConfig();
  const control = new URL(cfg.ZENITH_CONTROL_ORIGIN);
  const port = control.port ? `:${control.port}` : "";
  return `${cfg.ZENITH_APP_SCHEME}://${appHostname(slug)}${port}`;
}

/**
 * The slug an incoming Host header names, or null when the host is not an app
 * host. Pure string work so the edge middleware can use it.
 */
export function slugFromHost(host: string | null | undefined, appDomain: string): string | null {
  if (!host) return null;
  const bare = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${appDomain.toLowerCase()}`;
  if (!bare.endsWith(suffix)) return null;
  const slug = bare.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug) && !slug.includes(".") ? slug : null;
}
