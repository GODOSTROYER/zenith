/**
 * The two isolated runners, against doubles.
 *
 * Neither has been run live from this repository, so what is tested is what can
 * honestly be tested without a provider account: the exact sequence of calls the
 * E2B runner makes (including that the sandbox is killed even when the build
 * fails), the exact `docker run` argument vector (the flags *are* the boundary),
 * and the availability answers that keep either from pretending it can run.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir, uuid } from "../_fixtures";

const DATA = isolatedDataDir("zenith-w2-runners-");
const FIXTURE = path.join(process.cwd(), "fixtures", "hosted", "minimal-app");
const TEMPLATE_ID = "zenith-recipe-v1";
const TEMPLATE_DIGEST = `sha256:${"a".repeat(64)}`;
/** A docker image ID, the shape `docker image inspect --format '{{.Id}}'` prints. */
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const ATTESTATION_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = "template-key-2026-09";
const NOT_EXPIRED = "2099-01-01T00:00:00Z";

/** Signs the real canonical payload; the runner's own code verifies it. */
const signAttestation = (fields: { templateId: string; digest: string; keyId: string; expiresAt: string }): string =>
  sign(
    null,
    Buffer.from(
      `zenith-e2b-template-attestation-v2\n${fields.templateId}\n${fields.digest}\n${fields.keyId}\n${fields.expiresAt}\n`
    ),
    privateKey
  ).toString("base64");

/** A complete, valid attestation, with any field overridden then re-signed. */
const attestationFor = (overrides: Partial<Record<"templateId" | "digest" | "keyId" | "expiresAt", string>> = {}) => {
  const fields = {
    templateId: process.env.ZENITH_E2B_TEMPLATE ?? "",
    digest: process.env.ZENITH_E2B_TEMPLATE_DIGEST ?? "",
    keyId: KEY_ID,
    expiresAt: NOT_EXPIRED,
    ...overrides,
  };
  return { ...fields, signature: signAttestation(fields) };
};

/** The four variables an E2B build needs, set together so no test half-configures. */
const configureE2b = (): void => {
  process.env.ZENITH_BUILD_RUNNER = "e2b";
  process.env.E2B_API_KEY = "e2b_test_key";
  process.env.ZENITH_E2B_TEMPLATE = TEMPLATE_ID;
  process.env.ZENITH_E2B_TEMPLATE_DIGEST = TEMPLATE_DIGEST;
  process.env.ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID = KEY_ID;
};

let build: typeof import("@/lib/hosted/build");
let source: typeof import("@/lib/hosted/source");
let contracts: typeof import("@/lib/hosted/contracts");

beforeAll(async () => {
  build = await import("@/lib/hosted/build");
  source = await import("@/lib/hosted/source");
  contracts = await import("@/lib/hosted/contracts");
});

beforeEach(() => {
  process.env.ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY = ATTESTATION_PUBLIC_KEY;
  process.env.ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID = KEY_ID;
});

afterEach(async () => {
  delete process.env.ZENITH_BUILD_RUNNER;
  delete process.env.E2B_API_KEY;
  delete process.env.ZENITH_E2B_TEMPLATE;
  delete process.env.ZENITH_E2B_TEMPLATE_DIGEST;
  delete process.env.ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY;
  delete process.env.ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID;
  delete process.env.ZENITH_RECIPE_IMAGE;
});

afterAll(() => removeDir(DATA));

const request = () => ({
  jobId: uuid(),
  appId: "app-alpha",
  source: source.validateSource({ kind: "directory", path: FIXTURE }),
  recipe: contracts.RECIPE_V1,
  limits: { timeoutMs: 60_000, maxLogBytes: 32_000, memoryMb: 512 },
});

/* ----------------------------- the E2B double ----------------------------- */

interface Call {
  name: string;
  detail?: string;
  /** whether the runner forwarded an AbortSignal with the call */
  signalled?: boolean;
}

interface FakeFile {
  path: string;
  data: string | ArrayBuffer;
}

interface FakeFileEntry {
  name: string;
  path: string;
  type?: string;
}

interface FakeCommandOptions {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
}

