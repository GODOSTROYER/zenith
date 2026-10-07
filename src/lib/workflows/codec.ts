/**
 * Node-only Temporal payload encryption, outside the deterministic workflow
 * sandbox. AES-256-GCM encrypts the complete protobuf payload (including its
 * metadata); HKDF separates this key from other uses of ZENITH_SECRET_KEY.
 * Encoding/version and a non-secret key fingerprint are authenticated as AAD.
 * Fresh nonces are generated on every encode; keys never leave this process.
 *
 * The payload root is ZENITH_TEMPORAL_PAYLOAD_KEY when set, else ZENITH_SECRET_KEY; the key registry
 * (src/lib/keycustody) reports both as the enc:temporal-payload purpose with this same key id.
 *
 * Legacy plaintext payloads remain readable for existing history replay. This
 * does not encrypt workflow ids, visibility fields or default failure messages.
 * No live Temporal Cloud acceptance is claimed by this module.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { DataConverter, Payload, PayloadCodec } from "@temporalio/common";
import { temporal } from "@temporalio/proto";

export const TEMPORAL_PAYLOAD_ENCODING = "binary/zenith.temporal.v1";
export const TEMPORAL_PAYLOAD_KEY_ID = "zenith.temporal.key-id";
const KEY_INFO = "zenith.temporal.payload.v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WirePayload = temporal.api.common.v1.Payload;

/** Fixed guidance only: no input, payload, key id or crypto errors are echoed. */
export class TemporalCodecError extends Error {
  readonly code = "temporal_payload_codec";
}

function deriveKey(secretKey: string): { id: string; key: Buffer } {
  if (typeof secretKey !== "string" || !/^[a-f0-9]{64}$/i.test(secretKey)) {
    throw new TemporalCodecError("Temporal payload encryption requires ZENITH_SECRET_KEY (64 hex characters).");
  }
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secretKey, "hex"), Buffer.alloc(0), KEY_INFO, 32));
  const id = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return { id, key };
}

const aad = (id: string): Buffer => Buffer.from(JSON.stringify([TEMPORAL_PAYLOAD_ENCODING, id]));

export class TemporalPayloadCodec implements PayloadCodec {
  // JavaScript privacy is required: Temporal may inspect options in debug logs.
  readonly #keys = new Map<string, Buffer>();
  readonly keyId: string;
  /** Includes decrypt-only keys so a cached client never retains stale config. */
  readonly cacheKey: string;

  constructor(secretKey: string, previousSecretKeys: readonly string[] = []) {
    const current = deriveKey(secretKey);
    this.keyId = current.id;
    this.#keys.set(current.id, current.key);
    for (const previous of previousSecretKeys) {
      const { id, key } = deriveKey(previous);
      this.#keys.set(id, key);
    }
    this.cacheKey = [current.id, ...[...this.#keys.keys()].sort()].join(":");
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    try {
      return payloads.map((payload) => {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", this.#keys.get(this.keyId)!, nonce, { authTagLength: TAG_BYTES });
        cipher.setAAD(aad(this.keyId));
        const ciphertext = Buffer.concat([cipher.update(WirePayload.encode(payload).finish()), cipher.final()]);
        return {
          metadata: {
            encoding: Buffer.from(TEMPORAL_PAYLOAD_ENCODING),
            [TEMPORAL_PAYLOAD_KEY_ID]: Buffer.from(this.keyId),
          },
          data: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
        };
      });
    } catch {
      throw new TemporalCodecError("Temporal payload encryption failed.");
    }
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    try {
      return payloads.map((payload) => {
        const metadata = payload.metadata;
        const encoding = metadata?.encoding ? Buffer.from(metadata.encoding).toString("utf8") : "";
        if (encoding !== TEMPORAL_PAYLOAD_ENCODING) {
          // Reject damaged/unsupported Zenith envelopes instead of treating
          // their bytes as legacy plaintext. Legacy payloads have no key id.
          if (metadata && (TEMPORAL_PAYLOAD_KEY_ID in metadata || encoding.startsWith("binary/zenith.temporal"))) {
            throw new TemporalCodecError("Temporal encrypted payload is invalid.");
          }
          return payload;
        }
        const idBytes = metadata?.[TEMPORAL_PAYLOAD_KEY_ID];
        const id = idBytes ? Buffer.from(idBytes).toString("utf8") : "";
        if (!/^[a-f0-9]{32}$/.test(id) || Object.keys(metadata!).length !== 2 || !payload.data || payload.data.length < NONCE_BYTES + TAG_BYTES) {
          throw new TemporalCodecError("Temporal encrypted payload is invalid.");
        }
        const key = this.#keys.get(id);
        if (!key) throw new TemporalCodecError("Temporal payload decryption key is unavailable; retain previous keys for history replay.");
        const bytes = Buffer.from(payload.data);
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
        decipher.setAAD(aad(id));
        decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
        const plaintext = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]);
        return WirePayload.decode(plaintext);
      });
    } catch (err) {
      if (err instanceof TemporalCodecError) throw err;
      throw new TemporalCodecError("Temporal payload authentication or decoding failed.");
    }
  }
}

/** Read only codec configuration, before any connection or worker starts. */
export function temporalDataConverterFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): DataConverter & { payloadCodecs: TemporalPayloadCodec[] } {
  // A dedicated payload root (PROD-OPS-05) rotates independently of the vault key; otherwise the vault root is used
  // through the same HKDF domain as always.
  const secretKey = env.ZENITH_TEMPORAL_PAYLOAD_KEY?.trim() || env.ZENITH_SECRET_KEY;
  const previous = env.ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS;
  if (!secretKey) {
    if (env.NODE_ENV === "production" || secretKey !== undefined || previous !== undefined) {
      throw new TemporalCodecError("Temporal payload encryption requires ZENITH_SECRET_KEY (64 hex characters).");
    }
    // Development/test only: no public default key or automatic random key.
    return { payloadCodecs: [] };
  }
  let previousKeys: string[] = [];
  if (previous !== undefined) {
    try {
      const parsed: unknown = JSON.parse(previous);
      if (!Array.isArray(parsed) || !parsed.every((key): key is string => typeof key === "string" && /^[a-f0-9]{64}$/i.test(key))) {
        throw new Error();
      }
      previousKeys = parsed;
    } catch {
      throw new TemporalCodecError("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS must be a JSON array of 64-hex keys.");
    }
  }
  return { payloadCodecs: [new TemporalPayloadCodec(secretKey, previousKeys)] };
}
