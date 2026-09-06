import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentsSection } from "@/app/(product)/p/[slug]/settings/environments";
import type { Environment } from "@/lib/domain/types";

const health = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  data: undefined as { services: Record<string, { status: string }>; simulated: boolean; generatedBy: string } | undefined,
  loading: false,
  refresh: vi.fn(),
}));

vi.mock("@/lib/client/api", async (original) => ({
  ...await original<typeof import("@/lib/client/api")>(),
  useJson: () => health,
}));
vi.mock("@/app/(product)/p/[slug]/settings/access", () => ({ useGate: () => () => undefined }));

const environment: Environment = {
  id: "env-test", projectId: "project-test", name: "Staging", class: "staging",
  connectionId: "sandbox", region: "local", deployedRevisionId: "rev-test",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: "staging.example.test", createdAt: "2026-09-01T00:00:00.000Z",
};

function render() {
  return renderToStaticMarkup(<EnvironmentsSection environments={[environment]} revisions={[]}
    deployments={[]} connections={[]} providerById={new Map()} connectionsLoaded role="admin"
    projectId="project-test" refresh={() => {}} />);
}

beforeEach(() => {
  health.error = undefined;
  health.data = undefined;
  health.loading = false;
});

describe("Settings environment health", () => {
  it("shows a recoverable request error instead of claiming the revision has no services", () => {
    health.error = new Error("Health is unavailable. Retry the check.");
    const markup = render();
    expect(markup).toContain("Health is unavailable. Retry the check.");
    expect(markup).toContain("Retry health check");
    expect(markup).not.toContain("has no managed services");
  });

  it("reserves the empty state for a successful response with no managed services", () => {
    health.data = { services: {}, simulated: true, generatedBy: "sandbox" };
    expect(render()).toContain("has no managed services");
  });

  it("retains the simulation label on populated synthetic health", () => {
    health.data = { services: { api: { status: "ok" } }, simulated: true, generatedBy: "sandbox" };
    const markup = render();
    expect(markup).toContain("1/1 services ok");
    expect(markup).toContain("simulated");
  });
});
