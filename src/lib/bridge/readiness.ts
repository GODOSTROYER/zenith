/**
 * Execution-plane readiness: can this install really deploy to a real cloud?
 *
 * ADR-0001: sandbox and LocalStack deployments run on the in-process engine;
 * real providers run through Temporal workflows (ADR-0009) against the platform
 * control store (ADR-0002). Until every prerequisite exists, a real provider
 * stays Preview (plan + export, never apply). This module answers the question
 * once, with a reason and a fix per prerequisite, so no surface offers a
 * control that cannot work.
 *
 * Checks, in order (ids are stable; a surface may key on them):
 *   provider          the provider is routable here at all (LocalStack is on
 *                     hold and the sandbox is the engine's: neither is ever
 *                     routed to the workflow path)
 *   platform_store    the platform control store opens (Postgres or PGlite) and
 *                     is the one a separate execution worker can also reach
 *   platform_schema   its schema is current (`assertPlatformSchemaCurrent`)
 *   temporal          Temporal answers and the namespace exists (`temporalAvailable`)
 *   control_signing_key  the Ed25519 key that signs capability grants
 *   oidc_signing_key  the RS256 key that signs workload-identity tokens
 *   oidc_issuer       ZENITH_OIDC_ISSUER (the token minter has no request origin)
 *   drivers           at least one resource driver is registered for the provider
 *                     IN THIS PROCESS
 *
 * Honest limits, repeated in the check details so nobody has to read this:
 *   - `temporal` proves the server answers. It does not prove an execution
 *     worker is polling the task queue; a deploy started with no worker waits.
 *   - `drivers` reads this process's driver registry. Drivers register when
 *     their module is imported; the execution worker imports them, a web
 *     process only if something there does. A control plane split from its
 *     worker will report no drivers until it imports them (or a deployment
 *     decides to attest to them differently — see the handoff).
 *   - "ready" is about prerequisites existing. Nothing here has been exercised
 *     against a real AWS account.
 *
 * Secrets and hosts: details name variables and ports of services the operator
 * configured, never a value, a key, a connection string or a driver error
 * message (driver errors quote parameters). Nothing is logged.
 *
 * Cost: every probe is cheap and bounded, the whole answer is cached for
 * `READINESS_TTL_MS`, and concurrent callers share one in-flight probe. Heavy
 * modules (Temporal client, PGlite) are imported lazily so merely importing
 * this file — which the AWS adapter does — costs nothing.
 */

/** Providers that run through the workflow path once ready. Never `sandbox` or `localstack`. */
export const REAL_PROVIDERS = ["aws", "gcp", "azure", "oci", "kubernetes", "zenith"] as const;
export type RealProvider = (typeof REAL_PROVIDERS)[number];

/** Providers that must never be routed here, with the reason the check reports. */
const NEVER_ROUTED: Readonly<Record<string, { detail: string; fix: string }>> = {
  localstack: {
    detail: "LocalStack is on hold: it is never routed to the real-provider execution plane.",
    fix: "Point the environment at the Sandbox connection to exercise the full flow, or at a real provider once it is ready.",
  },
  sandbox: {
    detail: "The Sandbox is simulated and runs on the in-process engine; it has no execution plane.",
    fix: "Nothing to do: Sandbox deployments run on the engine.",
  },
};

export const isRealProvider = (provider: string): provider is RealProvider => (REAL_PROVIDERS as readonly string[]).includes(provider);

export interface ReadinessCheck {
  id: string;
  ok: boolean;
  /** what was observed, without secrets */
  detail: string;
  /** what to do about it; "Nothing to do." when ok */
  fix: string;
}

export interface ExecutionReadiness {
  provider: string;
  ready: boolean;
  checks: ReadinessCheck[];
  /** ISO time the probes ran */
  checkedAt: string;
}

/** One probe's answer; the id/ok/detail/fix assembly is this module's. */
export interface ProbeAnswer {
  ok: boolean;
  detail: string;
  fix?: string;
}

/** Everything a probe reads, injectable so tests exercise each failing mode without a database or Temporal. */
export interface ReadinessProbes {
  /** open the platform store; a store only this process can see is reported honestly */
  platformStore(): Promise<ProbeAnswer>;
  platformSchema(): Promise<ProbeAnswer>;
  temporal(): Promise<ProbeAnswer>;
  credentials(): Promise<{ controlKey: ProbeAnswer; oidcKey: ProbeAnswer; issuer: ProbeAnswer }>;
  drivers(provider: RealProvider): number | Promise<number>;
}

export const READINESS_TTL_MS = 10_000;

