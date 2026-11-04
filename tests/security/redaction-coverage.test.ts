/**
 * Redaction coverage report (WS-SEC): what each existing redactor removes and
 * what it does not.
 *
 * Architecture invariant 3 says redaction is defense in depth, not the
 * mechanism ("references only" is). This file keeps that honest by MEASURING
 * the defence: a canary of every shape is planted in every position a real
 * value shows up in, through each redactor that exists today, and the survivors
 * are compared with a documented `KNOWN_GAPS` map (see
 * `tests/_support/security/coverage.ts`). The assertion moves in both
 * directions: a new leak is a regression, a fixed leak must be deleted from
 * the map so the residual-risk column of docs/platform/THREAT-MODEL.md never
 * overstates the exposure.
 *
 * Three redactors are measured:
 *   A. `redact()` in src/lib/agent-access/security.ts — the MCP v1/v2 result filter.
 *   B. `redactOutput()` in src/lib/tofu/redact.ts — tofu output, diagnostics and plan-view text.
 *   C. the audit `redact()` in src/lib/actions/core.ts (module-private; measured
 *      through the real `runAction` -> `appendAuditAsync` -> `readAudit` path).
 *      core.ts is not modified by this workstream.
 *
 * None of these gaps is, by itself, a vulnerability: the primary control is that
 * secret VALUES never enter the records these filters see. They ARE the reason
 * a value that strays (a provider error echoing a connection string, a pasted
 * compose file, a webhook URL) leaks.
 */
import { describe, expect, it } from "vitest";
import { redact as mcpRedact } from "@/lib/agent-access/security";
import { redactOutput } from "@/lib/tofu/redact";
import { tempDataDir } from "../_support/data-dir";
import { measureCoverage, expectCoverage, type CanaryShape, type CoverageContext, type CoverageMap } from "../_support/security";

tempDataDir("zenith-sec-redact-", { fast: true });

const ALL: CanaryShape[] = ["password", "aws-access-key-id", "aws-secret-access-key", "aws-session-token", "jwt", "pem-private-key", "zenith-agent-token", "github-token", "slack-token", "hex-key"];
/**
 * Shapes that are valid inside URL userinfo. A 40-character base64 AWS secret
 * key may contain `/` or `+`, which an RFC 3986 userinfo cannot hold unencoded,
 * so whether a URL pattern matches it is an accident of the value; it is left
 * out of the userinfo positions rather than measured as a coin flip.
 */
const PASSWORDISH: CanaryShape[] = ["password", "hex-key", "zenith-agent-token"];
const SINGLE_LINE = ALL.filter((s) => s !== "pem-private-key");

/** The positions a stray secret actually turns up in. */
const contexts: Record<string, CoverageContext> = {
  "key: value": { build: (s) => ({ value: s }) },
  "key: password": { build: (s) => ({ password: s }) },
  "key: token": { build: (s) => ({ accessToken: s }) },
  "key: neutral": { build: (s) => ({ note: s }) },
  "key: connectionUri": { build: (s) => ({ connectionUri: `postgres://app:${s}@db.internal:5432/app` }), shapes: PASSWORDISH },
  "free text": { build: (s) => `error: connection failed, the credential was ${s} for user app`, shapes: SINGLE_LINE },
  "KEY=value": { build: (s) => `AWS_SECRET_ACCESS_KEY=${s}`, shapes: SINGLE_LINE },
  "https userinfo": { build: (s) => `https://app:${s}@db.internal/`, shapes: PASSWORDISH },
  "postgres userinfo": { build: (s) => `postgres://app:${s}@db.internal:5432/app`, shapes: PASSWORDISH },
  "bearer header": { build: (s) => `Authorization: Bearer ${s}`, shapes: SINGLE_LINE },
  "url query": { build: (s) => `https://h.example/cb?token=${encodeURIComponent(s)}`, shapes: SINGLE_LINE },
  "json string": { build: (s) => JSON.stringify({ detail: s }) },
  "env pair, secret-ish name": { build: (s) => [{ env: [{ key: "DB_PASSWORD", value: s }] }] },
  "env pair, neutral name": { build: (s) => [{ env: [{ key: "DATABASE_URL", value: s }] }] },
  "object key": { build: (s) => ({ [s]: 1 }), shapes: SINGLE_LINE },
  "Error object": { build: (s) => new Error(`boom ${s}`), shapes: SINGLE_LINE },
  "base64 in neutral key": { build: (s) => ({ note: Buffer.from(s).toString("base64") }) },
};

