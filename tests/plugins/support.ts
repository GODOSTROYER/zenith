/**
 * Plugin test support. Keys are generated at runtime (no key material in the
 * repository); signatures are real Ed25519. The parent-credential lookup is an
 * explicit in-memory model of the credential authority: its behaviour (live,
 * revoked, narrowed) is what the tests drive, the plugin SQL is real PGlite.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { manifestDigestOf, signingInput, trustedPublishersFromEnv, type PluginManifest, type TrustedPublishers } from "@/lib/plugins/manifest";
import type { ParentCredential, ParentLookup } from "@/lib/plugins/service";

export const PUBLISHER = "acme";
export const KEY_ID = "acme-2026";

export interface TestPublisher {
  privateKey: KeyObject;
  publishers: TrustedPublishers;
}

export function makePublisher(publisher = PUBLISHER, keyId = KEY_ID): TestPublisher {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const publishers = trustedPublishersFromEnv({ ZENITH_PLUGIN_TRUSTED_PUBLISHERS: JSON.stringify({ [publisher]: [{ keyId, publicKey: raw }] }) });
  return { privateKey, publishers };
}

export type UnsignedManifest = Omit<PluginManifest, "signature">;

export function baseManifest(over: Partial<UnsignedManifest> = {}): UnsignedManifest {
  return {
    schemaVersion: 1,
    id: `${PUBLISHER}/topology-viewer`,
    name: "Topology viewer",
    description: "Reads topology and logs for a coding agent.",
    version: "1.0.0",
    publisher: { id: PUBLISHER, name: "Acme" },
    artifact: { digest: `sha256:${"a".repeat(64)}` },
    capabilities: { tools: ["zenith_get_topology", "zenith_query_logs"], scopes: ["read", "logs"] },
    isolation: { credentials: "none", store: "none", network: "mcp-only", tokenPassthrough: "forbidden" },
    ...over,
  };
}

export function signManifest(unsigned: UnsignedManifest, privateKey: KeyObject, keyId = KEY_ID): PluginManifest {
  const draft = { ...unsigned, signature: { alg: "ed25519" as const, keyId, value: "" } } as PluginManifest;
  const value = sign(null, signingInput(manifestDigestOf(draft)), privateKey).toString("base64");
  return { ...unsigned, signature: { alg: "ed25519", keyId, value } };
}

/** An in-memory credential authority: tests flip `revoked`, narrow scopes, or expire it. */
export class FakeParents {
  readonly rows = new Map<string, ParentCredential>();
  add(over: Partial<ParentCredential> & { id: string }): ParentCredential {
    const row: ParentCredential = {
      subject: "bob",
      workspaceId: "ws-a",
      projectIds: ["proj-a"],
      scopes: ["read", "plan", "logs", "write"],
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      ...over,
    };
    this.rows.set(row.id, row);
    return row;
  }
  lookup: ParentLookup = async (subject, workspaceId, credentialId) => {
    const row = this.rows.get(credentialId);
    if (!row || row.subject !== subject || row.workspaceId !== workspaceId || row.revokedAt || Date.parse(row.expiresAt) <= Date.now()) return null;
    return { ...row };
  };
}
