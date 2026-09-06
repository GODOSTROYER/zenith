import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OnboardingFlow } from "@/components/screens/onboarding-flow";
import { guideStorageKey } from "@/components/guide/progress";
import { starterBoot, starterProject } from "./onboarding-fixtures";
import type { Bootstrap } from "@/components/shell/shell-context";
import { ApiError } from "@/lib/client/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ boot: undefined as Bootstrap | undefined, error: undefined as { status: number; message: string } | undefined, me: { signedIn: true, configured: true, hasWorkspace: true }, search: new URLSearchParams(), refresh: vi.fn(), router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => state.router, useSearchParams: () => state.search }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children) }));
vi.mock("@/lib/client/api", async (original) => ({ ...await original<typeof import("@/lib/client/api")>(), useJson: (url: string) => url === "/api/me" ? { data: state.me, loading: false, refresh: state.refresh } : { data: state.boot, error: state.error, loading: false, refresh: state.refresh } }));
vi.mock("@/components/navigator/gimbal-character", () => ({ GimbalCharacter: () => null }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/shell/wordmark", () => ({ Wordmark: () => <span>Zenith.ai</span> }));
vi.mock("@/components/guide/workspace-guide", () => ({ GuideContent: ({ initialProjectId }: { initialProjectId?: string }) => <div>Guide project: {initialProjectId ?? "none"}</div> }));
vi.mock("@/components/screens/onboarding/step-provider", () => ({ StepProvider: ({ onNext }: { onNext: (choice: { providerId: string; displayName: string }) => void }) => <button onClick={() => onNext({ providerId: "aws", displayName: "AWS" })}>Choose AWS Preview</button> }));
vi.mock("@/components/screens/onboarding/step-system", () => ({ StepSystem: ({ onCreated }: { onCreated: (slug: string, summary: string, id: string) => void }) => <button onClick={() => { state.boot!.projects.push({ ...starterProject(), id: "p2", slug: "second" }); onCreated("second", "Manifest saved; nothing deployed", "p2"); }}>Save second project</button> }));

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  localStorage.clear(); state.boot = starterBoot(); state.error = undefined; state.me.hasWorkspace = true; state.search = new URLSearchParams();
  state.router.replace.mockReset().mockImplementation((url: string) => { state.search = new URLSearchParams(url.split("?")[1]); });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render(key = "first") { await act(async () => root.render(<OnboardingFlow key={key} blueprints={[]} sampleCompose="" />)); }
async function click(label: string) { await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!.click()); }

describe("real starter orchestration", () => {
  it("lets a signed-in account with no memberships create a workspace when bootstrap returns403", async () => {
    state.boot = undefined; state.error = { status: 403, message: "No membership" }; state.me.hasWorkspace = false;
    await render();
    expect(host.textContent).toContain("Create workspace");
    expect(host.textContent).not.toContain("No membership");
    expect(host.textContent).not.toContain("npm run seed");
  });
  it("does not swallow a forbidden bootstrap for an account that has memberships", async () => {
    state.boot = undefined; state.error = new ApiError("No membership", 403); state.me.hasWorkspace = true;
    await render();
    expect(host.textContent).toContain("No membership");
    expect(host.textContent).not.toContain("Create workspace");
  });
  it("updates the entry step URL and persists the actual newly created second project", async () => {
    state.boot!.projects = [starterProject()]; state.search = new URLSearchParams("step=2");
    await render(); await click("Choose AWS Preview");
    expect(state.search.get("step")).toBe("3");
    await click("Save second project");
    expect(state.search.get("step")).toBe("4");
    const saved = JSON.parse(localStorage.getItem(guideStorageKey(state.boot!)!)!);
    expect(saved).toMatchObject({ step: 4, providerId: "aws", projectId: "p2" });
    await render("refresh");
    expect(host.textContent).toContain("Guide project: p2");
    expect(host.textContent).not.toContain("Choose AWS Preview");
  });
  it("starts returning users at Workspace unless they have a validated saved draft", async () => {
    state.boot!.projects = [starterProject()]; await render();
    expect(host.textContent).toContain("Continue here");
    expect(host.textContent).not.toContain("Save second project");
  });
  it("ignores another workspace draft rather than resuming the wrong provider/project", async () => {
    localStorage.setItem(guideStorageKey(state.boot!)!, JSON.stringify({ version: 1, userId: "u1", workspaceId: "w2", step: 3, providerId: "aws", projectId: "foreign" }));
    await render();
    expect(host.textContent).toContain("Continue here");
    expect(host.textContent).not.toContain("Save second project");
  });
});
