/**
 * The Cloudflare runtime: Workers for Platforms dispatch + D1, through the real
 * API.
 *
 * **Nothing here has been run against a Cloudflare account.** No credentials
 * exist on this machine, so every request shape below is built from the
 * published API contracts and proven only by tests with an injected `fetch`.
 * `availability()` says so by refusing until `ZENITH_CF_ACCOUNT_ID`,
 * `ZENITH_CF_NAMESPACE` and `ZENITH_CF_API_TOKEN` are all present, and
 * `docs/hosted/DECISIONS.md` keeps the seven feasibility gates open. This
 * adapter is a ready path, not evidence: it never reports a check it did not
 * run, and `probeCandidate` refuses to invent a health result it cannot obtain.
 *
 * The shape of what it builds:
 *
 *   app      one D1 database `zenith-<slug>` and one trusted broker script
 *            `zenith-<slug>-broker` with exactly one binding, `DB`
 *   release  one script `zenith-<slug>-r<n>-<digest12>` carrying the built
 *            assets and no binding except `ASSETS` — no database, no service,
 *            no dispatch, nothing the editable half could reach data through
 *
 * Immutability is enforced by name *and* by readback: a script that already
 * exists under a candidate's name must carry that candidate's digest in its
 * tags, or staging refuses rather than replacing it.
 *
 * Workstream W6 (hosted R3).
 */
import fs from "node:fs";
import { FsArtifactStore } from "@/lib/hosted/artifacts";
import { appHostname } from "@/lib/hosted/config";
import {
  HostedError,
  type Artifact,
  type ArtifactFile,
  type ArtifactStore,
  type Availability,
  type BindingReadback,
  type CandidateProbeResult,
  type HostedApp,
  type HostedRuntime,
  type LimitEnforcement,
  type Release,
  type RuntimeAppRef,
  type RuntimeCandidateRef,
} from "@/lib/hosted/contracts";
import { enforcementFor } from "@/lib/hosted/quota";
import { assertCfName, assertNamespace, cfRefusal, CloudflareApiClient, type CfFetch } from "./cf-api";
import { brokerScriptName, releaseScriptName } from "./names";
import type { SelectableRuntime } from "./selectable";

/** Compatibility date every uploaded script is pinned to. Pinned, never "today". */
export const CF_COMPATIBILITY_DATE = "2026-09-01";

/** The release worker: assets only, no logic, no capability but its own files. */
export const RELEASE_WORKER_MODULE = `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
`;

/** Options. Everything injectable; production passes the env-derived values once. */
export interface CloudflareRuntimeOptions {
  accountId?: string;
  namespace?: string;
  /** Read from `process.env.ZENITH_CF_API_TOKEN` at exactly one call site (`index.ts`). */
  token?: string;
  fetch?: CfFetch;
  timeoutMs?: number;
  artifactStore?: ArtifactStore;
  /**
   * A URL template that reaches a *staged* candidate, e.g.
   * `https://{script}.example.workers.dev/`. Without it a candidate cannot be
   * probed over HTTP at all, and the probe says exactly that.
   */
  probeUrlTemplate?: string;
  /** The bundled `workers/broker-worker.ts` module, as source. */
  brokerModuleSource?: string;
  /** Where to read that bundle from, when it is not passed directly. */
  brokerModulePath?: string;
}

interface D1Database {
  uuid: string;
  name: string;
}

type Check = CandidateProbeResult["checks"][number];

const check = (id: string, ok: boolean, detail: string): Check => ({ id, ok, detail });

/** The three inputs this runtime cannot run without, and what each one is. */
const REQUIRED_ENV: { name: string; get: (o: CloudflareRuntimeOptions) => string | undefined; what: string }[] = [
  { name: "ZENITH_CF_ACCOUNT_ID", get: (o) => o.accountId, what: "the Cloudflare account that owns the dispatch namespace" },
  { name: "ZENITH_CF_NAMESPACE", get: (o) => o.namespace, what: "the Workers for Platforms dispatch namespace apps are uploaded into" },
  { name: "ZENITH_CF_API_TOKEN", get: (o) => o.token, what: "an API token with Workers Scripts, Workers for Platforms and D1 permissions" },
];

