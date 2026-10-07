/**
 * Threat class: build-to-deploy credential exfiltration (PROD-OPS-08).
 *
 * Attacker model: the author of the repository being built (a Dockerfile, a build script, an OpenTofu configuration, a
 * dependency's postinstall) who wants the deploy role, the control plane's own secrets, instance metadata or the
 * brokered cloud session. The defences are structural: what environment a child process receives, what identity and
 * network a provider build is admitted with, what a local recipe container may mount, and what source layout may reach
 * a build at all.
 *
 * Driven through the exported environment builder, the isolation admission, the container argv builder and the source
 * validators. All secret values are generated at runtime; nothing here resembles a real key at rest.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildChildEnv, validateExtraEnv, type SessionEnvProvider } from "@/lib/tofu/env";
import { BUILD_ISOLATION_PROFILES, BuildIsolationError, assertBuildIsolation, boundedTimeoutSec, contextDirOf, normalizeContextDir, type ObservedBuildIsolation } from "@/lib/execution/build-isolation";
import { dockerRunArgs } from "@/lib/hosted/build/runner-docker";

const secret = (label: string): string => `${label}-${randomBytes(18).toString("hex")}`;

/* ---------------------------------- child process environment ---------------------------------- */

describe("the environment handed to a build/plan child process", () => {
  const hostSecrets: Record<string, string> = {
    AWS_ACCESS_KEY_ID: secret("host-akid"), AWS_SECRET_ACCESS_KEY: secret("host-sak"), AWS_SESSION_TOKEN: secret("host-st"),
    GITHUB_TOKEN: secret("gh"), NPM_TOKEN: secret("npm"), DATABASE_URL: `postgres://u:${secret("pw")}@db.internal/x`,
    ZENITH_SECRET_KEY: secret("zsk"), ZENITH_CONTROL_SIGNING_JWK: secret("jwk"), CRON_SECRET: secret("cron"), SUPABASE_SERVICE_ROLE_KEY: secret("srk"),
    ANTHROPIC_API_KEY: secret("llm"), GOOGLE_APPLICATION_CREDENTIALS: "/secrets/gcp.json", KUBECONFIG: "/secrets/kube", SSH_AUTH_SOCK: "/tmp/agent.sock",
    HTTP_PROXY: "http://operator-proxy.internal:3128", LD_PRELOAD: "/tmp/evil.so", NODE_OPTIONS: "--require /tmp/evil.js", BASH_ENV: "/tmp/evil.sh",
    PATH: "/usr/local/bin:/usr/bin", HOME: "/root", SystemRoot: "C:\\Windows",
  };
  const dirs = { homeDir: "/tmp/run/home", tmpDir: "/tmp/run/tmp", cliConfigFile: "/tmp/run/cli.tfrc", pluginCacheDir: "/tmp/run/plugins" };
  const session = { AWS_ACCESS_KEY_ID: secret("session-akid"), AWS_SECRET_ACCESS_KEY: secret("session-sak"), AWS_SESSION_TOKEN: secret("session-st"), AWS_REGION: "us-east-1" };

  it("is built from scratch: no host variable reaches the child, only the brokered session and the fixed run directories", () => {
    const env = buildChildEnv({ ...dirs, sessionEnv: session, sessionProvider: "aws", platform: "linux", hostEnv: hostSecrets });
    const values = new Set(Object.values(env));
    for (const [name, value] of Object.entries(hostSecrets)) {
      expect(values.has(value), `${name} leaked into the child`).toBe(false);
    }
    for (const name of Object.keys(env)) {
      expect(["PATH", "HOME", "TMPDIR", "TF_IN_AUTOMATION", "TF_INPUT", "CHECKPOINT_DISABLE", "TF_CLI_CONFIG_FILE", "TF_PLUGIN_CACHE_DIR", ...Object.keys(session)], name).toContain(name);
    }
    expect(env.HOME).toBe(dirs.homeDir);
    expect(env.PATH).not.toContain("/tmp");
  });

  it("the brokered session is the ONLY credential, and a build of another provider cannot carry this provider's names", () => {
    const aws = buildChildEnv({ ...dirs, sessionEnv: session, sessionProvider: "aws", platform: "linux", hostEnv: {} });
    expect(aws.AWS_SECRET_ACCESS_KEY).toBe(session.AWS_SECRET_ACCESS_KEY);
    const wrongProviderNames: [SessionEnvProvider, Record<string, string>][] = [
      ["gcp", { AWS_SECRET_ACCESS_KEY: "x" }], ["aws", { GOOGLE_OAUTH_ACCESS_TOKEN: "x" }], ["azure", { AWS_ACCESS_KEY_ID: "x" }], ["kubernetes", { AWS_ACCESS_KEY_ID: "x" }],
    ];
    for (const [provider, env] of wrongProviderNames) {
      expect(() => validateExtraEnv(env, "Session", provider), `${provider} with ${Object.keys(env)}`).toThrow();
    }
  });

  it("refuses every variable that changes what a process loads or where it phones home, in both the session and the runner position", () => {
    const dangerous = [
      "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_ENV", "ENV", "PYTHONSTARTUP", "PYTHONPATH", "RUBYOPT", "PERL5OPT", "GIT_SSH_COMMAND",
      "GIT_ASKPASS", "PATH", "Path", "HOME", "TMPDIR", "TEMP", "SHELL", "IFS", "TF_CLI_ARGS", "TF_CLI_ARGS_apply", "TF_VAR_password", "TF_LOG", "TF_LOG_PATH", "TF_WORKSPACE",
      "TF_PLUGIN_CACHE_DIR", "TF_CLI_CONFIG_FILE", "TOFU_CLI_CONFIG_FILE", "OPENTOFU_ROOT", "ZENITH_SECRET_KEY", "ZENITH_DATA", "AWS_PROFILE", "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE", "AWS_ENDPOINT_URL", "AWS_CA_BUNDLE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN",
      "AWS_EC2_METADATA_SERVICE_ENDPOINT", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "http_proxy", "ALL_PROXY",
      "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT_OVERRIDE", "KUBECONFIG", "ARM_CLIENT_SECRET_FILE", "SSH_AUTH_SOCK",
    ];
    const accepted: string[] = [];
    for (const name of dangerous) {
      for (const label of ["Session", "Runner"] as const) {
        for (const provider of [undefined, "aws"] as const) {
          try { validateExtraEnv({ [name]: "x" }, label, provider); accepted.push(`${label}/${provider ?? "any"}: ${name}`); } catch { /* refused */ }
        }
      }
    }
    // Proxy variables are legitimately accepted in the operator's runner position only.
    const proxyOk = accepted.filter((a) => /^Runner\/.*: (HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)$/.test(a));
    expect(accepted.filter((a) => !proxyOk.includes(a))).toEqual([]);
  });

  it("refuses malformed names and values (smuggling a second variable, a NUL, a newline, an equals sign)", () => {
    for (const name of ["A=B", "A B", "", "1A", "A\n", "A\0", "A-B", "A.B", "é", "A;B", "A$(id)"]) {
      expect(() => validateExtraEnv({ [name]: "x" }, "Session", "aws"), JSON.stringify(name)).toThrow();
    }
    for (const value of ["a\0b"]) expect(() => validateExtraEnv({ AWS_REGION: value }, "Session", "aws")).toThrow();
    expect(() => validateExtraEnv({ AWS_REGION: 5 as unknown as string }, "Session", "aws")).toThrow();
  });

  it("runner-owned variables always win over anything the session or operator supplies", () => {
    const env = buildChildEnv({ ...dirs, sessionEnv: session, sessionProvider: "aws", extraEnv: { HTTPS_PROXY: "http://operator:3128" }, platform: "linux", hostEnv: {} });
    expect(env.TF_IN_AUTOMATION).toBe("1");
    expect(env.TF_INPUT).toBe("0");
    expect(env.CHECKPOINT_DISABLE).toBe("1");
    expect(env.TF_CLI_CONFIG_FILE).toBe(dirs.cliConfigFile);
    expect(env.TF_PLUGIN_CACHE_DIR).toBe(dirs.pluginCacheDir);
    expect(env.HOME).toBe(dirs.homeDir);
  });
});

