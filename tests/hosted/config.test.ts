/**
 * The hosted storage-backend flag: `ZENITH_HOSTED_STORE`, plus the two
 * variables that come with it (`ZENITH_ARTIFACT_BUCKET`, `SUPABASE_DB_URL`).
 *
 * What is worth pinning down is the same as for product A's `ZENITH_STORE`:
 * the default, that an unknown value is refused at parse time rather than
 * silently meaning the default, and that the flag reaches the selection point
 * — `assertHostedPreconditions()`, which is where a Postgres install with no
 * `SUPABASE_DB_URL` is refused by name.
 *
 * `SUPABASE_DB_URL` carries a password, so the last test asserts the thing
 * that matters about it: a rejected value never appears in the error text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isolatedDataDir } from "./_fixtures";

isolatedDataDir("zenith-hosted-config-");

const { hostedConfig, hostedStoreKind } = await import("@/lib/hosted/config");
const { assertHostedPreconditions, nodeMeetsFloor } = await import("@/lib/hosted/index");
const { env } = await import("@/lib/env");
const supabase = await import("@/lib/supabase/env");

const KEYS = ["ZENITH_HOSTED_STORE", "ZENITH_ARTIFACT_BUCKET", "SUPABASE_DB_URL"] as const;

describe("hosted Node admission", () => {
  it.each([
    ["20.19.0", false], ["22.16.0", false], ["22.22.1", false],
    ["22.22.2", true], ["22.23.3", true], ["23.0.0", false],
    ["24.19.0", false], ["22.22.2suffix", false],
  ])("checks the supported stable range for %s", (version, supported) => {
    expect(nodeMeetsFloor(version)).toBe(supported);
  });

  it("fails hosted boot on an unsupported Node while preserving local demo admission", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    const identity = vi.spyOn(supabase, "isSupabaseConfigured").mockReturnValue(true);
    try {
      vi.stubEnv("ZENITH_HOSTED_MODE", "1");
      for (const version of ["22.22.1", "23.0.0"]) {
        Object.defineProperty(process.versions, "node", { ...descriptor, value: version });
        expect(() => assertHostedPreconditions()).toThrow(/requires Node >=22\.22\.2 <23/);
      }
      Object.defineProperty(process.versions, "node", { ...descriptor, value: "22.22.2" });
      expect(() => assertHostedPreconditions()).not.toThrow();
      Object.defineProperty(process.versions, "node", { ...descriptor, value: "22.16.0" });
      vi.stubEnv("ZENITH_HOSTED_MODE", "0");
      expect(() => assertHostedPreconditions()).not.toThrow();
    } finally {
      Object.defineProperty(process.versions, "node", descriptor);
      identity.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

afterEach(async () => {
  for (const key of KEYS) delete process.env[key];
});

describe("ZENITH_HOSTED_STORE", () => {
  it("defaults to sqlite when unset or empty", async () => {
    expect(hostedStoreKind()).toBe("sqlite");
    process.env.ZENITH_HOSTED_STORE = "";
    expect(hostedStoreKind()).toBe("sqlite");
  });

  it("accepts postgres, and the memoised parse sees the change", async () => {
    expect(hostedStoreKind()).toBe("sqlite");
    process.env.ZENITH_HOSTED_STORE = "postgres";
    expect(hostedStoreKind()).toBe("postgres");
    expect(hostedConfig().ZENITH_HOSTED_STORE).toBe("postgres");
  });

  it("refuses an unknown value by name instead of defaulting", async () => {
    process.env.ZENITH_HOSTED_STORE = "mysql";
    expect(() => hostedConfig()).toThrow(/ZENITH_HOSTED_STORE/);
  });

  it("is refused at boot when it names Postgres and no database URL is set", async () => {
    // The selection point. Both implementations exist now, so what boot refuses
    // is not the choice but the missing half of it, and the message names the
    // variable to set rather than the build's limitations.
    process.env.ZENITH_HOSTED_STORE = "postgres";
    expect(() => assertHostedPreconditions()).toThrow(
      "ZENITH_HOSTED_STORE=postgres needs a database to connect to"
    );
    expect(() => assertHostedPreconditions()).toThrow(/SUPABASE_DB_URL/);
  });

  it("passes the store check once SUPABASE_DB_URL is set", async () => {
    process.env.ZENITH_HOSTED_STORE = "postgres";
    process.env.SUPABASE_DB_URL = "postgresql://u:p@db.example.test:6543/postgres";
    // Nothing connects here: the check is a configuration fact. Hosted mode is
    // off in this suite, so the function returns after it.
    expect(() => assertHostedPreconditions()).not.toThrow();
  });
});

describe("ZENITH_ARTIFACT_BUCKET", () => {
  it("defaults to zenith-artifacts and takes an override", async () => {
    expect(hostedConfig().ZENITH_ARTIFACT_BUCKET).toBe("zenith-artifacts");
    process.env.ZENITH_ARTIFACT_BUCKET = "zenith-artifacts-staging";
    expect(hostedConfig().ZENITH_ARTIFACT_BUCKET).toBe("zenith-artifacts-staging");
  });
});

describe("SUPABASE_DB_URL", () => {
  it("is optional, and a URL when set", async () => {
    expect(env().SUPABASE_DB_URL).toBeUndefined();
    const url = "postgresql://user:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
    process.env.SUPABASE_DB_URL = url;
    expect(env().SUPABASE_DB_URL).toBe(url);
  });

  it("never puts the rejected value — which holds a password — in the error", async () => {
    process.env.SUPABASE_DB_URL = "not-a-url-hunter2";
    try {
      env();
      expect.unreachable("expected invalid SUPABASE_DB_URL to throw");
    } catch (err) {
      const message = String((err as Error).message);
      expect(message).toContain("SUPABASE_DB_URL");
      expect(message).not.toContain("hunter2");
      expect(message).toContain("hidden");
    }
  });
});