/** The options the runner asked the factory for. SEC-05's whole control lives here. */
type FactoryOpts = Parameters<import("@/lib/hosted/build").SandboxFactory>[0];

/**
 * A factory that hands back `sandbox` and keeps what it was asked for. Every
 * earlier test used `async () => sandbox`, which discarded `opts` — so nothing
 * proved the runner ever requested `allowInternetAccess: false`.
 */
function recordingFactory(sandbox: unknown) {
  const opts: FactoryOpts[] = [];
  const createSandbox: import("@/lib/hosted/build").SandboxFactory = async (given) => {
    opts.push(given);
    return sandbox as Awaited<ReturnType<import("@/lib/hosted/build").SandboxFactory>>;
  };
  return { createSandbox, opts };
}

function fakeSandbox(
  behaviour: {
    installExit?: number;
    workerExit?: number;
    result?: unknown;
    distFiles?: Record<string, string>;
    attestation?: unknown;
    resolvedTemplateId?: string;
    omitGetInfo?: boolean;
    /** the worker command never returns, so only an abort can end the build */
    hangWorker?: boolean;
    /** `kill()` never returns, so only the teardown timeout can end the request */
    hangKill?: boolean;
  } = {}
) {
  const calls: Call[] = [];
  const written = new Map<string, string | ArrayBuffer>();
  const dist = behaviour.distFiles ?? {
    "index.html": "<!doctype html><title>Minimal app</title>",
    "assets/index-abc.js": "console.log('minimal app ok')",
  };
  const sandbox = {
    sandboxId: "sbx-test-1",
    files: {
      async write(files: FakeFile[]) {
        calls.push({ name: "files.write", detail: String(files.length) });
        for (const file of files) written.set(file.path, file.data);
        return files.map((f) => ({ path: f.path }));
      },
      async read(target: string) {
        calls.push({ name: "files.read", detail: target });
        if (target === build.TEMPLATE_ATTESTATION)
          return new TextEncoder().encode(JSON.stringify(behaviour.attestation ?? attestationFor()));
        if (target.endsWith("result.json"))
          return new TextEncoder().encode(
            JSON.stringify(behaviour.result ?? { ok: true, outDir: build.SANDBOX_OUT, modules: 27, foreign: [] })
          );
        const relative = target.slice(build.SANDBOX_OUT.length + 1);
        const body = dist[relative];
        if (body === undefined) throw new Error(`no such file ${target}`);
        return new TextEncoder().encode(body);
      },
      async list(dir: string): Promise<FakeFileEntry[]> {
        calls.push({ name: "files.list", detail: dir });
        return Object.keys(dist).map((relative) => ({
          name: relative.split("/").pop() as string,
          path: `${build.SANDBOX_OUT}/${relative}`,
          type: "file",
        }));
      },
    },
    async getInfo() {
      return { templateId: behaviour.resolvedTemplateId ?? process.env.ZENITH_E2B_TEMPLATE ?? "" };
    },
    commands: {
      async run(cmd: string, opts?: FakeCommandOptions) {
        calls.push({ name: "commands.run", detail: cmd, signalled: opts?.signal !== undefined });
        opts?.onStdout?.(`running ${cmd.slice(0, 20)}\n`);
        const isToolchainCheck = cmd.startsWith("node -e");
        if (behaviour.hangWorker && !isToolchainCheck) return new Promise<never>(() => {});
        const exitCode = isToolchainCheck ? behaviour.installExit ?? 0 : behaviour.workerExit ?? 0;
        return { exitCode, stdout: "", stderr: "" };
      },
    },
    async kill() {
      calls.push({ name: "kill" });
      if (behaviour.hangKill) return new Promise<never>(() => {});
      return true;
    },
  };
  if (behaviour.omitGetInfo) delete (sandbox as { getInfo?: unknown }).getInfo;
  return { sandbox, calls, written };
}

