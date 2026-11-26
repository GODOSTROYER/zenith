/** Operator CLI for reviewed compute discovery catalogs; never creates cloud resources. */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { fetchComputeArchive, importComputeArchive, mergeComputeCatalogs, MAX_COMPUTE_JOIN_BYTES, MAX_RAW_COMPUTE_SNAPSHOT_BYTES } from "../../src/lib/compute-catalog/archive";
import type { ComputeCollectionRequest } from "../../src/lib/compute-catalog/collect";
import { normalizeComputeSnapshots } from "../../src/lib/compute-catalog/normalize";
import { recommendCompute } from "../../src/lib/compute-catalog/recommend";
import { computeCatalogPath, loadComputeCatalog, parseRawComputeSnapshots, readBoundedBytes, readBoundedJson, saveComputeCatalog } from "../../src/lib/compute-catalog/store";
import type { ComputeCatalog, RawComputeSnapshot } from "../../src/lib/compute-catalog/types";

const HELP = `Compute catalog commands:
  fetch --provider aws|gcp|azure (--regions r1,r2 | --all-regions) --out <new-directory>
        [--aws-inventory] [--gcp-project <id> --gcp-token-file <file>]
        [--azure-subscription <id> --azure-token-file <file>]
  import (--snapshots <directory> | --input <envelope.json>)... --version <id> --out <catalog.json>
         [--generated-at <ISO timestamp>]
  inspect [--catalog <catalog.json>]
  recommend --request <requirements.json> [--catalog <catalog.json>] [--latency-file <observations.json>] [--now <ISO timestamp>]

fetch requires ZENITH_LIVE_CATALOG_REFRESH=1; it performs read-only API calls.
import accepts multiple archives or raw envelopes and atomically writes the explicit output.
The API reads ZENITH_COMPUTE_CATALOG_PATH or $ZENITH_DATA/compute-catalog/catalog.json.
See docs/platform/operations/COMPUTE-CATALOG.md for scope, permissions, and examples.`;

const OPTIONS = {
  provider: { type: "string" }, regions: { type: "string" }, "all-regions": { type: "boolean" },
  out: { type: "string" }, "aws-inventory": { type: "boolean" },
  "gcp-project": { type: "string" }, "gcp-token-file": { type: "string" },
  "azure-subscription": { type: "string" }, "azure-token-file": { type: "string" },
  snapshots: { type: "string", multiple: true }, input: { type: "string", multiple: true },
  version: { type: "string" }, "generated-at": { type: "string" },
  catalog: { type: "string" }, request: { type: "string" }, "latency-file": { type: "string" }, now: { type: "string" },
  help: { type: "boolean" },
} as const;
const ALLOWED: Record<string, readonly string[]> = {
  fetch: ["provider", "regions", "all-regions", "out", "aws-inventory", "gcp-project", "gcp-token-file", "azure-subscription", "azure-token-file"],
  import: ["snapshots", "input", "version", "generated-at", "out"],
  inspect: ["catalog"],
  recommend: ["catalog", "request", "latency-file", "now"],
};
const LatencyFileSchema = z.array(z.object({
  provider: z.enum(["aws", "gcp", "azure"]), region: z.string().min(1).max(256), audienceId: z.string().min(1).max(256),
  metric: z.literal("rtt_p95_ms"), valueMs: z.number().finite().nonnegative(), sampleCount: z.number().int().nonnegative(),
  observedAt: z.string().datetime({ offset: true }), source: z.string().min(1).max(4096),
}).strict()).max(100_000);

export interface ComputeCatalogCliRuntime {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => string;
  write: (text: string) => void;
}

async function accessToken(path: string): Promise<string> {
  let token: string;
  try { token = (await readBoundedBytes(resolve(path), 16 * 1024)).toString("utf8").trim(); }
  catch { throw new Error("Cannot read the access-token file; use a regular file of at most 16 KiB."); }
  if (!token || /\s/.test(token)) throw new Error("The access-token file must contain one token without internal whitespace.");
  return token;
}

