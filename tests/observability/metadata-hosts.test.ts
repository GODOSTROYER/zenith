/** Literal classification only; private operator backends remain supported. */
import { describe, expect, it } from "vitest";
import { isMetadataHost, normalizeBaseUrl } from "@/lib/observability/sources/http";

describe("metadata literal equivalence", () => {
  it.each([
    "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:a9fe:a9fe",
    "0000:0000:0000:0000:0000:FFFF:A9FE:A9FE", "::ffff:169.254.1.1",
    "::ffff:100.100.100.200", "::ffff:6464:64c8", "0:0:0:0:0:ffff:6464:64c8",
    "fd00:0ec2:0:0:0:0:0:0254",
  ])("rejects equivalent metadata host %s", (host) => {
    expect(isMetadataHost(host)).toBe(true);
    expect(isMetadataHost(`[${host}]`)).toBe(true);
    expect(() => normalizeBaseUrl(`http://[${host}]:9090/prefix`)).toThrow(/metadata/);
  });

  it.each(["::ffff:10.0.0.1", "::ffff:192.168.1.1", "::ffff:100.100.100.201", "fd00::1", "::1"])("permits private operator backend %s", (host) => {
    expect(isMetadataHost(host)).toBe(false);
    expect(normalizeBaseUrl(`https://[${host}]:9090/metrics/`)).toMatch(/:9090\/metrics$/);
  });
});
