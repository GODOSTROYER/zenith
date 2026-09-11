/**
 * A successful action refetches what the screen is showing.
 *
 * Both runners — `useRunAction` and the plan-first `ActionConfirm` — used to
 * leave that to an optional callback exactly one caller passed, so every other
 * screen kept showing the state from before the mutation until its next poll.
 * These tests drive the real providers over a stubbed `fetch`, so what they
 * pin is the request that actually goes out, not a spy on a prop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ActionConfirm } from "@/components/screens/action-confirm";
import { useRunAction } from "@/components/screens/use-run-action";
import { ProjectProvider, type ProjectPayload } from "@/components/shell/project-context";
import { ShellProvider, type Bootstrap } from "@/components/shell/shell-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }));

const BOOTSTRAP = "/api/bootstrap";
const PROJECT = "/api/projects/atlas";

const boot = {
  catalog: [], workspace: { id: "w1", name: "Acme", slug: "acme" }, workspaces: [],
  projects: [], environments: [], deployments: [], connections: [], providers: [],
  settings: {}, user: null, role: "admin", auth: { configured: false }, members: [],
} as unknown as Bootstrap;

const project = {
  project: { id: "atlas", slug: "atlas", name: "Atlas" },
  environments: [{ id: "dev", name: "Development", projectId: "atlas", class: "development" }],
  revisions: [], findings: [], workingIssues: [], changesets: {}, manifestHash: "current",
} as unknown as ProjectPayload;

const plan = {
  summary: "Deploy Atlas to Development.", details: [], warnings: [], risk: "low",
  costDeltaUsd: 0, requiresApproval: false,
};

let calls: string[];
let root: Root;
let host: HTMLDivElement;
let runner: ReturnType<typeof useRunAction>;

const countOf = (url: string) => calls.filter((c) => c === url).length;

function Runner() {
  runner = useRunAction();
  return null;
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      const mode = init?.body ? (JSON.parse(String(init.body)) as { mode?: string }).mode : undefined;
      const body =
        url === BOOTSTRAP ? boot
          : url === PROJECT ? project
            : mode === "plan" ? { plan }
              : { result: { ok: true, summary: "Deployed Atlas.", actionId: "project.deploy" } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    })
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => { await act(async () => { await Promise.resolve(); }); };

describe("useRunAction refetches on its own", () => {
  it("refreshes the workspace bootstrap after a successful action", async () => {
    await act(async () => root.render(<ShellProvider><Runner /></ShellProvider>));
    await settle();
    expect(countOf(BOOTSTRAP)).toBe(1);

    await act(async () => { await runner.run("project.deploy", {}); });
    await settle();
    expect(countOf(BOOTSTRAP)).toBe(2);
  });

  it("leaves the screen alone when the action was refused", async () => {
    await act(async () => root.render(<ShellProvider><Runner /></ShellProvider>));
    await settle();
    (fetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async (url: string) => {
        calls.push(url);
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ result: { ok: false, summary: "Refused.", error: "Not allowed." } }),
        };
      }
    );
    await act(async () => { await runner.run("project.deploy", {}); });
    await settle();
    expect(countOf(BOOTSTRAP)).toBe(1);
  });

  it("refreshes the project too, inside a project route", async () => {
    await act(async () =>
      root.render(
        <ShellProvider>
          <ProjectProvider slug="atlas" fallback={() => <p>Loading</p>}>
            <Runner />
          </ProjectProvider>
        </ShellProvider>
      )
    );
    await settle();
    expect(countOf(PROJECT)).toBe(1);

    await act(async () => { await runner.run("project.deploy", {}); });
    await settle();
    expect(countOf(PROJECT)).toBe(2);
    expect(countOf(BOOTSTRAP)).toBe(2);
  });

  it("runs outside the product shell without throwing", async () => {
    let result: unknown;
    await act(async () => root.render(<Runner />));
    await act(async () => { result = await runner.run("project.deploy", {}); });
    await settle();
    expect(result).toMatchObject({ ok: true });
    expect(countOf(BOOTSTRAP)).toBe(0);
  });
});

describe("ActionConfirm refetches on its own", () => {
  const confirmButton = () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Deploy");

  it("refreshes before handing control to onDone", async () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <ShellProvider>
          <ActionConfirm
            open
            onClose={onClose}
            actionId="project.deploy"
            title="Deploy Atlas"
            confirmLabel="Deploy"
            onDone={onDone}
          />
        </ShellProvider>
      )
    );
    await settle();
    expect(countOf(BOOTSTRAP)).toBe(1);

    const button = confirmButton();
    expect(button?.disabled).toBe(false);
    await act(async () => { button?.click(); });
    await settle();

    expect(countOf(BOOTSTRAP)).toBe(2);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