/* ---------------------------------- provider build admission ---------------------------------- */

describe("build isolation admission (a build that could reach the deploy role or the network is refused)", () => {
  const good = (): ObservedBuildIsolation => ({
    profileId: BUILD_ISOLATION_PROFILES.aws.id,
    identity: { principal: "arn:aws:iam::123456789012:role/zenith-acme-build", dedicated: true, deployCredentials: "absent" },
    metadata: { exposes: "none", mechanism: "buildspec firewall" },
    network: { egress: "allowlisted", verifiedBy: "provider_read", allowlistDigest: "a".repeat(64), mechanism: "iptables" },
    dependencies: { downloads: "allowlisted" },
    filesystem: { sourceMount: "read_only" },
    resources: { timeoutSec: 1200, computeClass: "BUILD_GENERAL1_SMALL" },
  });
  const policy = { allowOpenEgress: false };

  it("admits the control observation", () => {
    expect(assertBuildIsolation("aws", good(), policy)).toEqual({ exceptions: [] });
  });

  it("refuses each single weakening, generated over every control the profile names", () => {
    const weaken: Record<string, (o: ObservedBuildIsolation) => void> = {
      "deploy credentials present": (o) => { o.identity.deployCredentials = "present"; },
      "deploy credentials unknown": (o) => { o.identity.deployCredentials = "unknown"; },
      "shared identity": (o) => { o.identity.dedicated = false; },
      "the deploy role as build principal": (o) => { o.identity.principal = "arn:aws:iam::123456789012:role/zenith-acme-deploy"; },
      "a human role as build principal": (o) => { o.identity.principal = "arn:aws:iam::123456789012:role/Administrator"; },
      "another account's build role shape": (o) => { o.identity.principal = "arn:aws:iam::12345678901:role/zenith-x-build"; },
      "metadata exposed": (o) => { o.metadata.exposes = "unknown"; },
      "unrestricted egress": (o) => { o.network.egress = "unrestricted"; },
      "allowlist without verification": (o) => { delete o.network.verifiedBy; },
      "allowlist without digest": (o) => { delete o.network.allowlistDigest; },
      "direct dependency downloads": (o) => { o.dependencies.downloads = "direct"; },
      "writable source mount": (o) => { o.filesystem.sourceMount = "read_write"; },
      "timeout above the profile": (o) => { o.resources.timeoutSec = 7200; },
      "zero timeout": (o) => { o.resources.timeoutSec = 0; },
      "fractional timeout": (o) => { o.resources.timeoutSec = 10.5; },
      "bigger compute class": (o) => { o.resources.computeClass = "BUILD_GENERAL1_2XLARGE"; },
      "another profile's observation": (o) => { o.profileId = BUILD_ISOLATION_PROFILES.gcp.id; },
    };
    const admitted: string[] = [];
    for (const [label, mutate] of Object.entries(weaken)) {
      const observed = good();
      mutate(observed);
      try { assertBuildIsolation("aws", observed, policy); admitted.push(label); } catch (error) { expect(error).toBeInstanceOf(BuildIsolationError); }
    }
    expect(admitted).toEqual([]);
  });

  it("an unknown or missing observation, and an unsupported provider, are refused (fail closed)", () => {
    for (const bad of [undefined, null, {}, { profileId: BUILD_ISOLATION_PROFILES.aws.id }]) {
      expect(() => assertBuildIsolation("aws", bad as never, policy)).toThrow(BuildIsolationError);
    }
    for (const provider of ["oci", "kubernetes", "", "AWS", "__proto__", "constructor"]) {
      expect(() => assertBuildIsolation(provider, good(), policy), provider).toThrow(BuildIsolationError);
    }
  });

  it("open egress is admitted only by an explicit operator exception and is always recorded", () => {
    const open = good();
    open.network = { egress: "unrestricted", mechanism: "none" };
    open.dependencies = { downloads: "direct" };
    expect(() => assertBuildIsolation("aws", open, policy)).toThrow(BuildIsolationError);
    expect(assertBuildIsolation("aws", open, { allowOpenEgress: true }).exceptions).toContain("open_egress");
  });

  it("context directories and timeouts cannot be used to reach outside the repository or run forever", () => {
    for (const dir of ["..", "../x", "a/../b", "/abs", "a//b", "a\\b", "./a", "a/./b", "a b", "a;b", "$(id)", "a\nb", "x".repeat(201), 5, {}, ["a"], "a/", "~root"]) {
      expect(() => normalizeContextDir(dir), JSON.stringify(dir)).toThrow(BuildIsolationError);
    }
    expect(normalizeContextDir("apps/web")).toBe("apps/web");
    expect(normalizeContextDir(undefined)).toBe(".");
    expect(() => contextDirOf({ source: { builder: "buildpacks" } }, "aws")).toThrow(BuildIsolationError);
    for (const t of [0, 59, 1801, 10 ** 9, -1, 90.5, Number.NaN]) expect(() => boundedTimeoutSec("aws", t), String(t)).toThrow(BuildIsolationError);
    expect(boundedTimeoutSec("aws", 600)).toBe(600);
  });
});

