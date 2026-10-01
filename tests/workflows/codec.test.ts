/** Real Node crypto and protobufs; no Temporal server or cloud is used here. */
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { inspect } from "node:util";
import { defaultPayloadConverter, type Payload } from "@temporalio/common";
import { temporal } from "@temporalio/proto";
import { describe, expect, it } from "vitest";
import {
  TEMPORAL_PAYLOAD_ENCODING, TEMPORAL_PAYLOAD_KEY_ID,
  TemporalCodecError, TemporalPayloadCodec, temporalDataConverterFromEnv,
} from "@/lib/workflows/codec";

const CURRENT = "11".repeat(32);
const PREVIOUS = "22".repeat(32);
const WirePayload = temporal.api.common.v1.Payload;
const bytes = (payload: Payload): Buffer => Buffer.from(WirePayload.encode(payload).finish());
function copy(payload: Payload): Payload {
  return {
    metadata: Object.fromEntries(Object.entries(payload.metadata ?? {}).map(([name, value]) => [name, Buffer.from(value)])),
    data: payload.data ? Buffer.from(payload.data) : undefined,
  };
}

describe("Temporal AES-256-GCM payload codec", () => {
  it.each([
    { name: "JSON", value: { workspaceId: "ws-1", nested: [1, false, "payload-canary"] } },
    { name: "binary", value: new Uint8Array([0, 255, 128, 1]) },
    { name: "undefined", value: undefined },
    { name: "null", value: null },
    { name: "empty string", value: "" },
  ])("round-trips $name through the SDK payload converter", async ({ value }) => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const payload = defaultPayloadConverter.toPayload(value);
    const before = bytes(payload);
    const [encrypted] = await codec.encode([payload]);
    const [decoded] = await new TemporalPayloadCodec(CURRENT).decode([encrypted]);
    expect(defaultPayloadConverter.fromPayload(decoded)).toEqual(value);
    expect(bytes(decoded)).toEqual(before);
    expect(bytes(payload)).toEqual(before);
    expect(encrypted).not.toBe(payload);
    expect(Object.keys(encrypted.metadata!)).toEqual(["encoding", TEMPORAL_PAYLOAD_KEY_ID]);
    expect(Buffer.from(encrypted.metadata!.encoding).toString()).toBe(TEMPORAL_PAYLOAD_ENCODING);
    expect(Buffer.from(encrypted.metadata![TEMPORAL_PAYLOAD_KEY_ID]).toString()).toBe(codec.keyId);
  });

  it("encrypts original metadata as well as data, including arbitrary binary metadata", async () => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const canary = "test-payload-canary-not-a-real-secret";
    const payload: Payload = { metadata: { encoding: Buffer.from("json/plain"), private: Buffer.from(canary), binary: Buffer.from([0, 255]) }, data: Buffer.from(canary) };
    const [encrypted] = await codec.encode([payload]);
    expect(bytes(encrypted).includes(Buffer.from(canary))).toBe(false);
    expect(bytes(encrypted).includes(Buffer.from(CURRENT))).toBe(false);
    expect(bytes(encrypted).includes(Buffer.from("private"))).toBe(false);
    expect(bytes((await codec.decode([encrypted]))[0])).toEqual(bytes(payload));
  });

  it("uses the pinned HKDF domain and authenticates the envelope in independent decryption", async () => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const payload = defaultPayloadConverter.toPayload({ check: "independent" });
    const [encrypted] = await codec.encode([payload]);
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(CURRENT, "hex"), Buffer.alloc(0), "zenith.temporal.payload.v1", 32));
    const data = Buffer.from(encrypted.data!);
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(JSON.stringify([TEMPORAL_PAYLOAD_ENCODING, codec.keyId])));
    decipher.setAuthTag(data.subarray(12, 28));
    expect(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()])).toEqual(bytes(payload));
  });

  it("keeps derived key bytes out of SDK option inspection and serialization", () => {
    const codec = new TemporalPayloadCodec(CURRENT, [PREVIOUS]);
    const options = { dataConverter: { payloadCodecs: [codec] } };
    const rendered = inspect(options, { depth: null, showHidden: true });
    expect(Object.keys(codec)).toEqual(["keyId", "cacheKey"]);
    for (const secret of [CURRENT, PREVIOUS]) {
      const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "hex"), Buffer.alloc(0), "zenith.temporal.payload.v1", 32));
      expect(rendered).not.toContain(inspect(key));
      expect(rendered).not.toContain(key.toString("hex"));
      expect(rendered).not.toContain(secret);
      expect(JSON.stringify(options)).not.toContain(key.toString("hex"));
    }
  });

  it("uses fresh 96-bit nonces for repeated and concurrent encodes without changing order", async () => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const inputs = ["one", "two", "one"].map((value) => defaultPayloadConverter.toPayload(value));
    const batches = await Promise.all(Array.from({ length: 12 }, () => codec.encode(inputs)));
    const nonces = batches.flat().map((p) => Buffer.from(p.data!).subarray(0, 12).toString("hex"));
    expect(new Set(nonces).size).toBe(36);
    for (const batch of batches) {
      expect((await codec.decode(batch)).map((p) => defaultPayloadConverter.fromPayload(p))).toEqual(["one", "two", "one"]);
    }
  });

  it("handles empty batches and an empty protobuf payload", async () => {
    const codec = new TemporalPayloadCodec(CURRENT);
    expect(await codec.encode([])).toEqual([]);
    expect(await codec.decode([])).toEqual([]);
    expect(bytes((await codec.decode(await codec.encode([{}])))[0])).toEqual(bytes({}));
  });

  it("preserves plaintext history payloads and mixed plaintext/encrypted batches", async () => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const legacy = defaultPayloadConverter.toPayload({ legacy: true });
    const encrypted = (await codec.encode([defaultPayloadConverter.toPayload("new")]))[0];
    const decoded = await codec.decode([legacy, encrypted, {}]);
    expect(decoded[0]).toBe(legacy);
    expect(defaultPayloadConverter.fromPayload(decoded[1])).toBe("new");
    expect(decoded[2]).toEqual({});
  });

  it.each([
    { name: "nonce", index: 0 }, { name: "tag", index: 12 }, { name: "ciphertext", index: 28 },
  ])("rejects tampered $name without echoing data", async ({ index }) => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const payload = (await codec.encode([defaultPayloadConverter.toPayload("sensitive-test-canary")]))[0];
    const damaged = copy(payload);
    damaged.data![index] ^= 1;
    const error = await codec.decode([damaged]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TemporalCodecError);
    expect(String(error)).toBe("Error: Temporal payload authentication or decoding failed.");
    expect(String(error)).not.toContain(CURRENT);
    expect(String(error)).not.toContain("sensitive-test-canary");
    expect(bytes(payload)).not.toEqual(bytes(damaged));
  });

  it.each([0, 1, 12, 27])("rejects a truncated envelope (%i bytes)", async (length) => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const payload = (await codec.encode([defaultPayloadConverter.toPayload("test")]))[0];
    payload.data = payload.data!.subarray(0, length);
    await expect(codec.decode([payload])).rejects.toThrow("Temporal encrypted payload is invalid.");
  });

  it.each(["missing data", "missing key id", "invalid key id", "extra metadata", "changed encoding", "missing encoding", "future version"])("rejects %s instead of passing ciphertext through", async (mutation) => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const payload = (await codec.encode([defaultPayloadConverter.toPayload("test")]))[0];
    switch (mutation) {
      case "missing data": delete payload.data; break;
      case "missing key id": delete payload.metadata![TEMPORAL_PAYLOAD_KEY_ID]; break;
      case "invalid key id": payload.metadata![TEMPORAL_PAYLOAD_KEY_ID] = Buffer.from("external-canary"); break;
      case "extra metadata": payload.metadata!.extra = Buffer.from("external-canary"); break;
      case "changed encoding": payload.metadata!.encoding = Buffer.from("json/plain"); break;
      case "missing encoding": delete payload.metadata!.encoding; break;
      case "future version": payload.metadata!.encoding = Buffer.from("binary/zenith.temporal.v2"); delete payload.metadata![TEMPORAL_PAYLOAD_KEY_ID]; break;
    }
    const error = await codec.decode([payload]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TemporalCodecError);
    expect(String(error)).not.toContain("external-canary");
  });

  it("authenticates key ids even when the substituted id names a retained key", async () => {
    const codec = new TemporalPayloadCodec(CURRENT, [PREVIOUS]);
    const payload = (await codec.encode([defaultPayloadConverter.toPayload("test")]))[0];
    payload.metadata![TEMPORAL_PAYLOAD_KEY_ID] = Buffer.from(new TemporalPayloadCodec(PREVIOUS).keyId);
    await expect(codec.decode([payload])).rejects.toThrow("Temporal payload authentication or decoding failed.");
  });

  it("rejects valid ciphertext containing an invalid protobuf with a fixed error", async () => {
    const codec = new TemporalPayloadCodec(CURRENT);
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(CURRENT, "hex"), Buffer.alloc(0), "zenith.temporal.payload.v1", 32));
    const nonce = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([TEMPORAL_PAYLOAD_ENCODING, codec.keyId])));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from([255])), cipher.final()]);
    const payload = { metadata: { encoding: Buffer.from(TEMPORAL_PAYLOAD_ENCODING), [TEMPORAL_PAYLOAD_KEY_ID]: Buffer.from(codec.keyId) }, data: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]) };
    await expect(codec.decode([payload])).rejects.toThrow("Temporal payload authentication or decoding failed.");
  });

  it("reads retained keys, writes only the current key, and fails after key removal", async () => {
    const old = new TemporalPayloadCodec(PREVIOUS);
    const rotated = new TemporalPayloadCodec(CURRENT, [PREVIOUS]);
    const [historyPayload] = await old.encode([defaultPayloadConverter.toPayload("old history")]);
    expect(defaultPayloadConverter.fromPayload((await rotated.decode([historyPayload]))[0])).toBe("old history");
    const [newPayload] = await rotated.encode([defaultPayloadConverter.toPayload("new history")]);
    expect(Buffer.from(newPayload.metadata![TEMPORAL_PAYLOAD_KEY_ID]).toString()).toBe(rotated.keyId);
    expect(rotated.keyId).not.toBe(old.keyId);
    await expect(old.decode([newPayload])).rejects.toThrow("decryption key is unavailable");
    await expect(new TemporalPayloadCodec(CURRENT).decode([historyPayload])).rejects.toThrow("decryption key is unavailable");
    expect(rotated.cacheKey).toBe(new TemporalPayloadCodec(CURRENT, [PREVIOUS, CURRENT, PREVIOUS]).cacheKey);
    expect(rotated.cacheKey).not.toBe(new TemporalPayloadCodec(CURRENT).cacheKey);
  });
});

