/**
 * Workspace assembly: `TofuFragment`s → a pinned, deterministic `TofuWorkspace`.
 *
 * Drivers emit fragments (`resource`/`data`/`output`/`locals` + the tofu
 * addresses they own). Only this module writes the parts of a workspace that
 * are about the *environment* rather than a node: `versions.tf.json`
 * (`required_version` + exact `required_providers`), `providers.tf.json`
 * (region, default tags — never credentials), `backend.tf.json` (state
 * location, native S3 lockfile, optional client-side KMS state/plan
 * encryption) and `main.tf.json` (the merged fragments).
 *
 * `TofuFragment.addresses` are BASE addresses (`aws_route53_record.r`, no
 * `[key]` suffix): the plan normalizer strips instance keys from
 * `for_each`/`count` addresses before joining them to nodes.
 *
 * Invariants enforced here, because fragments are built from
 * manifest-derived strings and a workspace runs with real credentials:
 *   - determinism: fragments merge with sorted keys; input order is irrelevant;
 *   - no duplicate resource/data/output/local names or claimed addresses;
 *   - every claimed address is actually defined by its fragment;
 *   - a fragment belongs to a node of the graph; a node Zenith does not
 *     manage (`referenced`/`external`) may only contribute `data`/`output`/`locals`;
 *   - resource types must belong to the provider set (or be `terraform_data`);
 *   - no `provisioner`/`connection` blocks (they run arbitrary commands on the
 *     runner), no `terraform_remote_state`; HCL templates use a closed set of
 *     pure functions and known variable roots (no filesystem/process access,
 *     namespaces, nondeterminism or `nonsensitive`), allowlisted non-secret, non-routing
 *     provider config; templates are rechecked before runner materialization;
 *   - credentials never appear in any file: providers read the environment the
 *     runner builds from the broker session.
 *
 * Limits (honest): fragment *semantics* are not validated here — a resource
 * with the wrong arguments only fails at `validate`/`plan`. Only `aws` and
 * `random` provider blocks have been exercised by real `tofu validate` runs;
 * the google/azurerm/oci/kubernetes blocks are minimal and unverified.
 */
import { assertBackendBlock, backendFile, type BackendConfig } from "@/lib/tofu/backend-config";
import { assertProviderConfig } from "@/lib/tofu/provider-config";
import { TofuWorkspaceError } from "@/lib/tofu/workspace-error";
import type { TofuFragment } from "@/lib/drivers/types";
import type { ResourceGraph } from "@/lib/resources/types";
import { configDigestOf, isSafeRelativePath, lockDigestOf, MAX_WORKSPACE_FILE_BYTES } from "@/lib/tofu/config-digest";
import { LOCKFILES } from "@/lib/tofu/locks.generated";
import { expressionRefusal } from "@/lib/tofu/expression-policy";
import { HclTemplateError } from "@/lib/tofu/hcl-template";
import {
  PROVIDER_PINS,
  PROVIDER_SET_PROVIDERS,
  providerOfType,
  requiredProviders,
  type ProviderLocalName,
  type ProviderSetName,
  type ProviderSetSpec,
} from "@/lib/tofu/providers";
import { stableJson } from "@/lib/tofu/stable";
import { TOFU_VERSION, type TofuFile, type TofuWorkspace } from "@/lib/tofu/types";

export { configDigestOf, lockDigestOf } from "@/lib/tofu/config-digest";

export { TofuWorkspaceError } from "@/lib/tofu/workspace-error";
export type { BackendConfig } from "@/lib/tofu/backend-config";

/* --------------------------------- inputs --------------------------------- */

export interface AssembleWorkspaceInput {
  graph: ResourceGraph;
  /** node address → compiled fragment */
  fragments: Map<string, TofuFragment>;
  providerSet: ProviderSetName | ProviderSetSpec;
  region: string;
  backend: BackendConfig;
  /** state object key (GCS fallback prefix), e.g. `zenith/<workspace>/<environment>/terraform.tfstate` */
  stateKey?: string;
  /** provider default tags (AWS `default_tags`) */
  tags: Record<string, string>;
  /**
   * Allowlisted non-secret, non-routing provider arguments, e.g. `{ google: { project } }`,
   * `{ azurerm: { subscription_id } }`. Unknown keys and nested settings are refused.
   */
  providerConfig?: Partial<Record<ProviderLocalName, Record<string, unknown>>>;
}

