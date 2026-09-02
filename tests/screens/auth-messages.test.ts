/**
 * The auth copy rules, which are the only non-presentational logic in the
 * sign-in screens: a redirect's `?error=` must never reach the page, and
 * every error must end by naming a fix.
 */
import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_FALLBACK,
  callbackErrorCode,
  explain,
  isUnconfirmedEmail,
  messageForErrorCode,
} from "@/components/auth/messages";

describe("callbackErrorCode", () => {
  it("turns the messages Supabase actually returns into codes the form knows", () => {
    const cases: Record<string, string> = {
      "Email link is invalid or has expired": "link_expired",
      "Token has expired or is invalid": "link_expired",
      "Email link has already been used": "link_expired",
      "The link is missing its confirmation code — request a fresh one.": "link_missing_code",
      "Database error saving new user": "link_failed",
    };
    for (const [message, code] of Object.entries(cases)) {
      expect(callbackErrorCode(message)).toBe(code);
    }
  });

  it("only ever emits a code that has copy", () => {
    for (const message of ["", "anything at all", "expired", "missing its confirmation code"]) {
      expect(AUTH_ERROR_CODES[callbackErrorCode(message)]).toBeTruthy();
    }
  });
});

describe("messageForErrorCode", () => {
  it("says nothing when there is no error", () => {
    expect(messageForErrorCode(null)).toBeUndefined();
    expect(messageForErrorCode("")).toBeUndefined();
  });

  it("renders copy for a known code, not the code", () => {
    expect(messageForErrorCode("link_expired")).toBe(AUTH_ERROR_CODES.link_expired);
    expect(messageForErrorCode("link_expired")).not.toContain("link_expired");
  });

  it("never echoes an unknown parameter back into the page", () => {
    const hostile = [
      "<img src=x onerror=alert(1)>",
      "Your account was suspended — call +1 555 0100 to restore it",
      "https://evil.example/steal",
      "link_expired__",
    ];
    for (const raw of hostile) {
      const shown = messageForErrorCode(raw);
      expect(shown).toBe(AUTH_ERROR_FALLBACK);
      expect(shown).not.toContain(raw);
    }
  });
});

describe("explain", () => {
  it("maps the errors the form can provoke", () => {
    expect(explain("Invalid login credentials")).toMatch(/do not match/);
    expect(explain("Email not confirmed")).toMatch(/Confirm your email first/);
    expect(explain("User already registered")).toMatch(/already exists/);
    expect(explain("Password should be at least 8 characters")).toMatch(/too short/);
    expect(explain("Request rate limit reached")).toMatch(/Wait a minute/);
    expect(explain("Failed to fetch")).toMatch(/Could not reach the auth server/);
  });

  it("names a fix for anything it does not recognise, and does not punt to the logs", () => {
    const out = explain("Database error saving new user");
    expect(out).toContain("Database error saving new user");
    expect(out).toMatch(/\.env\.local/);
    expect(out.toLowerCase()).not.toContain("supabase logs");
  });
});

describe("isUnconfirmedEmail", () => {
  it("recognises the one error that a resend can fix", () => {
    expect(isUnconfirmedEmail("Email not confirmed")).toBe(true);
    expect(isUnconfirmedEmail("email not confirmed")).toBe(true);
    expect(isUnconfirmedEmail("Invalid login credentials")).toBe(false);
  });
});
