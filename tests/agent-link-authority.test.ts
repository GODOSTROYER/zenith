/**
 * The two credential authorities: the file one end to end in a temp directory,
 * and the Postgres one against a fake `sql` tag.
 *
 * **What is proven here and what is not.** The file authority is exercised for
 * real — every statement of the device flow runs against actual files. The
 * Postgres authority's *statements* are asserted against a fake tag: that the
 * exchange is a guarded `UPDATE … WHERE state='approved'` whose zero-row answer
 * is `expired_token`, that revocation drops the subject predicate only for an
 * admin, and that a database without `agent.schema_migrations` version 1 is
 * refused rather than queried. Whether those statements do what they say
 * against a real server is P5's contract lane (`tests/agent-link/pg-contract.test.ts`),
 * which runs them against `postgres:16.15-alpine` in CI — this file cannot and
 * does not claim to have proven that.
 *
 * ## Windows
 *
 * `loadCredentials` refuses on `win32` outright (`security.ts:51`, in the same
 * condition as the uid and mode-bit checks), because the file authority's
 * security argument *is* POSIX ownership and permissions. So on Windows:
 *
 *  - `ready()` refuses, which is the documented behaviour (LINK-PROTOCOL §7) —
 *    asserted below on every platform, in opposite directions;
 *  - `verify()` cannot be called, so the tests that go through it are skipped
 *    with the reason printed once;
 *  - everything else — minting, approving, exchanging, revoking, the quota, the
 *    single-use guarantee — runs on every platform, and the issued record is
 *    checked against the **unmodified** `authenticate()` by parsing the file
 *    this authority just wrote.
 *
 * Linux and macOS skip nothing, and CI runs on Linux.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const WINDOWS = process.platform === "win32";
if (WINDOWS)
  console.warn(
    "\n[agent-link authority] tests that call verify()/ready()-on-a-good-directory are SKIPPED on win32:\n" +
      "  src/lib/agent-access/security.ts:51 refuses the credential file on win32 explicitly (it also reads\n" +
      "  process.getuid()), so the file authority is unavailable there by design. Nothing is skipped on\n" +
      "  Linux or macOS, and CI runs them.\n"
  );

process.env.ZENITH_SECRET_KEY ??= Buffer.alloc(32, 9).toString("base64");
process.env.ZENITH_AGENT_CONTROL = "1";

const directory = mkdtempSync(join(tmpdir(), "zenith-agent-link-"));
if (!WINDOWS) chmodSync(directory, 0o700);
const CREDENTIALS = join(directory, "access.credentials.json");
process.env.ZENITH_AGENT_CREDENTIAL_FILE = CREDENTIALS;
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const { fileCredentialAuthority } = await import("../src/lib/agent-access/authority/file");
const { PgCredentialAuthority } = await import("../src/lib/agent-access/authority/pg");
const { authenticate, parseCredentials, AgentError } = await import("../src/lib/agent-access/security");
const { hashDeviceCode, hashUserCode, mintDeviceCode, mintUserCode, normalizeUserCode } = await import(
  "../src/lib/agent-access/link/protocol"
);

const authority = fileCredentialAuthority();

/** One link request, started. Returns what the terminal would be holding. */
async function start(overrides: Record<string, unknown> = {}) {
  const userCode = normalizeUserCode(mintUserCode())!;
  const deviceCode = mintDeviceCode();
  const now = Date.now();
  await authority.startLink({
    userCodeHash: hashUserCode(userCode),
    deviceCodeHash: hashDeviceCode(deviceCode),
    clientName: "Claude Code",
    clientVersion: "2.1.4",
    label: "laptop",
    requestedScopes: ["read", "plan", "write"],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    ...overrides,
  });
  return { userCode, deviceCode, userCodeHash: hashUserCode(userCode) };
}

const approval = (userCodeHash: string, overrides: Record<string, unknown> = {}) => ({
  userCodeHash,
  subject: "member_1",
  workspaceId: "ws_1",
  projectIds: ["prj_a", "prj_b"],
  scopes: ["read", "plan", "write"] as ("read" | "plan" | "write")[],
  days: 30,
  ...overrides,
});

/** The credential file as it stands, through the unmodified parser. */
const onDisk = () => parseCredentials(JSON.parse(readFileSync(CREDENTIALS, "utf8")));

beforeEach(() => {
  rmSync(CREDENTIALS, { force: true });
  rmSync(join(directory, "link-codes.json"), { force: true });
});