const ok = (id: string, detail: string): ReadinessCheck => ({ id, ok: true, detail, fix: "Nothing to do." });
const fromProbe = (id: string, probe: ProbeAnswer, fallbackFix: string): ReadinessCheck => ({
  id,
  ok: probe.ok,
  detail: probe.detail,
  fix: probe.ok ? "Nothing to do." : (probe.fix ?? fallbackFix),
});

/* --------------------------------- probes ---------------------------------- */

const errCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,40}$/i.test(code) ? code : "unknown";
};

async function platformStoreProbe(): Promise<ProbeAnswer> {
  const [{ isMemoryStoreEnabled }, { platformDb, platformDbConfigFromEnv }] = await Promise.all([
    import("@/lib/capabilities/platform"),
    import("@/lib/controlplane/db"),
  ]);
  if (isMemoryStoreEnabled()) {
    return {
      ok: false,
      detail: "The capability broker is using its per-process in-memory store (ZENITH_PLATFORM_BROKER_MEMORY=1). A separate execution worker cannot see operations that live in this process's memory.",
      fix: "Unset ZENITH_PLATFORM_BROKER_MEMORY and configure the platform control store: ZENITH_PLATFORM_DB_URL for Postgres, or ZENITH_PLATFORM_DB=pglite for single-process local development.",
    };
  }
  let config;
  try {
    config = platformDbConfigFromEnv();
  } catch {
    return { ok: false, detail: "The platform control store is misconfigured (ZENITH_PLATFORM_DB / ZENITH_PLATFORM_DB_URL).", fix: "Set ZENITH_PLATFORM_DB to postgres or pglite, and ZENITH_PLATFORM_DB_URL to a Postgres URI when it is postgres." };
  }
  if (process.env.NODE_ENV === "production" && config.source === "default") {
    return {
      ok: false,
      detail: "This production build has no platform control store configured, and will not default to a local PGlite directory.",
      fix: "Set ZENITH_PLATFORM_DB_URL (the Supavisor pooler URI in production), run the platform migration, and restart.",
    };
  }
  try {
    const db = await platformDb();
    await db.query("select 1 as ok");
    // A PGlite directory belongs to ONE process: a separate execution worker cannot share it.
    return config.kind === "pglite"
      ? { ok: true, detail: "The platform control store (PGlite) opens. PGlite is single-process: it suits local development, and a separately running execution worker cannot share it." }
      : { ok: true, detail: "The platform control store (Postgres) answers." };
  } catch (err) {
    return {
      ok: false,
      detail: `The platform control store could not be opened (${errCode(err)}).`,
      fix: "Check ZENITH_PLATFORM_DB_URL, that Postgres is up and reachable from this server, and the server log for the driver's own error.",
    };
  }
}

async function platformSchemaProbe(): Promise<ProbeAnswer> {
  const { assertPlatformSchemaCurrent, platformDb, MIGRATE_COMMAND } = await import("@/lib/controlplane/db");
  try {
    await assertPlatformSchemaCurrent(await platformDb());
    return { ok: true, detail: "The platform schema is current." };
  } catch (err) {
    const code = errCode(err);
    if (code === "schema_behind" || code === "schema_tampered") {
      return {
        ok: false,
        detail: code === "schema_behind" ? "The platform control store schema is behind this build." : "An applied platform migration does not match this build.",
        fix: `Run \`${MIGRATE_COMMAND}\` against ZENITH_PLATFORM_DB_URL, then restart.`,
      };
    }
    return { ok: false, detail: `The platform schema could not be checked (${code}); the store is not reachable.`, fix: "Fix the platform_store check first." };
  }
}

async function temporalProbe(): Promise<ProbeAnswer> {
  try {
    const { temporalAvailable } = await import("@/lib/workflows/client");
    const t = await temporalAvailable();
    if (t.available) {
      return {
        ok: true,
        detail: `Temporal at ${t.address} (namespace ${t.namespace}) answered in ${t.latencyMs} ms. Reachability only: whether an execution worker is polling the task queue is not checked here.`,
      };
    }
    return {
      ok: false,
      detail: `Temporal at ${t.address} (namespace ${t.namespace}) is not usable: ${t.reason.replace(/_/g, " ")}.`,
      fix:
        t.reason === "namespace_not_found"
          ? `Create the namespace "${t.namespace}" (or set ZENITH_TEMPORAL_NAMESPACE to one that exists).`
          : t.reason === "unauthenticated"
            ? "Check ZENITH_TEMPORAL_API_KEY and ZENITH_TEMPORAL_TLS for this namespace."
            : "Start Temporal (`temporal server start-dev` locally; Temporal Cloud or a self-hosted cluster otherwise), set ZENITH_TEMPORAL_ADDRESS / ZENITH_TEMPORAL_NAMESPACE, and run the execution worker (`npm run worker`).",
    };
  } catch (err) {
    // temporalConfigFromEnv throws a typed config error naming the variable, never a value.
    return {
      ok: false,
      detail: `The Temporal settings are invalid (${errCode(err)}).`,
      fix: "Fix ZENITH_TEMPORAL_ADDRESS (host:port), ZENITH_TEMPORAL_NAMESPACE and ZENITH_TEMPORAL_TLS.",
    };
  }
}

