import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Deployment, NavigatorRun, NavigatorStep, NavigatorVerification } from "@/lib/domain/types";
import { RunReceipt, StepReceipt } from "@/components/navigator/recorded-receipt";

const original = "Deployment succeeded — 1 changed. Live: web — https://app.example.test.";
const step: NavigatorStep = { id: "step", seq: 1, title: "Deploy", rationale: "Requested", actionId: "deploy.apply", input: {}, risk: "high", needsApproval: true, status: "done", deploymentId: "sandbox-deploy", resultSummary: original };
const verification: NavigatorVerification = { scope: "run", source: "provider", status: "passed", simulated: true, evidenceRef: "evidence", checkedAt: "2026-09-07T00:00:00Z", checks: [
  { deploymentId: "sandbox-deploy", revisionId: "revision", provider: "sandbox", detail: "Simulation", passed: true },
  { deploymentId: "local-deploy", revisionId: "revision-local", provider: "localstack", detail: "Provider checked", passed: true },
] };
function element(ui: React.ReactNode) { const host = document.createElement("div"); host.innerHTML = renderToStaticMarkup(ui); return host; }

describe("Navigator recorded receipts", () => {
  it("uses matched Sandbox evidence and preserves the original in a closed disclosure", () => {
    const host = element(<StepReceipt step={step} verification={verification} />);
    expect(host.firstElementChild?.querySelector("p")?.textContent).toContain("Its outputs are simulated; no live endpoint was verified.");
    expect(host.querySelector("details p")?.textContent).toBe(original);
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(step.resultSummary).toBe(original);
  });
  it("does not turn another provider receipt in a mixed run into a simulation", () => {
    const host = element(<StepReceipt step={{ ...step, deploymentId: "local-deploy" }} verification={verification} />);
    expect(host.textContent).toBe(original);
    expect(host.querySelector("details")).toBeNull();
  });
  it("does not rewrite arbitrary action text containing Live", () => {
    const host = element(<StepReceipt step={{ ...step, actionId: "system.setEnvVar" }} verification={verification} />);
    expect(host.textContent).toBe(original);
    expect(host.querySelector("details")).toBeNull();
  });
  it("uses explicit simulated output flags before run verification is available", () => {
    const deployment = { id: step.deploymentId, outputs: [{ key: "url", kind: "url", label: "Preview", value: "https://example.test", simulated: true }] } as Deployment;
    const host = element(<StepReceipt step={step} deployment={deployment} />);
    expect(host.textContent).toContain("Deployment completed with simulated outputs.");
    expect(host.querySelector("details p")?.textContent).toBe(original);
    const unclassified = element(<StepReceipt step={step} deployment={{ ...deployment, outputs: [{ ...deployment.outputs[0], simulated: undefined }] }} />);
    expect(unclassified.querySelector("details")).toBeNull();
  });
  it("clarifies the final reflection without changing the stored summary or claiming the whole run was simulated", () => {
    const run: NavigatorRun = { id: "run", projectId: "project", createdAt: "2026-09-07T00:00:00Z", goal: "Deploy", status: "done", steps: [step], verification, summary: original };
    const host = element(<RunReceipt run={run} />);
    expect(host.textContent).toContain("This run includes simulated deployment results.");
    expect(host.querySelector("details p")?.textContent).toBe(original);
    expect(run.summary).toBe(original);
    const withoutVerifier = element(<RunReceipt run={{ ...run, verification: undefined }} deployments={[{ id: step.deploymentId, outputs: [{ key: "url", kind: "url", label: "Preview", value: "https://example.test", simulated: true }] } as Deployment]} />);
    expect(withoutVerifier.textContent).toContain("This run includes simulated deployment results.");
  });
});
