/**
 * The local runtime, against real files and a real database.
 *
 * The probe is the interesting part: it is the gate that keeps a broken
 * candidate off a live hostname, so the tests here check that it passes on a
 * healthy fixture *and* that each individual check can actually fail — a probe
 * that cannot fail is a probe that proves nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactFile, ArtifactStore } from "@/lib/hosted/contracts";
import type { HostedError as HostedErrorType } from "@/lib/hosted/contracts";
import { isolatedDataDir, removeDir } from "../_fixtures";
import { provenance, seedActiveRelease, seedApp, seedArtifactRow, writeBuiltTree } from "../gateway/_helpers";

const DATA_DIR = isolatedDataDir("zenith-runtime-local-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { appDataDir, hostedConfig } = await import("@/lib/hosted/config");
const { appDataPath, closeAllAppData, openAppData } = await import("@/lib/hosted/data");
const { LocalRuntime, hostedRuntimes, selectedHostedRuntime } = await import("@/lib/hosted/runtime");
const { HostedError } = await import("@/lib/hosted/contracts");

const authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(writeBuiltTree(DATA_DIR), provenance("job-local"));
await seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const app = await seedApp(authority, { slug: "alpha" });
const release = await seedActiveRelease(authority, app, artifact.digest);
const current = async () => (await authority.repos.apps.get(app.id))!;

afterAll(async () => {
  closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

/** An artifact store that answers whatever a test needs it to. */
function fakeStore(overrides: Partial<ArtifactStore>): ArtifactStore {
  const base: ArtifactStore = {
    put: async () => artifact,
    get: async () => artifact,
    list: async () => store.list(artifact.digest),
    open: async (digest, file) => store.open(digest, file),
    verify: async (digest) => store.verify(digest),
    remove: async () => false,
    ...overrides,
  } as ArtifactStore;
  return base;
}

describe("identity and availability", () => {
  it("is always available, and says what it does not isolate", async () => {
    const runtime = new LocalRuntime();
    expect(runtime.id).toBe("local");
    expect(runtime.label).toBe(
      "Local runtime — this control process serves the app and runs the broker (single host, no CPU/subrequest limits)"
    );
    expect(await runtime.availability()).toEqual({ available: true });
    expect(await runtime.blockedReason()).toBeNull();
  });

  it("names the app's stable hostname", async () => {
    expect(new LocalRuntime().hostname(app)).toBe("alpha.apps.localhost");
  });
});

describe("ensureApp", () => {
  it("creates the app's directory and a migrated database", async () => {
    const ref = await new LocalRuntime().ensureApp(app);
    expect(ref.runtime).toBe("local");
    expect(ref.ref.dataDir).toBe(appDataDir(app.id));
    expect(fs.existsSync(appDataPath(app.id, "data"))).toBe(true);
    expect(await openAppData(app.id).store.schemaVersion(app.id)).toBe(1);
  });
});

describe("stageCandidate", () => {
  it("verifies the stored bytes before a release may point at them", async () => {
    const ref = await new LocalRuntime().stageCandidate(app, release, artifact);
    expect(ref).toEqual({ runtime: "local", releaseId: release.id, ref: { digest: artifact.digest } });
  });

  it("refuses when the artifact no longer matches its digest", async () => {
    const runtime = new LocalRuntime({
      artifactStore: fakeStore({
        verify: async () => ({ ok: false, detail: "index.html has been edited since it was stored." }),
      }),
    });
    await expect(runtime.stageCandidate(app, release, artifact)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("probeCandidate", () => {
  const candidate = { runtime: "local" as const, releaseId: release.id, ref: { digest: artifact.digest } };

  it("passes on the real fixture, having actually exercised the test database", async () => {
    const result = await new LocalRuntime().probeCandidate(app, candidate);
    expect(result.ok).toBe(true);
    expect(result.testDatabase).toBe(appDataPath(app.id, "test"));
    expect(fs.existsSync(result.testDatabase)).toBe(true);

    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId["data.roundTrip"].ok).toBe(true);
    expect(byId["data.roundTrip"].detail).toContain("stale update answering 409");
    expect(byId["artifact.index"].ok).toBe(true);
    expect(byId["artifact.verified"].ok).toBe(true);
    expect(byId["data.schemaVersion"].ok).toBe(true);
  });

  it("leaves production data untouched while it does so", async () => {
    const { store: production } = openAppData(app.id);
    const before = await production.storageBytes(app.id);
    await new LocalRuntime().probeCandidate(app, candidate);
    expect(await production.storageBytes(app.id)).toBe(before);
  });

  it("fails when the artifact has no index.html", async () => {
    const runtime = new LocalRuntime({
      artifactStore: fakeStore({ open: async () => null }),
    });
    const result = await runtime.probeCandidate(app, candidate);
    expect(result.ok).toBe(false);
    const index = result.checks.find((c) => c.id === "artifact.index");
    expect(index?.ok).toBe(false);
    expect(index?.detail).toContain("no index.html");
  });

  it("fails when index.html is present but empty", async () => {
    const empty: ArtifactFile = { path: "index.html", bytes: 0, sha256: "0".repeat(64), contentType: "text/html" };
    const runtime = new LocalRuntime({
      artifactStore: fakeStore({ open: async () => ({ bytes: Buffer.alloc(0), file: empty }) }),
    });
    const result = await runtime.probeCandidate(app, candidate);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "artifact.index")?.detail).toContain("empty");
  });

  it("fails when the app's data is at a schema the candidate does not expect", async () => {
    const runtime = new LocalRuntime({ productionSchemaVersion: async () => 2 });
    const result = await runtime.probeCandidate(app, candidate);
    expect(result.ok).toBe(false);
    const schema = result.checks.find((c) => c.id === "data.schemaVersion");
    expect(schema?.ok).toBe(false);
    expect(schema?.detail).toContain("incompatible release");
  });

  it("fails when the stored artifact no longer verifies", async () => {
    const runtime = new LocalRuntime({
      artifactStore: fakeStore({ verify: async () => ({ ok: false, detail: "assets/app-abc123.js changed." }) }),
    });
    const result = await runtime.probeCandidate(app, candidate);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "artifact.verified")?.detail).toContain("changed");
  });
});