const print = process.env.ZENITH_SEC_PRINT_COVERAGE === "1";
const report = (name: string, r: Awaited<ReturnType<typeof measureCoverage>>) => {
  if (print) console.info(`\n=== ${name} ===\n${r.table()}\nKNOWN_GAPS_JSON<${name}>${JSON.stringify(r.leaks)}`);
};

/* ---------------------------------- A: MCP ---------------------------------- */

/**
 * Positions where `redact()` (the MCP result filter) lets a planted secret
 * through. `key: value/password/token` and the `env pair, secret-ish name` are
 * covered because it masks by KEY NAME; `Bearer`, `za_…`, `https://user:pw@`
 * and `sk-…` are covered by pattern. Everything else relies on the secret not
 * being in the data at all.
 */
const MCP_KNOWN_GAPS: CoverageMap = {
  "key: neutral": ["aws-access-key-id", "aws-secret-access-key", "aws-session-token", "github-token", "hex-key", "jwt", "password", "pem-private-key", "slack-token"],
  "key: connectionUri": ["hex-key", "password"],
  "free text": ["aws-access-key-id", "aws-secret-access-key", "aws-session-token", "github-token", "hex-key", "jwt", "password", "slack-token"],
  "KEY=value": ["aws-access-key-id", "aws-secret-access-key", "aws-session-token", "github-token", "hex-key", "jwt", "password", "slack-token"],
  "postgres userinfo": ["hex-key", "password"],
  "url query": ["aws-access-key-id", "aws-secret-access-key", "aws-session-token", "github-token", "hex-key", "jwt", "password", "slack-token"],
  "json string": ["aws-access-key-id", "aws-secret-access-key", "aws-session-token", "github-token", "hex-key", "jwt", "password", "pem-private-key", "slack-token"],
  "object key": SINGLE_LINE,
  "base64 in neutral key": ALL,
};

describe("A. MCP result redaction (src/lib/agent-access/security.ts redact)", async () => {
  const r = await measureCoverage({ contexts, redact: mcpRedact });
  report("MCP redact()", r);

  it("removes secrets by key name and by the four patterns it knows, and misses the rest — exactly as documented", () => {
    expectCoverage(r.leaks, MCP_KNOWN_GAPS, "MCP redact() (security.ts)");
  });

  it("what it DOES cover stays covered: key-name masking and its own token patterns", () => {
    for (const [position, shape] of [
      ["key: value", "password"],
      ["key: password", "hex-key"],
      ["key: token", "jwt"],
      ["env pair, secret-ish name", "password"],
      ["bearer header", "zenith-agent-token"],
      ["https userinfo", "password"],
    ] as const) {
      expect(r.covered[position], `${position} must cover ${shape}`).toContain(shape);
    }
  });
});

/* -------------------------------- B: tofu text ------------------------------- */

const TOFU_KNOWN_GAPS: CoverageMap = {
  "free text": ["aws-secret-access-key", "aws-session-token", "hex-key", "password", "zenith-agent-token"],
  "json string": ["aws-secret-access-key", "aws-session-token", "hex-key", "password", "zenith-agent-token"],
};

describe("B. OpenTofu output, diagnostic and plan-view text (src/lib/tofu/redact.ts redactOutput)", async () => {
  const textOnly = Object.fromEntries(
    Object.entries(contexts)
      .filter(([, c]) => typeof c.build("x".repeat(12)) === "string")
      .map(([k, c]) => [k, c])
  );
  const r = await measureCoverage({ contexts: textOnly, redact: (v) => redactOutput(String(v)) });
  report("tofu redactOutput()", r);

  it("removes credential-shaped tokens and assignments, and misses bare secrets — exactly as documented", () => {
    expectCoverage(r.leaks, TOFU_KNOWN_GAPS, "tofu redactOutput() (src/lib/tofu/redact.ts)");
  });

  it("exact-value redaction removes a session secret wherever it appears, in any shape (the runner's own credentials)", () => {
    for (const shape of ALL) {
      const secret = `${shape}-session-${"z".repeat(12)}`;
      const out = redactOutput(`prefix ${secret} suffix ${secret}`, [secret]);
      expect(out, shape).not.toContain(secret);
    }
  });
});

/* ------------------------------- C: audit redact ------------------------------ */

const AUDIT_KNOWN_GAPS: CoverageMap = {
  "key: value": ALL,
  "key: neutral": ALL,
  "key: connectionUri": PASSWORDISH,
  "free text": SINGLE_LINE,
  "KEY=value": SINGLE_LINE,
  "https userinfo": PASSWORDISH,
  "postgres userinfo": PASSWORDISH,
  "bearer header": SINGLE_LINE,
  "url query": SINGLE_LINE,
  "json string": ALL,
  "env pair, neutral name": ALL,
  "object key": SINGLE_LINE,
  "base64 in neutral key": ALL,
};