describe("E2bRunner availability", () => {
  it("refuses when another runner is selected", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const availability = await new build.E2bRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("ZENITH_BUILD_RUNNER");
    expect(availability.fix).toContain("ZENITH_BUILD_RUNNER=e2b");
  });

  it("refuses when E2B_API_KEY is absent, naming the variable", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    const availability = await new build.E2bRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("E2B_API_KEY");
    expect(availability.fix).toContain("E2B_API_KEY");
  });

  it("is available with both the selection and the key", async () => {
    configureE2b();
    expect(await new build.E2bRunner().availability()).toEqual({ available: true });
  });

  it("refuses without an immutable template", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    const availability = await new build.E2bRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("ZENITH_E2B_TEMPLATE");
  });

  it("refuses without the template attestation digest", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    process.env.ZENITH_E2B_TEMPLATE = TEMPLATE_ID;
    const availability = await new build.E2bRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("ZENITH_E2B_TEMPLATE_DIGEST");
  });

  it("refuses without a trusted attestation public key", async () => {
    configureE2b();
    delete process.env.ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY;
    const availability = await new build.E2bRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY");
  });

  it("rejects template tags instead of treating them as immutable IDs", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    process.env.ZENITH_E2B_TEMPLATE = `${TEMPLATE_ID}:latest`;
    process.env.ZENITH_E2B_TEMPLATE_DIGEST = TEMPLATE_DIGEST;
    await expect(new build.E2bRunner().availability()).rejects.toThrow("bare E2B template ID");
  });

  it("refuses without a trusted attestation key id", async () => {
    configureE2b();
    delete process.env.ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID;
    const availability = await new build.E2bRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain(build.ATTESTATION_KEY_ID_ENV);
    expect(availability.fix).toContain("Rotating a key");
  });

  it("refuses a key id that is not a key id", async () => {
    for (const value of ["", "   ", "key with spaces", "key\nid", "a".repeat(65)])
      expect(build.attestationKeyId(value), `${JSON.stringify(value)} must not be accepted`).toBeUndefined();
    expect(build.attestationKeyId(" key-1 ")).toBe("key-1");
  });

  it("says its boundary is unverified live, and does not claim to measure the image", async () => {
    const boundary = new build.E2bRunner().boundary;
    expect(boundary).toContain("unverified live");
    expect(boundary).toContain("disposable");
    // The report's FIND-09: the old string read as image-digest pinning.
    expect(boundary).toContain("drift detection, not measurement");
    expect(boundary).toContain("never computed over the image");
  });

  it("refuses an SDK adapter that cannot report the provider-resolved template", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox({ omitGetInfo: true });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("resolved template ID");
    expect(calls.map((c) => c.name)).toEqual(["files.read", "kill"]);
  });
});

