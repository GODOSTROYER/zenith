/**
 * The plugin manifest: what a plugin declares, and the proof of who published
 * it. Registration (service.ts) refuses a manifest that does not parse here or
 * whose signature does not verify against a configured trusted publisher key.
 *
 * What a plugin can declare is deliberately small:
 *  - `capabilities.tools`: MCP v3 tool names (closed set, `TOOL_NAMES`). A tool
 *    is the ONLY way a plugin reaches Zenith; every call goes through the
 *    capability broker like any other agent call.
 *  - `capabilities.scopes`: the integration scopes it requests. Each declared
 *    tool's required scope must be declared.
 *  - `isolation`: literal values only. A manifest asking for credential
 *    access, direct store access, or token passthrough does not parse.
 *
 * Provenance: an Ed25519 signature over `zenith-plugin-manifest-v1\n` +
 * `manifestDigest`, where `manifestDigest` is the control-plane canonical
 * digest of the manifest without its `signature` member. The digest therefore
 * covers the publisher, version, artifact digest and every capability.
 * Verification needs a trusted key from `ZENITH_PLUGIN_TRUSTED_PUBLISHERS`;
 * with none configured every registration is refused (there is no
 * "unverified but allowed" mode).
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { z } from "zod/v4";
import { digest } from "@/lib/controlplane/digest";
import { INTEGRATION_SCOPES, TOOL_NAMES, type IntegrationScope, type ToolName } from "@/lib/agent-access/v3/contract";
import { toolDescriptor } from "@/lib/agent-access/v3/catalog";
import { PluginError } from "./errors";

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const SIGNATURE_DOMAIN = "zenith-plugin-manifest-v1\n" as const;

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z.-]{1,30})?$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

const toolSchema = z.enum(TOOL_NAMES);
const scopeSchema = z.enum(INTEGRATION_SCOPES);

const unique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;

const COMPONENT_NAME = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
const SECRET_NAME = /token|secret|password|passwd|credential|api.?key|authorization|cookie/i;
const ComponentsSchema = z.strictObject({
  skills: z.array(COMPONENT_NAME).max(100).refine(unique, "skills must be unique").optional(),
  agents: z
    .array(z.strictObject({ name: COMPONENT_NAME, tools: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/)).max(20) }))
    .max(50)
    .optional(),
  mcpServers: z
    .array(
      z.strictObject({
        name: COMPONENT_NAME,
        transport: z.literal("stdio"),
        command: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, "command must be a bare executable name"),
        args: z.array(z.string().max(300)).max(20),
        /** Plain configuration only: a variable that looks like a credential is refused, so a manifest cannot smuggle a token in. */
        env: z
          .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,60}$/), z.string().max(200))
          .refine((env) => Object.keys(env).every((k) => !SECRET_NAME.test(k)), "env must not carry credentials or tokens")
          .optional(),
      })
    )
    .max(10)
    .optional(),
});

export const PluginManifest = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}\/[a-z0-9][a-z0-9-]{1,60}$/, "id must be <publisher>/<name> in lowercase"),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  version: z.string().regex(SEMVER, "version must be semver"),
  publisher: z.strictObject({ id: z.string().regex(SLUG), name: z.string().min(1).max(100) }),
  /**
   * The published plugin archive. `digest` is the sha256 of the archive bytes and is
   * covered by the signature. Zenith never fetches the archive: the client or
   * installer must hash what it downloaded and compare before installing.
   */
  artifact: z.strictObject({
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "artifact digest must be sha256:<64 hex>"),
    format: z.enum(["tar.gz", "tgz", "zip"]).optional(),
    url: z.string().url().startsWith("https://").max(2000).optional(),
  }),
  /**
   * What the package ships, so a reviewer sees it (a Claude Code plugin: skills,
   * subagents, MCP server config). Descriptive and covered by the signature; it
   * grants nothing. Authority comes only from `capabilities` and the review.
   */
  components: ComponentsSchema.optional(),
  capabilities: z.strictObject({
    /** The MCP contract the tool names belong to. Only v3 is enforceable with plugin tokens. */
    apiVersion: z.literal("v3"),
    tools: z.array(toolSchema).min(1).max(TOOL_NAMES.length).refine(unique, "tools must be unique"),
    scopes: z.array(scopeSchema).min(1).max(INTEGRATION_SCOPES.length).refine(unique, "scopes must be unique"),
  }),
  /** Literals only: the manifest cannot ask for more than the boundary gives. */
  isolation: z.strictObject({
    credentials: z.literal("none"),
    store: z.literal("none"),
    network: z.literal("mcp-only"),
    tokenPassthrough: z.literal("forbidden"),
  }),
  signature: z.strictObject({
    alg: z.literal("ed25519"),
    keyId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    value: z.string().regex(/^[A-Za-z0-9+/_-]{80,100}={0,2}$/, "signature must be base64 ed25519"),
  }),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

export interface ParsedManifest {
  manifest: PluginManifest;
  /** sha256 hex of the canonical manifest without `signature` */
  manifestDigest: string;
  artifactDigest: string;
}

