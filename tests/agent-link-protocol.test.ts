/**
 * The link protocol's wire rules — the parts three independent implementations
 * have to agree on: what a code looks like, how it is hashed, and what the
 * seal that holds the issued token guarantees.
 *
 * The token-shape assertions exist because the shape is pinned in four places
 * (this app's `security.ts` and `http.ts`, and the plugins repo's
 * `packages/client/control.ts`). If minting ever drifts from
 * `^za_[A-Za-z0-9_-]{43}$`, every one of them refuses the credential and the
 * failure looks like an authentication bug rather than a minting bug.
 */
import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

process.env.ZENITH_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");

const {
  LINK_MAX_DAYS,
  LINK_PROTOCOL_VERSION,
  LINK_PROTOCOL_VERSIONS,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  formatUserCode,
  hashToken,
  hashUserCode,
  isDeviceCode,
  linkJson,
  mintDeviceCode,
  mintToken,
  mintUserCode,
  normalizeUserCode,
  openLinkSecret,
  paceInterval,
  parseApproveRequest,
  parseStartRequest,
  parseTokenBody,
  parseTokenRequest,
  sealLinkSecret,
} = await import("../src/lib/agent-access/link/protocol");
const { authenticate } = await import("../src/lib/agent-access/security");

const jsonRequest = (body: unknown, type = "application/json") =>
  new Request("https://zenith.test/api/agent/link/start", {
    method: "POST",
    headers: { "content-type": type },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("user codes", () => {
  it("draws 8 symbols from a 28-symbol alphabet that excludes I, L, O and U", () => {
    expect(USER_CODE_ALPHABET).toHaveLength(28);
    expect(new Set(USER_CODE_ALPHABET).size).toBe(28);
    for (const confusable of ["I", "L", "O", "U"]) expect(USER_CODE_ALPHABET).not.toContain(confusable);
    for (let i = 0; i < 200; i++) {
      const code = mintUserCode();
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      expect(code.replace("-", "")).toHaveLength(USER_CODE_LENGTH);
      for (const character of code.replace("-", "")) expect(USER_CODE_ALPHABET).toContain(character);
    }
  });

  it("uses every symbol of the alphabet across enough draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) for (const c of mintUserCode().replace("-", "")) seen.add(c);
    // A biased or truncated alphabet shows up here as a missing symbol.
    expect(seen.size).toBe(28);
  });

  it("round-trips display form, normalization and hash", () => {
    const code = mintUserCode();
    const bare = code.replace("-", "");
    expect(formatUserCode(bare)).toBe(code);
    expect(normalizeUserCode(code)).toBe(bare);
    expect(normalizeUserCode(bare)).toBe(bare);
    expect(normalizeUserCode(code.toLowerCase())).toBe(bare);
    expect(normalizeUserCode(` ${code} `)).toBe(bare);
    expect(hashUserCode(bare)).toBe(createHash("sha256").update(bare).digest("hex"));
  });

  it("refuses anything that is not a user code, rather than repairing it", () => {
    for (const bad of [undefined, null, 42, "", "SHORT", "TOOLONGCODE", "ILOU1234", "ABCD-EFG!", "x".repeat(64)])
      expect(normalizeUserCode(bad)).toBeUndefined();
  });
});

describe("device codes and tokens", () => {
  it("mints a 256-bit device code the shape check accepts", () => {
    for (let i = 0; i < 50; i++) {
      const code = mintDeviceCode();
      expect(code).toMatch(/^zl_[A-Za-z0-9_-]{43}$/);
      expect(isDeviceCode(code)).toBe(true);
    }
    for (const bad of ["", "zl_short", `za_${"a".repeat(43)}`, 7, null]) expect(isDeviceCode(bad)).toBe(false);
  });

  it("mints exactly the bearer shape every validator pins", () => {
    for (let i = 0; i < 50; i++) expect(mintToken()).toMatch(/^za_[A-Za-z0-9_-]{43}$/);
  });

  it("hashes a token the way the unmodified authenticate() does", () => {
    const token = mintToken();
    const record = {
      id: "cred_1",
      tokenHash: hashToken(token),
      subject: "member",
      workspaceId: "ws",
      projectIds: ["prj"],
      scopes: ["read"] as const,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(authenticate(`Bearer ${token}`, [{ ...record, scopes: [...record.scopes] }]).id).toBe("cred_1");
    expect(() => authenticate(`Bearer ${mintToken()}`, [{ ...record, scopes: [...record.scopes] }])).toThrow(
      /invalid, expired, or revoked/
    );
  });
});

describe("the seal over the issued token", () => {
  it("round-trips under the code's own hash", () => {
    const hash = hashUserCode(normalizeUserCode(mintUserCode())!);
    const token = mintToken();
    const sealed = sealLinkSecret(hash, token);
    expect(sealed.toString("utf8")).not.toContain(token);
    expect(openLinkSecret(hash, sealed)).toBe(token);
  });

  it("refuses to open under another code's hash", () => {
    const token = mintToken();
    const sealed = sealLinkSecret(hashUserCode("AAAA2222"), token);
    // A row copied onto another code fails rather than handing back a token
    // that was approved for a different request.
    expect(() => openLinkSecret(hashUserCode("BBBB3333"), sealed)).toThrow(/ZENITH_SECRET_KEY/);
  });

  it("refuses short or truncated ciphertext instead of guessing", () => {
    expect(() => openLinkSecret(hashUserCode("AAAA2222"), Buffer.alloc(4))).toThrow(/ZENITH_SECRET_KEY/);
  });

  /**
   * The seal moved into `src/lib/secrets/index.ts`, which owns Zenith's secret
   * crypto. It must not have moved the bytes: a value sealed by the version
   * that wrote its own AES-256-GCM here has to open unchanged, because rows
   * written before the refactor are sitting in `agent.agent_link_codes` and in
   * `link-codes.json` right now.
   */
  it("opens a value sealed by the AES-256-GCM this module used to write itself", () => {
    const key = Buffer.from(process.env.ZENITH_SECRET_KEY!, "base64");
    const hash = hashUserCode("AAAA2222");
    const token = mintToken();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`agent-link ${hash}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

    expect(openLinkSecret(hash, legacy)).toBe(token);
    // iv(12) ‖ tag(16) ‖ ciphertext, still one buffer of the same length.
    expect(sealLinkSecret(hash, token)).toHaveLength(legacy.length);
  });

  it("has nowhere to put a secret when no key is configured", () => {
    const saved = process.env.ZENITH_SECRET_KEY;
    delete process.env.ZENITH_SECRET_KEY;
    try {
      expect(() => sealLinkSecret(hashUserCode("AAAA2222"), mintToken())).toThrow(/ZENITH_SECRET_KEY/);
    } finally {
      process.env.ZENITH_SECRET_KEY = saved;
    }
  });
});

describe("request bodies", () => {
  it("accepts the documented start body and rejects everything else", async () => {
    const parsed = parseStartRequest({
      clientName: "Claude Code",
      clientVersion: "2.1.4",
      label: "tarun-laptop",
      requestedScopes: ["read", "plan", "write", "logs"],
      protocolVersion: LINK_PROTOCOL_VERSION,
    });
    expect(parsed.clientName).toBe("Claude Code");
    expect(parsed.requestedScopes).toEqual(["read", "plan", "write", "logs"]);
    // An absent hint is not an error; the browser decides the scopes anyway.
    expect(parseStartRequest({ clientName: "Codex" }).requestedScopes).toEqual(["read"]);
    for (const bad of [
      null,
      "string",
      {},
      { clientName: "" },
      { clientName: "x".repeat(61) },
      { clientName: "Bad<script>" },
      { clientName: "ok", clientVersion: "x".repeat(41) },
      { clientName: "ok", label: "has space" },
      { clientName: "ok", requestedScopes: ["root"] },
      { clientName: "ok", protocolVersion: 3 },
      { clientName: "ok", protocolVersion: "2" },
      { clientName: "ok", extra: 1 },
    ])
      expect(() => parseStartRequest(bad)).toThrow();
    await expect(linkJson(jsonRequest({ clientName: "ok" }, "text/plain"), 4096)).rejects.toMatchObject({
      code: "media_type",
      status: 415,
    });
    await expect(linkJson(jsonRequest("{".repeat(4000)), 128)).rejects.toMatchObject({ status: 413 });
    await expect(linkJson(jsonRequest("not json"), 4096)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("accepts only a device code of the shape this server issued", () => {
    const code = mintDeviceCode();
    expect(parseTokenRequest({ deviceCode: code, protocolVersion: 1 })).toBe(code);
    for (const bad of [{}, { deviceCode: "nope" }, { deviceCode: code, protocolVersion: 9 }, { deviceCode: code, x: 1 }])
      expect(() => parseTokenRequest(bad)).toThrow();
  });

  it("refuses an approval without read, without a project, or beyond the ceiling", () => {
    const base = {
      userCode: "K7QM-3XRB".replace(/[ILOU]/g, "A"),
      approve: true,
      workspaceId: "ws_1",
      projectIds: ["prj_a"],
      scopes: ["read", "plan", "write"],
      days: 7,
    };
    expect(parseApproveRequest(base)).toMatchObject({ approve: true, days: 7 });
    for (const bad of [
      { ...base, scopes: ["plan"] },
      { ...base, projectIds: [] },
      { ...base, days: LINK_MAX_DAYS + 1 },
      { ...base, days: 0 },
      { ...base, days: 7.5 },
      { ...base, scopes: ["read", "root"] },
      { ...base, scopes: ["read", "read"] },
      { ...base, workspaceId: "" },
      { ...base, environmentIds: ["not valid"] },
      { ...base, approve: "yes" },
      { ...base, surprise: 1 },
    ])
      expect(() => parseApproveRequest(bad)).toThrow();
    // A denial needs nothing but the code.
    expect(parseApproveRequest({ userCode: base.userCode, approve: false })).toEqual({
      userCode: base.userCode.replace("-", ""),
      approve: false,
    });
  });
});

describe("poll pacing", () => {
  it("leaves a client that honours the interval alone and backs a fast one off", () => {
    const start = 1_700_000_000_000;
    // Polling once every five seconds: never escalated.
    for (let poll = 0; poll < 20; poll++)
      expect(paceInterval(poll, start, start + poll * 5000)).toBe(5);
    // Polling in a tight loop: 5 -> 10 -> 20 -> 30, and never past 30.
    expect(paceInterval(1, start, start)).toBe(10);
    expect(paceInterval(3, start, start)).toBe(20);
    expect(paceInterval(6, start, start)).toBe(30);
    expect(paceInterval(600, start, start)).toBe(30);
  });
});

describe("link protocol 2 (whole workspace, workspace hints)", () => {
  it("speaks 2 and still answers 1, echoing whichever the client sent", () => {
    expect(LINK_PROTOCOL_VERSION).toBe(2);
    expect(LINK_PROTOCOL_VERSIONS).toEqual([1, 2]);
    expect(parseStartRequest({ clientName: "Codex" }).protocolVersion).toBe(1);
    expect(parseStartRequest({ clientName: "Codex", protocolVersion: 1 }).protocolVersion).toBe(1);
    expect(parseStartRequest({ clientName: "Codex", protocolVersion: 2 }).protocolVersion).toBe(2);
    const code = mintDeviceCode();
    expect(parseTokenBody({ deviceCode: code })).toEqual({ deviceCode: code, protocolVersion: 1 });
    expect(parseTokenBody({ deviceCode: code, protocolVersion: 2 })).toEqual({ deviceCode: code, protocolVersion: 2 });
    for (const bad of [0, 3, "2", 1.5, null])
      expect(() => parseTokenBody({ deviceCode: code, protocolVersion: bad })).toThrow(/protocol versions 1 and 2/);
  });

  it("accepts a workspace hint or a new-workspace name, strictly, and only at protocol 2", () => {
    expect(parseStartRequest({ clientName: "Codex", protocolVersion: 2, workspaceHint: "ws_1-A" })).toMatchObject({
      workspaceHint: "ws_1-A",
    });
    expect(
      parseStartRequest({ clientName: "Codex", protocolVersion: 2, workspaceNameHint: "Acme Labs (EU) 2.0" })
    ).toMatchObject({ workspaceNameHint: "Acme Labs (EU) 2.0" });
    expect(parseStartRequest({ clientName: "Codex", protocolVersion: 2, workspaceNameHint: "Café Zürich" }).workspaceNameHint).toBe(
      "Café Zürich"
    );
    expect(parseStartRequest({ clientName: "Codex", protocolVersion: 2 })).not.toHaveProperty("workspaceHint");
    for (const bad of [
      // protocol 1 (explicit or implied) carries no hints
      { clientName: "ok", workspaceHint: "ws_1" },
      { clientName: "ok", protocolVersion: 1, workspaceNameHint: "Acme" },
      // one or the other
      { clientName: "ok", protocolVersion: 2, workspaceHint: "ws_1", workspaceNameHint: "Acme" },
      // an identifier, not a path or a URL
      { clientName: "ok", protocolVersion: 2, workspaceHint: "../ws" },
      { clientName: "ok", protocolVersion: 2, workspaceHint: "" },
      { clientName: "ok", protocolVersion: 2, workspaceHint: "x".repeat(101) },
      { clientName: "ok", protocolVersion: 2, workspaceHint: 7 },
      { clientName: "ok", protocolVersion: 2, workspaceHint: null },
      // 1-60 plain characters, no markup, no control characters, no padding
      { clientName: "ok", protocolVersion: 2, workspaceNameHint: "" },
      { clientName: "ok", protocolVersion: 2, workspaceNameHint: "x".repeat(61) },
      { clientName: "ok", protocolVersion: 2, workspaceNameHint: "<b>Acme</b>" },
      { clientName: "ok", protocolVersion: 2, workspaceNameHint: "Acme\nLabs" },
      { clientName: "ok", protocolVersion: 2, workspaceNameHint: " Acme" },
      { clientName: "ok", protocolVersion: 2, workspaceNameHint: "Acme " },
      { clientName: "ok", protocolVersion: 2, workspaceNameHint: "-Acme" },
      { clientName: "ok", protocolVersion: 2, workspaceNameHint: ["Acme"] },
    ])
      expect(() => parseStartRequest(bad), JSON.stringify(bad)).toThrow();
  });

  it("parses a whole-workspace approval and refuses every half of one", () => {
    const base = {
      userCode: "AAAA-2222",
      approve: true,
      workspaceId: "ws_1",
      scopes: ["read", "plan", "write"],
      days: 7,
    };
    expect(parseApproveRequest({ ...base, projectIds: [], allProjects: true })).toMatchObject({
      approve: true,
      allProjects: true,
      projectIds: [],
    });
    // Absent and false both mean an explicit list, which a protocol-1 page sends.
    expect(parseApproveRequest({ ...base, projectIds: ["prj_a"] })).toMatchObject({ allProjects: false });
    expect(parseApproveRequest({ ...base, projectIds: ["prj_a"], allProjects: false })).toMatchObject({
      allProjects: false,
    });
    for (const bad of [
      { ...base, allProjects: true },
      { ...base, allProjects: true, projectIds: ["prj_a"] },
      { ...base, allProjects: true, projectIds: [], environmentIds: ["env_1"] },
      { ...base, allProjects: true, projectIds: [], environmentIds: [] },
      { ...base, allProjects: "true", projectIds: [] },
      { ...base, allProjects: false, projectIds: [] },
    ])
      expect(() => parseApproveRequest(bad), JSON.stringify(bad)).toThrow(/whole workspace|project|environment/i);
  });
});

describe("the single project-grant predicate", () => {
  it("is the only way the link and reader surfaces test a project grant", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(process.cwd(), "src", "lib", "agent-access");
    for (const file of ["security.ts", "zenith-reader.ts", "control/boundary.ts"]) {
      const source = readFileSync(join(root, file), "utf8");
      // `grantsProject` itself (`g.projectIds.includes(…)`) is the one allowed use.
      const uses = source.match(/[\w.]*projectIds\.includes\(/g) ?? [];
      expect(uses.filter((use) => use !== "g.projectIds.includes("), `${file} must use grantsProject()`).toEqual([]);
    }
  });
});