async function credentialsProbe(): Promise<{ controlKey: ProbeAnswer; oidcKey: ProbeAnswer; issuer: ProbeAnswer }> {
  const { loadCredentialsConfig } = await import("@/lib/credentials/config");
  let config;
  try {
    config = loadCredentialsConfig();
  } catch (err) {
    // CredentialConfigError names the variable and the problem, never the value.
    const message = err instanceof Error ? err.message.slice(0, 200) : "invalid";
    const bad: ProbeAnswer = { ok: false, detail: `The credential configuration is invalid: ${message}`, fix: "Correct that variable (see src/lib/credentials/OPERATIONS.md) and restart." };
    return { controlKey: bad, oidcKey: bad, issuer: bad };
  }
  const controlKey: ProbeAnswer =
    config.controlSigningJwk || config.controlKmsKeyId
      ? { ok: true, detail: `A control-plane signing key is configured (${config.controlKmsKeyId ? "KMS" : "local JWK"}).` }
      : {
          ok: false,
          detail: "No control-plane signing key is configured, so capability grants cannot be signed and no operation can start.",
          fix: "Generate an Ed25519 key (src/lib/credentials/OPERATIONS.md) and set ZENITH_CONTROL_SIGNING_JWK, or ZENITH_CONTROL_KMS_KEY_ID for a KMS key.",
        };
  const oidcKey: ProbeAnswer =
    config.oidcSigningJwk || config.oidcKmsKeyId
      ? { ok: true, detail: `An OIDC signing key is configured (${config.oidcKmsKeyId ? "KMS" : "local JWK"}).` }
      : {
          ok: false,
          detail: "No OIDC signing key is configured, so Zenith cannot mint the workload-identity tokens AWS exchanges for credentials.",
          fix: "Generate an RS256 key (src/lib/credentials/OPERATIONS.md) and set ZENITH_OIDC_SIGNING_JWK, or ZENITH_OIDC_KMS_KEY_ID for a KMS key.",
        };
  const issuer: ProbeAnswer = config.oidcIssuer
    ? { ok: true, detail: `The OIDC issuer is ${config.oidcIssuer}.` }
    : {
        ok: false,
        detail: "ZENITH_OIDC_ISSUER is not set. The token minter runs outside any request and has no origin to derive the issuer from.",
        fix: "Set ZENITH_OIDC_ISSUER to the public https URL of this install's OIDC endpoint, for example https://app.example.com/api/oidc.",
      };
  return { controlKey, oidcKey, issuer };
}

async function driversCount(provider: RealProvider): Promise<number> {
  const { listDrivers } = await import("@/lib/drivers/types");
  return listDrivers(provider).length;
}

const defaultProbes: ReadinessProbes = {
  platformStore: platformStoreProbe,
  platformSchema: platformSchemaProbe,
  temporal: temporalProbe,
  credentials: credentialsProbe,
  drivers: driversCount,
};

/* --------------------------------- compute --------------------------------- */

async function compute(provider: string, probes: ReadinessProbes | undefined): Promise<ExecutionReadiness> {
  const checkedAt = new Date().toISOString();
  const held = NEVER_ROUTED[provider];
  if (held) return { provider, ready: false, checkedAt, checks: [{ id: "provider", ok: false, detail: held.detail, fix: held.fix }] };
  if (!isRealProvider(provider)) {
    return {
      provider,
      ready: false,
      checkedAt,
      checks: [{ id: "provider", ok: false, detail: `"${provider}" is not a provider the execution plane knows.`, fix: `Use one of: ${REAL_PROVIDERS.join(", ")}.` }],
    };
  }

  const p = probes ?? defaultProbes;
  const [store, schema, temporal, creds] = await Promise.all([p.platformStore(), p.platformSchema(), p.temporal(), p.credentials()]);
  const driverCount = await p.drivers(provider);

  const checks: ReadinessCheck[] = [
    ok("provider", `${provider} runs through the execution plane when it is ready.`),
    fromProbe("platform_store", store, "Configure the platform control store (ZENITH_PLATFORM_DB_URL)."),
    // A schema verdict on a store that did not open says nothing: keep the order but be plain about it.
    fromProbe("platform_schema", store.ok ? schema : { ok: false, detail: "Not checked: the platform store is not available.", fix: "Fix the platform_store check first." }, "Run the platform migration."),
    fromProbe("temporal", temporal, "Start Temporal and the execution worker."),
    fromProbe("control_signing_key", creds.controlKey, "Configure ZENITH_CONTROL_SIGNING_JWK."),
    fromProbe("oidc_signing_key", creds.oidcKey, "Configure ZENITH_OIDC_SIGNING_JWK."),
    fromProbe("oidc_issuer", creds.issuer, "Configure ZENITH_OIDC_ISSUER."),
    driverCount > 0
      ? ok("drivers", `${driverCount} ${provider} resource driver${driverCount === 1 ? " is" : "s are"} registered in this process.`)
      : {
          id: "drivers",
          ok: false,
          detail: `No ${provider} resource drivers are registered in this process. Drivers register when their module is imported; the execution worker imports them at start-up, and a web process only if something there does.`,
          fix: `Ship and register the ${provider} drivers (the execution worker does this), and make sure this process imports them too, or this check cannot see them.`,
        },
  ];
  return { provider, ready: checks.every((c) => c.ok), checks, checkedAt };
}

