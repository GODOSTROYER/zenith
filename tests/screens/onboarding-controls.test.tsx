import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StepProvider } from "@/components/screens/onboarding/step-provider";
import { StepSystem } from "@/components/screens/onboarding/step-system";
import { Rail } from "@/components/screens/onboarding/rail";
import { starterBoot, starterEnvironment, starterProject } from "./onboarding-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const calls = vi.hoisted(() => ({ api: vi.fn(), execute: vi.fn(), health: { data: { ok: false, checks: [] }, loading: false, error: undefined } }));
vi.mock("@/lib/client/api", async (original) => ({ ...await original<typeof import("@/lib/client/api")>(), api: calls.api, executeAction: calls.execute, useJson: () => calls.health }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { localStorage.clear(); calls.api.mockReset(); calls.execute.mockReset(); calls.health.data = { ok: false, checks: [] }; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render(node: ReactNode) { await act(async () => root.render(node)); }
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;
async function click(label: string) { await act(async () => button(label).click()); }
async function input(element: HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }

describe("provider choices remain truthful and explicit", () => {
  it("requires a selection, allows AWS Preview, and disables future providers", async () => {
    const boot = starterBoot(); const next = vi.fn();
    await render(<StepProvider {...boot} loading={false} onBack={vi.fn()} onNext={next} />);
    expect(host.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
    expect(button("Choose a provider").disabled).toBe(true);
    await act(async () => (host.querySelector("#guide-provider-aws") as HTMLButtonElement).click());
    expect(host.textContent).toContain("No credentials or IAM setup required");
    await click("Continue with AWS");
    expect(next).toHaveBeenCalledWith({ providerId: "aws", displayName: "AWS", connectionId: undefined });
    expect(button("Azure").disabled).toBe(true);
    expect(button("Oracle Cloud").disabled).toBe(true);
  });
  it("keeps unreachable LocalStack selected and requires an explicit successful recheck", async () => {
    const boot = starterBoot();
    await render(<StepProvider {...boot} loading={false} initialChoice={{ providerId: "localstack", displayName: "LocalStack" }} onBack={vi.fn()} onNext={vi.fn()} />);
    expect(button("Continue with LocalStack").disabled).toBe(true);
    expect(host.querySelector('#guide-provider-localstack')?.getAttribute("aria-checked")).toBe("true");
    calls.api.mockResolvedValue({ ok: true, checks: [] });
    await click("Recheck LocalStack");
    expect(calls.api).toHaveBeenCalledWith("/api/providers/localstack/health");
    expect(button("Continue with LocalStack").disabled).toBe(false);
  });
  it("does not turn visited rail steps into checkmarks", async () => {
    await render(<Rail step={4} complete={[true, false, false, false]} hasWorkspace hasChoice onGo={vi.fn()} />);
    expect(host.querySelectorAll('[aria-label="Present in workspace"]')).toHaveLength(1);
  });
});

describe("creation safety and importer preservation", () => {
  const blueprint = { id: "starter", name: "Starter", description: "Example", highlights: [], nodes: 1, services: 1, resources: 0, monthlyUsd: 0 };
  it("blocks viewer mutations and editor connection creation", async () => {
    await render(<StepSystem boot={starterBoot({ role: "viewer" })} choice={{ providerId: "sandbox", connectionId: "c1", displayName: "Sandbox" }} blueprints={[blueprint]} sampleCompose="" onBack={vi.fn()} onCreated={vi.fn()} />);
    expect(button("Create editable project").disabled).toBe(true);
    await render(<StepSystem key="editor" boot={starterBoot({ role: "editor" })} choice={{ providerId: "aws", displayName: "AWS" }} blueprints={[blueprint]} sampleCompose="" onBack={vi.fn()} onCreated={vi.fn()} />);
    expect(button("Create editable project").disabled).toBe(true);
    expect(host.textContent).toContain("An admin must create this connection");
    expect(calls.execute).not.toHaveBeenCalled();
  });
  it("revalidates active workspace before a write", async () => {
    const boot = starterBoot(); calls.api.mockResolvedValue({ ...boot, workspace: { ...boot.workspace, id: "w2" } });
    await render(<StepSystem boot={boot} choice={{ providerId: "sandbox", connectionId: "c1", displayName: "Sandbox" }} blueprints={[blueprint]} sampleCompose="" onBack={vi.fn()} onCreated={vi.fn()} />);
    await click("Create editable project");
    expect(calls.execute).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Your workspace or access changed");
  });
  it("retries a failed Dockerfile manifest write in the same project with actual secret-reference identity", async () => {
    const boot = starterBoot(); calls.api.mockImplementation(async () => boot);
    let attempts = 0;
    calls.execute.mockImplementation(async (id: string) => {
      if (id === "project.create") { boot.projects.push(starterProject()); boot.environments.push(starterEnvironment()); return { ok: true, summary: "Created", data: { projectId: "p1", slug: "project", environmentId: "e1" } }; }
      if (id === "project.updateManifest") return { ok: ++attempts > 1, summary: attempts > 1 ? "Saved" : "Temporary failure" };
      throw new Error(`Unexpected action ${id}`);
    });
    await render(<StepSystem boot={boot} choice={{ providerId: "sandbox", connectionId: "c1", displayName: "Sandbox" }} blueprints={[blueprint]} sampleCompose="" onBack={vi.fn()} onCreated={vi.fn()} />);
    await click("Import a file"); await click("dockerfile");
    await input(host.querySelector("textarea")!, "FROM node:22\nENV API_TOKEN=secret\nEXPOSE 3000");
    await click("Import and review");
    expect(host.textContent).toContain("project exists");
    await click("Retry import in saved project");
    expect(calls.execute.mock.calls.filter(([id]) => id === "project.create")).toHaveLength(1);
    expect(calls.execute.mock.calls.filter(([id]) => id === "project.updateManifest")).toHaveLength(2);
    const manifest = calls.execute.mock.calls.find(([id]) => id === "project.updateManifest")![1].input.manifest;
    expect(JSON.stringify(manifest)).toContain("vault:p1/");
    expect(JSON.stringify(manifest)).not.toContain('"value":"secret"');
    expect(host.textContent).toContain("Continue to the guide");
    expect([...Object.keys(localStorage)].some((key) => localStorage.getItem(key)?.includes("FROM node"))).toBe(false);
  });
});
