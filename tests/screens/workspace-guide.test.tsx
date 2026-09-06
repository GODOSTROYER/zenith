import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client/api";
import { GuideContent, WorkspaceGuide } from "@/components/guide/workspace-guide";
import { starterBoot, starterEnvironment, starterProject } from "./onboarding-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/link", () => ({ default: ({ children, ...rest }: React.ComponentProps<"a">) => <a {...rest}>{children}</a> }));
vi.mock("@/components/navigator/gimbal-character", () => ({ GimbalCharacter: () => null }));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ boot: undefined, loading: false, error: new ApiError("Choose a workspace", 403), refresh: vi.fn() }) }));
let root: Root | undefined;
let host: HTMLDivElement;
function render(node: ReactNode) {
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host); act(() => root!.render(node));
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

describe("anytime workspace guide", () => {
  it("gives a workspace-less member a starter path without hiding the access error", () => {
    render(<WorkspaceGuide />);
    expect(host.textContent).toContain("Choose a workspace");
    expect(host.querySelector('a[href="/onboarding?step=1"]')).not.toBeNull();
  });
  it("explains all ten areas and scopes project links to the displayed environment", () => {
    const boot = starterBoot(); boot.projects = [starterProject()]; boot.environments = [starterEnvironment()];
    render(<GuideContent boot={boot} />);
    for (const name of ["Overview", "System", "Source", "Deploys", "Observe", "Security", "Navigator", "Settings", "Activity", "Revisions"])
      expect([...host.querySelectorAll("a")].some((a) => a.textContent === name)).toBe(true);
    expect(host.querySelector('a[href="/p/project/source?env=e1"]')).not.toBeNull();
    expect(host.textContent).toContain("Simulation");
  });
  it("directs a healthy AWS preview profile to Source without claiming deployment", () => {
    const boot = starterBoot(); boot.projects = [starterProject()]; boot.environments = [starterEnvironment()];
    boot.connections[0] = { ...boot.connections[0], provider: "aws" };
    render(<GuideContent boot={boot} />);
    expect(host.textContent).toContain("Preview · plan and export only");
    expect([...host.querySelectorAll("a")].find((a) => a.textContent?.includes("Review Source and export"))?.getAttribute("href")).toBe("/p/project/source?env=e1");
    expect(host.textContent).toContain("Choose a project to see what’s ready and find your next step");
    expect(host.textContent).toContain("Review a plan before applying changes");
    expect(host.textContent).not.toContain("workspace records");
  });
});
