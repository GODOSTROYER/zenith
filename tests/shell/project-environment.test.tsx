import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectProvider, useProjectData, type ProjectData, type ProjectPayload } from "@/components/shell/project-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
const refresh = () => {};
const payload = {
  project: { id: "atlas", slug: "atlas", name: "Atlas" },
  environments: [
    { id: "dev", name: "Development", projectId: "atlas", class: "development" },
    { id: "prod", name: "Production", projectId: "atlas", class: "production" },
  ], revisions: [], findings: [], workingIssues: [], changesets: {}, manifestHash: "current",
} as unknown as ProjectPayload;
vi.mock("@/lib/client/api", () => ({
  useJson: () => ({ data: payload, loading: false, error: undefined, refresh }),
  useEventStream: () => ({ connected: false }), streamedPollMs: () => 5000,
}));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ boot: { deployments: [] }, refresh }) }));

let root: Root;
let host: HTMLDivElement;
let current: ProjectData;
let mounts: number;
function Probe() {
  current = useProjectData();
  useEffect(() => { mounts += 1; }, []);
  return <input aria-label="Unsaved source" defaultValue="working draft" />;
}
const render = async () => {
  await act(async () => root.render(<ProjectProvider slug="atlas" fallback={() => <div>Loading</div>}><Probe /></ProjectProvider>));
};
beforeEach(() => {
  mounts = 0; localStorage.clear(); window.history.replaceState({}, "", "/p/atlas?env=dev&filter=open#finding");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("environment identity in a persistent project layout", () => {
  it("applies a same-project environment deep link while preserving the working surface", async () => {
    await render();
    const draft = host.querySelector("input");
    expect(current.selectedEnvId).toBe("dev");
    window.history.replaceState({}, "", "/p/atlas/security?env=prod");
    await render();
    expect(current.selectedEnvId).toBe("prod");
    expect(host.querySelector("input")).toBe(draft);
    expect(mounts).toBe(1);
  });

  it("synchronizes a manual selection to the URL and existing storage key without losing other context", async () => {
    await render();
    await act(async () => current.setSelectedEnv("prod"));
    expect(current.selectedEnvId).toBe("prod");
    expect(new URLSearchParams(window.location.search).get("env")).toBe("prod");
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("open");
    expect(window.location.hash).toBe("#finding");
    expect(localStorage.getItem("orrery-env-atlas")).toBe("prod");
  });

  it("refuses foreign environment IDs from links and manual callbacks", async () => {
    await render();
    window.history.replaceState({}, "", "/p/atlas?env=another-project-production");
    await render();
    expect(current.selectedEnvId).toBe("dev");
    await act(async () => current.setSelectedEnv("another-project-production"));
    expect(current.selectedEnvId).toBe("dev");
    expect(localStorage.getItem("orrery-env-atlas")).not.toBe("another-project-production");
  });
});