/* ---------------------------------- local recipe container ---------------------------------- */

describe("the local recipe container (hosted app builds)", () => {
  const args = dockerRunArgs({ memoryMb: 512, root: "/work/src", out: "/work/out", image: "zenith/recipe:1", name: "zr-1" });

  it("has no network, a read-only root, read-only source, and is bounded in memory, CPU and processes", () => {
    const joined = args.join(" ");
    expect(joined).toContain("--network none");
    expect(args).toContain("--read-only");
    expect(joined).toContain("--pids-limit");
    expect(joined).toContain("--memory 512m");
    expect(joined).toContain("--cpus 1");
    expect(args.filter((a) => a === "-v")).toHaveLength(2);
    expect(args.some((a) => a.startsWith("/work/src:") && a.endsWith(":ro"))).toBe(true);
  });

  it("never passes the host's environment, a privileged flag, the container socket or a host-namespace flag", () => {
    for (const flag of ["-e", "--env", "--env-file", "--privileged", "--cap-add", "--device", "--pid", "--ipc", "--uts", "--userns", "--security-opt", "--network=host", "--net", "--volumes-from"]) {
      expect(args, flag).not.toContain(flag);
    }
    expect(args.join(" ")).not.toMatch(/docker\.sock|\/var\/run|\/etc|\.ssh|\.aws|\/proc|\/sys/);
    // the only writable mount is the output directory
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts.filter((m) => !m.endsWith(":ro"))).toEqual([expect.stringMatching(/^\/work\/out:/)]);
  });

  it("a hostile directory name cannot add an option: arguments are separate argv entries, never a shell string", () => {
    const hostile = dockerRunArgs({ memoryMb: 256, root: "/w/a --privileged", out: "/w/o -v /:/host", image: "zenith/recipe:1", name: "zr-2" });
    expect(hostile).not.toContain("--privileged");
    expect(hostile).not.toContain("/:/host");
    expect(hostile.some((a) => a === "/w/a --privileged:/src:ro" || a.startsWith("/w/a --privileged:"))).toBe(true);
  });
});