describe("file credential authority", () => {
  it("refuses on Windows and accepts a private POSIX directory", async () => {
    if (WINDOWS) await expect(authority.ready()).rejects.toMatchObject({ status: 503 });
    else await expect(authority.ready()).resolves.toBeUndefined();
  });

  it.skipIf(WINDOWS)("refuses a directory other people can read", async () => {
    chmodSync(directory, 0o755);
    try {
      await expect(authority.ready()).rejects.toMatchObject({ code: "policy_unavailable", status: 503 });
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  it("carries one request from start to a working credential and back to revoked", async () => {
    const { userCode, deviceCode, userCodeHash } = await start();

    const looked = await authority.linkByUserCode(userCodeHash);
    expect(looked).toMatchObject({ state: "pending", clientName: "Claude Code", label: "laptop" });
    expect(looked?.requestedScopes).toEqual(["read", "plan", "write"]);
    // The store holds only the hash, so it cannot echo the display form.
    expect(looked?.userCode).toBe("");
    expect(JSON.stringify(looked)).not.toContain(userCode);

    // Polling before approval never leaks anything and never issues anything.
    expect(await authority.exchange(hashDeviceCode(deviceCode))).toMatchObject({
      status: "authorization_pending",
    });

    const issued = await authority.approveLink(approval(userCodeHash, { label: "tarun-laptop" }));
    expect(issued.credentialId).toMatch(/^cred_/);
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const exchanged = await authority.exchange(hashDeviceCode(deviceCode));
    expect(exchanged.status).toBe("issued");
    if (exchanged.status !== "issued") throw new Error("unreachable");
    expect(exchanged.token).toMatch(/^za_[A-Za-z0-9_-]{43}$/);
    expect(exchanged.credential).toMatchObject({
      id: issued.credentialId,
      workspaceId: "ws_1",
      subject: "member_1",
      label: "tarun-laptop",
      clientName: "Claude Code",
    });
    expect(exchanged.credential.projectIds).toEqual(["prj_a", "prj_b"]);

    // The record this authority wrote is one the UNMODIFIED authenticate()
    // accepts — parsed straight off disk, not through any helper of its own.
    const records = onDisk();
    expect(authenticate(`Bearer ${exchanged.token}`, records).id).toBe(issued.credentialId);
    // …and neither the token nor the codes are anywhere in the file.
    const raw = readFileSync(CREDENTIALS, "utf8");
    expect(raw).not.toContain(exchanged.token);
    expect(raw).not.toContain(deviceCode);
    expect(readFileSync(join(directory, "link-codes.json"), "utf8")).not.toContain(deviceCode);

    if (!WINDOWS) expect((await authority.verify(`Bearer ${exchanged.token}`)).id).toBe(issued.credentialId);

    const listed = await authority.listCredentials("member_1", "ws_1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: issued.credentialId, tokenHash: "" });

    expect(await authority.revokeCredential("member_1", "ws_1", issued.credentialId)).toBe(true);
    // Revoked, not vanished: the screen can still show it.
    expect(await authority.listCredentials("member_1", "ws_1")).toHaveLength(1);
    expect(() => authenticate(`Bearer ${exchanged.token}`, onDisk())).toThrow(/invalid, expired, or revoked/);
    if (!WINDOWS)
      await expect(authority.verify(`Bearer ${exchanged.token}`)).rejects.toMatchObject({ status: 401 });
    // Revoking twice is not an error the screen has to explain; it is a no-op.
    expect(await authority.revokeCredential("member_1", "ws_1", issued.credentialId)).toBe(false);
  });

  it("exchanges exactly once, and tells the second poller the code expired", async () => {
    const { deviceCode, userCodeHash } = await start();
    await authority.approveLink(approval(userCodeHash));
    const first = await authority.exchange(hashDeviceCode(deviceCode));
    expect(first.status).toBe("issued");
    const second = await authority.exchange(hashDeviceCode(deviceCode));
    expect(second).toEqual({ status: "expired" });
    // Exactly one credential exists, whatever the terminal did.
    expect(onDisk()).toHaveLength(1);
  });

  it("issues one credential when the browser approves twice", async () => {
    const { userCodeHash } = await start();
    await authority.approveLink(approval(userCodeHash));
    await expect(authority.approveLink(approval(userCodeHash))).rejects.toMatchObject({
      code: "link_code_consumed",
      status: 409,
    });
    expect(onDisk()).toHaveLength(1);
  });

  it("refuses a lifetime beyond the 30-day ceiling", async () => {
    const { userCodeHash } = await start();
    for (const days of [31, 0, 365, 7.5])
      await expect(authority.approveLink(approval(userCodeHash, { days }))).rejects.toMatchObject({
        code: "invalid_request",
      });
    expect(await authority.linkByUserCode(userCodeHash)).toMatchObject({ state: "pending" });
  });

  it("treats an elapsed code as expired, whoever asks", async () => {
    const past = Date.now() - 1000;
    const { deviceCode, userCodeHash } = await start({
      createdAt: new Date(past - 600_000).toISOString(),
      expiresAt: new Date(past).toISOString(),
    });
    expect(await authority.linkByUserCode(userCodeHash)).toMatchObject({ state: "expired" });
    expect(await authority.exchange(hashDeviceCode(deviceCode))).toEqual({ status: "expired" });
    await expect(authority.approveLink(approval(userCodeHash))).rejects.toMatchObject({
      code: "link_code_not_found",
      status: 404,
    });
  });

  it("answers an unknown device code without saying it is unknown twice", async () => {
    expect(await authority.exchange(hashDeviceCode(mintDeviceCode()))).toEqual({ status: "unknown" });
  });

  it("retires a code that is looked up over and over", async () => {
    const { userCodeHash } = await start();
    for (let attempt = 0; attempt < 5; attempt++)
      expect(await authority.linkByUserCode(userCodeHash)).toMatchObject({ state: "pending" });
    expect(await authority.linkByUserCode(userCodeHash)).toMatchObject({ state: "expired" });
  });

  it("stops one subject at twenty live credentials in one workspace", async () => {
    for (let issued = 0; issued < 20; issued++) {
      const { userCodeHash } = await start();
      await authority.approveLink(approval(userCodeHash));
    }
    const { userCodeHash } = await start();
    await expect(authority.approveLink(approval(userCodeHash))).rejects.toMatchObject({
      code: "credential_quota",
      status: 429,
    });
    // A different workspace is a different budget.
    await expect(
      authority.approveLink(approval(userCodeHash, { workspaceId: "ws_2" }))
    ).resolves.toMatchObject({ credentialId: expect.stringMatching(/^cred_/) });
  });

  it("denies without issuing anything", async () => {
    const { deviceCode, userCodeHash } = await start();
    expect(await authority.denyLink(userCodeHash, "member_1")).toBe(true);
    expect(await authority.exchange(hashDeviceCode(deviceCode))).toEqual({ status: "denied" });
    expect(await authority.denyLink(userCodeHash, "member_1")).toBe(false);
    expect(() => onDisk()).toThrow(); // no credential file was ever written
  });

  it("moves elapsed codes to expired, bounded, and destroys their secrets", async () => {
    const past = Date.now() - 1000;
    await start({ createdAt: new Date(past - 600_000).toISOString(), expiresAt: new Date(past).toISOString() });
    await start();
    expect(await authority.expireLinks()).toBe(1);
    expect(await authority.expireLinks()).toBe(0);
  });
});

describe("the credential file the operator utility writes", () => {
  it("still parses when it carries none of the new optional keys", () => {
    // Exactly the record shape `scripts/agent-credential.mjs` wrote before this
    // change: no revokedAt, no label, no clientName.
    const legacy = {
      version: 1,
      credentials: [
        {
          id: "4f9d0e2a-6b41-4c77-8f0d-2b7c19b4a501",
          tokenHash: "a".repeat(64),
          subject: "member_1",
          workspaceId: "ws_1",
          projectIds: ["prj_a"],
          scopes: ["read", "plan"],
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(CREDENTIALS, `${JSON.stringify(legacy, null, 2)}\n`);
    const parsed = onDisk();
    expect(parsed).toHaveLength(1);
    expect(parsed[0].revokedAt).toBeUndefined();
    expect(parsed[0].label).toBeUndefined();
  });

  it("refuses a revoked record at the door", () => {
    const now = Date.now();
    const record = {
      id: "cred_1",
      tokenHash: "b".repeat(64),
      subject: "member_1",
      workspaceId: "ws_1",
      projectIds: ["prj_a"],
      scopes: ["read"] as ("read" | "plan")[],
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    // The same token, the same clock, one field apart.
    const header = "Bearer za_" + "A".repeat(43);
    const withHash = { ...record, tokenHash: createHash("sha256").update(header.slice(7)).digest("hex") };
    expect(authenticate(header, [withHash]).id).toBe("cred_1");
    expect(() => authenticate(header, [{ ...withHash, revokedAt: new Date().toISOString() }])).toThrow(
      /invalid, expired, or revoked/
    );
    // And a malformed revokedAt is a file to repair, not a credential to trust.
    expect(() => parseCredentials({ version: 1, credentials: [{ ...withHash, revokedAt: "whenever" }] })).toThrow(
      AgentError
    );
    expect(() => parseCredentials({ version: 1, credentials: [{ ...withHash, label: "not a label!" }] })).toThrow(
      AgentError
    );
  });
});

/* ------------------------------ postgres shape ----------------------------- */

interface FakeCall {
  text: string;
  values: unknown[];
}

/**
 * Enough of postgres.js to assert the statements: a tagged template that
 * records what it was asked, returns whatever the handler says, and carries the
 * `count` a guarded `UPDATE … RETURNING` is judged by.
 */
function fakeSql(handler: (text: string, values: unknown[]) => unknown[]) {
  const calls: FakeCall[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ? ").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    const rows = handler(text, values);
    return Promise.resolve(Object.assign([...rows], { count: rows.length }));
  };
  (tag as unknown as { begin: (fn: (tx: unknown) => unknown) => unknown }).begin = (fn) => fn(tag);
  return { tag, calls };
}

const migrated = (text: string) => (text.includes("agent.schema_migrations") ? [{ version: 1 }] : []);

const credentialRow = (overrides: Record<string, unknown> = {}) => ({
  id: "cred_pg",
  token_hash: "c".repeat(64),
  subject: "member_1",
  workspace_id: "ws_1",
  project_ids: ["prj_a"],
  environment_ids: null,
  app_ids: null,
  scopes: ["read", "plan"],
  label: "laptop",
  client_name: "Codex",
  client_version: null,
  issued_at: new Date(Date.now() - 1000).toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  revoked_at: null,
  last_used_at: null,
  ...overrides,
});

describe("postgres credential authority (statement shape; live behaviour is P5's lane)", () => {
  it("refuses every request until the migration is recorded", async () => {
    const { tag, calls } = fakeSql((text) => (text.includes("agent.schema_migrations") ? [] : []));
    const pg = new PgCredentialAuthority(() => tag as never);
    await expect(pg.ready()).rejects.toMatchObject({ code: "policy_unavailable", status: 503 });
    await expect(pg.ready()).rejects.toThrow(/0006_agent_link\.sql/);
    // Remembered, not re-probed: a database that is behind must not be asked
    // again on every request until the connection budget is gone.
    expect(calls.filter((call) => call.text.includes("schema_migrations"))).toHaveLength(1);
  });

  it("never reaches the database with an unparseable bearer", async () => {
    const { tag, calls } = fakeSql(migrated);
    const pg = new PgCredentialAuthority(() => tag as never);
    for (const header of [null, "Bearer nope", `Bearer za_${"a".repeat(42)}`])
      await expect(pg.verify(header)).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(calls).toHaveLength(0);
  });

  it("looks a credential up by digest and refuses a revoked or expired row", async () => {
    const token = `za_${"A".repeat(43)}`;
    const hash = createHash("sha256").update(token).digest("hex");
    for (const [row, ok] of [
      [credentialRow({ token_hash: hash }), true],
      [credentialRow({ token_hash: hash, revoked_at: new Date().toISOString() }), false],
      [credentialRow({ token_hash: hash, expires_at: new Date(Date.now() - 1).toISOString() }), false],
      [credentialRow({ token_hash: hash, issued_at: new Date(Date.now() + 60_000).toISOString() }), false],
    ] as const) {
      const { tag, calls } = fakeSql((text) => (text.includes("schema_migrations") ? [{ version: 1 }] : [row]));
      const pg = new PgCredentialAuthority(() => tag as never);
      if (ok) expect((await pg.verify(`Bearer ${token}`)).id).toBe("cred_pg");
      else await expect(pg.verify(`Bearer ${token}`)).rejects.toMatchObject({ status: 401 });
      // The digest is what travels, never the token.
      const lookup = calls.find((call) => call.text.includes("agent_credentials"))!;
      expect(lookup.values).toContain(hash);
      expect(JSON.stringify(lookup.values)).not.toContain(token);
    }
  });

  it("consumes an approved code with a guarded update and refuses a second poller", async () => {
    const seal = (await import("../src/lib/agent-access/link/protocol")).sealLinkSecret;
    const token = `za_${"B".repeat(43)}`;
    const userCodeHash = hashUserCode("AAAA2222");
    const row = {
      user_code_hash: userCodeHash,
      device_code_hash: "d".repeat(64),
      state: "approved",
      client_name: "Codex",
      client_version: null,
      label: null,
      requested_scopes: ["read"],
      created_at: new Date(Date.now() - 30_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      credential_id: "cred_pg",
      secret_ct: seal(userCodeHash, token),
      poll_count: 1,
      last_polled_at: new Date(Date.now() - 30_000).toISOString(),
      failed_lookups: 0,
    };
    let consumedAlready = false;
    const { tag, calls } = fakeSql((text) => {
      if (text.includes("schema_migrations")) return [{ version: 1 }];
      if (text.includes("set state = 'consumed'")) {
        if (consumedAlready) return []; // the guard matched zero rows
        consumedAlready = true;
        return [{ credential_id: row.credential_id, secret_ct: row.secret_ct }];
      }
      if (text.includes("agent_credentials")) return [credentialRow()];
      if (text.startsWith("update agent.agent_link_codes")) return [];
      return [row];
    });
    const pg = new PgCredentialAuthority(() => tag as never);
    const first = await pg.exchange("d".repeat(64));
    expect(first).toMatchObject({ status: "issued", token });
    const second = await pg.exchange("d".repeat(64));
    expect(second).toEqual({ status: "expired" });
    // The consuming statement destroys the stored copy in the same breath.
    const consume = calls.find((call) => call.text.includes("set state = 'consumed'"))!;
    expect(consume.text).toContain("secret_ct = null");
    expect(consume.text).toContain("state = 'approved'");
  });

  it("drops the subject predicate only for an admin", async () => {
    const { tag, calls } = fakeSql((text) =>
      text.includes("schema_migrations") ? [{ version: 1 }] : [{ id: "cred_pg" }]
    );
    const pg = new PgCredentialAuthority(() => tag as never);
    expect(await pg.revokeCredential("member_1", "ws_1", "cred_pg")).toBe(true);
    expect(calls.at(-1)!.text).toContain("subject =");
    expect(await pg.revokeCredential(null, "ws_1", "cred_pg")).toBe(true);
    expect(calls.at(-1)!.text).not.toContain("subject =");
    expect(calls.at(-1)!.text).toContain("revoked_at is null");
  });

  it("inserts the credential and moves the code inside one transaction", async () => {
    const userCodeHash = hashUserCode("BBBB3333");
    const { tag, calls } = fakeSql((text) => {
      if (text.includes("schema_migrations")) return [{ version: 1 }];
      if (text.includes("for update"))
        return [
          {
            user_code_hash: userCodeHash,
            state: "pending",
            client_name: "Codex",
            client_version: null,
            label: null,
            requested_scopes: ["read"],
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        ];
      if (text.includes("count(*)")) return [{ n: 0 }];
      if (text.includes("set state = 'approved'")) return [{ user_code_hash: userCodeHash }];
      return [];
    });
    const pg = new PgCredentialAuthority(() => tag as never);
    const issued = await pg.approveLink({
      userCodeHash,
      subject: "member_1",
      workspaceId: "ws_1",
      projectIds: ["prj_a"],
      scopes: ["read", "plan"],
      days: 30,
    });
    expect(issued.credentialId).toMatch(/^cred_/);
    const insert = calls.find((call) => call.text.includes("insert into agent.agent_credentials"))!;
    const move = calls.find((call) => call.text.includes("set state = 'approved'"))!;
    expect(calls.indexOf(insert)).toBeLessThan(calls.indexOf(move));
    expect(move.text).toContain("state = 'pending'");
    // sha256 hex, and no bearer anywhere in the parameters.
    expect(insert.values.some((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))).toBe(true);
    expect(JSON.stringify(insert.values)).not.toMatch(/za_[A-Za-z0-9_-]{43}/);
  });

  it("refuses the twenty-first live credential without inserting one", async () => {
    const userCodeHash = hashUserCode("CCCC4444");
    const { tag, calls } = fakeSql((text) => {
      if (text.includes("schema_migrations")) return [{ version: 1 }];
      if (text.includes("for update"))
        return [
          {
            user_code_hash: userCodeHash,
            state: "pending",
            client_name: "Codex",
            client_version: null,
            label: null,
            requested_scopes: ["read"],
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        ];
      if (text.includes("count(*)")) return [{ n: 20 }];
      return [];
    });
    const pg = new PgCredentialAuthority(() => tag as never);
    await expect(
      pg.approveLink({
        userCodeHash,
        subject: "member_1",
        workspaceId: "ws_1",
        projectIds: ["prj_a"],
        scopes: ["read"],
        days: 1,
      })
    ).rejects.toMatchObject({ code: "credential_quota", status: 429 });
    expect(calls.some((call) => call.text.includes("insert into agent.agent_credentials"))).toBe(false);
  });
});
