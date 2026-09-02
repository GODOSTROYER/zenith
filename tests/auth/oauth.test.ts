/**
 * OAuth configuration and identity — both pure, both testable without a
 * browser or a provider.
 *
 * Two rules under test:
 *  - a button exists only for a provider the operator listed, so the page can
 *    never offer a door the Supabase project has not been told to open. An
 *    unknown name is dropped *loudly*: a typo belongs in the console, not in a
 *    button that fails at the provider.
 *  - an OAuth user's display name comes from whichever metadata key the
 *    provider happened to fill, in one fixed order. Google sends `full_name` /
 *    `name`; GitHub often sends only `user_name` / `preferred_username`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWN_OAUTH_PROVIDERS, parseOAuthProviders } from "@/lib/supabase/env";
import { userFromClaims } from "@/lib/auth/session";

const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => vi.restoreAllMocks());

describe("parseOAuthProviders", () => {
  it("shows nothing when nothing is configured", () => {
    const spy = warn();
    expect(parseOAuthProviders(undefined)).toEqual([]);
    expect(parseOAuthProviders(null)).toEqual([]);
    expect(parseOAuthProviders("")).toEqual([]);
    // Empty is not a mistake — it means "email and password only".
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats whitespace and stray commas as nothing", () => {
    const spy = warn();
    expect(parseOAuthProviders("   ")).toEqual([]);
    expect(parseOAuthProviders(" , ,, ")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads a list, trimming and case-folding each name", () => {
    expect(parseOAuthProviders("github,google")).toEqual(["github", "google"]);
    expect(parseOAuthProviders("  GitHub , Google  ")).toEqual(["github", "google"]);
    expect(parseOAuthProviders("\tgoogle\n")).toEqual(["google"]);
  });

  it("keeps the configured order and lists each provider once", () => {
    expect(parseOAuthProviders("google,github")).toEqual(["google", "github"]);
    expect(parseOAuthProviders("github,github,google")).toEqual(["github", "google"]);
  });

  it("drops an unknown provider with a warning that names it and the fix", () => {
    const spy = warn();
    expect(parseOAuthProviders("gihtub")).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    const said = String(spy.mock.calls[0][0]);
    expect(said).toContain("gihtub");
    expect(said).toContain("NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS");
    expect(said).toContain("github, google");
  });

  it("keeps the good names in a list that also has a bad one", () => {
    const spy = warn();
    expect(parseOAuthProviders("github,facebook,google")).toEqual(["github", "google"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("accepts every provider it claims to know", () => {
    const spy = warn();
    expect(parseOAuthProviders(KNOWN_OAUTH_PROVIDERS.join(","))).toEqual([
      ...KNOWN_OAUTH_PROVIDERS,
    ]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("userFromClaims display name", () => {
  const nameFrom = (user_metadata: Record<string, unknown>, email = "ada@orrery.test") =>
    userFromClaims({ sub: "u-1", email, user_metadata })?.name;

  it("prefers full_name over every other key", () => {
    expect(
      nameFrom({
        full_name: "Ada Lovelace",
        name: "ada.l",
        user_name: "adalovelace",
        preferred_username: "ada",
      })
    ).toBe("Ada Lovelace");
  });

  it("falls back to name, then user_name, then preferred_username", () => {
    expect(nameFrom({ name: "Ada L", user_name: "adalovelace", preferred_username: "ada" })).toBe(
      "Ada L"
    );
    expect(nameFrom({ user_name: "adalovelace", preferred_username: "ada" })).toBe("adalovelace");
    expect(nameFrom({ preferred_username: "ada" })).toBe("ada");
  });

  it("skips a key that is blank or not a string", () => {
    expect(nameFrom({ full_name: "   ", user_name: "adalovelace" })).toBe("adalovelace");
    expect(nameFrom({ full_name: "", name: 42, user_name: "adalovelace" })).toBe("adalovelace");
    expect(nameFrom({ full_name: null, name: { first: "Ada" }, preferred_username: "ada" })).toBe(
      "ada"
    );
  });

  it("trims the name it does take", () => {
    expect(nameFrom({ full_name: "  Ada Lovelace  " })).toBe("Ada Lovelace");
  });

  it("falls back to the email's local part, then to a placeholder", () => {
    expect(nameFrom({})).toBe("ada");
    expect(nameFrom({}, "")).toBe("you");
    expect(userFromClaims({ sub: "u-1", user_metadata: {} })?.name).toBe("you");
  });

  it("still reads the role from app_metadata only", () => {
    // The name bag is user-writable; a role in it must not be honoured.
    const user = userFromClaims({
      sub: "u-1",
      email: "ada@orrery.test",
      user_metadata: { full_name: "Ada", role: "admin" },
      app_metadata: {},
    });
    expect(user?.role).toBeUndefined();
  });
});
