/**
 * Doubles for the two collaborators W7 cannot get honest answers from yet: the
 * hosted runtime (W6) and, where a real Vite build would only make a test slow
 * without making it stronger, the build runner (W2).
 *
 * The runtime double is deliberately not a stub. `probeCandidate` reads the
 * artifact out of the real content-addressed store and passes only when
 * `index.html` is actually there, so "the probe passed" means the same thing
 * here as it will when W6 lands: bytes exist that a browser could be served.
 * The parts a local runtime cannot express yet (staging, activation, cleanup)
 * are recorded rather than performed, and the recorder is what the tests
 * assert against.
 *
 * Not a test file — vitest only collects `*.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Artifact,
  ArtifactStore,
  Availability,
  BindingReadback,
  BuildRequest,
  BuildResult,
  BuildRunner,
  CandidateProbeResult,
  HostedApp,
  HostedRuntime,
  LimitEnforcement,
  Release,
  RuntimeAppRef,
  RuntimeCandidateRef,
} from "@/lib/hosted/contracts";

/** Nothing the local runtime enforces itself is claimed here. */
const ENFORCEMENT: LimitEnforcement = {
  buildsPerApp: "enforced",
  buildsPilotWide: "enforced",
  buildTimeoutMs: "enforced",
  requestCpuMs: "not_enforced",
  outboundSubrequests: "not_enforced",
  bodyBytes: "enforced",
  requestsPerDay: "enforced",
  storageBytes: "enforced",
};

/** What the runtime double was asked to do, in order. */
export interface RuntimeRecorder {
  ensured: string[];
  staged: { appId: string; releaseId: string; digest: string }[];
  activated: { appId: string; releaseId: string; fence: number }[];
  cleaned: { appId: string; retain: string[] }[];
  probed: number;
}

export interface RuntimeDoubleOptions {
  /** The real store the default probe reads the candidate's bytes out of. */
  store: ArtifactStore;
  /** Replace the probe: return `ok: false` to prove a bad candidate never activates. */
  probe?(app: HostedApp, candidate: RuntimeCandidateRef): Promise<CandidateProbeResult> | CandidateProbeResult;
  /** Runs just before the default probe answers — the seam a fence race is injected through. */
  beforeProbe?(): void | Promise<void>;
  /** Runs just before a candidate is staged — the seam a mid-phase crash is injected through. */
  beforeStage?(): void | Promise<void>;
  /** Replace activation, e.g. to fail it. */
  activate?(app: HostedApp, release: Release, fence: number): Promise<void> | void;
  /** Make `ensureApp` refuse, so app creation records the reason. */
  ensureAppError?: Error;
}

/** A hosted runtime whose probe is real and whose bookkeeping is recorded. */
export function runtimeDouble(opts: RuntimeDoubleOptions): {
  runtime: HostedRuntime;
  recorder: RuntimeRecorder;
} {
  const recorder: RuntimeRecorder = { ensured: [], staged: [], activated: [], cleaned: [], probed: 0 };

  const defaultProbe = async (candidate: RuntimeCandidateRef): Promise<CandidateProbeResult> => {
    const digest = String(candidate.ref.artifactDigest ?? "");
    const files = digest ? await opts.store.list(digest) : [];
    const index = files.find((file) => file.path === "index.html");
    const checks = [
      {
        id: "index_fetch",
        ok: Boolean(index),
        detail: index
          ? `index.html is present in artifact ${digest.slice(0, 12)} (${index.bytes} bytes, ${index.contentType}).`
          : `artifact ${digest.slice(0, 12) || "(none)"} has no index.html, so nothing could be served.`,
      },
      {
        id: "schema_compat",
        ok: true,
        detail: "The candidate declares data schema 1, which is the schema this app's records are on.",
      },
    ];
    return {
      ok: checks.every((check) => check.ok),
      checkedAt: new Date().toISOString(),
      checks,
      testDatabase: "test.sqlite (disposable)",
    };
  };

  const runtime: HostedRuntime = {
    id: "local",
    label: "This control host (test double)",
    enforcement: ENFORCEMENT,
    availability: (): Promise<Availability> => Promise.resolve({ available: true }),
    hostname: (app) => `${app.slug}.apps.localhost`,
    ensureApp: (app): Promise<RuntimeAppRef> => {
      if (opts.ensureAppError) return Promise.reject(opts.ensureAppError);
      recorder.ensured.push(app.id);
      return Promise.resolve({ runtime: "local", ref: { dir: `apps/${app.id}` } });
    },
    stageCandidate: async (app, release, artifact: Artifact): Promise<RuntimeCandidateRef> => {
      await opts.beforeStage?.();
      recorder.staged.push({ appId: app.id, releaseId: release.id, digest: artifact.digest });
      return Promise.resolve({
        runtime: "local",
        releaseId: release.id,
        ref: { artifactDigest: artifact.digest, testDatabase: "test.sqlite" },
      });
    },
    probeCandidate: async (app, candidate) => {
      recorder.probed += 1;
      await opts.beforeProbe?.();
      return opts.probe ? opts.probe(app, candidate) : defaultProbe(candidate);
    },
    activate: async (app, release, fence) => {
      recorder.activated.push({ appId: app.id, releaseId: release.id, fence });
      await opts.activate?.(app, release, fence);
    },
    readBindings: (candidate): Promise<BindingReadback> =>
      Promise.resolve({
        ok: true,
        release: [String(candidate.ref.artifactDigest ?? "")],
        broker: ["fixed-broker"],
        detail: "Recorded by the test double.",
      }),
    cleanup: (app, retain) => {
      recorder.cleaned.push({ appId: app.id, retain: [...retain] });
      return Promise.resolve();
    },
  };

  return { runtime, recorder };
}

