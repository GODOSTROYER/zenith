import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("motion/react", () => ({ motion: { div: (props: React.ComponentProps<"div">) => <div {...props} />, button: (props: React.ComponentProps<"button">) => <button {...props} /> } }));
vi.mock("@/app/_landing/landing-motion", () => ({ useReveal() {}, useHeroScene() {}, useHeaderState() {}, useStatementReveal() {}, useSmoothScroll() {}, useCountUp() {}, useCountOnView() {}, useProgressLine() {}, useOrbitMotion() {}, useFlowMotion() {}, useSystemFlow() {}, useFan() {}, useSheetHandoff() {} }));
// eslint-disable-next-line @next/next/no-img-element
vi.mock("next/image", () => ({ default: (props: React.ComponentProps<"img">) => <img {...props} alt={props.alt ?? ""} /> }));
vi.mock("@/components/navigator/gimbal-character", () => ({
  GimbalCharacter: ({ state, mood, activateLabel, onActivate }: { state: string | null; mood: string; activateLabel?: string; onActivate?: () => void }) =>
    <button type="button" data-testid="gimbal" data-state={state ?? "neutral"} data-mood={mood} aria-label={activateLabel} onClick={onActivate} />,
}));

import { LandingExperienceProvider } from "@/app/_landing/landing-experience";
import { BeforeChapter } from "@/app/_landing/before-chapter";
import { ScenarioChapter } from "@/app/_landing/scenario-chapter";
import { CloudOrbit } from "@/app/_landing/cloud-orbit";
import { GimbalChapter } from "@/app/_landing/gimbal-chapter";
import { AgentsChapter } from "@/app/_landing/agents-chapter";
import { CloseChapter } from "@/app/_landing/close-chapter";
import { GimbalCompanion } from "@/app/_landing/gimbal-companion";
import { AUTONOMY_MEANING } from "@/lib/navigator/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const providers = [
  { id: "sandbox", displayName: "Zenith Sandbox", availability: "available" as const, tagline: "Simulated cloud." },
  { id: "localstack", displayName: "LocalStack", availability: "available" as const, tagline: "Real S3 buckets and SQS queues." },
  { id: "aws", displayName: "Amazon Web Services", availability: "preview" as const, tagline: "Preview: exports Terraform." },
  { id: "kubernetes", displayName: "Kubernetes", availability: "planned" as const, tagline: "Planned." },
];
function Page() {
  return <LandingExperienceProvider><AgentsChapter /><BeforeChapter /><ScenarioChapter /><GimbalChapter /><CloudOrbit providers={providers} /><CloseChapter cta={{ href: "/signup", label: "Create account" }} /><GimbalCompanion /></LandingExperienceProvider>;
}
function render() { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(<Page />)); }
function button(text: string, within: ParentNode = host!) { const element = [...within.querySelectorAll("button")].find((item) => item.textContent?.trim() === text || item.textContent?.includes(text) || item.getAttribute("aria-label") === text); if (!element) throw new Error(`Missing button: ${text}`); return element; }
function click(element: HTMLElement) { act(() => element.click()); }
async function type(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function ask(dialog: Element, question: string) {
  await type(dialog.querySelector<HTMLTextAreaElement>("textarea")!, question);
  await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="Send question"]')!.click(); });
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
  sessionStorage.clear();
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("landing chapters over one shared state", () => {
  it("never talks to the network and shows no code, terminal or Atlas story", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render();
    click(button("Proposed change"));
    click(button("autonomous", host!.querySelector("#gimbal")!));
    click(button("Explore the cloud roadmap", host!.querySelector("#cloud")!));
    click(button("100,000"));
    expect(fetch).not.toHaveBeenCalled();
    expect(host!.querySelector("pre, code")).toBeNull();
    expect(host!.textContent).not.toMatch(/atlas|sim:\/\/|POST \/api|terraform \{/i);
    expect(host!.querySelector('a[href*="github.com/GODOSTROYER/zenith"]:not([href*="Zenith-plugins"])')).toBeNull();
    expect(host!.querySelector('#agents a[href="/guide"]')?.textContent).toContain("Read the docs");
  });

  it("switches the inspected system, keeps the selection, and reads the product plan", () => {
    render();
    const before = host!.querySelector("#before")!;
    click(button("Current system"));
    expect(before.textContent).toContain("parts running today");
    expect(before.querySelector('[data-node="process-jobs"]')).toBeNull();
    click(button("Proposed change"));
    expect(before.querySelector('[data-node="process-jobs"]')).not.toBeNull();
    expect(before.textContent).toContain("Provisions a message queue");
    expect(before.textContent).toContain("$30.00");
    expect(before.textContent).toContain("+$8.00");
    expect(before.textContent).toContain("We map the system.");
    click(before.querySelector<HTMLButtonElement>('button[data-node="results"]')!);
    expect(before.textContent).toContain("Results database · Stores what each job produced.");
    click(button("Current system"));
    expect(before.textContent).toContain("Results database · Stores what each job produced.");
  });

  it("changes the estimate and configuration with the scenario and labels it a concept preview", () => {
    render();
    const chapter = host!.querySelector("#scenarios")!;
    expect(chapter.textContent).toContain("$30.00");
    click(button("100,000"));
    expect(chapter.textContent).toContain("$163.50");
    expect(chapter.textContent).toContain("6 replicas");
    expect(chapter.textContent).toMatch(/Concept preview/);
    expect(chapter.textContent).toMatch(/does not forecast traffic/);
  });

  it("explains five real autonomy levels without any workspace write", () => {
    render();
    const chapter = host!.querySelector("#gimbal")!;
    expect(chapter.textContent).toContain(AUTONOMY_MEANING.approve);
    click(button("bounded", chapter));
    expect(chapter.textContent).toContain(AUTONOMY_MEANING.bounded);
    expect(chapter.textContent).toContain("no workspace setting is changed");
    expect(chapter.textContent).toContain("And you stay in control.");
    expect(host!.querySelector('[data-testid="gimbal"]')?.getAttribute("data-state")).toBe("neutral");
  });

  it("draws the cloud roadmap from the registry and keeps managed hosting a vision", () => {
    render();
    const chapter = host!.querySelector("#cloud")!;
    expect(chapter.textContent).toContain("Your cloud.");
    expect(chapter.querySelectorAll("[data-orbit-card]")).toHaveLength(6);
    expect(chapter.textContent).toContain("AWSPreview");
    expect(chapter.textContent).toContain("KubernetesPlanned");
    expect(chapter.textContent).toContain("Oracle CloudPlanned · later");
    expect(chapter.textContent).toContain("Zenith-managedProduct vision");
    expect(chapter.querySelector('img[src="/cloud-logos/aws.svg"]')).not.toBeNull();
    const details = chapter.querySelector("details")!;
    expect(details.open).toBe(false);
    click(button("Explore the cloud roadmap", chapter));
    expect(details.open).toBe(true);
    expect(details.textContent).toMatch(/not an available service/);
  });

  it("opens a curated question panel from the character, answers, and restores focus on close", async () => {
    render();
    const gimbal = host!.querySelector<HTMLButtonElement>('[data-testid="gimbal"]')!;
    expect(gimbal.getAttribute("aria-label")).toBe("Ask Gimbal");
    click(gimbal);
    const dialog = host!.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Answers from the Zenith team");
    await ask(dialog, "can I export my infrastructure");
    expect(dialog.textContent).toMatch(/operations guide/);
    await ask(dialog, "do you handle GDPR");
    expect(dialog.textContent).toMatch(/roadmap item/);
    await ask(dialog, "what is the weather like");
    expect(dialog.textContent).toMatch(/don’t have a written answer/);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(host!.querySelector('[role="dialog"]')).toBeNull();
  });

  it("runs a walkthrough as presentation only and restores the view afterwards", async () => {
    render();
    const before = host!.querySelector("#before")!;
    click(before.querySelector<HTMLButtonElement>('button[data-node="results"]')!);
    click(host!.querySelector<HTMLButtonElement>('[data-testid="gimbal"]')!);
    const dialog = host!.querySelector('[role="dialog"]')!;
    await ask(dialog, "what happens before deployment");
    click(button("Read the plan with me", dialog));
    const callout = host!.querySelector('[role="dialog"][aria-label^="Walkthrough"]')!;
    expect(callout.textContent).toContain("Two additions");
    expect(before.querySelector('[data-node="process-jobs"]')?.getAttribute("data-hot")).toBe("true");
    expect(before.querySelector('[data-node="results"]')?.getAttribute("data-soft")).toBe("true");
    click(button("Next")); click(button("Next"));
    expect(host!.querySelector('[aria-label^="Walkthrough"]')?.textContent).toContain("$22.00 to $30.00");
    click(button("Done"));
    expect(host!.querySelector('[aria-label^="Walkthrough"]')).toBeNull();
    expect(before.querySelector('[data-node="results"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(before.querySelector('[data-node="results"]')?.getAttribute("data-soft")).toBeNull();
  });

  it("can be minimized and restored without losing help", () => {
    render();
    click(host!.querySelector<HTMLButtonElement>('[data-testid="gimbal"]')!);
    click(button("Minimize Gimbal"));
    expect(host!.querySelector('[data-testid="gimbal"]')).toBeNull();
    click(button("Show Gimbal"));
    expect(host!.querySelector('[data-testid="gimbal"]')).not.toBeNull();
  });
});
