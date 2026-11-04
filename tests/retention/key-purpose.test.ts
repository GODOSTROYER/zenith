import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyRing } from "@/lib/keycustody/registry";

describe("retention archive encryption purpose", () => {
  it("derives independent archive bytes and identifiers from the backup root", () => {
    const ring = KeyRing.fromEnv({ ZENITH_BACKUP_KEY: randomBytes(32).toString("hex") }, { purposes: ["enc:archive", "enc:backup"] });
    const archive = ring.useKey("enc:archive", "encrypt"), backup = ring.useKey("enc:backup", "encrypt");
    expect(archive.equals(backup)).toBe(false);
    expect(ring.violations()).toEqual([]);
    expect(ring.descriptors("enc:archive")[0].keyId).not.toBe(ring.descriptors("enc:backup")[0].keyId);
  });
  it("refuses missing root and signing under an encryption purpose", () => {
    const ring = KeyRing.fromEnv({});
    expect(() => ring.useKey("enc:archive", "encrypt")).toThrow("No enc:archive key");
    expect(() => ring.useKey("enc:archive", "sign")).toThrow("may not be used to sign");
  });
});