/* ----------------------------- provider sets ------------------------------ */

export function resolveProviderSet(set: ProviderSetName | ProviderSetSpec): ProviderSetSpec {
  if (typeof set !== "string") return set;
  const providers = PROVIDER_SET_PROVIDERS[set];
  const lockfile = LOCKFILES[set];
  if (!providers || lockfile === undefined) {
    throw new TofuWorkspaceError("unknown_provider_set", `No committed lockfile for provider set "${set}". Run src/lib/tofu/scripts/lock.ts.`);
  }
  return { name: set, providers, lockfile };
}

/* ------------------------------- validation ------------------------------- */

const LABEL = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_-]*$/;
const TYPE_NAME = /^[a-z][a-z0-9_]*$/;
const OUTPUT_NAME = LABEL;
const REGION = /^[a-z0-9-]{3,40}$/;

const FRAGMENT_KEYS = new Set(["resource", "data", "output", "locals", "addresses"]);
const FORBIDDEN_RESOURCE_KEYS = ["provisioner", "connection"];
const FORBIDDEN_DATA_TYPES = new Set(["terraform_remote_state"]);
const BUILTIN_TYPE_PREFIX = "terraform";

const CREDENTIAL_KEY =
  /(secret|passw(or)?d|token|private[_-]?key|access[_-]?key|client[_-]?key|client[_-]?certificate|credential|sas[_-]?token|key[_-]?data|api[_-]?key|kubeconfig|config[_-]?content|auth[_-]?token|bearer)/i;

