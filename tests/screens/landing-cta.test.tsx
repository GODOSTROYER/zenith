import { describe, expect, it } from "vitest";
import { ctaFor } from "@/app/_landing/cta";

describe("Zenith entry paths", () => {
  it("gives visitors an account-creation path independent of other tenants", () => {
    expect(ctaFor({ configured: true, signedIn: false, hasWorkspace: true })).toEqual({ href: "/signup", text: "Create account" });
  });
  it("takes a new member to setup and returning members directly to their workspace", () => {
    expect(ctaFor({ configured: true, signedIn: true, hasWorkspace: false }).href).toBe("/onboarding");
    expect(ctaFor({ configured: true, signedIn: true, hasWorkspace: true })).toEqual({ href: "/overview", text: "Open Zenith" });
  });
  it("never asks demo-mode users to create an account", () => {
    expect(ctaFor({ configured: false, signedIn: false, hasWorkspace: false }).text).toBe("Start with Gimbal");
  });
});
