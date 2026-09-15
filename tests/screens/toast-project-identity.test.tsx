/**
 * A notification has to know which project it is about, or the activity panel
 * cannot lead it anywhere honest.
 *
 * Two things supply that, and this pins both. The provider stamps the project
 * whose route the notification was raised on, so the hundred-odd `push()` call
 * sites do not each have to remember. And the runner every screen shares
 * passes the scope its action actually ran in, which is the one thing the
 * route cannot know — a project-scoped action started from a workspace screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRunAction } from "@/components/screens/use-run-action";
import { ToastProvider, routeProjectSlug, useToasts, type ToastApi, type ToastRecord } from "@/components/ui/toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }));

let root: Root;
let host: HTMLDivElement;
let runner: ReturnType<typeof useRunAction>;
let toasts: ToastApi;
let mirrored: ToastRecord[];

function Runner() {
  runner = useRunAction();
  toasts = useToasts();
  return null;
}

/** Where the browser is, as the product's own routes spell it. */
const at = (path: string) => window.history.replaceState(null, "", path);

const answer = (result: unknown) =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ result }),
  }));

beforeEach(async () => {
  mirrored = [];
  at("/");
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
  at("/");
  vi.unstubAllGlobals();
});

describe("the provider stamps the route a notification came from", () => {
  it("reads the project out of a project route", () => {
    expect(routeProjectSlug("/p/atlas/deploys")).toBe("atlas");
    expect(routeProjectSlug("/p/atlas")).toBe("atlas");
    expect(routeProjectSlug("/p/atlas?tab=all")).toBe("atlas");
    expect(routeProjectSlug("/overview")).toBeUndefined();
    expect(routeProjectSlug("/")).toBeUndefined();
    expect(routeProjectSlug(undefined)).toBeUndefined();
  });

  it("stamps it on a toast pushed from a project screen", async () => {
    at("/p/atlas/source");
    await act(async () => void toasts.push({ kind: "ok", title: "Service added." }));
    expect(mirrored[0]).toMatchObject({ projectSlug: "atlas" });
  });

  it("stamps nothing on a workspace screen", async () => {
    at("/overview");
    await act(async () => void toasts.push({ kind: "ok", title: "Workspace renamed." }));
    expect(mirrored[0].projectSlug).toBeUndefined();
    expect(mirrored[0].projectId).toBeUndefined();
  });

  it("never overrides a caller that knows better than the route", async () => {
    at("/p/atlas/deploys");
    await act(async () => void toasts.push({ kind: "ok", title: "Borealis deployed.", projectId: "p2" }));
    expect(mirrored[0]).toMatchObject({ projectId: "p2" });
    expect(mirrored[0].projectSlug).toBeUndefined();
  });
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
