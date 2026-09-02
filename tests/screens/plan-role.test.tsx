/**
 * The one piece of logic behind "this preview says so before you press it":
 * a plan carries the role its execute demands, and a surface must say when the
 * caller is below it — whether or not the server also set `blocked`.
 */
import { describe, expect, it } from "vitest";
import { roleShortfall } from "@/components/screens/shared";

describe("roleShortfall", () => {
  it("is silent when the caller is at or above the role the plan needs", () => {
    expect(roleShortfall("viewer", "viewer")).toBeUndefined();
    expect(roleShortfall("editor", "editor")).toBeUndefined();
    expect(roleShortfall("editor", "admin")).toBeUndefined();
    expect(roleShortfall("viewer", "admin")).toBeUndefined();
  });

  it("names the role, the caller's role, and the fix", () => {
    const msg = roleShortfall("admin", "editor");
    expect(msg).toContain("admin role");
    expect(msg).toContain("you are editor");
    expect(msg).toContain("Settings → Members");
  });

  it("catches every step down the ladder", () => {
    expect(roleShortfall("editor", "viewer")).toBeDefined();
    expect(roleShortfall("admin", "viewer")).toBeDefined();
  });

  it("says nothing when either side is unknown — no role, no accusation", () => {
    expect(roleShortfall(undefined, "viewer")).toBeUndefined();
    expect(roleShortfall("admin", null)).toBeUndefined();
    expect(roleShortfall("admin", undefined)).toBeUndefined();
  });
});
