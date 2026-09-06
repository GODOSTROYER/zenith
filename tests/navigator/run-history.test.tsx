import { afterEach, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunHistory } from "@/components/navigator/run-history";
import type { NavigatorRun } from "@/lib/domain/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("keeps completed unverified runs neutral in history", () => {
  const run: NavigatorRun = { id: "run", projectId: "p", goal: "Deploy staging", createdAt: new Date().toISOString(), status: "done",
    steps: [{ id: "s", seq: 1, actionId: "deploy.apply", title: "Deploy", rationale: "Requested", input: {}, risk: "high", needsApproval: true, status: "done" }] };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<RunHistory runs={[run]} loading={false} />));
  expect(host.textContent).toContain("Completed");
  expect(host.querySelector(".text-ok")).toBeNull();
  expect(host.textContent).not.toContain("Verified");
});