/* ---------------------------------- cache ---------------------------------- */

type Cache = {
  results: Map<string, { at: number; result: ExecutionReadiness }>;
  inflight: Map<string, Promise<ExecutionReadiness>>;
};
type G = typeof globalThis & { __zenithReadiness?: Cache };
const cache = (): Cache => ((globalThis as G).__zenithReadiness ??= { results: new Map(), inflight: new Map() });

/**
 * Is the execution plane ready for `provider`? Cached for `READINESS_TTL_MS`;
 * concurrent callers share one probe. Never throws: a probe that fails is an
 * unmet check. With `probes` injected (tests) the cache is bypassed.
 */
export async function executionPlaneReadiness(provider: string, opts: { probes?: ReadinessProbes; fresh?: boolean } = {}): Promise<ExecutionReadiness> {
  if (opts.probes) return compute(provider, opts.probes);
  const c = cache();
  const hit = c.results.get(provider);
  if (!opts.fresh && hit && Date.now() - hit.at < READINESS_TTL_MS) return hit.result;
  const pending = c.inflight.get(provider);
  if (!opts.fresh && pending) return pending;
  const run = compute(provider, undefined)
    .catch((err): ExecutionReadiness => ({
      provider,
      ready: false,
      checkedAt: new Date().toISOString(),
      checks: [{ id: "readiness", ok: false, detail: `Readiness could not be computed (${errCode(err)}).`, fix: "Check the server log; every prerequisite is reported separately once this works." }],
    }))
    .then((result) => {
      c.results.set(provider, { at: Date.now(), result });
      return result;
    })
    .finally(() => {
      if (c.inflight.get(provider) === run) c.inflight.delete(provider);
    });
  c.inflight.set(provider, run);
  return run;
}

/**
 * The last answer, without probing: what a synchronous label (a provider's
 * `availability`) may read. `undefined` when never computed, or older than
 * `READINESS_TTL_MS * 6` (a stale "ready" must not outlive the dependencies it
 * described — and a never-asked process says Preview, the conservative answer).
 */
export function cachedReadiness(provider: string): ExecutionReadiness | undefined {
  const hit = cache().results.get(provider);
  if (!hit || Date.now() - hit.at > READINESS_TTL_MS * 6) return undefined;
  return hit.result;
}

/** Tests: forget every cached answer, or install one. */
export function resetReadinessCache(): void {
  const c = cache();
  c.results.clear();
  c.inflight.clear();
}
export function primeReadinessForTests(result: ExecutionReadiness): void {
  cache().results.set(result.provider, { at: Date.now(), result });
}

/* ------------------------------ plain language ----------------------------- */

const CHECK_LABELS: Record<string, string> = {
  provider: "a routable provider",
  platform_store: "the platform control store",
  platform_schema: "a current platform schema",
  temporal: "Temporal",
  control_signing_key: "the control-plane signing key",
  oidc_signing_key: "the OIDC signing key",
  oidc_issuer: "ZENITH_OIDC_ISSUER",
  drivers: "registered resource drivers",
  readiness: "a working readiness check",
};

/** "Temporal, the OIDC signing key and registered resource drivers" — what is still missing, for a sentence. */
export function missingSummary(readiness: ExecutionReadiness | undefined): string {
  if (!readiness) return "readiness has not been checked in this process yet (open Settings → Connections, or run a plan)";
  const missing = readiness.checks.filter((c) => !c.ok).map((c) => CHECK_LABELS[c.id] ?? c.id);
  if (missing.length === 0) return "nothing";
  if (missing.length === 1) return missing[0];
  return `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
}

/** Every failing check as a "label: fix" line, for a refusal that has to name each way out. */
export function fixList(readiness: ExecutionReadiness): string[] {
  return readiness.checks.filter((c) => !c.ok).map((c) => `${CHECK_LABELS[c.id] ?? c.id}: ${c.fix}`);
}
