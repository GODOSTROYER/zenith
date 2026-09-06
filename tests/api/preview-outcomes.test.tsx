import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Deployment, Output } from "@/lib/domain/types";

const db = vi.hoisted(() => ({
  deployment: vi.fn(), revision: vi.fn(), project: vi.fn(), environment: vi.fn(),
}));
vi.mock("@/lib/db/store", () => ({ q: db }));
import PreviewPage from "@/app/preview/[deploymentId]/[serviceId]/page";

const previewOutput: Output = {
  key: "url:web", label: "web — https://web--staging.atlas.orrery.app",
  value: "/preview/deploy-1/web", kind: "url", targetId: "web", simulated: true,
};
let deployment: Pick<Deployment, "id" | "projectId" | "environmentId" | "revisionId" | "status" | "outputs">;
async function render() {
  return renderToStaticMarkup(await PreviewPage({
    params: Promise.resolve({ deploymentId: "deploy-1", serviceId: "web" }),
  }));
}
function expectNoSuccess(html: string) {
  expect(html).not.toContain("completed successfully");
  expect(html).not.toContain("is running");
  expect(html).not.toContain("verified it answered");
  expect(html).not.toContain("web--staging.atlas.orrery.app");
}

describe("simulated preview outcomes", () => {
  beforeEach(() => {
    deployment = {
      id: "deploy-1", projectId: "project-1", environmentId: "staging",
      revisionId: "revision-1", status: "succeeded", outputs: [previewOutput],
    };
    db.deployment.mockImplementation(() => deployment);
    db.project.mockReturnValue({ slug: "atlas", name: "Atlas" });
    db.environment.mockReturnValue({ name: "Staging" });
    db.revision.mockReturnValue({ number: 1, manifest: { services: [
      { id: "web", name: "web", kind: "web", size: "small", replicas: 1, port: 3000 },
    ] } });
  });

  it.each([
    "planning", "awaiting_approval", "applying", "verifying", "failed",
    "rolling_back", "rolled_back", "cancelled",
  ] as const)("does not present a %s deployment as a successful preview even with retained outputs", async (status) => {
    deployment.status = status;
    const html = await render();
    expect(html).toContain("Preview unavailable");
    expect(html).toContain(`This deployment is ${status.replaceAll("_", " ")}.`);
    expectNoSuccess(html);
  });

  it.each([
    [],
    [{ ...previewOutput, kind: "hostname" as const }],
    [{ ...previewOutput, targetId: "worker" }],
    [{ ...previewOutput, value: "/preview/older-deployment/web" }],
    [{ ...previewOutput, value: "https://real-application.example", simulated: false }],
  ].map((outputs) => ({ outputs })))("requires a matching recorded preview output: $outputs", async ({ outputs }) => {
    deployment.outputs = outputs;
    const html = await render();
    expect(html).toContain("No preview was published for this service");
    expectNoSuccess(html);
  });

  it("shows a completed simulation without claiming current service health", async () => {
    const html = await render();
    expect(html).toContain("web · simulated preview");
    expect(html).toContain("completed successfully");
    expect(html).toContain("https://web--staging.atlas.orrery.app");
    expect(html).toContain("does not check live service health");
    expect(html).not.toContain("is running");
    expect(html).not.toContain("verified it answered");
  });

  it("supports LocalStack's recorded preview without inventing a hostname", async () => {
    deployment.outputs = [{ ...previewOutput, simulated: undefined,
      label: "web — simulated preview (ECS is Pro/AWS territory)",
    }];
    const html = await render();
    expect(html).toContain("completed successfully");
    expect(html).toContain("simulated preview (ECS is Pro/AWS territory)");
    expect(html).not.toContain("https://");
  });

  it("handles missing deployment records", async () => {
    db.deployment.mockReturnValue(undefined);
    const html = await render();
    expect(html).toContain("No such deployment");
    expectNoSuccess(html);
  });

  it("handles a service absent from the deployed revision", async () => {
    db.revision.mockReturnValue({ number: 1, manifest: { services: [] } });
    const html = await render();
    expect(html).toContain("That service is not part of this deployment");
    expectNoSuccess(html);
  });
});
