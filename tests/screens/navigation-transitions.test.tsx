import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NavigationTransitions } from "@/components/brand/navigation-transitions";
import Loading from "@/app/loading";
const mocks = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn(), curtain: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("@/lib/client/page-curtain", () => ({ curtainNavigate: mocks.curtain, productGround: () => "#22241f" }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(async () => {
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<NavigationTransitions />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function click(href: string, options: MouseEventInit = {}, attrs = "", wrapper = "") {
  const container = document.createElement("div"); container.className = wrapper;
  container.innerHTML = '<a href="' + href + '" ' + attrs + '><span>Join the waitlist</span></a>';
  // Cancel native navigation after the root capture listener has handled it.
  container.addEventListener("click", event => event.preventDefault());
  host.append(container);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options });
  container.querySelector("span")!.dispatchEvent(event);
  return event;
}
it("shows the shared curtain for sign-in to waitlist and preserves continuation", () => {
  const href = "/waitlist?next=%2Finvite%3Finvite%3Dabc";
  expect(click(href).defaultPrevented).toBe(true);
  expect(mocks.prefetch).toHaveBeenCalledWith(href);
  expect(mocks.curtain).toHaveBeenCalledWith(href, expect.any(Function), { color: "#f7f5ef" });
  mocks.curtain.mock.calls[0][1](href);
  expect(mocks.push).toHaveBeenCalledWith(href);
});
it.each([
  ["/waitlist", { ctrlKey: true }, "", ""],
  ["/waitlist", {}, 'target="_blank"', ""],
  ["/waitlist", {}, "download", ""],
  ["/waitlist", {}, "", "zenith-landing"],
  ["https://example.com", {}, "", ""],
  ["/auth/signout", {}, "", ""],
  ["/preview/example", {}, "", ""],
  ["#main", {}, "", ""],
] as const)("preserves native or specialized behavior for %s", (href, options, attrs, wrapper) => {
  click(href, options, attrs, wrapper);
  expect(mocks.curtain).not.toHaveBeenCalled();
});
it("server navigation fallback uses the Zenith mark and accessible status", async () => {
  await act(async () => root.render(<Loading />));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading Zenith");
  expect(host.querySelector("svg.zl")).not.toBeNull();
});