describe("E2bRunner call sequence", () => {
  it("creates, uploads, installs the platform toolchain, runs the worker, downloads and kills", async () => {
    configureE2b();
    const { sandbox, calls, written } = fakeSandbox();
    const { createSandbox, opts } = recordingFactory(sandbox);
    const runner = new build.E2bRunner({ createSandbox });
    const req = request();
    const result = await runner.run(req, new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.runner).toBe("e2b");

    // SEC-05. The sandbox is created with egress disabled and from the bare
    // immutable template ID — the only two arguments that are the boundary.
    // Asserted on the options the runner actually passed, because a refactor
    // that drops either one would otherwise break nothing in this suite.
    expect(opts).toHaveLength(1);
    expect(opts[0]).toEqual({
      apiKey: "e2b_test_key",
      timeoutMs: req.limits.timeoutMs,
      template: TEMPLATE_ID,
      allowInternetAccess: false,
    });
    expect(opts[0]?.allowInternetAccess).toBe(false);
    expect(opts[0]?.template).not.toContain(":");

    // Every command carries the caller's abort signal.
    for (const call of calls.filter((c) => c.name === "commands.run"))
      expect(call.signalled, `${call.detail} ran without an abort signal`).toBe(true);

    expect(calls.map((c) => c.name)).toEqual([
      "files.read",
      "files.write",
      "commands.run",
      "commands.run",
      "files.read",
      "files.list",
      "files.read",
      "files.read",
      "kill",
    ]);

    const [install, worker] = calls.filter((c) => c.name === "commands.run");
    expect(install?.detail).toContain("node -e");
    expect(install?.detail).not.toContain("npm install");
    expect(install?.detail).toContain(contracts.RECIPE_V1.vite);
    expect(install?.detail).toContain(contracts.RECIPE_V1.react);
    expect(worker?.detail).toContain("recipe-worker.mjs");

    // The worker and its config module travel with the source; nothing from the
    // submission decides what runs.
    expect(written.has(`${build.SANDBOX_ROOT}/recipe-worker.mjs`)).toBe(true);
    expect(written.has(`${build.SANDBOX_ROOT}/recipe-config.mjs`)).toBe(true);
    const job = JSON.parse(written.get(`${build.SANDBOX_ROOT}/job.json`) as string);
    expect(job.root).toBe(build.SANDBOX_SOURCE);
    expect(job.outDir).toBe(build.SANDBOX_OUT);
    expect(written.has(`${build.SANDBOX_SOURCE}/src/main.tsx`)).toBe(true);

    const outputDir = result.outputDir as string;
    try {
      expect(fs.readFileSync(path.join(outputDir, "index.html"), "utf8")).toContain("Minimal app");
      expect(fs.existsSync(path.join(outputDir, "assets", "index-abc.js"))).toBe(true);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("kills the sandbox when the install fails", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox({ installExit: 1 });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("pinned recipe toolchain");
    expect(calls.at(-1)?.name).toBe("kill");
  });

  it("refuses when E2B resolves a different template ID", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox({ resolvedTemplateId: "other-template" });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("different template ID");
    expect(calls.map((c) => c.name)).toEqual(["files.read", "kill"]);
  });

  it("refuses a template whose attestation digest is not the configured digest", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox({
      attestation: attestationFor({ digest: `sha256:${"b".repeat(64)}` }),
    });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("attestation digest");
    expect(calls.map((c) => c.name)).toEqual(["files.read", "kill"]);
  });

  it("refuses an attestation without a valid publisher signature", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox({
      attestation: { ...attestationFor(), signature: "not-a-signature" },
    });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("trusted publisher key");
    expect(calls.map((c) => c.name)).toEqual(["files.read", "kill"]);
  });

  it("refuses an attestation signed under a retired key id, even with a good signature", async () => {
    configureE2b();
    // Correctly signed by the same key, but naming a different key id: this is
    // what a rotation leaves behind, and what a replay from an old template is.
    const { sandbox, calls } = fakeSandbox({ attestation: attestationFor({ keyId: "template-key-2025-01" }) });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("template-key-2025-01");
    expect(result.error).toContain(KEY_ID);
    expect(calls.map((c) => c.name)).toEqual(["files.read", "kill"]);
  });

  it("refuses an expired attestation, however valid its signature", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox({ attestation: attestationFor({ expiresAt: "2020-01-01T00:00:00Z" }) });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("expired at 2020-01-01T00:00:00Z");
    expect(calls.map((c) => c.name)).toEqual(["files.read", "kill"]);
  });

  it("fails closed on an attestation with no expiry or an unreadable one", async () => {
    for (const expiresAt of [undefined, "", "soon", "2027-13-01T00:00:00Z", "2027-01-01T00:00:00+05:30"]) {
      configureE2b();
      const base = attestationFor();
      const attestation = { ...base, expiresAt } as Record<string, unknown>;
      if (expiresAt === undefined) delete attestation.expiresAt;
      const { sandbox, calls } = fakeSandbox({ attestation });
      const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
        request(),
        new AbortController().signal
      );
      expect(result.ok, `expiresAt=${String(expiresAt)} must be refused`).toBe(false);
      expect(result.error).toContain("expiry");
      expect(calls.map((c) => c.name)).toEqual(["files.read", "kill"]);
    }
  });

  it("names the variable when the operator's public key cannot be read", async () => {
    configureE2b();
    process.env.ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nnot base64\n-----END PUBLIC KEY-----\n";
    const { sandbox, calls } = fakeSandbox();
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    // A configuration error must not be reported as an attack (REVIEW-D FIND-16).
    expect(result.error).toContain("ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY");
    expect(result.error).not.toContain("trusted publisher key");
    // Refused before the attestation was even read.
    expect(calls.map((c) => c.name)).toEqual(["kill"]);
  });

  it("stops waiting on a cancelled build and kills the sandbox", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox({ hangWorker: true });
    const controller = new AbortController();
    const running = new build.E2bRunner({ createSandbox: async () => sandbox }).run(request(), controller.signal);
    // The worker command never returns; only the abort can end this.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cancelled");
    expect(calls.at(-1)?.name).toBe("kill");
  });

  it("does not wait forever for a sandbox that will not die", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox({ hangKill: true, result: { ok: false, error: "build failed" } });
    const started = Date.now();
    // The production bound is SANDBOX_KILL_TIMEOUT_MS; shortened here so the
    // test measures that the bound exists, not how long it is.
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox, killTimeoutMs: 50 }).run(
      request(),
      new AbortController().signal
    );
    // The build result still comes back rather than hanging on the `finally`.
    expect(result.ok).toBe(false);
    expect(calls.at(-1)?.name).toBe("kill");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(build.SANDBOX_KILL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("kills the sandbox when the worker throws", async () => {
    configureE2b();
    const { sandbox, calls } = fakeSandbox();
    sandbox.commands.run = async () => {
      throw new Error("sandbox went away");
    };
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sandbox went away");
    expect(calls.at(-1)?.name).toBe("kill");
  });

  it("refuses a build whose sandbox result says it failed", async () => {
    configureE2b();
    const { sandbox } = fakeSandbox({ result: { ok: false, error: "esbuild: Unexpected token" } });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unexpected token");
  });

  it("refuses output that has no index.html", async () => {
    configureE2b();
    const { sandbox } = fakeSandbox({ distFiles: { "assets/only.js": "x" } });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("index.html");
  });
});

