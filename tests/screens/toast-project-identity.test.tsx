/**
 * A notification has to know which project it is about, or the activity panel
 * cannot lead it anywhere honest. This pins the wiring at the runner every
 * screen shares: the scope an action ran in becomes the notification's project
 * identity, and a workspace-level action still pushes cleanly without one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRunAction } from "@/components/screens/use-run-action";
import { ToastProvider, type ToastRecord } from "@/components/ui/toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }));

let root: Root;
let host: HTMLDivElement;
let runner: ReturnType<typeof useRunAction>;
let mirrored: ToastRecord[];

function Runner() {
  runner = useRunAction();
  return null;
}

const answer = (result: unknown) =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ result }),
  }));

beforeEach(async () => {
  mirrored = [];
  vi.stubGlobal("fetch", answer({ ok: true, summary: "Deployed Atlas.", actionId: "project.deploy" }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ToastProvider renderToaster={false}>
        <Runner />
      </ToastProvider>
    )
  );
  // The shell mirrors every toast into the activity buffer through this hook;
  // reading it is how a test sees exactly what a row would be built from.
  window.__zenithActivity = (t) => void mirrored.push(t);
});

afterEach(async () => {
  delete window.__zenithActivity;
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("notifications carry the project their action ran in", () => {
  it("attaches the scope's project to a successful run", async () => {
    await act(async () => {
      await runner.run("project.deploy", { scope: { projectId: "p2", environmentId: "dev" } });
    });
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({ kind: "ok", projectId: "p2" });
  });

  it("attaches it to a refusal too, so the failure leads somewhere", async () => {
    vi.stubGlobal("fetch", answer({ ok: false, summary: "Refused.", error: "Not allowed." }));
    await act(async () => {
      await runner.run("project.deploy", { scope: { projectId: "p2" } });
    });
    expect(mirrored[0]).toMatchObject({ kind: "err", projectId: "p2" });
  });

  it("attaches it when the call itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    await act(async () => {
      await runner.run("project.deploy", { scope: { projectId: "p2" } });
    });
    expect(mirrored[0]).toMatchObject({ kind: "err", projectId: "p2" });
  });

  it("leaves a workspace-level action without a project rather than inventing one", async () => {
    await act(async () => {
      await runner.run("workspace.rename", {});
    });
    expect(mirrored[0].projectId).toBeUndefined();
    expect(mirrored[0].projectSlug).toBeUndefined();
  });
});