function fail(code: TofuWorkspaceError["code"], message: string): never {
  throw new TofuWorkspaceError(code, message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Walk every key and string value of a fragment looking for forbidden expressions. */
function scanExpressions(value: unknown, where: string, resourceTypes: ReadonlySet<string>, depth = 0): void {
  if (depth > 128) fail("forbidden_construct", `${where}: workspace expression nesting exceeds the limit.`);
  if (typeof value === "string") {
    try {
      const reason = expressionRefusal(value, resourceTypes);
      if (reason) fail("forbidden_construct", `${where}: ${reason}.`);
    } catch (error) {
      if (!(error instanceof HclTemplateError)) throw error;
      fail("forbidden_construct", `${where}: ${error.message}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanExpressions(v, `${where}[${i}]`, resourceTypes, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    let i = 0;
    for (const [k, v] of Object.entries(value)) {
      // Keys can themselves be hostile templates or secret-bearing data.
      // Locate by entry index, never include the key's text in diagnostics.
      scanExpressions(k, `${where}.entry[${i}].key`, resourceTypes, depth + 1);
      scanExpressions(v, `${where}.entry[${i++}].value`, resourceTypes, depth + 1);
    }
  }
}

function assertNoCredentialKeys(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCredentialKeys(v, `${where}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(k)) fail("forbidden_construct", `${where}.${k}: credentials are never written into workspace files; providers read them from the runner environment.`);
      assertNoCredentialKeys(v, `${where}.${k}`);
    }
  }
}

function allowedPrefixes(providers: readonly ProviderLocalName[]): Set<string> {
  return new Set<string>([BUILTIN_TYPE_PREFIX, ...providers]);
}

interface CheckedFragment {
  nodeAddress: string;
  fragment: TofuFragment;
}

function checkFragment(nodeAddress: string, fragment: TofuFragment, graph: ResourceGraph, prefixes: Set<string>, setName: string, resourceTypes: ReadonlySet<string>): void {
  const node = graph.nodes.find((n) => n.address === nodeAddress);
  if (!node) fail("unknown_node", `Fragment for "${nodeAddress}" does not belong to any node of the graph.`);
  if (!isPlainObject(fragment)) fail("invalid_fragment", `Fragment for "${nodeAddress}" is not an object.`);
  // Check template-bearing labels before structural diagnostics can quote a
  // hostile key. The expression walker uses indexed, redaction-safe locations.
  scanExpressions({ resource: fragment.resource, data: fragment.data, output: fragment.output, locals: fragment.locals }, "fragment", resourceTypes);
  for (const k of Object.keys(fragment)) {
    if (!FRAGMENT_KEYS.has(k)) fail("invalid_fragment", `Fragment for "${nodeAddress}" has unsupported key "${k}" (drivers emit only resource, data, output, locals, addresses).`);
  }
  if (!Array.isArray(fragment.addresses) || fragment.addresses.some((a) => typeof a !== "string")) {
    fail("invalid_fragment", `Fragment for "${nodeAddress}" must list the tofu addresses it owns.`);
  }
  if (node.ownership !== "managed" && fragment.resource && Object.keys(fragment.resource).length > 0) {
    fail("invalid_fragment", `Node "${nodeAddress}" is ${node.ownership}, not managed: its fragment may read data but must not declare resources.`);
  }
  for (const [kind, blocks] of [
    ["resource", fragment.resource],
    ["data", fragment.data],
  ] as const) {
    if (blocks === undefined) continue;
    if (!isPlainObject(blocks)) fail("invalid_fragment", `Fragment for "${nodeAddress}": ${kind} must be an object.`);
    for (const [type, named] of Object.entries(blocks)) {
      if (!TYPE_NAME.test(type)) fail("invalid_fragment", `Fragment for "${nodeAddress}": invalid ${kind} type "${type}".`);
      const prefix = providerOfType(type);
      if (!prefixes.has(prefix)) {
        fail("invalid_fragment", `Fragment for "${nodeAddress}": ${kind} type "${type}" needs provider "${prefix}", which is not in provider set "${setName}".`);
      }
      if (kind === "data" && FORBIDDEN_DATA_TYPES.has(type)) fail("forbidden_construct", `Fragment for "${nodeAddress}": data source ${type} is not allowed.`);
      if (!isPlainObject(named)) fail("invalid_fragment", `Fragment for "${nodeAddress}": ${kind}.${type} must be an object.`);
      for (const [name, body] of Object.entries(named)) {
        if (!LABEL.test(name)) fail("invalid_fragment", `Fragment for "${nodeAddress}": invalid ${kind} name "${name}".`);
        if (!isPlainObject(body)) fail("invalid_fragment", `Fragment for "${nodeAddress}": ${kind}.${type}.${name} must be an object.`);
        for (const forbidden of FORBIDDEN_RESOURCE_KEYS) {
          if (forbidden in body) fail("forbidden_construct", `Fragment for "${nodeAddress}": ${type}.${name} declares a ${forbidden} block, which runs commands on the runner.`);
        }
      }
    }
  }
  for (const name of Object.keys(fragment.output ?? {})) {
    if (!OUTPUT_NAME.test(name)) fail("invalid_fragment", `Fragment for "${nodeAddress}": invalid output name "${name}".`);
  }
  for (const name of Object.keys(fragment.locals ?? {})) {
    if (!LABEL.test(name)) fail("invalid_fragment", `Fragment for "${nodeAddress}": invalid local name "${name}".`);
  }
}

/** The tofu addresses a fragment defines, as `type.name` / `data.type.name`. */
function definedAddresses(fragment: TofuFragment): Set<string> {
  const out = new Set<string>();
  for (const [type, named] of Object.entries(fragment.resource ?? {})) for (const name of Object.keys(named)) out.add(`${type}.${name}`);
  for (const [type, named] of Object.entries(fragment.data ?? {})) for (const name of Object.keys(named)) out.add(`data.${type}.${name}`);
  return out;
}

/* -------------------------------- merging --------------------------------- */

function mergeFragments(checked: CheckedFragment[]): { main: Record<string, unknown>; addressMap: Record<string, string[]> } {
  const resource: Record<string, Record<string, unknown>> = {};
  const data: Record<string, Record<string, unknown>> = {};
  const output: Record<string, unknown> = {};
  const locals: Record<string, unknown> = {};
  const owner = new Map<string, string>(); // tofu address / output / local → node address
  const addressMap: Record<string, string[]> = Object.create(null) as Record<string, string[]>;

  const claim = (key: string, nodeAddress: string, what: string) => {
    const prior = owner.get(key);
    if (prior !== undefined) {
      fail("duplicate_address", `${what} "${key}" is defined by both "${prior}" and "${nodeAddress}".`);
    }
    owner.set(key, nodeAddress);
  };

  for (const { nodeAddress, fragment } of checked) {
    const defined = definedAddresses(fragment);
    for (const a of fragment.addresses) {
      if (!defined.has(a)) fail("invalid_fragment", `Fragment for "${nodeAddress}" claims address "${a}" but does not define it.`);
    }
    for (const [type, named] of Object.entries(fragment.resource ?? {})) {
      for (const [name, body] of Object.entries(named)) {
        claim(`${type}.${name}`, nodeAddress, "Resource address");
        (resource[type] ??= {})[name] = body;
      }
    }
    for (const [type, named] of Object.entries(fragment.data ?? {})) {
      for (const [name, body] of Object.entries(named)) {
        claim(`data.${type}.${name}`, nodeAddress, "Data address");
        (data[type] ??= {})[name] = body;
      }
    }
    for (const [name, body] of Object.entries(fragment.output ?? {})) {
      claim(`output.${name}`, nodeAddress, "Output");
      output[name] = body;
    }
    for (const [name, body] of Object.entries(fragment.locals ?? {})) {
      claim(`local.${name}`, nodeAddress, "Local");
      locals[name] = body;
    }
    // claimed addresses must also be unique across fragments; already covered
    // by the definition check above, since a claim needs a definition.
    const list = (addressMap[nodeAddress] ??= []);
    for (const a of fragment.addresses) if (!list.includes(a)) list.push(a);
  }
  for (const list of Object.values(addressMap)) list.sort();

  const main: Record<string, unknown> = {};
  if (Object.keys(data).length) main.data = data;
  if (Object.keys(locals).length) main.locals = locals;
  if (Object.keys(output).length) main.output = output;
  if (Object.keys(resource).length) main.resource = resource;
  return { main, addressMap };
}

/* ---------------------------- environment files --------------------------- */

function versionsFile(providers: readonly ProviderLocalName[]): Record<string, unknown> {
  const terraform: Record<string, unknown> = { required_version: `= ${TOFU_VERSION}` };
  if (providers.length) terraform.required_providers = requiredProviders(providers);
  return { terraform };
}

function providersFile(providers: readonly ProviderLocalName[], region: string, tags: Record<string, string>, extra: AssembleWorkspaceInput["providerConfig"], resourceTypes: ReadonlySet<string>): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  for (const name of providers) {
    const more = extra?.[name] ?? {};
    assertNoCredentialKeys(more, `providerConfig.${name}`);
    scanExpressions(more, `providerConfig.${name}`, resourceTypes);
    switch (name) {
      case "aws":
        provider.aws = { ...more, region, ...(Object.keys(tags).length ? { default_tags: { tags } } : {}) };
        break;
      case "google":
        provider.google = { ...more, region };
        break;
      case "azurerm":
        provider.azurerm = { features: {}, ...more };
        break;
      case "oci":
        provider.oci = { ...more, region };
        break;
      case "kubernetes":
        if (Object.keys(more).length) provider.kubernetes = more;
        break;
      case "random":
        if (Object.keys(more).length) provider.random = more;
        break;
    }
  }
  return Object.keys(provider).length ? { provider } : {};
}

/* -------------------------------- assembly -------------------------------- */

export function assembleWorkspace(input: AssembleWorkspaceInput): TofuWorkspace {
  if (!REGION.test(input.region)) fail("invalid_input", `Invalid region "${input.region}".`);
  for (const [k, v] of Object.entries(input.tags)) {
    if (typeof v !== "string" || typeof k !== "string") fail("invalid_input", "Tags must be string → string.");
  }
  const resourceTypes = new Set<string>(["terraform_data"]);
  for (const fragment of input.fragments.values()) {
    if (isPlainObject(fragment) && isPlainObject(fragment.resource)) {
      for (const type of Object.keys(fragment.resource)) resourceTypes.add(type);
    }
  }
  scanExpressions(input.tags, "tags", resourceTypes);
  scanExpressions(input.providerConfig, "providerConfig", resourceTypes);
  assertProviderConfig(input.providerConfig);

  const set = resolveProviderSet(input.providerSet);
  for (const p of set.providers) if (!(p in PROVIDER_PINS)) fail("unknown_provider_set", `Provider "${p}" has no pin.`);
  const prefixes = allowedPrefixes(set.providers);

  // deterministic order: node address, code-unit order
  const entries = [...input.fragments.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const checked: CheckedFragment[] = [];
  for (const [nodeAddress, fragment] of entries) {
    checkFragment(nodeAddress, fragment, input.graph, prefixes, set.name, resourceTypes);
    checked.push({ nodeAddress, fragment });
  }
  const { main, addressMap } = mergeFragments(checked);

  const backend = backendFile(input.backend, input.region, input.stateKey);
  const files: TofuFile[] = [
    { path: "backend.tf.json", content: stableJson(backend.file) },
    { path: "main.tf.json", content: stableJson(main) },
    { path: "providers.tf.json", content: stableJson(providersFile(set.providers, input.region, input.tags, input.providerConfig, resourceTypes)) },
    { path: "versions.tf.json", content: stableJson(versionsFile(set.providers)) },
  ];
  for (const f of files) {
    if (!isSafeRelativePath(f.path)) fail("invalid_input", `Unsafe workspace path ${f.path}.`);
    if (Buffer.byteLength(f.content) > MAX_WORKSPACE_FILE_BYTES) fail("invalid_input", `${f.path} exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes.`);
  }
  const ws: TofuWorkspace = {
    files,
    lockfile: set.lockfile,
    configDigest: configDigestOf(files),
    lockDigest: lockDigestOf(set.lockfile),
    addressMap,
    backend: backend.kind,
  };
  assertWorkspaceIntact(ws);
  return ws;
}

/**
 * Recompute a workspace's digests from its bytes. A workspace crosses queues
 * and databases before it runs; the runner calls this so a tampered or
 * truncated workspace cannot execute under a stale approval. Matching digests
 * do not establish trust: serialized keys/values are scanned again, even for
 * workspaces assembled elsewhere. Native config/variable files are refused
 * because they could otherwise bypass the JSON-template scanner.
 */
export function assertWorkspaceIntact(ws: TofuWorkspace): void {
  const seen = new Set<string>();
  const configs: { value: unknown; where: string }[] = [];
  const resourceTypes = new Set<string>(["terraform_data"]);
  for (const f of ws.files) {
    if (!isSafeRelativePath(f.path)) fail("invalid_input", `Unsafe workspace path "${f.path}".`);
    if (seen.has(f.path)) fail("invalid_input", `Duplicate workspace path "${f.path}".`);
    seen.add(f.path);
    if (Buffer.byteLength(f.content) > MAX_WORKSPACE_FILE_BYTES) fail("invalid_input", `${f.path} exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes.`);
    // Native HCL cannot bypass the JSON-template scanner. Auxiliary files are
    // data, but every executable OpenTofu config must use the guarded syntax.
    if (/\.(?:tf|tofu|tfvars|tofuvars)$/i.test(f.path)) fail("forbidden_construct", `${f.path}: native HCL workspace files are not allowed.`);
    if (/\.json$/i.test(f.path)) {
      let value: unknown;
      try { value = JSON.parse(f.content); }
      catch { fail("forbidden_construct", `${f.path}: malformed workspace JSON.`); }
      if (!isPlainObject(value)) fail("forbidden_construct", `${f.path}: workspace JSON must be an object.`);
      configs.push({ value, where: f.path });
      if (isPlainObject(value.resource)) for (const type of Object.keys(value.resource)) resourceTypes.add(type);
    }
  }
  const config = configDigestOf(ws.files);
  if (config !== ws.configDigest) fail("digest_mismatch", `Workspace files do not match configDigest (${ws.configDigest.slice(0, 12)} ≠ ${config.slice(0, 12)}).`);
  const lock = lockDigestOf(ws.lockfile);
  if (lock !== ws.lockDigest) fail("digest_mismatch", `Workspace lockfile does not match lockDigest (${ws.lockDigest.slice(0, 12)} ≠ ${lock.slice(0, 12)}).`);
  for (const config of configs) {
    scanExpressions(config.value, config.where, resourceTypes);
    if (isPlainObject(config.value) && config.value.provider !== undefined) assertProviderConfig(config.value.provider);
    if (isPlainObject(config.value) && isPlainObject(config.value.terraform) && config.value.terraform.backend !== undefined) assertBackendBlock(config.value.terraform.backend);
  }
}