describe("activate", () => {
  it("accepts the fence the app is actually at", async () => {
    await expect(new LocalRuntime().activate(app, release, (await current()).activeFence)).resolves.toBeUndefined();
  });

  it("refuses a stale fence rather than letting an old worker point the hostname", async () => {
    const stale = (await current()).activeFence - 1;
    await expect(new LocalRuntime().activate(app, release, stale)).rejects.toBeInstanceOf(HostedError);
    await new LocalRuntime()
      .activate(app, release, stale)
      .catch(async (err: HostedErrorType) => {
        expect(err.code).toBe("conflict");
        expect(err.details?.currentFence).toBe((await current()).activeFence);
        expect(err.fix).toContain("stays live");
      });
  });
});

describe("readBindings", () => {
  it("says the capabilities are process-internal rather than claiming a readback", async () => {
    const readback = await new LocalRuntime().readBindings({
      runtime: "local",
      releaseId: release.id,
      ref: { digest: artifact.digest },
    });
    expect(readback.ok).toBe(true);
    expect(readback.release).toEqual([`ASSETS (artifact ${artifact.digest})`]);
    expect(readback.broker).toEqual(["DB (data.sqlite)"]);
    expect(readback.detail).toContain("no provider to read them back from");
  });
});

describe("cleanup", () => {
  it("removes the disposable test database and nothing else", async () => {
    await new LocalRuntime().probeCandidate(app, {
      runtime: "local",
      releaseId: release.id,
      ref: { digest: artifact.digest },
    });
    expect(fs.existsSync(appDataPath(app.id, "test"))).toBe(true);

    await new LocalRuntime().cleanup(app, new Set([release.id]));
    expect(fs.existsSync(appDataPath(app.id, "test"))).toBe(false);
    expect(fs.existsSync(appDataPath(app.id, "data"))).toBe(true);
    expect(fs.existsSync(path.join(appDataDir(app.id)))).toBe(true);
  });
});

describe("selectedHostedRuntime", () => {
  it("lists both runtimes", async () => {
    expect(hostedRuntimes().map((r) => r.id)).toEqual(["local", "cloudflare"]);
  });

  it("selects local by default", async () => {
    expect(selectedHostedRuntime().id).toBe("local");
  });

  it("refuses cloudflare by naming every variable that is missing", async () => {
    process.env.ZENITH_RUNTIME = "cloudflare";
    try {
      selectedHostedRuntime();
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(HostedError);
      const hosted = err as HostedErrorType;
      expect(hosted.code).toBe("runtime_unavailable");
      expect(hosted.message).toContain("ZENITH_CF_ACCOUNT_ID");
      expect(hosted.message).toContain("ZENITH_CF_NAMESPACE");
      expect(hosted.message).toContain("ZENITH_CF_API_TOKEN");
      expect(hosted.fix).toContain("ZENITH_RUNTIME=local");
    } finally {
      delete process.env.ZENITH_RUNTIME;
    }
  });

  it("selects cloudflare once all three inputs exist", async () => {
    process.env.ZENITH_RUNTIME = "cloudflare";
    process.env.ZENITH_CF_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    process.env.ZENITH_CF_NAMESPACE = "zenith-pilot";
    process.env.ZENITH_CF_API_TOKEN = "token-value-that-is-long-enough";
    try {
      expect(selectedHostedRuntime().id).toBe("cloudflare");
    } finally {
      delete process.env.ZENITH_RUNTIME;
      delete process.env.ZENITH_CF_ACCOUNT_ID;
      delete process.env.ZENITH_CF_NAMESPACE;
      delete process.env.ZENITH_CF_API_TOKEN;
    }
  });
});