export class CloudflareRuntime implements HostedRuntime, SelectableRuntime {
  readonly id = "cloudflare" as const;

  readonly label =
    "Cloudflare Workers for Platforms — dispatch namespace per install, one D1 database and one trusted broker " +
    "script per app, release assets uploaded under a content-addressed script name (not verified against a live account)";

  private readonly options: CloudflareRuntimeOptions;

  constructor(options: CloudflareRuntimeOptions = {}) {
    this.options = options;
  }

  /** Blocked, by name, until all three inputs exist. Never "probably fine". */
  blockedReason(): { reason: string; fix: string } | null {
    const missing = REQUIRED_ENV.filter((row) => !(row.get(this.options) ?? "").trim());
    if (missing.length === 0) return null;
    return {
      reason: `The Cloudflare runtime needs ${missing.map((m) => m.name).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set.`,
      fix: `Set ${missing.map((m) => `${m.name} (${m.what})`).join("; ")} in .env.local, then restart the control service. Until then ZENITH_RUNTIME=local is the runtime that can serve apps.`,
    };
  }

  async availability(): Promise<Availability> {
    const blocked = this.blockedReason();
    return blocked ? { available: false, reason: blocked.reason, fix: blocked.fix } : { available: true };
  }

  get enforcement(): LimitEnforcement {
    return enforcementFor("cloudflare");
  }

  hostname(app: HostedApp): string {
    // The stable hostname is the platform's, not the provider's: the dispatch
    // worker is routed from `*.<app domain>`, so the name does not change with
    // the runtime.
    return appHostname(app.slug);
  }

  /* -------------------------------- the app ------------------------------- */