/* ---------------------------- the docker double --------------------------- */

/** A `spawn` double: records the argv and answers with a scripted exit code. */
function fakeSpawn(script: (command: string, args: readonly string[]) => { code: number; stdout?: string }) {
  const seen: { command: string; args: string[] }[] = [];
  const spawn: import("@/lib/hosted/build").SpawnFn = (command, args) => {
    seen.push({ command, args: [...args] });
    const answer = script(command, args);
    const child = new EventEmitter() as import("node:child_process").ChildProcess;
    Object.assign(child, {
      pid: 4242,
      stdout: Readable.from([answer.stdout ?? ""]),
      stderr: Readable.from([""]),
      kill: () => true,
    });
    setImmediate(() => child.emit("close", answer.code));
    return child;
  };
  return { spawn, seen };
}

describe("DockerRunner image pinning", () => {
  it("accepts an image ID and a digest reference, and nothing else", () => {
    expect(build.resolveRecipeImage(IMAGE_DIGEST)).toEqual({ ok: true, image: IMAGE_DIGEST });
    expect(build.resolveRecipeImage(`zenith-recipe@${IMAGE_DIGEST}`)).toEqual({
      ok: true,
      image: `zenith-recipe@${IMAGE_DIGEST}`,
    });
    expect(build.resolveRecipeImage(`registry.example.com:5000/ns/zenith-recipe@${IMAGE_DIGEST}`).ok).toBe(true);
  });

  it("refuses the mutable tag the image used to be named by, and says why", () => {
    const refused = build.resolveRecipeImage("zenith-recipe:v1");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("is not a digest");
    expect(refused.reason).toContain("repointed");
    expect(refused.fix).toContain(build.RECIPE_IMAGE_ENV);
  });

  it("refuses latest, a short digest and a digest with uppercase hex", () => {
    for (const value of [
      "zenith-recipe:latest",
      "latest",
      `sha256:${"a".repeat(63)}`,
      `sha256:${"A".repeat(64)}`,
      `zenith-recipe@sha1:${"a".repeat(40)}`,
    ])
      expect(build.resolveRecipeImage(value).ok, `${value} must be refused`).toBe(false);
  });

  it("refuses an unset variable rather than falling back to a tag", () => {
    const refused = build.resolveRecipeImage(undefined);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain(build.RECIPE_IMAGE_ENV);
    expect(refused.fix).toContain("docker/recipe/Dockerfile");
  });
});