/** Resolve existing aliases, including a destination whose final directories do not exist yet. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(absolute) === absolute) throw error;
    return join(await canonicalPath(dirname(absolute)), basename(absolute));
  }
}

function isInside(path: string, directory: string): boolean {
  const child = relative(directory, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

export async function runComputeCatalogCli(argv: string[], runtime: ComputeCatalogCliRuntime): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") { runtime.write(HELP); return; }
  if (!Object.hasOwn(ALLOWED, command)) throw new Error("Unknown compute catalog command. Use --help.");
  let values: Record<string, string | boolean | string[] | undefined>;
  try { values = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false }).values; }
  catch { throw new Error("Invalid command arguments. Use --help; tokens must be provided through files."); }
  if (values.help) { runtime.write(HELP); return; }
  if (Object.keys(values).some(key => !ALLOWED[command]!.includes(key))) throw new Error("An option is not supported by this command. Use --help.");
  const need = (name: string): string => {
    const value = values[name];
    if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required.`);
    return value;
  };
  const path = () => typeof values.catalog === "string" ? resolve(values.catalog) : computeCatalogPath(runtime.env);
  if (command === "fetch") {
    // Check permission before opening operator credential files.
    if (runtime.env.ZENITH_LIVE_CATALOG_REFRESH !== "1") throw new Error("Set ZENITH_LIVE_CATALOG_REFRESH=1 to allow read-only official API collection.");
    const provider = z.enum(["aws", "gcp", "azure"]).parse(need("provider"));
    if ((typeof values.regions === "string") === (values["all-regions"] === true)) throw new Error("Choose exactly one of --regions or --all-regions.");
    const providerOptions = provider === "aws" ? ["aws-inventory"] : provider === "gcp" ? ["gcp-project", "gcp-token-file"] : ["azure-subscription", "azure-token-file"];
    if (["aws-inventory", "gcp-project", "gcp-token-file", "azure-subscription", "azure-token-file"].some(key => values[key] !== undefined && !providerOptions.includes(key))) throw new Error("Credential and inventory options must match the selected provider.");
    const request: ComputeCollectionRequest = {
      provider,
      ...(typeof values.regions === "string" ? { regions: values.regions.split(",").map(region => region.trim()) } : {}),
      ...(provider === "aws" ? { awsInventory: values["aws-inventory"] === true } : {}),
      ...(provider === "gcp" ? { gcpProject: need("gcp-project") } : {}),
      ...(provider === "azure" ? { azureSubscription: need("azure-subscription") } : {}),
    };
    const output = resolve(need("out"));
    const manifest = await fetchComputeArchive(request, {
      env: runtime.env, fetch: runtime.fetch, now: runtime.now,
      ...(provider === "gcp" ? { gcpAccessToken: await accessToken(need("gcp-token-file")) } : {}),
      ...(provider === "azure" ? { azureAccessToken: await accessToken(need("azure-token-file")) } : {}),
    }, output);
    runtime.write(JSON.stringify({ archive: output, snapshots: manifest.files.length, provider, collectedAt: manifest.collectedAt }, null, 2));
    return;
  }
  if (command === "import") {
    const archives = Array.isArray(values.snapshots) ? values.snapshots : [];
    const inputs = Array.isArray(values.input) ? values.input : [];
    if (!archives.length && !inputs.length) throw new Error("Provide at least one --snapshots directory or --input envelope.");
    const options = { version: need("version"), generatedAt: typeof values["generated-at"] === "string" ? values["generated-at"] : runtime.now() };
    const output = resolve(need("out"));
    const canonicalOutput = await canonicalPath(output);
    for (const input of inputs) if (await canonicalPath(input) === canonicalOutput) throw new Error("Catalog output must not overwrite a raw snapshot input.");
    const catalogs: ComputeCatalog[] = [];
    for (const archive of archives) {
      if (isInside(canonicalOutput, await canonicalPath(archive))) throw new Error("Catalog output must be outside its source archive.");
      catalogs.push(await importComputeArchive(archive, options));
    }
    const raw: RawComputeSnapshot[] = [];
    let inputBytes = 0;
    for (const input of inputs) {
      inputBytes += (await stat(resolve(input))).size;
      if (inputBytes > MAX_COMPUTE_JOIN_BYTES) throw new Error("Raw inputs exceed the 512 MiB in-memory join limit. Use snapshot archives for regional AWS imports.");
    }
    for (const input of inputs) raw.push(...parseRawComputeSnapshots(await readBoundedJson(resolve(input), MAX_RAW_COMPUTE_SNAPSHOT_BYTES)));
    if (raw.length) catalogs.push(normalizeComputeSnapshots(raw, options));
    const catalog = await saveComputeCatalog(mergeComputeCatalogs(catalogs, options), output);
    runtime.write(JSON.stringify({ catalog: output, version: catalog.version, generatedAt: catalog.generatedAt, coverage: catalog.coverage }, null, 2));
    return;
  }
  const catalog = await loadComputeCatalog(path());
  if (command === "inspect") {
    runtime.write(JSON.stringify({ version: catalog.version, generatedAt: catalog.generatedAt, coverage: catalog.coverage, warnings: catalog.warnings }, null, 2));
    return;
  }
  const request = await readBoundedJson(resolve(need("request")), 256 * 1024);
  const latencyObservations = typeof values["latency-file"] === "string" ? LatencyFileSchema.parse(await readBoundedJson(resolve(values["latency-file"]))) : undefined;
  const result = recommendCompute(catalog, request, { now: typeof values.now === "string" ? values.now : runtime.now(), latencyObservations });
  runtime.write(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runComputeCatalogCli(process.argv.slice(2), { env: process.env, fetch, now: () => new Date().toISOString(), write: text => process.stdout.write(`${text}\n`) }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Compute catalog command failed."}\n`);
    process.exitCode = 1;
  });
}
