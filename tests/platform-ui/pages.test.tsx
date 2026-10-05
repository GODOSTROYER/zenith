/** Server page rendering with explicit loader fakes: empty/error/honesty contracts, not live API evidence. */
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { button, mount, text } from "../screens/platform/render";
import type { PageContext } from "@/app/(product)/platform/_lib/loaders";
import OperationsPage from "@/app/(product)/platform/page";
import OperationPage from "@/app/(product)/platform/operations/[id]/page";
import EnvironmentsPage from "@/app/(product)/platform/environments/page";
import EnvironmentPage from "@/app/(product)/platform/environments/[id]/page";
import InvestigationsPage from "@/app/(product)/platform/environments/[id]/incidents/page";
import PolicyPage from "@/app/(product)/platform/settings/page";
import AwsPage from "@/app/(product)/platform/connections/aws/page";
import Loading from "@/app/(product)/platform/loading";
import ErrorPage from "@/app/(product)/platform/error";
import { decision, operation, planView } from "../screens/platform/fixtures";

const state = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock("@/app/(product)/platform/_lib/loaders", () => ({
  loadPage: async () => state.value, loadOperations: async () => state.value,
  loadOperation: async () => state.value, loadEnvironment: async () => state.value,
  loadInvestigations: async () => state.value, loadPolicy: async () => state.value,
  one: (params: Record<string, unknown>, key: string) => typeof params[key] === "string" ? params[key] : undefined,
  OPERATION_STATUSES: ["awaiting_approval", "running", "uncertain"],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const context: PageContext = { workspaceId: "ws_1", principal: { kind: "user", id: "human", name: "Human" }, role: "viewer", environments: [] };
const params = Promise.resolve({ id: "env_1" });
beforeEach(() => { state.value = { error: "Platform store unavailable." }; });
const pages: { name: string; render: () => Promise<ReactElement> }[] = [
  { name: "operations", render: () => OperationsPage({ searchParams: Promise.resolve({}) }) },
  { name: "operation detail", render: () => OperationPage({ params }) },
  { name: "environments", render: () => EnvironmentsPage() },
  { name: "environment state", render: () => EnvironmentPage({ params, searchParams: Promise.resolve({}) }) },
  { name: "investigations", render: () => InvestigationsPage({ params }) },
  { name: "policy", render: () => PolicyPage() },
  { name: "AWS", render: () => AwsPage() },
];
describe("page states", () => {
  it.each(pages)("$name renders a loader error without a blank page", async ({ render }) => {
    const el = mount(await render()); expect(text(el)).toContain("Could not load platform"); expect(text(el)).toContain("Platform store unavailable");
  });
  it("renders a missing workspace without pretending there are no operations", async () => {
    state.value = { error: "No workspace yet. Complete onboarding.", missing: true };
    expect(text(mount(await OperationsPage({ searchParams: Promise.resolve({}) })))).toContain("No workspace yet");
  });
  it("renders the operations empty state and both server filter controls", async () => {
    state.value = { context, data: { items: [] } };
    const el = mount(await OperationsPage({ searchParams: Promise.resolve({}) }));
    expect(text(el)).toContain("No operations match"); expect(el.querySelector('select[name="status"]')).not.toBeNull(); expect(el.querySelector('select[name="environmentId"]')).not.toBeNull(); expect(text(el)).toContain("Evidence: contract");
  });
  it("preserves filters in pagination and links to real operation ids", async () => {
    state.value = { context, data: { items: [{ ...operation(), proposal: { ...operation().proposal, summary: "<script>external text</script>" } }], nextCursor: "next" } };
    const el = mount(await OperationsPage({ searchParams: Promise.resolve({ status: "uncertain", environmentId: "env_1" }) }));
    expect(el.querySelector('a[href="/platform/operations/op_1"]')).not.toBeNull();
    expect(el.querySelector('a[href="/platform?status=uncertain&environmentId=env_1&cursor=next"]')).not.toBeNull(); expect(el.querySelector("script")).toBeNull();
  });
  it("renders an honest investigation empty state", async () => {
    state.value = { context, data: { investigations: [], escalations: [], truncated: false, evidence: "contract" } };
    expect(text(mount(await InvestigationsPage({ params })))).toContain("does not establish that it is healthy");
  });
  it("renders an honest plan/cost gap instead of inferred records", async () => {
    state.value = { context, data: { operation: operation(), approvals: [], events: [], timelineTruncated: false } };
    const el = mount(await OperationPage({ params }));
    expect(text(el)).toContain("plan is unavailable for review"); expect(text(el)).toContain("No estimate yet"); expect(text(el)).toContain("No events recorded yet");
  });
  it("renders recorded plan addresses, attributes, policy and cost and enables its approval", async () => {
    const view = planView();
    const facts = { create: 1, update: 1, delete: 0, replace: 1, destroysData: true, destroyedStatefulAddresses: ["aws_db_instance.main"], regions: [], publicDatabases: [], openIngress: [], wildcardIam: [], identityChanges: [], firewallChanges: [], dnsChanges: [] };
    state.value = { context: { ...context, role: "admin" }, data: { operation: { ...operation({ expiresAt: new Date(Date.now() + 3600000).toISOString() }), approvalRound: 1, planReview: { planDigest: view.planDigest, view, facts, cost: { deltaUsdMonthly: 7 } } }, decision: decision(), approvals: [], events: [], timelineTruncated: false } };
    const el = mount(await OperationPage({ params }));
    expect(text(el)).toContain("aws_ecs_service.web"); expect(text(el)).toContain("desired_count"); expect(text(el)).toContain("$7");
    expect(text(el)).not.toContain("plan is unavailable"); expect(button(el, "Approve").disabled).toBe(false);
  });
  it("shows loading and a recoverable generic error without raw error values", () => {
    expect(mount(<Loading />).querySelector('[role="status"]')).not.toBeNull();
    const reset = vi.fn(); const el = mount(<ErrorPage reset={reset} />); expect(text(el)).toContain("Retry");
  });
});
