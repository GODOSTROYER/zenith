import { describe, expect, it } from "vitest";
import { TofuEnvError, buildChildEnv, validateExtraEnv } from "@/lib/tofu/env";
import { runProcess } from "@/lib/tofu/process";
import { redactExact, redactOutput, secretValuesOf } from "@/lib/tofu/redact";

const node = process.execPath;
const baseEnv = () => ({ ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) });
const run = (script: string, over: Partial<Parameters<typeof runProcess>[0]> = {}) =>
  runProcess({ file: node, args: ["-e", script], cwd: process.cwd(), env: baseEnv(), timeoutMs: 20_000, maxOutputBytes: 64 * 1024, ...over });

describe("buildChildEnv: allowlist", () => {
  const input = { homeDir: "/run/home", tmpDir: "/run/tmp", cliConfigFile: "/run/tofu.rc", pluginCacheDir: "/cache" };

  it("contains only the allowlisted names on POSIX", () => {
    const env = buildChildEnv({ ...input, platform: "linux", hostEnv: { ZENITH_CANARY: "x", DATABASE_URL: "postgres://u:p@h/db" } });
    expect(Object.keys(env).sort()).toEqual(["CHECKPOINT_DISABLE", "HOME", "PATH", "TF_CLI_CONFIG_FILE", "TF_INPUT", "TF_IN_AUTOMATION", "TF_PLUGIN_CACHE_DIR", "TMPDIR"]);
    expect(env).toMatchObject({ TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1", TF_PLUGIN_CACHE_DIR: "/cache", HOME: "/run/home", PATH: "/usr/local/bin:/usr/bin:/bin" });
    expect(env.TF_CLI_ARGS).toBeUndefined();
  });

  it("adds only Windows essentials on Windows, with private profile directories", () => {
    const env = buildChildEnv({ ...input, platform: "win32", hostEnv: { SystemRoot: "C:\\Windows", USERNAME: "someone", SECRET: "s" } });
    expect(Object.keys(env).sort()).toEqual(["APPDATA", "CHECKPOINT_DISABLE", "HOME", "LOCALAPPDATA", "PATH", "SystemRoot", "TEMP", "TF_CLI_CONFIG_FILE", "TF_INPUT", "TF_IN_AUTOMATION", "TF_PLUGIN_CACHE_DIR", "TMP", "TMPDIR", "USERPROFILE"]);
    expect(env.USERPROFILE).toBe("/run/home");
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows");
  });

  it("includes brokered session credentials and operator extras", () => {
    const env = buildChildEnv({
      ...input,
      platform: "linux",
      sessionEnv: { AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE1", AWS_SECRET_ACCESS_KEY: "s3cr3t-value-123", AWS_SESSION_TOKEN: "tok-123456", AWS_REGION: "ap-south-1" },
      extraEnv: { HTTPS_PROXY: "http://proxy.internal:3128" },
    });
    expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE1", AWS_REGION: "ap-south-1", HTTPS_PROXY: "http://proxy.internal:3128" });
  });

  it("refuses a session or extras that try to override runner-owned or dangerous names", () => {
    for (const name of ["PATH", "HOME", "TF_CLI_ARGS", "TF_CLI_ARGS_plan", "TF_LOG", "TF_LOG_PATH", "TF_VAR_x", "TF_REATTACH_PROVIDERS", "TF_DATA_DIR", "TF_PLUGIN_CACHE_DIR", "TOFU_CLI_ARGS", "ZENITH_DATABASE_URL", "path", "SystemRoot", "CHECKPOINT_DISABLE"]) {
      expect(() => buildChildEnv({ ...input, sessionEnv: { [name]: "x" } }), name).toThrow(TofuEnvError);
      expect(() => buildChildEnv({ ...input, extraEnv: { [name]: "x" } }), name).toThrow(TofuEnvError);
    }
    expect(() => validateExtraEnv({ "BAD NAME": "x" }, "Session")).toThrow(/valid identifier/);
    expect(() => validateExtraEnv({ OK: "a\0b" }, "Session")).toThrow(/NUL/);
  });

  it("a canary variable in the host environment never reaches a real child process", async () => {
    process.env.ZENITH_TEST_CANARY = "canary-must-not-leak-1234";
    process.env.DATABASE_URL = "postgres://canary:canary-db-pw@db/zenith";
    try {
      const env = buildChildEnv({ ...input, homeDir: process.cwd(), tmpDir: process.cwd(), pluginCacheDir: process.cwd(), cliConfigFile: process.cwd() });
      const res = await run("console.log(JSON.stringify(process.env))", { env: { ...baseEnv(), ...env } });
      const seen = JSON.parse(res.output.trim()) as Record<string, string>;
      expect(JSON.stringify(seen)).not.toContain("canary-must-not-leak-1234");
      expect(JSON.stringify(seen)).not.toContain("canary-db-pw");
      expect(Object.keys(seen).some((k) => k.startsWith("ZENITH_"))).toBe(false);
      expect(seen.TF_IN_AUTOMATION).toBe("1");
      expect(seen.TF_INPUT).toBe("0");
      expect(seen.CHECKPOINT_DISABLE).toBe("1");
      expect(seen.TF_CLI_ARGS).toBeUndefined();
    } finally {
      delete process.env.ZENITH_TEST_CANARY;
      delete process.env.DATABASE_URL;
    }
  });
});

describe("runProcess", () => {
  it("captures combined output and the exit code without a shell", async () => {
    const res = await run('console.log("out"); console.error("err"); process.exit(3)');
    expect(res.exitCode).toBe(3);
    expect(res.output).toContain("out");
    expect(res.output).toContain("err");
    expect(res.truncated).toBe(false);
    expect(res.timedOut).toBe(false);
    // shell metacharacters in args are just characters
    const arg = "a; echo INJECTED && b | c";
    const echoed = await runProcess({ file: node, args: ["-e", "console.log(process.argv[1])", arg], cwd: process.cwd(), env: baseEnv(), timeoutMs: 20_000, maxOutputBytes: 4096 });
    expect(echoed.output.trim()).toBe(arg);
  });

  it("truncates output beyond the cap, keeping head and tail, and flags it", async () => {
    const res = await run('process.stdout.write("HEAD-MARK-" + "x".repeat(200000) + "-TAIL-MARK")', { maxOutputBytes: 4096 });
    expect(res.truncated).toBe(true);
    expect(res.output.length).toBeLessThan(6000);
    expect(res.output.startsWith("HEAD-MARK-")).toBe(true);
    expect(res.output.endsWith("-TAIL-MARK")).toBe(true);
    expect(res.output).toMatch(/bytes of output truncated/);
    expect(res.exitCode).toBe(0);
  });

  it("does not flag output that exactly fits", async () => {
    const res = await run('process.stdout.write("y".repeat(1000))', { maxOutputBytes: 4096 });
    expect(res.truncated).toBe(false);
    expect(res.output).toHaveLength(1000);
  });

  it("kills a process that outlives the timeout", async () => {
    const t0 = Date.now();
    const res = await run("setTimeout(() => {}, 60000)", { timeoutMs: 800, graceMs: 500 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(res.output).toMatch(/timed out after 800 ms/);
  });

  it("kills the whole tree: a grandchild holding the pipes open does not hang the runner", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
      setTimeout(() => {}, 60000);
    `;
    const t0 = Date.now();
    const res = await run(script, { timeoutMs: 800, graceMs: 500 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("stops on an AbortSignal, and refuses to start when already aborted", async () => {
    const ac = new AbortController();
    const p = run("setTimeout(() => {}, 60000)", { signal: ac.signal, graceMs: 500 });
    setTimeout(() => ac.abort(), 300);
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.output).toMatch(/aborted/);

    const pre = new AbortController();
    pre.abort();
    const skipped = await run('console.log("should not run")', { signal: pre.signal });
    expect(skipped.aborted).toBe(true);
    expect(skipped.output).toBe("");
  });

  it("captures structured stdout separately, out of the displayable output, and flags overflow", async () => {
    const ok = await run('process.stdout.write(JSON.stringify({ secret: "RAW-VALUE-IN-JSON" })); console.error("warn")', { captureStdoutBytes: 1024 });
    expect(ok.stdout).toContain("RAW-VALUE-IN-JSON");
    expect(ok.output).not.toContain("RAW-VALUE-IN-JSON");
    expect(ok.output).toContain("warn");
    expect(ok.stdoutOverflow).toBe(false);
    const big = await run('process.stdout.write("z".repeat(5000))', { captureStdoutBytes: 1024 });
    expect(big.stdoutOverflow).toBe(true);
  });

  it("applies the redactor to displayable output", async () => {
    const res = await run('console.log("token is SECRET-ABCDEF")', { redact: (t) => redactExact(t, ["SECRET-ABCDEF"]) });
    expect(res.output).not.toContain("SECRET-ABCDEF");
    expect(res.output).toContain("[REDACTED]");
  });

  it("rejects when the binary cannot be started", async () => {
    await expect(runProcess({ file: "definitely-not-a-binary-zenith", args: [], cwd: process.cwd(), env: baseEnv(), timeoutMs: 5000, maxOutputBytes: 4096 })).rejects.toThrow();
  });
});

describe("redaction", () => {
  it("removes exact secret values wherever they appear, longest first", () => {
    const out = redactExact("a SECRETSECRET1 b SECRETSECRET1-extra c", ["SECRETSECRET1", "SECRETSECRET1-extra"]);
    expect(out).not.toContain("SECRETSECRET1");
    expect(redactExact("short abc", ["abc"])).toBe("short abc"); // too short to be a safe exact match
  });

  it("removes credential-shaped strings", () => {
    const text = [
      "key AKIAABCDEFGHIJKLMNOP and ASIAABCDEFGHIJKLMNOP",
      "Authorization: Bearer abcdef1234567890abcdef",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "url postgres://admin:hunter22pw@db.internal:5432/app",
      'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
      "password: correct-horse-battery",
      '{"client_secret": "abc123def456"}',
      "AWS_SESSION_TOKEN=FwoGZXIvYXdzEXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34\n-----END RSA PRIVATE KEY-----",
      "gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n");
    const out = redactOutput(text);
    for (const leaked of ["AKIAABCDEFGHIJKLMNOP", "ASIAABCDEFGHIJKLMNOP", "abcdef1234567890abcdef", "eyJhbGciOiJIUzI1NiJ9", "hunter22pw", "wJalrXUtnFEMI", "correct-horse-battery", "abc123def456", "FwoGZXIvYXdzEXAMPLE", "MIIBOgIBAAJBAKj34", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]) {
      expect(out, leaked).not.toContain(leaked);
    }
  });

  it("leaves ordinary tofu output readable", () => {
    const line = "aws_ecs_service.web: Modifying... [id=arn:aws:ecs:ap-south-1:111122223333:service/c/web]";
    expect(redactOutput(line)).toBe(line);
    expect(redactOutput("Plan: 2 to add, 1 to change, 0 to destroy.")).toBe("Plan: 2 to add, 1 to change, 0 to destroy.");
  });

  it("derives exact-redaction values only from secret-looking env entries", () => {
    const vals = secretValuesOf({ AWS_ACCESS_KEY_ID: "AKIAX", AWS_SECRET_ACCESS_KEY: "sekrit-value", AWS_SESSION_TOKEN: "session-token-v", AWS_REGION: "ap-south-1", TF_INPUT: "0" });
    expect(vals).toEqual(expect.arrayContaining(["sekrit-value", "session-token-v", "AKIAX"]));
    expect(vals).not.toContain("ap-south-1");
  });
});