describe("Temporal codec environment", () => {
  it("requires a production key and permits only unconfigured development/test plaintext", () => {
    expect(() => temporalDataConverterFromEnv({ NODE_ENV: "production" })).toThrow(TemporalCodecError);
    expect(temporalDataConverterFromEnv({ NODE_ENV: "development" }).payloadCodecs).toEqual([]);
    expect(temporalDataConverterFromEnv({ NODE_ENV: "test" }).payloadCodecs).toEqual([]);
    expect(temporalDataConverterFromEnv({}).payloadCodecs).toEqual([]);
    expect(temporalDataConverterFromEnv({ NODE_ENV: "production", ZENITH_SECRET_KEY: CURRENT }).payloadCodecs).toHaveLength(1);
  });

  it.each(["", " ", "test-key-canary", "11".repeat(31), "11".repeat(33), "gg".repeat(32)])("rejects invalid supplied key #%# in every environment without echo", (invalid) => {
    for (const NODE_ENV of ["production", "development", "test"]) {
      const error = (() => { try { temporalDataConverterFromEnv({ NODE_ENV, ZENITH_SECRET_KEY: invalid }); } catch (err) { return err; } })();
      expect(error).toBeInstanceOf(TemporalCodecError);
      expect(String(error)).toBe("Error: Temporal payload encryption requires ZENITH_SECRET_KEY (64 hex characters).");
    }
  });

  it.each(["", "test-key-canary", "{}", "null", '"canary"', '["canary"]', '[42]', '[null]'])("rejects malformed retained keys #%# without echoing the JSON", (previous) => {
    expect(() => temporalDataConverterFromEnv({ ZENITH_SECRET_KEY: CURRENT, ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS: previous })).toThrow("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS must be a JSON array of 64-hex keys.");
  });

  it("never allows retained keys without an active key", () => {
    expect(() => temporalDataConverterFromEnv({ ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS: "[]" })).toThrow(TemporalCodecError);
  });

  it("reads a retained key ring and accepts case-insensitive hex consistently", async () => {
    const uppercase = "AB".repeat(32);
    expect(new TemporalPayloadCodec(uppercase).keyId).toBe(new TemporalPayloadCodec(uppercase.toLowerCase()).keyId);
    const converter = temporalDataConverterFromEnv({ ZENITH_SECRET_KEY: CURRENT, ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS: JSON.stringify([PREVIOUS]) });
    const [payload] = await new TemporalPayloadCodec(PREVIOUS).encode([defaultPayloadConverter.toPayload("old")]);
    expect(defaultPayloadConverter.fromPayload((await converter.payloadCodecs[0].decode([payload]))[0])).toBe("old");
  });
});
