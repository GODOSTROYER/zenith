import { describe, expect, it } from "vitest";
import { canEditGuide, choiceFromDraft, guideProgress, guideStorageKey, restoreGuide } from "@/components/guide/progress";
import { restoreRecovery } from "@/components/guide/recovery";
import { starterBoot, starterEnvironment, starterProject } from "./onboarding-fixtures";

describe("starter progress comes from real scoped state", () => {
  it("does not count the automatically supplied sandbox as a chosen environment", () => {
    expect(guideProgress(starterBoot()).complete).toEqual([true, false, false, false]);
    expect(guideProgress(undefined).complete).toEqual([false, false, false, false]);
  });
  it("distinguishes a blank project from a populated manifest, without claiming deployment", () => {
    const boot = starterBoot({ projects: [starterProject()], environments: [starterEnvironment()] });
    expect(guideProgress(boot).complete).toEqual([true, true, false, false]);
    boot.projects[0].workingManifest.resources.push({ id: "r1", name: "bucket", kind: "object_store", config: {}, size: "small", ownership: "managed" });
    expect(guideProgress(boot).complete).toEqual([true, true, true, false]);
    expect(guideProgress(boot).mode).toBe("Simulation");
  });
  it("ignores foreign projects and their environments", () => {
    expect(guideProgress(starterBoot({ projects: [{ ...starterProject(), workspaceId: "w2" }], environments: [starterEnvironment()] }), "p1").project).toBeUndefined();
  });
  it("gates project edits on actual roles", () => {
    for (const role of ["viewer", null] as const) expect(canEditGuide(starterBoot({ role }))).toBe(false);
    for (const role of ["editor", "admin"] as const) expect(canEditGuide(starterBoot({ role }))).toBe(true);
  });
});

describe("resumable starter validates identities and allows only safe fields", () => {
  const draft = { version: 1, workspaceId: "w1", userId: "u1", step: 3, providerId: "sandbox", connectionId: "c1", projectId: "p1" };
  it("restores an explicit choice without retaining import contents or secrets", () => {
    const boot = starterBoot({ projects: [starterProject()] });
    const restored = restoreGuide(JSON.stringify({ ...draft, secret: "do-not-store", source: "file contents" }), boot);
    expect(restored).toEqual(draft);
    expect(choiceFromDraft(restored, boot)).toEqual({ providerId: "sandbox", displayName: "Sandbox", connectionId: "c1" });
  });
  it("rejects wrong user/workspace and validates stale IDs", () => {
    expect(restoreGuide(JSON.stringify({ ...draft, userId: "u2" }), starterBoot())).toBeUndefined();
    expect(restoreGuide(JSON.stringify({ ...draft, workspaceId: "w2" }), starterBoot())).toBeUndefined();
    const restored = restoreGuide(JSON.stringify({ ...draft, connectionId: "stale" }), starterBoot());
    expect(restored?.connectionId).toBeUndefined();
    expect(restored?.projectId).toBeUndefined();
    expect(restoreGuide(JSON.stringify({ ...draft, providerId: "azure" }), starterBoot())?.step).toBe(2);
  });
  it("preserves AWS Preview and never silently substitutes sandbox", () => {
    const boot = starterBoot();
    const restored = restoreGuide(JSON.stringify({ ...draft, providerId: "aws" }), boot);
    expect(choiceFromDraft(restored, boot)?.providerId).toBe("aws");
    expect(restored?.connectionId).toBeUndefined();
    expect(choiceFromDraft(undefined, boot)).toBeUndefined();
  });
  it("namespaces by real user and workspace IDs; demo remains ephemeral", () => {
    expect(guideStorageKey(starterBoot())).toBe("orrery:guide:v1:u1:w1");
    expect(guideStorageKey(starterBoot({ user: null }))).toBeUndefined();
    expect(restoreGuide("{", starterBoot())).toBeUndefined();
  });
  it("reuses a saved import only when its project, environment and provider agree", () => {
    const boot = starterBoot({ projects: [starterProject()], environments: [starterEnvironment()] });
    const recovery = { workspaceId: "w1", userId: "u1", providerId: "sandbox", connectionId: "c1", projectId: "p1", format: "dockerfile" };
    expect(restoreRecovery(JSON.stringify(recovery), boot, "sandbox")?.projectId).toBe("p1");
    boot.environments[0].connectionId = "other";
    const invalid = restoreRecovery(JSON.stringify(recovery), boot, "sandbox");
    expect(invalid?.projectId).toBeUndefined();
    expect(invalid?.uncertain).toBe(true);
    expect(restoreRecovery(JSON.stringify(recovery), boot, "aws")).toBeUndefined();
  });
});
