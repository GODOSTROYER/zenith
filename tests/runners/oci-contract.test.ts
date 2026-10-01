/** Cross-language contract drift and an independent signing-vector oracle. */
import { createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OCI_ALLOWLIST } from "@/lib/providers/oci/allowlist";
import { OCI_SERVICE_HOSTS } from "@/lib/providers/oci/services";
import { RUNNER_JOB_KINDS } from "@/lib/runners/types";

const fixture = (name: string) => JSON.parse(readFileSync(`go/internal/oci/testdata/${name}.json`, "utf8"));
describe("OCI shared Go contracts", () => {
  it("embeds exactly the TypeScript per-capability allowlist", () => expect(fixture("allowlist")).toEqual(OCI_ALLOWLIST));
  it("embeds exactly the TypeScript service endpoints and versions", () => expect(fixture("services")).toEqual(OCI_SERVICE_HOSTS));
  it("includes oci.http in the runner vocabulary", () => expect(RUNNER_JOB_KINDS).toContain("oci.http"));
  it("independently verifies all RSA signatures and canonical strings", () => {
    const vector = fixture("signing-vector") as { publicKey: string; host: string; date: string; cases: { method: string; uri: string; bodyB64: string; canonical: string; signature: string }[] };
    for (const c of vector.cases) {
      const bytes = Buffer.from(c.bodyB64, "base64");
      const lines = [`(request-target): ${c.method.toLowerCase()} ${c.uri}`, `host: ${vector.host}`, `date: ${vector.date}`];
      if (["POST", "PUT"].includes(c.method)) lines.push(`x-content-sha256: ${createHash("sha256").update(bytes).digest("base64")}`, "content-type: application/json", `content-length: ${bytes.length}`);
      expect(c.canonical).toBe(lines.join("\n"));
      expect(verify("RSA-SHA256", Buffer.from(c.canonical), vector.publicKey, Buffer.from(c.signature, "base64"))).toBe(true);
    }
  });
});
