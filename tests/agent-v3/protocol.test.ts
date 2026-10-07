/** Pure policy: which MCP protocol versions v3 serves, and how the rest are refused. */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION_META_KEY, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS, REFUSED_MCP_PROTOCOL_VERSIONS, SUPPORTED_MCP_PROTOCOL_VERSIONS, checkProtocolVersion, versionRefusalResponse } from "@/lib/agent-access/v3/protocol";

const init = (protocolVersion: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "1" } } });

describe("pinned protocol versions", () => {
  it("are explicit and every legacy one is implemented by the installed SDK", () => {
    expect(LEGACY_PROTOCOL_VERSIONS).toEqual(["2025-11-25", "2025-06-18", "2025-03-26"]);
    expect(MODERN_PROTOCOL_VERSIONS).toEqual(["2026-07-28"]);
    for (const version of LEGACY_PROTOCOL_VERSIONS) expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(version);
    for (const refused of REFUSED_MCP_PROTOCOL_VERSIONS) expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).not.toContain(refused);
  });
});

describe("checkProtocolVersion", () => {
  it.each([...LEGACY_PROTOCOL_VERSIONS, ...MODERN_PROTOCOL_VERSIONS])("accepts header and initialize %s", (version) => {
    expect(checkProtocolVersion(version, undefined)).toBeUndefined();
    expect(checkProtocolVersion(null, init(version))).toBeUndefined();
  });
  it("accepts a request with no version at all (the version negotiated at initialize applies)", () => {
    expect(checkProtocolVersion(null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).toBeUndefined();
    expect(checkProtocolVersion(null, undefined)).toBeUndefined();
  });
  it.each(["2024-11-05", "2024-10-07", "2025-01-01", "nonsense", "", "2026-01-01"])("refuses header %j and echoes the request id", (version) => {
    expect(checkProtocolVersion(version, { jsonrpc: "2.0", id: 7, method: "tools/list" })).toEqual({ requested: version, id: 7 });
  });
  it.each(["2024-11-05", "2024-10-07", "2025-01-01", "garbage", "2099-13-45x"])("refuses initialize %s (older, unknown or malformed)", (version) => {
    expect(checkProtocolVersion(null, init(version, 9))).toMatchObject({ requested: version, id: 9 });
  });
  it("refuses initialize without a string version", () => {
    expect(checkProtocolVersion(null, init(undefined))).toMatchObject({ requested: "(missing)" });
    expect(checkProtocolVersion(null, init(20250326))).toMatchObject({ requested: "(missing)" });
  });
  it("counter-offers a well-formed NEWER version instead of refusing it", () => {
    expect(checkProtocolVersion(null, init("2099-01-01"))).toBeUndefined();
  });
  it("refuses an unsupported 2026-era request envelope and accepts the supported one", () => {
    const call = (v: unknown) => ({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { [PROTOCOL_VERSION_META_KEY]: v } } });
    expect(checkProtocolVersion(null, call("2026-07-28"))).toBeUndefined();
    expect(checkProtocolVersion(null, call("2026-01-01"))).toMatchObject({ requested: "2026-01-01", id: 3 });
    expect(checkProtocolVersion(null, call("2025-06-18"))).toMatchObject({ requested: "2025-06-18" });
    expect(checkProtocolVersion(null, call(5))).toMatchObject({ requested: "(invalid)" });
  });
  it("checks every message of a batch", () => {
    expect(checkProtocolVersion(null, [init("2025-06-18", 1), init("2024-11-05", 2)])).toMatchObject({ requested: "2024-11-05", id: 2 });
  });
});

describe("versionRefusalResponse", () => {
  it("is HTTP 400 with JSON-RPC -32602 and the full supported list", async () => {
    const response = versionRefusalResponse({ requested: "2024-11-05", id: 4 });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32602, message: "Unsupported protocol version", data: { requested: "2024-11-05", supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS] } } });
  });
});