/** What the build-runner double produced and how often it was asked. */
export interface BuildRecorder {
  calls: number;
  outputs: string[];
}

export interface BuildDoubleOptions {
  /** Body of the produced index.html. Different bodies make different digests. */
  html?: string;
  /** Fail the build with this reason instead of producing output. */
  fail?: string;
  /** Report the runner as unavailable, so nothing is ever asked to build. */
  unavailable?: Availability;
}

/**
 * A build runner that writes a two-file output tree instead of compiling.
 *
 * The real recipe is exercised by `publish-real.test.ts`; everywhere else what
 * matters is what the pipeline does with a build's result, and two seconds of
 * Vite per case would buy nothing.
 */
export function buildRunnerDouble(opts: BuildDoubleOptions = {}): {
  runner: BuildRunner;
  recorder: BuildRecorder;
} {
  const recorder: BuildRecorder = { calls: 0, outputs: [] };
  const runner: BuildRunner = {
    id: "recipe-local",
    label: "Build runner (test double)",
    boundary: "A test double: it writes files and compiles nothing.",
    availability: () => Promise.resolve(opts.unavailable ?? { available: true }),
    run: (req: BuildRequest): Promise<BuildResult> => {
      recorder.calls += 1;
      if (opts.fail)
        return Promise.resolve({
          ok: false,
          logs: [{ ts: new Date().toISOString(), stream: "stderr", line: opts.fail }],
          durationMs: 1,
          runner: "recipe-local",
          boundary: runner.boundary,
          error: opts.fail,
        });
      const outputDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-double-out-"));
      const body = opts.html ?? `<!doctype html><title>${req.appId}</title><div id="root"></div>`;
      fs.writeFileSync(path.join(outputDir, "index.html"), body);
      fs.mkdirSync(path.join(outputDir, "assets"));
      fs.writeFileSync(
        path.join(outputDir, "assets", "app.js"),
        `export const source = ${JSON.stringify(req.source.digest)};\n`
      );
      recorder.outputs.push(outputDir);
      return Promise.resolve({
        ok: true,
        outputDir,
        logs: [{ ts: new Date().toISOString(), stream: "info", line: `built ${req.source.files.length} files` }],
        durationMs: 2,
        runner: "recipe-local",
        boundary: runner.boundary,
      });
    },
  };
  return { runner, recorder };
}

/** A usage double that never pauses builds and remembers what it was charged. */
export function usageDouble(paused?: { paused: boolean; reason?: string }) {
  const charged: { kind: string; amount: number }[] = [];
  return {
    charged,
    recordUsage: (entry: { kind: string; amount: number }) => {
      charged.push({ kind: entry.kind, amount: entry.amount });
      return { id: "usage-double", at: new Date().toISOString(), ...entry } as never;
    },
    buildsPaused: () => paused ?? { paused: false },
  };
}