  /**
   * One D1 database and one broker script per app.
   *
   * Idempotent by listing before creating: a retried publish after a lost
   * acknowledgement finds the database it made last time instead of making a
   * second one, which is the reconciliation rule the job runner depends on.
   */
  async ensureApp(app: HostedApp): Promise<RuntimeAppRef> {
    const client = this.client();
    const namespace = this.namespace();
    const databaseName = assertCfName("D1 database", `zenith-${app.slug}`);
    const brokerScript = assertCfName("dispatch script", brokerScriptName(app.slug));

    const existing = await client.send({
      method: "GET",
      path: client.account("/d1/database"),
      query: { name: databaseName },
    });
    const found = asDatabases(existing.result).find((row) => row.name === databaseName);
    const database =
      found ??
      asDatabase(
        (
          await client.send({
            method: "POST",
            path: client.account("/d1/database"),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: databaseName }),
          })
        ).result
      );

    await client.send({
      method: "PUT",
      path: client.account(`/workers/dispatch/namespaces/${namespace}/scripts/${brokerScript}`),
      body: scriptUpload({
        module: this.brokerModule(),
        metadata: {
          main_module: "broker.mjs",
          compatibility_date: CF_COMPATIBILITY_DATE,
          // The one privileged binding in the whole design, and it is on the
          // fixed broker, never on anything an app author can change.
          bindings: [{ type: "d1", name: "DB", id: database.uuid }],
        },
      }),
    });

    return {
      runtime: "cloudflare",
      ref: {
        accountId: client.accountId,
        namespace,
        d1DatabaseId: database.uuid,
        d1DatabaseName: database.name,
        brokerScript,
      },
    };
  }

  /* ----------------------------- the candidate ---------------------------- */

  /**
   * Upload the release's assets under a content-addressed script name.
   *
   * The name embeds the digest, so two different builds can never contend for
   * one name. That is not enough on its own — an upload endpoint replaces
   * whatever is there — so the digest is also written into the script's tags
   * and read back before anything is sent: a name that exists with a different
   * digest is a refusal, not an overwrite.
   */
  async stageCandidate(app: HostedApp, release: Release, artifact: Artifact): Promise<RuntimeCandidateRef> {
    const client = this.client();
    const namespace = this.namespace();
    const script = assertCfName(
      "dispatch script",
      releaseScriptName(app.slug, release.number, artifact.digest)
    );
    const digestTag = `digest:${artifact.digest}`;
    const scriptPath = client.account(`/workers/dispatch/namespaces/${namespace}/scripts/${script}`);

    const tags = await client.send({ method: "GET", path: `${scriptPath}/tags`, allowNotFound: true });
    if (tags.status !== 404) {
      const present = asStrings(tags.result);
      if (!present.includes(digestTag))
        throw new HostedError(
          "conflict",
          `A Cloudflare script called ${script} already exists and does not carry this artifact's digest, so it will not be replaced.`,
          {
            fix: "Delete that script by hand after checking what it is, or publish a build with different content. A release name is never reused for different bytes.",
            details: { script, digest: artifact.digest },
          }
        );
      // Same name, same digest: this is a retry of an upload that already
      // finished. Adopt it rather than sending the bytes again.
      return this.candidateRef(app, release, artifact, script, namespace);
    }

    const files = await this.store().list(artifact.digest);
    if (files.length === 0)
      throw cfRefusal(
        `Artifact ${artifact.digest} has no files to upload.`,
        "Publish again: the artifact store has no manifest for that digest."
      );

    const completionToken = await this.uploadAssets(client, namespace, script, artifact.digest, files);

    await client.send({
      method: "PUT",
      path: scriptPath,
      body: scriptUpload({
        module: RELEASE_WORKER_MODULE,
        metadata: {
          main_module: "release.mjs",
          compatibility_date: CF_COMPATIBILITY_DATE,
          // The editable half of the platform gets exactly one capability: its
          // own files. No D1, no service, no dispatch, no mTLS, no secrets.
          bindings: [{ type: "assets", name: "ASSETS" }],
          assets: {
            jwt: completionToken,
            config: { html_handling: "auto-trailing-slash", not_found_handling: "single-page-application" },
          },
        },
      }),
    });

    await client.send({
      method: "PUT",
      path: `${scriptPath}/tags`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["zenith", digestTag, `release:${release.id}`]),
    });

    return this.candidateRef(app, release, artifact, script, namespace);
  }

  /**
   * Probe a staged candidate over HTTP.
   *
   * Without a reachable URL for a *staged but not yet activated* script there
   * is nothing to probe: the dispatch worker only routes what the authority
   * says is active, and a preview URL for a Workers-for-Platforms script is not
   * available by default. So unless `ZENITH_CF_PROBE_URL` names a template that
   * reaches one, this returns `ok: false` and says why. It never returns a
   * healthy-looking result it did not obtain.
   */
  async probeCandidate(app: HostedApp, candidate: RuntimeCandidateRef): Promise<CandidateProbeResult> {
    const script = String(candidate.ref.script ?? "");
    const template = (this.options.probeUrlTemplate ?? "").trim();
    const checks: Check[] = [];

    if (!template) {
      checks.push(
        check(
          "candidate.http",
          false,
          "This candidate cannot be probed: a Workers for Platforms script has no preview hostname until the dispatch worker routes it, " +
            "and no ZENITH_CF_PROBE_URL template is configured. Set ZENITH_CF_PROBE_URL to a URL that reaches a staged script " +
            "(with {script} where the script name goes), or publish on the local runtime, which probes against a real test database."
        )
      );
      return { ok: false, checkedAt: new Date().toISOString(), checks, testDatabase: "none (no probe was run)" };
    }

    const url = template.replaceAll("{script}", encodeURIComponent(script)).replaceAll("{slug}", app.slug);
    if (!url.startsWith("https://")) {
      checks.push(
        check("candidate.http", false, `ZENITH_CF_PROBE_URL produced "${url}", which is not an https URL, so no probe was made.`)
      );
      return { ok: false, checkedAt: new Date().toISOString(), checks, testDatabase: "none (no probe was run)" };
    }

    try {
      const transport = this.options.fetch ?? ((target, init) => globalThis.fetch(target, init));
      const response = await transport(url, { method: "GET", redirect: "manual", cache: "no-store" });
      const body = response.status === 200 ? await response.text() : "";
      checks.push(
        check(
          "candidate.http",
          response.status === 200 && body.length > 0,
          `The staged script answered ${response.status} with ${body.length} bytes.`
        )
      );
    } catch (err) {
      checks.push(check("candidate.http", false, err instanceof Error ? err.message : "The probe request failed."));
    }

    checks.push(
      check(
        "data.roundTrip",
        false,
        "No data round trip was run: a D1 test database for a candidate is not created by this adapter, so the contract's " +
          "create/get/update/conflict probe has not been executed against Cloudflare. This gate is open in DECISIONS.md."
      )
    );

    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      checks,
      testDatabase: "none (no D1 test database was created)",
    };
  }

  /**
   * No provider call. The stable hostname is routed to the dispatch worker,
   * which asks `/api/hosted/policy/admit` which release is active on every
   * request — so activation is the authority's compare-and-swap and nothing
   * else. There is deliberately no provider-side pointer that could disagree
   * with the authority.
   */
  async activate(app: HostedApp, release: Release, fence: number): Promise<void> {
    void app;
    void release;
    void fence;
  }

  /**
   * Read every binding back, from both endpoints, against the strict allowlist.
   *
   * A release may carry nothing, or exactly `ASSETS`. A broker must carry
   * exactly one `d1` binding called `DB`. Anything else — an extra binding, a
   * different database, a field the allowlist does not name — is `ok: false`,
   * because the whole isolation argument is "the editable half has no data
   * capability" and an unexpected binding is precisely that argument failing.
   */
  async readBindings(candidate: RuntimeCandidateRef): Promise<BindingReadback> {
    const client = this.client();
    const namespace = this.namespace();
    const releaseScript = String(candidate.ref.script ?? "");
    const broker = String(candidate.ref.brokerScript ?? "");
    const expectedDatabase = candidate.ref.d1DatabaseId === undefined ? undefined : String(candidate.ref.d1DatabaseId);
    const problems: string[] = [];

    const read = async (script: string): Promise<unknown[]> => {
      const base = client.account(`/workers/dispatch/namespaces/${namespace}/scripts/${script}`);
      const bindings = await client.send({ method: "GET", path: `${base}/bindings` });
      const settings = await client.send({ method: "GET", path: `${base}/settings` });
      const fromSettings =
        typeof settings.result === "object" && settings.result !== null
          ? (settings.result as { bindings?: unknown }).bindings
          : undefined;
      const a = Array.isArray(bindings.result) ? bindings.result : null;
      const b = Array.isArray(fromSettings) ? fromSettings : null;
      if (a === null || b === null) {
        problems.push(`${script}: Cloudflare did not report a binding list on both endpoints.`);
        return [];
      }
      if (JSON.stringify(a) !== JSON.stringify(b))
        problems.push(`${script}: /bindings and /settings disagree about what is bound.`);
      return a;
    };

    const releaseBindings = await read(releaseScript);
    const releaseNames = describe(releaseBindings);
    if (!isAllowedReleaseBindings(releaseBindings))
      problems.push(
        `${releaseScript}: a release may have no bindings or exactly {type:"assets", name:"ASSETS"}; it has ${releaseNames.join(", ") || "an unreadable list"}.`
      );

    const brokerBindings = broker ? await read(broker) : [];
    const brokerNames = describe(brokerBindings);
    if (!broker) problems.push("no broker script was named on the candidate, so its bindings were not read.");
    else if (!isAllowedBrokerBindings(brokerBindings, expectedDatabase))
      problems.push(
        `${broker}: the broker must have exactly one d1 binding called DB${expectedDatabase ? ` for database ${expectedDatabase}` : ""}; it has ${brokerNames.join(", ") || "an unreadable list"}.`
      );

    return {
      ok: problems.length === 0,
      release: releaseNames,
      broker: brokerNames,
      detail:
        problems.length === 0
          ? "Both endpoints agree and both binding lists match the allowlist. This is a read at one moment, not a guarantee about later changes."
          : problems.join(" "),
    };
  }

  /**
   * Delete this app's release scripts that nothing retains. Brokers are never
   * removed here — an app's broker outlives every release it serves.
   *
   * `retain` holds script names and/or artifact digests: the active release
   * and any release a rollback could still select. A digest matches the script
   * whose name ends in that digest's first twelve characters, which is the
   * only substring relationship the naming scheme actually guarantees.
   */
  async cleanup(app: HostedApp, retain: Set<string>): Promise<void> {
    const client = this.client();
    const namespace = this.namespace();
    const prefix = `zenith-${app.slug}-r`;
    const listed = await client.send({
      method: "GET",
      path: client.account(`/workers/dispatch/namespaces/${namespace}/scripts`),
    });
    const names = (Array.isArray(listed.result) ? listed.result : [])
      .map((row) => (typeof row === "object" && row !== null ? String((row as { id?: unknown }).id ?? "") : ""))
      .filter((name) => name.startsWith(prefix));

    const isRetained = (name: string): boolean =>
      retain.has(name) ||
      [...retain].some((value) => value.length >= 12 && name.endsWith(`-${value.slice(0, 12)}`));

    for (const name of names) {
      if (isRetained(name)) continue;
      await client.send({
        method: "DELETE",
        path: client.account(`/workers/dispatch/namespaces/${namespace}/scripts/${name}`),
        allowNotFound: true,
      });
    }
  }

  /* ------------------------------- internals ------------------------------ */

  private client(): CloudflareApiClient {
    const blocked = this.blockedReason();
    if (blocked) throw new HostedError("runtime_unavailable", blocked.reason, { fix: blocked.fix });
    return new CloudflareApiClient({
      accountId: (this.options.accountId ?? "").trim(),
      token: (this.options.token ?? "").trim(),
      fetch: this.options.fetch,
      timeoutMs: this.options.timeoutMs,
    });
  }

  private namespace(): string {
    return assertNamespace((this.options.namespace ?? "").trim());
  }

  private store(): ArtifactStore {
    return this.options.artifactStore ?? new FsArtifactStore();
  }

  private brokerModule(): string {
    if (this.options.brokerModuleSource !== undefined) return this.options.brokerModuleSource;
    const path = (this.options.brokerModulePath ?? "").trim();
    if (!path)
      throw new HostedError(
        "runtime_unavailable",
        "The Cloudflare broker script has not been built, so no app can be given one.",
        {
          fix: "Bundle workers/broker-worker.ts to a single ES module and point ZENITH_CF_BROKER_MODULE at the built file. The broker is platform code; it is never generated from an app's source.",
        }
      );
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      throw new HostedError(
        "runtime_unavailable",
        `The Cloudflare broker bundle named by ZENITH_CF_BROKER_MODULE could not be read: ${path}`,
        { fix: "Build workers/broker-worker.ts and point ZENITH_CF_BROKER_MODULE at the resulting file." }
      );
    }
  }

  private candidateRef(
    app: HostedApp,
    release: Release,
    artifact: Artifact,
    script: string,
    namespace: string
  ): RuntimeCandidateRef {
    return {
      runtime: "cloudflare",
      releaseId: release.id,
      ref: {
        script,
        namespace,
        digest: artifact.digest,
        brokerScript: brokerScriptName(app.slug),
      },
    };
  }

  /**
   * The two-step asset upload: open a session with a manifest, then send the
   * buckets Cloudflare asks for. Files it already has are not re-sent — that is
   * the point of the manifest — and the completion token from the last bucket
   * is what the script upload references.
   */
  private async uploadAssets(
    client: CloudflareApiClient,
    namespace: string,
    script: string,
    digest: string,
    files: ArtifactFile[]
  ): Promise<string> {
    const manifest: Record<string, { hash: string; size: number }> = {};
    const byHash = new Map<string, ArtifactFile>();
    for (const file of files) {
      // Cloudflare keys assets by a 32-hex-character hash; the artifact's own
      // SHA-256 prefix is stable, content-addressed and already computed.
      const hash = file.sha256.slice(0, 32);
      manifest[`/${file.path}`] = { hash, size: file.bytes };
      byHash.set(hash, file);
    }

    const session = await client.send({
      method: "POST",
      path: client.account(`/workers/dispatch/namespaces/${namespace}/scripts/${script}/assets-upload-session`),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    const opened = session.result as { jwt?: unknown; buckets?: unknown } | null;
    const uploadJwt = typeof opened?.jwt === "string" ? opened.jwt : "";
    const buckets = Array.isArray(opened?.buckets) ? (opened.buckets as unknown[]) : [];
    if (!uploadJwt)
      throw cfRefusal(
        "Cloudflare did not return an upload token for this release's assets.",
        "Try publishing again. Nothing was uploaded."
      );

    let completion = uploadJwt;
    const store = this.store();
    for (const bucket of buckets) {
      const hashes = Array.isArray(bucket) ? bucket.map(String) : [];
      if (hashes.length === 0) continue;
      const form = new FormData();
      for (const hash of hashes) {
        const file = byHash.get(hash);
        if (!file) continue;
        const opened2 = await store.open(digest, file.path);
        if (!opened2)
          throw cfRefusal(
            `The artifact no longer contains ${file.path}, so the upload was stopped.`,
            "Publish again; the artifact store changed under the running publish."
          );
        form.append(
          hash,
          new Blob([Buffer.from(opened2.bytes).toString("base64")], { type: file.contentType }),
          hash
        );
      }
      const uploaded = await client.send({
        method: "POST",
        path: client.account("/workers/assets/upload"),
        query: { base64: "true" },
        bearer: uploadJwt,
        body: form,
      });
      const token = (uploaded.result as { jwt?: unknown } | null)?.jwt;
      if (typeof token === "string" && token) completion = token;
    }
    return completion;
  }
}

/* --------------------------------- helpers -------------------------------- */

/** The multipart body a Workers script upload takes: metadata plus one module. */
export function scriptUpload(input: { module: string; metadata: Record<string, unknown> }): FormData {
  const form = new FormData();
  const main = String(input.metadata.main_module ?? "index.mjs");
  form.append("metadata", new Blob([JSON.stringify(input.metadata)], { type: "application/json" }));
  form.append(main, new Blob([input.module], { type: "application/javascript+module" }), main);
  return form;
}

const asDatabases = (value: unknown): D1Database[] =>
  Array.isArray(value)
    ? value
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
        .map((row) => ({ uuid: String(row.uuid ?? ""), name: String(row.name ?? "") }))
        .filter((row) => row.uuid !== "")
    : [];

function asDatabase(value: unknown): D1Database {
  const [first] = asDatabases([value]);
  if (!first)
    throw cfRefusal(
      "Cloudflare did not return the database it was asked to create.",
      "Try publishing again. If the database exists in the dashboard, this adapter will adopt it on the next attempt."
    );
  return first;
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((row): row is string => typeof row === "string") : [];

/** A one-line description per binding, for the readback report. */
const describe = (bindings: unknown[]): string[] =>
  bindings.map((binding) => {
    if (typeof binding !== "object" || binding === null) return "an unreadable binding";
    const row = binding as Record<string, unknown>;
    return `${String(row.name ?? "?")} (${String(row.type ?? "?")})`;
  });

/** A release may have nothing, or exactly the assets binding — and no extra fields. */
export function isAllowedReleaseBindings(bindings: unknown[]): boolean {
  if (bindings.length === 0) return true;
  if (bindings.length !== 1) return false;
  const row = bindings[0];
  if (typeof row !== "object" || row === null) return false;
  const binding = row as Record<string, unknown>;
  return (
    binding.type === "assets" &&
    binding.name === "ASSETS" &&
    Object.keys(binding).every((key) => key === "type" || key === "name")
  );
}

/** A broker must have exactly one d1 binding called DB, on the expected database. */
export function isAllowedBrokerBindings(bindings: unknown[], expectedDatabase?: string): boolean {
  if (bindings.length !== 1) return false;
  const row = bindings[0];
  if (typeof row !== "object" || row === null) return false;
  const binding = row as Record<string, unknown>;
  if (binding.type !== "d1" || binding.name !== "DB") return false;
  if (!Object.keys(binding).every((key) => ["type", "name", "id", "database_id", "database_name"].includes(key)))
    return false;
  if (expectedDatabase === undefined) return true;
  const id = binding.database_id ?? binding.id;
  if (id !== expectedDatabase) return false;
  // The deprecated `id` field, when present alongside `database_id`, must agree.
  if ("id" in binding && "database_id" in binding && binding.id !== binding.database_id) return false;
  return true;
}