describe("C. audit-log redaction (src/lib/actions/core.ts redact, through runAction)", async () => {
  const { defineAction, runAction } = await import("@/lib/actions/core");
  const { resetDb, readAudit } = await import("@/lib/db/store");
  const { z } = await import("zod");

  defineAction({
    id: "sec.auditProbe",
    title: "Security audit probe (test only)",
    category: "system",
    risk: "low",
    requiredRole: "viewer",
    mutates: true,
    input: z.any(),
    plan: () => ({ summary: "probe", details: [], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false }),
    execute: () => ({ ok: true, summary: "probe" }),
  });
  defineAction({
    id: "sec.auditThrow",
    title: "Security audit throw probe (test only)",
    category: "system",
    risk: "low",
    requiredRole: "viewer",
    mutates: true,
    input: z.object({ message: z.string() }),
    plan: () => ({ summary: "probe", details: [], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false }),
    execute: (_ctx, input) => {
      throw new Error(input.message);
    },
  });

  const ws = "ws-redact-01";
  const ctx = { workspaceId: ws, actor: { type: "user" as const, id: "u-redact-01", name: "Redactor" } };
  resetDb({
    workspaces: [{ id: ws, name: "Redact", slug: "redact", createdAt: "2026-09-01T00:00:00.000Z" }],
    members: [{ id: "u-redact-01", workspaceId: ws, name: "Redactor", email: "r@zenith.test", role: "admin" }],
  });

  /** Run the probe action with `value` as its whole input and return what the audit log kept. */
  let serial = 0;
  async function audited(value: unknown): Promise<unknown> {
    const marker = `probe-${++serial}`;
    await runAction("sec.auditProbe", { ...ctx, projectId: undefined }, { marker, payload: value }, { mode: "execute" });
    const row = readAudit({ workspaceId: ws, actionId: "sec.auditProbe" }).find((e) => (e.input as { marker?: string })?.marker === marker);
    if (!row) throw new Error("the audit row for the probe was not written");
    return (row.input as { payload: unknown }).payload;
  }

  const r = await measureCoverage({ contexts, redact: audited });
  report("audit redact()", r);

  it("masks by field name and by the { key, value } rule, and misses the rest — exactly as documented", () => {
    expectCoverage(r.leaks, AUDIT_KNOWN_GAPS, "audit redact() (core.ts)");
  });

  it("a secret-named field is masked: the documented contract for secretValue, password, token, apiKey", async () => {
    for (const field of ["secretValue", "password", "token", "apiKey", "api_key", "accessKey", "credential"]) {
      const out = (await audited({ [field]: "definitely-a-secret-value-1234" })) as Record<string, unknown>;
      expect(out[field], field).toBe("•••");
    }
  });

  it("the { key, value } rule masks a secret-named variable's value and only that one", async () => {
    const out = (await audited([
      { key: "DB_PASSWORD", value: "pw-value-123456" },
      { key: "LOG_LEVEL", value: "debug" },
    ])) as { key: string; value: string }[];
    expect(out[0].value).toBe("•••");
    expect(out[1].value).toBe("debug");
  });

  it("CHARACTERIZATION: a failed action's error text is written to the audit row verbatim, secrets included", async () => {
    const secret = "pw-echoed-by-a-provider-7788";
    await runAction("sec.auditThrow", ctx, { message: `connect failed: postgres://app:${secret}@db/app` }, { mode: "execute" });
    const row = readAudit({ workspaceId: ws, actionId: "sec.auditThrow" })[0];
    // This is the gap: `audit()` redacts the INPUT by key name and never touches `error` or `summary`.
    // When the audit path starts scrubbing error text, this test fails — delete it and the matching threat-model row.
    expect(JSON.stringify(row), "audit.error is not redacted today").toContain(secret);
  });

  it("an integration-originated action records only the receipt, never the input (the MCP write path)", async () => {
    const secret = "integration-input-secret-99";
    await runAction("sec.auditProbe", { ...ctx, integration: { operationId: "op_1", clientId: "client-1", proposalDigest: "d".repeat(64) } }, { password: secret, free: secret }, { mode: "execute" });
    const rows = readAudit({ workspaceId: ws, actionId: "sec.auditProbe" });
    const newest = rows[0];
    expect(JSON.stringify(newest.input)).not.toContain(secret);
    expect(newest.input).toMatchObject({ inputStoredInReceipt: true });
  });
});
