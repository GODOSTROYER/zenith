/**
 * Azure live acceptance harness (PROD-LIFE-04).
 *
 * Two kinds of test live here and they must never be confused:
 *
 *   1. "harness logic" tests run always. They exercise the harness's gate, config parsing and report rules against
 *      FAKE endpoints. They are contract-level and prove nothing about a real Azure subscription.
 *   2. The "LIVE" suite runs only when ZENITH_LIVE_AZURE=1 and ZENITH_LIVE_AZURE_CRED_FILE name a credential FILE
 *      (see scripts/acceptance/azure-live.ts). Otherwise it is reported as SKIPPED with the reason in the test
 *      name. A skipped live test is never a pass. Public Azure only; sovereign clouds are refused.
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AzureLiveConfigError, loadAzureLiveConfig, runAzureLive, tarGz } from "../../../scripts/acceptance/azure-live";
import { CLIENT, SUB, TENANT, fakeArm, fakeAssertion } from "./_helpers";

const CRED = { tenantId: TENANT, clientId: CLIENT, subscriptionId: SUB, region: "westeurope", assertionFile: "/run/secrets/assertion.jwt" };
const read = (obj: unknown) => () => JSON.stringify(obj);

describe("Azure live harness logic (fake endpoints; NOT live evidence)", () => {
  it("does nothing without the explicit opt in, and names the reason", () => {
    expect(loadAzureLiveConfig({})).toEqual({ skipReason: expect.stringContaining("ZENITH_LIVE_AZURE=1") });
    expect(loadAzureLiveConfig({ ZENITH_LIVE_AZURE: "1" })).toEqual({ skipReason: expect.stringContaining("ZENITH_LIVE_AZURE_CRED_FILE") });
    expect(loadAzureLiveConfig({ ZENITH_LIVE_AZURE: "true", ZENITH_LIVE_AZURE_CRED_FILE: "/x" }).config).toBeUndefined();
  });

  it("reads credentials only from a FILE and validates their shape", () => {
    const env = { ZENITH_LIVE_AZURE: "1", ZENITH_LIVE_AZURE_CRED_FILE: "/creds.json" };
    const ok = loadAzureLiveConfig(env, read(CRED)).config!;
    expect(ok.connection).toMatchObject({ provider: "azure", mode: "oidc_web_identity", tenantId: TENANT, subscriptionId: SUB });
    expect(ok.allowBuild).toBe(false);
    expect(loadAzureLiveConfig({ ...env, ZENITH_LIVE_AZURE_ALLOW_BUILD: "1" }, read(CRED)).config!.allowBuild).toBe(true);
    expect(() => loadAzureLiveConfig(env, () => "not json")).toThrow(AzureLiveConfigError);
    expect(() => loadAzureLiveConfig(env, read([]))).toThrow(AzureLiveConfigError);
    expect(() => loadAzureLiveConfig(env, read({ ...CRED, tenantId: "nope" }))).toThrow(/GUID/);
    expect(() => loadAzureLiveConfig(env, read({ ...CRED, assertionFile: undefined }))).toThrow(/assertionFile/);
    expect(() => loadAzureLiveConfig(env, read({ ...CRED, region: "West Europe" }))).toThrow(/region/);
    // there is no inline-credential path: an `assertion` or `clientSecret` property is simply never read
    const withInline = loadAzureLiveConfig(env, read({ ...CRED, assertion: "eyJ.inline.token", clientSecret: "s" })).config!;
    expect(JSON.stringify(withInline)).not.toContain("eyJ.inline.token");
  });

  it("refuses sovereign clouds instead of skipping them as passed", () => {
    const env = { ZENITH_LIVE_AZURE: "1", ZENITH_LIVE_AZURE_CRED_FILE: "/creds.json" };
    for (const cloud of ["usgov", "china"]) expect(() => loadAzureLiveConfig(env, read({ ...CRED, cloud }))).toThrow(/public Azure only/);
    expect(loadAzureLiveConfig(env, read({ ...CRED, cloud: "public" })).config).toBeDefined();
  });

  it("the mutating build check needs its own opt in and a registry; everything unconfigured is skipped, never passed", async () => {
    const arm = await fakeArm([{ method: "GET", match: `/subscriptions/${SUB}`, body: { subscriptionId: SUB } }]);
    try {
      const config = loadAzureLiveConfig({ ZENITH_LIVE_AZURE: "1", ZENITH_LIVE_AZURE_CRED_FILE: "/c" }, read(CRED)).config!;
      const report = await runAzureLive(config, { fetchImpl: arm.fetchImpl, readFile: () => fakeAssertion(Math.floor(Date.now() / 1000) + 300) });
      const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
      expect(byId["control-plane-subscription"].status).toBe("passed_live");
      for (const id of ["data-plane-blob-read", "data-plane-keyvault-metadata", "role-assignment-exact-scope", "acr-source-build"]) expect(byId[id].status, id).toBe("skipped");
      expect(byId["acr-source-build"].detail).toContain("ZENITH_LIVE_AZURE_ALLOW_BUILD=1");
      // any skipped check keeps the verdict from being a clean pass
      expect(report.verdict).toBe("incomplete");
      // the harness never printed or returned a token
      expect(JSON.stringify(report)).not.toMatch(/entra-access-token|eyJ/);
    } finally {
      await arm.close();
    }
  });

  it("a failed control-plane call fails the run immediately and runs no later check", async () => {
    const arm = await fakeArm([{ method: "GET", match: `/subscriptions/${SUB}`, status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } }]);
    try {
      const config = loadAzureLiveConfig({ ZENITH_LIVE_AZURE: "1", ZENITH_LIVE_AZURE_CRED_FILE: "/c" }, read(CRED)).config!;
      const report = await runAzureLive(config, { fetchImpl: arm.fetchImpl, readFile: () => fakeAssertion(Math.floor(Date.now() / 1000) + 300) });
      expect(report.verdict).toBe("failed");
      expect(report.checks.map((c) => c.id)).toEqual(["control-plane-subscription"]);
    } finally {
      await arm.close();
    }
  });

  it("the tar writer produces a valid ustar archive that gunzips back to the Dockerfile", () => {
    const archive = tarGz({ Dockerfile: "FROM scratch\nLABEL a=b\n" });
    const tar = gunzipSync(archive);
    expect(tar.length % 512).toBe(0);
    const header = tar.subarray(0, 512);
    expect(header.subarray(0, 10).toString("utf8").replace(/\0.*$/, "")).toBe("Dockerfile");
    expect(header.subarray(257, 262).toString("utf8")).toBe("ustar");
    const size = parseInt(header.subarray(124, 135).toString("utf8"), 8);
    expect(tar.subarray(512, 512 + size).toString("utf8")).toBe("FROM scratch\nLABEL a=b\n");
    // the checksum field is the sum of all header bytes with the field read as spaces
    const stored = parseInt(header.subarray(148, 154).toString("utf8"), 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    expect(copy.reduce((a, b) => a + b, 0)).toBe(stored);
  });
});

const live = process.env.ZENITH_LIVE_AZURE === "1" && !!process.env.ZENITH_LIVE_AZURE_CRED_FILE;
const skipReason = !process.env.ZENITH_LIVE_AZURE ? "ZENITH_LIVE_AZURE=1 not set" : process.env.ZENITH_LIVE_AZURE !== "1" ? "ZENITH_LIVE_AZURE is not exactly 1" : "ZENITH_LIVE_AZURE_CRED_FILE not set";

if (!live) {
  // reported as skipped, with the reason in the name; never counted as passed
  it.skip(`LIVE AZURE ACCEPTANCE SKIPPED (${skipReason}); public Azure only, requires explicit env and a credential file`, () => undefined);
} else {
  describe("LIVE public Azure acceptance (real subscription)", () => {
    it("control plane, data-plane permission, exact-scope role assignment and (if allowed) an ACR source build", async () => {
      const loaded = loadAzureLiveConfig(process.env);
      expect(loaded.config, loaded.skipReason).toBeDefined();
      const report = await runAzureLive(loaded.config!, { log: (line) => process.stdout.write(`${line}\n`) });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      expect(report.verdict, JSON.stringify(report.checks)).not.toBe("failed");
      expect(report.checks.some((c) => c.status === "passed_live")).toBe(true);
    }, 30 * 60_000);
  });
}