describe("DockerRunner availability", () => {
  it("refuses when another runner is selected", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    const availability = await new build.DockerRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.fix).toContain("ZENITH_BUILD_RUNNER=docker");
  });

  it("refuses before touching the daemon when the image is not pinned by digest", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    const { spawn, seen } = fakeSpawn(() => ({ code: 0 }));
    const availability = await new build.DockerRunner({ spawn, image: "zenith-recipe:v1" }).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("is not a digest");
    expect(seen, "a tag must be refused without asking the daemon anything").toEqual([]);
  });

  it("reports a daemon that does not answer, with the fix", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    process.env.ZENITH_RECIPE_IMAGE = IMAGE_DIGEST;
    const { spawn } = fakeSpawn(() => ({ code: 1 }));
    const availability = await new build.DockerRunner({ spawn }).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("docker info");
    expect(availability.fix).toContain("Start Docker");
  });

  it("reports a missing image by its digest, with the command that builds it", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    process.env.ZENITH_RECIPE_IMAGE = IMAGE_DIGEST;
    const { spawn, seen } = fakeSpawn((_c, args) => ({ code: args[0] === "info" ? 0 : 1 }));
    const availability = await new build.DockerRunner({ spawn }).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain(IMAGE_DIGEST);
    expect(availability.fix).toContain("docker/recipe/Dockerfile");
    expect(seen.map((s) => s.args[0])).toEqual(["info", "image"]);
    // The inspect must name the digest, not a tag that could resolve elsewhere.
    expect(seen[1]?.args).toEqual(["image", "inspect", IMAGE_DIGEST]);
  });

  it("is available when the daemon answers and the pinned image is present", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    process.env.ZENITH_RECIPE_IMAGE = IMAGE_DIGEST;
    const { spawn } = fakeSpawn(() => ({ code: 0 }));
    expect(await new build.DockerRunner({ spawn }).availability()).toEqual({ available: true });
  });
});

describe("DockerRunner argument vector", () => {
  it("carries the whole boundary in the flags", async () => {
    const args = await build.dockerRunArgs({
      memoryMb: 768,
      root: "/tmp/src-1",
      out: "/tmp/out-1",
      image: IMAGE_DIGEST,
    });
    expect(args).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--memory",
      "768m",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "-v",
      "/tmp/src-1:/src:ro",
      "-v",
      "/tmp/out-1:/out",
      IMAGE_DIGEST,
    ]);
  });

  it("mounts the source read-only and the output writable when it actually runs", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    process.env.ZENITH_RECIPE_IMAGE = IMAGE_DIGEST;
    const { spawn, seen } = fakeSpawn(() => ({ code: 0 }));
    const result = await new build.DockerRunner({ spawn }).run(request(), new AbortController().signal);

    const run = seen.find((s) => s.args[0] === "run");
    expect(run, "the runner must have issued a docker run").toBeTruthy();
    const argv = (run as { args: string[] }).args;
    expect(argv).toContain("--network");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv).toContain("--read-only");
    expect(argv.some((a) => a.endsWith(":/src:ro"))).toBe(true);
    expect(argv.some((a) => a.endsWith(":/out"))).toBe(true);
    expect(argv.at(-1)).toBe(IMAGE_DIGEST);

    // The double never wrote a result file, so the runner must say so rather
    // than claim a build it cannot see.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("without writing a result");
  });

  it("never starts a container when the image is a tag", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    process.env.ZENITH_RECIPE_IMAGE = "zenith-recipe:v1";
    const { spawn, seen } = fakeSpawn(() => ({ code: 0 }));
    const result = await new build.DockerRunner({ spawn }).run(request(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("is not a digest");
    expect(seen.some((s) => s.args[0] === "run")).toBe(false);
  });

  it("says its boundary is digest-pinned, the daemon's, and unproven here", async () => {
    expect(new build.DockerRunner().boundary).toContain("no network");
    expect(new build.DockerRunner().boundary).toContain("digest-pinned");
    expect(new build.DockerRunner().boundary).toContain("no container has been run from this repository");
  });
});
