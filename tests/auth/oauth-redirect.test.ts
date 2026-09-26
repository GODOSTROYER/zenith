import { describe, expect, it } from "vitest";
import { authCallbackUrl, authPageUrl } from "@/lib/auth/oauth";
import { safeNextPath } from "@/lib/auth/destination";
describe("authentication return URLs", () => {
  it("preserves invitation token and recovery continuation in the callback query", () => {
    const target = new URL(authCallbackUrl("https://zenith.test", "/apps/accept?token=a%26b&mode=invite"));
    expect(target.origin).toBe("https://zenith.test");
    expect(target.pathname).toBe("/auth/callback");
    expect(target.searchParams.get("next")).toBe("/apps/accept?token=a%26b&mode=invite");
    expect(new URL(authCallbackUrl("https://zenith.test", "/reset-password")).searchParams.get("next")).toBe("/reset-password");
  });
  it.each(["//evil.test", "/\n/evil.test", "/\t/evil.test", "/\\evil.test", "/x/../auth/callback", "/%2e%2e/auth/callback", "/login?next=/overview"])("rejects unsafe or looping return %j", (target) => {
    expect(safeNextPath(target)).toBeUndefined();
    expect(authCallbackUrl("https://zenith.test", target)).toBe("https://zenith.test/auth/callback");
  });
});

it("carries invitation through password recovery without creating an auth-page loop", () => {
  expect(authPageUrl("/login", "/invite?invite=workspace-token")).toBe("/login?next=%2Finvite%3Finvite%3Dworkspace-token");
  const reset = authPageUrl("/reset-password", "/invite?invite=workspace-token");
  expect(new URL(authCallbackUrl("https://zenith.test", reset)).searchParams.get("next")).toBe(reset);
  expect(authPageUrl("/signup", "//evil.test")).toBe("/signup");
});
