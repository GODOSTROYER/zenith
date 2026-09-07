import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@/components/navigator/gimbal-character", () => ({ GimbalCharacter: ({ state, motion }: { state: string | null; motion: string }) => <div data-testid="gimbal" data-state={state ?? "neutral"} data-motion={motion} /> }));
import { GimbalIntroduction } from "@/components/landing/gimbal-introduction";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<GimbalIntroduction />));
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
describe("public Gimbal introduction", () => {
  it("starts neutral without quality or motion selectors", () => {
    render();
    expect(host.querySelector('[data-testid="gimbal"]')?.getAttribute("data-state")).toBe("neutral");
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).not.toContain("Low power");
  });
  it("offers real setup/help links and distinguishes simulation from verification", () => {
    render();
    expect(host.querySelector('a[href="/onboarding?step=1"]')?.textContent).toContain("Start with Gimbal");
    expect(host.querySelector('a[href="/guide"]')?.textContent).toBe("Open workspace guide");
    expect(host.textContent).toContain("simulation or completed plan is not a verified deployment");
  });
});
