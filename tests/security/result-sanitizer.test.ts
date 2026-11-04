/**
 * PROD-MACH-05: the model-visible result sanitizer. Credential-shaped fixtures
 * are assembled at run time so no source line looks like a real key.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { setTimeout as setRealTimeout, clearTimeout as clearRealTimeout } from "node:timers";
import { buildEnvelope, buildErrorEnvelope } from "@/lib/agent-access/v3/envelope";
import { detectCredentialShapes, isSecretMemberName, redactionNote, sanitizeForModel, sanitizeText, SANITIZER_NOTE } from "@/lib/security/result-sanitizer";

const keyId = (): string => "AK" + "IA" + "Q".repeat(16);
const jwt = (): string => ["eyJ" + "a".repeat(12), "eyJ" + "b".repeat(12), "c".repeat(16)].join(".");
const pem = (): string => ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ") + "\nMIIB" + "x".repeat(60) + "\n" + ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const ghToken = (): string => "gh" + "p_" + "z".repeat(36);
const tool = { name: "zenith_get_operation", schemaVersion: 1 };

const adversarialChild = `
import { sanitizeForModel, sanitizeText } from './src/lib/security/result-sanitizer.ts';
const name = process.argv[1];
const canary = 'private-fixture-value';
let input;
switch (name) {
  case 'ordinary-limit': input = 'a'.repeat(2_000_100) + canary; break;
  case 'repeated-secret-word': input = 'token'.repeat(400_000); break;
  case 'unterminated-quote': input = 'token="' + 'a'.repeat(1_800_000) + ' db_password=' + canary; break;
  case 'long-secret-assignment': input = 'token'.repeat(360_000) + '=' + canary; break;
  case 'dotted-scheme': input = 'a.'.repeat(1_000_000); break;
  default: process.exit(2);
}
const result = name === 'ordinary-limit' || name === 'long-secret-assignment'
  ? sanitizeForModel(input) : sanitizeText(input);
const output = 'value' in result ? result.value : result.text;
process.stdout.write(JSON.stringify({
  name, applied: result.report.applied, limited: result.report.scanLimited,
  assignment: result.report.kinds.includes('secret-assignment'),
  url: result.report.kinds.includes('url-password'),
  tail: output.endsWith('[REDACTED:unscanned-tail]'),
  canaryAbsent: !output.includes(canary), completeness: result.report.completeness,
}));
`;

async function runAdversarialChild(name: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; overflow: boolean; launchFailed: boolean; stdout: string }> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--max-old-space-size=256", "--import", "tsx", "--input-type=module", "--eval", adversarialChild, name], {
      cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let timedOut = false;
    let overflow = false;
    let launchFailed = false;
    let escalation: ReturnType<typeof setRealTimeout> | undefined;
    const deadline = setRealTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setRealTimeout(() => child.kill("SIGKILL"), 2_000);
    }, 20_000);
    child.stdout.on("data", (part: Buffer) => {
      if (overflow) return;
      if (stdout.length + part.length > 4096) {
        overflow = true;
        child.kill("SIGKILL");
      } else stdout += part.toString("utf8");
    });
    // Child diagnostics and input values never enter assertion output.
    child.stderr.resume();
    child.on("error", () => { launchFailed = true; });
    child.on("close", (code, signal) => {
      clearRealTimeout(deadline);
      if (escalation) clearRealTimeout(escalation);
      resolve({ code, signal, timedOut, overflow, launchFailed, stdout });
    });
  });
}

describe("value rules", () => {
  it("replaces credential shapes with explicit kind markers and reports them", () => {
    const input = { log: `deploy used ${keyId()} then ${jwt()} then ${ghToken()}\n${pem()}`, url: "postgres://admin:hunter22pw@db.internal/app" };
    const { value, report } = sanitizeForModel(input);
    const text = JSON.stringify(value);
    for (const leaked of [keyId(), jwt(), ghToken(), "MIIB", "hunter22pw"]) expect(text).not.toContain(leaked);
    for (const kind of ["aws-access-key-id", "jwt", "github-token", "private-key", "url-password"]) {
      expect(text).toContain(`[REDACTED:${kind}]`);
      expect(report.kinds).toContain(kind);
    }
    expect(report.redactions).toBeGreaterThanOrEqual(5);
    expect(report.applied).toBe(true);
  });

  it("never claims completeness, even when it changed nothing", () => {
    const { value, report } = sanitizeForModel({ name: "web", replicas: 2 });
    expect(value).toEqual({ name: "web", replicas: 2 });
    expect(report.redactions).toBe(0);
    expect(report.completeness).toBe("best_effort");
    expect(redactionNote(report)).toBeUndefined();
    expect(SANITIZER_NOTE).toMatch(/best-effort/);
    expect(SANITIZER_NOTE).toMatch(/can remain/);
  });

  it("an unrecognised secret shape is NOT claimed to be caught", () => {
    const opaque = "plainwordsecretthatnopatternmatches";
    const { value } = sanitizeForModel({ note: `the value is ${opaque}` });
    expect(JSON.stringify(value)).toContain(opaque);
  });

  it("removes name = value assignments but leaves references and benign values", () => {
    const { text: value } = sanitizeText("db_password = s3cr3tvalue99 and secretRef: vault:API_KEY and token_count = 12 and api_key = (sensitive value)");
    expect(value).toContain("db_password = [REDACTED:secret-assignment]");
    expect(value).not.toContain("s3cr3tvalue99");
    expect(value).toContain("vault:API_KEY");
    expect(value).toContain("token_count = 12");
    expect(value).toContain("(sensitive value)");
  });

  it("retains assignment substring names, original quotes, whitespace and minimum value length", () => {
    const input = `_password\u00a0=\n'abcdef' 123secret="ghijkl" .passwordPolicy: mnopqr "api-key"\u00a0:\n"stuvwx" secretRef='vault:KEY' token=short api_key=<sensitive>`;
    const { text, report } = sanitizeText(input);
    expect(text).toBe(`_password\u00a0=\n'[REDACTED:secret-assignment]' 123secret="[REDACTED:secret-assignment]" .passwordPolicy: [REDACTED:secret-assignment] "api-key"\u00a0:\n"[REDACTED:secret-assignment]" secretRef='vault:KEY' token=short api_key=<sensitive>`);
    expect(report.redactions).toBe(4);
    expect(report.kinds).toEqual(["secret-assignment"]);
  });

  it("finds inner secret assignments after benign heads and unterminated quoted values", () => {
    for (const input of ["note: password = secretvalue", "label = api_key = abcdefgh", 'token="unfinished db_password=longvalue']) {
      const { text, report } = sanitizeText(input);
      expect(text).toContain("[REDACTED:secret-assignment]");
      expect(text).not.toMatch(/secretvalue|abcdefgh|longvalue/);
      expect(report.redactions).toBe(1);
    }
  });

  it("preserves URL scheme boundaries and exact heads while replacing colon-bearing passwords", () => {
    for (const prefix of [".https", "123.https", "a+b.c-d", "'https", '"HTTPS']) {
      const { text, report } = sanitizeText(`${prefix}://user:first:second@host/path`);
      expect(text).toBe(`${prefix}://user:[REDACTED:url-password]@host/path`);
      expect(report.redactions).toBe(1);
      expect(report.kinds).toEqual(["url-password"]);
    }
    for (const input of ["_https://user:pass@host", "123https://user:pass@host", "https://:pass@host", "https://user:@host", "https://user:pa/ss@host"]) {
      expect(sanitizeText(input).text).toBe(input);
    }
  });

  it("finds a later valid URL after rejected outer userinfo", () => {
    const { text, report } = sanitizeText("outer://first:bad/https://user:pass@host");
    expect(text).toBe("outer://first:bad/https://user:[REDACTED:url-password]@host");
    expect(report.redactions).toBe(1);
  });

  it("redacts plugin tokens alongside existing Zenith tokens without shortening the suffix requirement", () => {
    for (const prefix of ["z" + "rt_", "z" + "a_", "z" + "p_"]) {
      const long = prefix + "q".repeat(16);
      const short = prefix + "q".repeat(15);
      const { text, report } = sanitizeText(long);
      expect(text).toBe("[REDACTED:zenith-token]");
      expect(report.kinds).toEqual(["zenith-token"]);
      expect(sanitizeText(short).text).toBe(short);
    }
  });
});

describe("bounded string scans in an independent process", () => {
  it.each([
    ["ordinary-limit", true, false, true],
    ["repeated-secret-word", false, false, false],
    ["unterminated-quote", false, true, false],
    ["long-secret-assignment", false, true, false],
    ["dotted-scheme", false, false, false],
  ] as const)("finishes %s before a real child deadline", async (name, limited, assignment, tail) => {
    const child = await runAdversarialChild(name);
    expect({ ...child, stdout: undefined }).toEqual({ code: 0, signal: null, timedOut: false, overflow: false, launchFailed: false, stdout: undefined });
    expect(JSON.parse(child.stdout)).toEqual({ name, applied: true, limited, assignment, url: false, tail, canaryAbsent: true, completeness: "best_effort" });
  }, 30_000);
});

describe("member rules", () => {
  it("replaces every string under a secret-named member, keeps references and non-secret names", () => {
    const { value, report } = sanitizeForModel({
      password: "pw-123456",
      credentials: { accessKeyId: "id-ish-value", nested: ["a-b-c-d-e-f"] },
      clientSecret: "vault:CLIENT_SECRET",
      tokenCount: 5,
      maxTokens: 1000,
      nextToken: "page-2",
      hasPassword: true,
      secretName: "db-pass",
      accessToken: "tok-abcdefgh",
    });
    expect(value).toEqual({
      password: "[REDACTED:secret-member]",
      credentials: { accessKeyId: "[REDACTED:secret-member]", nested: ["[REDACTED:secret-member]"] },
      clientSecret: "vault:CLIENT_SECRET",
      tokenCount: 5,
      maxTokens: 1000,
      nextToken: "page-2",
      hasPassword: true,
      secretName: "db-pass",
      accessToken: "[REDACTED:secret-member]",
    });
    expect(report.kinds).toContain("secret-member");
    expect(report.paths).toContain("credentials.nested[0]");
  });

  it("decides secret-ness by suffix, not substring", () => {
    for (const k of ["password", "dbPassword", "x-api-key", "client_secret", "authorization", "Set-Cookie", "sessionToken"]) expect(isSecretMemberName(k)).toBe(true);
    for (const k of ["tokenCount", "maxTokens", "secretName", "secretRef", "passwordPolicy", "isSecret", "hasToken", "nextToken"]) expect(isSecretMemberName(k)).toBe(false);
  });

  it("scrubs a secret used as a member NAME and keeps members distinct", () => {
    const { value } = sanitizeForModel({ [keyId()]: "a", [`${keyId()} `]: "b" });
    const keys = Object.keys(value as Record<string, unknown>);
    expect(keys.join()).not.toContain(keyId());
    expect(new Set(keys).size).toBe(2);
  });
});

describe("exact values and limits", () => {
  it("removes known secrets wherever they appear, including keys", () => {
    const secret = "known-" + "s".repeat(20);
    const { value, report } = sanitizeForModel({ [`k-${secret}`]: `prefix ${secret} suffix`, list: [secret] }, { knownSecrets: [secret, "short"] });
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(report.kinds).toContain("known-secret");
  });

  it("fails closed beyond depth, node and string limits, and says so", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { n: deep };
    const d = sanitizeForModel(deep);
    expect(JSON.stringify(d.value)).toContain("[REDACTED:unscanned]");
    expect(d.report.scanLimited).toBe(true);

    const big = "a".repeat(2_000_100) + keyId();
    const s = sanitizeForModel(big);
    expect(s.value).not.toContain(keyId());
    expect(s.value as string).toMatch(/\[REDACTED:unscanned-tail\]$/);
    expect(s.report.scanLimited).toBe(true);
  });

  it("handles cycles, errors and binary without throwing or leaking", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(JSON.stringify(sanitizeForModel(cyc).value)).toContain("[Circular]");
    const err = sanitizeForModel(new Error(`failed with ${keyId()}`)).value as { message: string };
    expect(err.message).not.toContain(keyId());
    expect(sanitizeForModel({ blob: new Uint8Array([1, 2, 3]) }).value).toEqual({ blob: "[REDACTED:binary]" });
  });

  it("detectCredentialShapes names high-confidence kinds only and never returns text", () => {
    expect(detectCredentialShapes({ a: `x ${keyId()}` })).toEqual(["aws-access-key-id"]);
    expect(detectCredentialShapes({ password: "something-long-enough", note: "hello" })).toEqual([]);
    expect(JSON.stringify(detectCredentialShapes({ a: pem() }))).not.toContain("MIIB");
  });
});

describe("MCP v3 envelope integration", () => {
  it("scrubs data, untrusted data, notes and errors, and says so without claiming completeness", () => {
    const envelope = buildEnvelope(tool, {
      data: { id: "op_1", token: "literal-token-value" },
      untrusted: { log: `saw ${keyId()}` },
      notes: [`note ${ghToken()}`],
    });
    const text = JSON.stringify(envelope);
    for (const leaked of ["literal-token-value", keyId(), ghToken()]) expect(text).not.toContain(leaked);
    expect(text).toContain("[REDACTED:");
    const note = envelope.notes.find((n) => n.includes("replaced by [REDACTED"));
    expect(note).toBeTruthy();
    expect(note).toContain("best-effort");

    const err = buildErrorEnvelope(tool, { code: "failed", message: `bad ${jwt()}`, details: { password: "hunter22pw" }, retryable: false });
    expect(JSON.stringify(err)).not.toMatch(/hunter22pw|eyJa{12}/);
    expect(err.notes.some((n) => n.includes("best-effort"))).toBe(true);
  });

  it("adds no redaction note when nothing was replaced", () => {
    const envelope = buildEnvelope(tool, { data: { id: "op_1", status: "succeeded" } });
    expect(envelope.notes).toEqual([]);
  });
});
