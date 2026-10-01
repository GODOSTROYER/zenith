/**
 * The agent bearer credential and its scope selection under hostile input
 * (WS-SEC; threat rows: compromised agent, stale authorization, cross-tenant
 * access).
 *
 * `za_` credentials (src/lib/agent-access/security.ts) are what a connected
 * coding agent holds. If the agent — or the connector around it — is
 * compromised, this is the whole blast radius: one workspace, the projects the
 * human chose, the scopes the human ticked, at most 30 days. This file attacks
 * the parsing and selection code with the injection corpus so that radius cannot
 * grow through a malformed header, a look-alike identifier or a crafted record.
 *
 * Complements tests/agent-access/reader.node.mjs (which covers the happy paths
 * and the file authority) rather than repeating it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentError, authenticate, parseCredentials, selectScope, type Credential } from "@/lib/agent-access/security";
import { injectionsFor, SMALL_CATEGORIES } from "../_support/security";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const token = `za_${"A".repeat(20)}${"b".repeat(23)}`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const record = (over: Record<string, unknown> = {}): Credential => ({
  id: "cred_1",
  tokenHash: hash(token),
  subject: "user_1",
  workspaceId: "ws_1",
  projectIds: ["prj_1"],
  scopes: ["read"],
  issuedAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
  ...over,
});
const refusal = (fn: () => unknown): AgentError | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
};

describe("authenticate: only the exact credential shape is ever looked up", () => {
  const ok = (header: string | null) => authenticate(header, [record()], NOW);

  it("accepts the one valid form", () => {
    expect(ok(`Bearer ${token}`).id).toBe("cred_1");
  });

  it("refuses every near miss with the same 401, before any hash comparison", () => {
    const nearMisses: (string | null)[] = [
      null,
      "",
      token,
      `bearer ${token}`,
      `BEARER ${token}`,
      `Bearer  ${token}`,
      `Bearer\t${token}`,
      ` Bearer ${token}`,
      `Bearer ${token} `,
      `Bearer ${token}\n`,
      `Bearer ${token}\r\nX-Injected: 1`,
      `Bearer ${token.slice(0, -1)}`,
      `Bearer ${token}x`,
      `Bearer ${token.replace("za_", "zb_")}`,
      `Bearer ${token.replace("za_", "ZA_")}`,
      `Basic ${token}`,
      `Bearer ${token}=`,
      `Bearer ${token.slice(0, 10)}+${token.slice(11)}`,
      `Bearer ${token.slice(0, 10)}/${token.slice(11)}`,
      `Bearer ${token}, Bearer ${token}`,
      `Bearer ${token}\u0000`,
    ];
    for (const header of nearMisses) {
      const e = refusal(() => ok(header));
      expect(e, JSON.stringify(header)).toBeDefined();
      expect(e!.status, JSON.stringify(header)).toBe(401);
      expect(e!.code).toBe("unauthorized");
    }
  });

  it("refuses expired, revoked, not-yet-valid and unknown credentials with one indistinguishable answer", () => {
    const cases: [string, Credential[]][] = [
      ["expired", [record({ expiresAt: new Date(NOW - 1).toISOString() })]],
      ["expiring exactly now", [record({ expiresAt: new Date(NOW).toISOString() })]],
      ["revoked", [record({ revokedAt: new Date(NOW - 1000).toISOString() })]],
      ["issued in the future", [record({ issuedAt: new Date(NOW + 1000).toISOString() })]],
      ["unknown", []],
      ["another token's hash", [record({ tokenHash: hash(`${token}x`) })]],
    ];
    const messages = new Set<string>();
    for (const [name, records] of cases) {
      const e = refusal(() => authenticate(`Bearer ${token}`, records, NOW));
      expect(e, name).toBeDefined();
      expect(e!.status, name).toBe(401);
      messages.add(`${e!.code}|${e!.message}`);
    }
    expect(messages.size, "expired, revoked and unknown must not be distinguishable to the caller").toBe(1);
  });

  it("the stored record never holds the token, only its SHA-256", () => {
    expect(JSON.stringify(record())).not.toContain(token);
    expect(record().tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => parseCredentials({ version: 1, credentials: [{ ...record(), token }] })).toThrow(AgentError);
  });
});

describe("parseCredentials: a crafted record cannot widen the grant", () => {
  const parse = (over: Record<string, unknown>) => parseCredentials({ version: 1, credentials: [{ ...record(), ...over }] });

  it("refuses demo identities, unknown scopes, a missing read scope and lifetimes beyond 30 days", () => {
    for (const subject of ["local", "navigator", "system"]) expect(refusal(() => parse({ subject })), subject).toBeDefined();
    expect(refusal(() => parse({ scopes: ["read", "admin"] }))).toBeDefined();
    expect(refusal(() => parse({ scopes: ["write"] }))).toBeDefined();
    expect(refusal(() => parse({ scopes: [] }))).toBeDefined();
    expect(refusal(() => parse({ expiresAt: new Date(NOW + 31 * 86_400_000).toISOString() }))).toBeDefined();
    expect(refusal(() => parse({ expiresAt: new Date(NOW - 86_400_000 * 2).toISOString(), issuedAt: new Date(NOW).toISOString() }))).toBeDefined();
    expect(refusal(() => parse({ projectIds: [] }))).toBeDefined();
  });

  it("refuses unknown fields (a smuggled `admin`, `workspaceIds`, `role`, `__proto__`)", () => {
    for (const extra of [{ admin: true }, { workspaceIds: ["ws_2"] }, { role: "admin" }, { projectIds2: [] }, JSON.parse('{"__proto__":{"scopes":["write"]}}')]) {
      expect(refusal(() => parse(extra)), JSON.stringify(extra)).toBeDefined();
    }
    expect(({} as Record<string, unknown>).scopes).toBeUndefined();
  });

  it("every corpus string is refused as an id, a subject, a workspace, a project or an environment", () => {
    for (const c of injectionsFor(...SMALL_CATEGORIES)) {
      for (const field of ["id", "subject", "workspaceId"]) expect(refusal(() => parse({ [field]: c.value })), `${field} <- ${c.id}`).toBeDefined();
      expect(refusal(() => parse({ projectIds: [c.value] })), `projectIds <- ${c.id}`).toBeDefined();
      expect(refusal(() => parse({ environmentIds: [c.value] })), `environmentIds <- ${c.id}`).toBeDefined();
      // label and clientName are display text with a small alphabet: refused, or made only of that alphabet
      for (const [field, alphabet] of [
        ["label", /^[A-Za-z0-9._-]{1,40}$/],
        ["clientName", /^[A-Za-z0-9 ._-]{1,60}$/],
      ] as const) {
        if (!refusal(() => parse({ [field]: c.value }))) expect(c.value, `${field} <- ${c.id}`).toMatch(alphabet);
      }
    }
  });

  it("refuses duplicate ids or hashes, and a file with more than 100 credentials", () => {
    expect(() => parseCredentials({ version: 1, credentials: [record(), record()] })).toThrow(AgentError);
    expect(() => parseCredentials({ version: 1, credentials: [record(), record({ id: "cred_2" })] })).toThrow(AgentError);
    const many = Array.from({ length: 101 }, (_, i) => record({ id: `cred_${i}`, tokenHash: hash(`t${i}`) }));
    expect(() => parseCredentials({ version: 1, credentials: many })).toThrow(AgentError);
  });
});

describe("selectScope: headers cannot name anything the credential does not hold", () => {
  const grant = record({ projectIds: ["prj_1"], environmentIds: ["env_1"] });
  /** A header a real client cannot even send (non-Latin-1, CR/LF, NUL) is refused by the platform's Headers API: also a refusal. */
  const attempt = (h: Record<string, string>): AgentError | undefined => {
    let headers: Headers;
    try {
      headers = new Headers(h);
    } catch {
      return new AgentError("invalid_header", "rejected by the Headers API");
    }
    return refusal(() => selectScope(headers, grant));
  };

  it("accepts the credential's own selection and narrower ones", () => {
    expect(selectScope(new Headers({ "x-zenith-workspace": "ws_1" }), grant)).toEqual({ workspaceId: "ws_1" });
    expect(selectScope(new Headers({ "x-zenith-workspace": "ws_1", "x-zenith-project": "prj_1", "x-zenith-environment": "env_1" }), grant)).toEqual({ workspaceId: "ws_1", projectId: "prj_1", environmentId: "env_1" });
  });

  it("refuses another workspace, project or environment, and an environment without its project", () => {
    const cases: Record<string, string>[] = [
      { "x-zenith-workspace": "ws_2" },
      { "x-zenith-workspace": "ws_1", "x-zenith-project": "prj_2" },
      { "x-zenith-workspace": "ws_1", "x-zenith-project": "prj_1", "x-zenith-environment": "env_2" },
      { "x-zenith-workspace": "ws_1", "x-zenith-environment": "env_1" },
      {},
    ];
    for (const h of cases) {
      expect(attempt(h), JSON.stringify(h)).toBeDefined();
    }
  });

  it("look-alike identifiers (case, unicode, invisible characters, homoglyphs) are different identifiers", () => {
    // (leading/trailing whitespace is stripped by the Headers API itself, so it never reaches selectScope)
    for (const workspace of ["WS_1", "ws_\uFF11", "ws\u200B_1", "ws_1\u0000", "ws\u0301_1", "ws_1\u202E", "w s_1", "ws_1%00", "ws_1;", "ws_1/../ws_2"]) {
      expect(attempt({ "x-zenith-workspace": workspace }), JSON.stringify(workspace)).toBeDefined();
    }
  });

  it("every corpus string is refused as a workspace, project or environment selection", () => {
    for (const c of injectionsFor(...SMALL_CATEGORIES)) {
      expect(attempt({ "x-zenith-workspace": c.value }), `workspace <- ${c.id}`).toBeDefined();
      expect(attempt({ "x-zenith-workspace": "ws_1", "x-zenith-project": c.value }), `project <- ${c.id}`).toBeDefined();
      expect(attempt({ "x-zenith-workspace": "ws_1", "x-zenith-project": "prj_1", "x-zenith-environment": c.value }), `environment <- ${c.id}`).toBeDefined();
    }
  });
});
