/**
 * The hosted storage-backend flag: `ZENITH_HOSTED_STORE`, plus the two
 * variables that come with it (`ZENITH_ARTIFACT_BUCKET`, `SUPABASE_DB_URL`).
 *
 * What is worth pinning down is the same as for product A's `ZENITH_STORE`:
 * the default, that an unknown value is refused at parse time rather than
 * silently meaning the default, and that the flag reaches the selection point
 * — `assertHostedPreconditions()`, which refuses "postgres" in this build.
 *
 * `SUPABASE_DB_URL` carries a password, so the last test asserts the thing
 * that matters about it: a rejected value never appears in the error text.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isolatedDataDir } from "./_fixtures";

isolatedDataDir("zenith-hosted-config-");

const { hostedConfig, hostedStoreKind } = await import("@/lib/hosted/config");
const { assertHostedPreconditions } = await import("@/lib/hosted/index");
const { env } = await import("@/lib/env");

const KEYS = ["ZENITH_HOSTED_STORE", "ZENITH_ARTIFACT_BUCKET", "SUPABASE_DB_URL"] as const;

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

  it("is refused at boot while no Postgres authority exists", async () => {
    process.env.ZENITH_HOSTED_STORE = "postgres";
    expect(() => assertHostedPreconditions()).toThrow(
      "ZENITH_HOSTED_STORE=postgres is not available in this build yet"
    );
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