/** The part of the manifest the signature covers. */
export function signedPortion(manifest: PluginManifest): Omit<PluginManifest, "signature"> {
  const { signature: _signature, ...rest } = manifest;
  void _signature;
  return rest;
}

export const manifestDigestOf = (manifest: PluginManifest): string => digest(signedPortion(manifest));
export const signingInput = (manifestDigest: string): Buffer => Buffer.from(`${SIGNATURE_DOMAIN}${manifestDigest}`, "utf8");

/** Parse and check internal consistency. Throws `plugin_manifest_invalid`. No signature check here. */
export function parseManifest(raw: unknown): ParsedManifest {
  const parsed = PluginManifest.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError(
      "plugin_manifest_invalid",
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(manifest)"}: ${i.message}`)
        .join("; ")
        .slice(0, 1500)
    );
  }
  const manifest = parsed.data;
  if (!manifest.id.startsWith(`${manifest.publisher.id}/`)) {
    throw new PluginError("plugin_manifest_invalid", "The plugin id must start with the publisher id.");
  }
  const scopes = new Set<IntegrationScope>(manifest.capabilities.scopes);
  if (!scopes.has("read")) throw new PluginError("plugin_manifest_invalid", "A plugin must request the read scope.");
  for (const name of manifest.capabilities.tools) {
    const tool = toolDescriptor(name as ToolName);
    if (!tool) throw new PluginError("plugin_manifest_invalid", `Unknown tool ${name}.`);
    if (!scopes.has(tool.requiredScope)) {
      throw new PluginError("plugin_manifest_invalid", `Tool ${name} needs the ${tool.requiredScope} scope, which the manifest does not request.`);
    }
  }
  return { manifest, manifestDigest: manifestDigestOf(manifest), artifactDigest: manifest.artifact.digest.slice("sha256:".length) };
}

/* ------------------------------- provenance ------------------------------- */

export interface TrustedKey {
  keyId: string;
  key: KeyObject;
}
export type TrustedPublishers = ReadonlyMap<string, readonly TrustedKey[]>;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function keyFromRaw(base64: string): KeyObject {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) throw new PluginError("plugin_unavailable", "A trusted plugin publisher key must be a 32-byte ed25519 public key (base64).");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

const TrustedConfig = z.record(
  z.string().regex(SLUG),
  z
    .array(z.strictObject({ keyId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), publicKey: z.string().min(40).max(100) }))
    .min(1)
    .max(10)
);

/**
 * `ZENITH_PLUGIN_TRUSTED_PUBLISHERS` is JSON: `{ "<publisherId>": [{ "keyId": "...", "publicKey": "<base64 raw ed25519>" }] }`.
 * An absent or empty value means no publisher is trusted and every registration is refused.
 */
export function trustedPublishersFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): TrustedPublishers {
  const text = env.ZENITH_PLUGIN_TRUSTED_PUBLISHERS;
  const out = new Map<string, TrustedKey[]>();
  if (!text || !text.trim()) return out;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PluginError("plugin_unavailable", "ZENITH_PLUGIN_TRUSTED_PUBLISHERS is not valid JSON.");
  }
  const parsed = TrustedConfig.safeParse(value);
  if (!parsed.success) throw new PluginError("plugin_unavailable", "ZENITH_PLUGIN_TRUSTED_PUBLISHERS has an invalid shape.");
  for (const [publisher, keys] of Object.entries(parsed.data)) {
    out.set(
      publisher,
      keys.map((k) => ({ keyId: k.keyId, key: keyFromRaw(k.publicKey) }))
    );
  }
  return out;
}

export interface Provenance {
  publisherId: string;
  keyId: string;
  alg: "ed25519";
  manifestDigest: string;
  artifactDigest: string;
  verifiedAt: string;
}

/**
 * Verify the signature against a trusted key of the declared publisher.
 * Throws `plugin_provenance_unverified`; never returns a "not verified" value.
 */
export function verifyProvenance(parsed: ParsedManifest, publishers: TrustedPublishers, now: Date = new Date()): Provenance {
  const { manifest } = parsed;
  const keys = publishers.get(manifest.publisher.id);
  if (!keys || keys.length === 0) {
    throw new PluginError("plugin_provenance_unverified", "This publisher is not trusted on this deployment, so the plugin cannot be registered.", { publisherId: manifest.publisher.id });
  }
  const key = keys.find((k) => k.keyId === manifest.signature.keyId);
  if (!key) throw new PluginError("plugin_provenance_unverified", "The signing key is not a trusted key of this publisher.", { keyId: manifest.signature.keyId });
  let ok = false;
  try {
    ok = cryptoVerify(null, signingInput(parsed.manifestDigest), key.key, Buffer.from(manifest.signature.value, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new PluginError("plugin_provenance_unverified", "The manifest signature does not verify for this exact manifest.");
  return { publisherId: manifest.publisher.id, keyId: key.keyId, alg: "ed25519", manifestDigest: parsed.manifestDigest, artifactDigest: parsed.artifactDigest, verifiedAt: now.toISOString() };
}
