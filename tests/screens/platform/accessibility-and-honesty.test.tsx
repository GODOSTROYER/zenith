/**
 * Cross-cutting checks that every platform surface must pass in every state it
 * has: populated, loading, error and empty. Per-component tests cover what each
 * one specifically promises; this file is the floor they all share.
 *
 *   accessibility  buttons and form controls have names; every disabled button
 *                  explains itself (title and linked visible text); aria
 *                  references resolve; headings do not skip levels; ids stay
 *                  unique when a component appears twice on a page
 *   honesty        loading is announced, errors say what failed, an empty state
 *                  names the next step, nothing renders a blank cell, and no raw
 *                  enum or machine code appears in visible text outside a
 *                  disclosure
 */
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalCard,
  AutonomyControl,
  AwsConnectionSetup,
  CostEstimateCard,
  DriftList,
  InvestigationView,
  OperationTimeline,
  PlacementComparison,
  PlanChangesTable,
  PolicyDecisionPanel,
  ResourceStateDetail,
  ResourceStateTable,
} from "@/components/platform";
import { approval, decision, driftReport, estimate, event, investigation, NOW, node, observation, operation, placementResult, planView, runtime } from "./fixtures";
import { headingsDoNotSkip, mount, nameOf, text } from "./render";

const noop = vi.fn();

interface Surface {
  name: string;
  populated: () => ReactElement;
  loading: () => ReactElement;
  error: () => ReactElement;
  /** undefined when the surface has no separate empty state (it is always a form or control) */
  empty?: () => ReactElement;
  /** what the empty state says (a fragment) */
  emptySays?: string;
  title: string;
}

const SURFACES: Surface[] = [
  {
    name: "OperationTimeline",
    title: "Timeline",
    populated: () => <OperationTimeline events={[event("operation.proposed"), event("operation.uncertain"), event("resource.verified", { data: { simulated: true } })]} operation={operation({ status: "uncertain" })} />,
    loading: () => <OperationTimeline events={[]} loading />,
    error: () => <OperationTimeline events={[]} error="The stream dropped." onRetry={noop} />,
    empty: () => <OperationTimeline events={[]} />,
    emptySays: "as the change is proposed, approved and run",
  },
  {
    name: "ApprovalCard",
    title: "Apply an infrastructure plan",
    populated: () => <ApprovalCard operation={operation()} decision={decision()} approvals={[]} viewer={{ id: "u", role: "admin" }} capabilityTitle="Apply an infrastructure plan" plan={planView()} onApprove={noop} onReject={noop} now={NOW} />,
    loading: () => <ApprovalCard operation={operation()} approvals={[]} viewer={{ id: "u", role: "admin" }} capabilityTitle="Apply an infrastructure plan" onApprove={noop} onReject={noop} now={NOW} loading />,
    error: () => <ApprovalCard operation={operation()} approvals={[]} viewer={{ id: "u", role: "admin" }} capabilityTitle="Apply an infrastructure plan" onApprove={noop} onReject={noop} now={NOW} error="Not found." onRetry={noop} />,
  },
  {
    name: "ApprovalCard (viewer blocked)",
    title: "Apply an infrastructure plan",
    populated: () => <ApprovalCard operation={operation()} decision={decision()} approvals={[approval()]} viewer={{ id: "v", role: "viewer" }} capabilityTitle="Apply an infrastructure plan" onApprove={noop} onReject={noop} now={NOW} />,
    loading: () => <ApprovalCard operation={operation()} approvals={[]} viewer={{ id: "v", role: "viewer" }} capabilityTitle="Apply an infrastructure plan" onApprove={noop} onReject={noop} now={NOW} loading />,
    error: () => <ApprovalCard operation={operation()} approvals={[]} viewer={{ id: "v", role: "viewer" }} capabilityTitle="Apply an infrastructure plan" onApprove={noop} onReject={noop} now={NOW} error="Gone." />,
  },
  {
    name: "PlanChangesTable",
    title: "Planned changes",
    populated: () => <PlanChangesTable plan={planView()} />,
    loading: () => <PlanChangesTable loading />,
    error: () => <PlanChangesTable error="Plan unreadable." onRetry={noop} />,
    empty: () => <PlanChangesTable />,
    emptySays: "once Zenith has computed what a change would do",
  },
  {
    name: "PolicyDecisionPanel",
    title: "Policy decision",
    populated: () => <PolicyDecisionPanel decision={decision({ constraints: { maxLines: 10 } })} />,
    loading: () => <PolicyDecisionPanel loading />,
    error: () => <PolicyDecisionPanel error="Unavailable." onRetry={noop} />,
    empty: () => <PolicyDecisionPanel />,
    emptySays: "Policy evaluates a proposal as soon as it is made",
  },
  {
    name: "ResourceStateTable",
    title: "Resource state",
    populated: () => <ResourceStateTable rows={[{ node: node(), observation: observation(), runtime: runtime() }, { node: node({ address: "resource/db" }) }]} drift={driftReport()} onSelect={noop} />,
    loading: () => <ResourceStateTable rows={[]} loading />,
    error: () => <ResourceStateTable rows={[]} error="Unavailable." onRetry={noop} />,
    empty: () => <ResourceStateTable rows={[]} />,
    emptySays: "once the configuration has been expanded into infrastructure",
  },
  {
    name: "ResourceStateDetail",
    title: "service/web",
    populated: () => <ResourceStateDetail row={{ node: node(), observation: observation(), runtime: runtime() }} finding={driftReport().findings[0]} />,
    loading: () => <ResourceStateDetail loading />,
    error: () => <ResourceStateDetail error="Unavailable." onRetry={noop} />,
    empty: () => <ResourceStateDetail />,
    emptySays: "Choose a resource from the list",
  },
  {
    name: "DriftList",
    title: "Drift",
    populated: () => <DriftList report={driftReport()} onSelect={noop} />,
    loading: () => <DriftList loading />,
    error: () => <DriftList error="Unavailable." onRetry={noop} />,
    empty: () => <DriftList />,
    emptySays: "Zenith cannot say whether anything differs",
  },
  {
    name: "InvestigationView",
    title: "Investigation",
    populated: () => <InvestigationView investigation={investigation()} onProposeRemediation={noop} proposeDisabledReason="Only editors can propose fixes." />,
    loading: () => <InvestigationView loading />,
    error: () => <InvestigationView error="Unavailable." onRetry={noop} />,
    empty: () => <InvestigationView />,
    emptySays: "checks each hop of the request path",
  },
  {
    name: "CostEstimateCard",
    title: "Estimate",
    populated: () => <CostEstimateCard estimate={estimate()} />,
    loading: () => <CostEstimateCard loading />,
    error: () => <CostEstimateCard error="Unavailable." onRetry={noop} />,
    empty: () => <CostEstimateCard />,
    emptySays: "once Zenith has priced the configuration",
  },
  {
    name: "PlacementComparison",
    title: "Placement options",
    populated: () => <PlacementComparison result={placementResult()} />,
    loading: () => <PlacementComparison loading />,
    error: () => <PlacementComparison error="Unavailable." onRetry={noop} />,
    empty: () => <PlacementComparison />,
    emptySays: "Describe where your users are",
  },
  {
    name: "AutonomyControl (admin)",
    title: "Autonomy",
    populated: () => <AutonomyControl level={2} viewerRole="admin" onChange={noop} />,
    loading: () => <AutonomyControl level={2} viewerRole="admin" onChange={noop} loading />,
    error: () => <AutonomyControl level={2} viewerRole="admin" onChange={noop} error="Unavailable." onRetry={noop} />,
  },
  {
    name: "AutonomyControl (viewer)",
    title: "Autonomy",
    populated: () => <AutonomyControl level={2} viewerRole="viewer" onChange={noop} />,
    loading: () => <AutonomyControl level={2} viewerRole="viewer" onChange={noop} loading />,
    error: () => <AutonomyControl level={2} viewerRole="viewer" onChange={noop} error="Unavailable." />,
  },
  {
    name: "AwsConnectionSetup",
    title: "Connect an AWS account",
    populated: () => <AwsConnectionSetup trust={{ mode: "oidc_web_identity", issuerHost: "app.example.test/api/oidc", oidcSubject: "zenith:ws:a:conn:b" }} onVerify={noop} />,
    loading: () => <AwsConnectionSetup onVerify={noop} loading />,
    error: () => <AwsConnectionSetup onVerify={noop} error="Unavailable." onRetry={noop} />,
  },
];

/** Enum values and machine codes that must never be visible text on their own. */
const RAW_CODES = [
  "awaiting_approval", "require_approval", "model_knowledge", "internal_assumption", "third_party_mirror",
  "official_api", "official_page", "not_inspected", "access_denied", "not_supported", "not_applicable",
  "no_observation", "not_read", "resource_missing", "resource_inaccessible", "oidc_web_identity",
  "aws_assume_role", "single_region", "multi_region", "cross_cloud", "cross_region", "separationOfDuties",
  "minRole", "proposalDigest", "policyVersion", "autoRepairEligible", "forcesReplacement", "destroysData",
  "undefined", "[object Object]", "NaN",
];

/** Visible text outside disclosures: what a person reads without asking for technical detail. */
function visibleText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("details").forEach((d) => d.remove());
  return text(clone);
}

function assertAccessible(el: Element): void {
  // buttons are named
  for (const b of el.querySelectorAll("button")) expect(nameOf(b).length, `button without a name: ${b.outerHTML.slice(0, 120)}`).toBeGreaterThan(0);
  // form controls are named
  for (const c of el.querySelectorAll("input, textarea, select")) {
    const id = c.getAttribute("id");
    const labelled = c.getAttribute("aria-label") || c.getAttribute("aria-labelledby") || (id && el.querySelector(`label[for="${CSS.escape(id)}"]`));
    expect(Boolean(labelled), `unlabelled control: ${c.outerHTML.slice(0, 120)}`).toBe(true);
  }
  // every disabled button says why, in a tooltip and in linked text
  for (const b of el.querySelectorAll<HTMLButtonElement>("button:disabled")) {
    if (b.getAttribute("aria-busy") === "true") continue;
    expect((b.getAttribute("title") ?? "").length, `disabled button without a reason: ${nameOf(b)}`).toBeGreaterThan(10);
    const ids = (b.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    expect(ids.length, `disabled button not linked to its reason: ${nameOf(b)}`).toBeGreaterThan(0);
  }
  // aria references resolve to real, non-empty elements
  for (const ref of el.querySelectorAll("[aria-describedby], [aria-labelledby]")) {
    for (const attr of ["aria-describedby", "aria-labelledby"]) {
      for (const id of (ref.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(id);
        expect(target, `${attr} points at a missing id: ${id}`).not.toBeNull();
        expect((target?.textContent ?? "").trim().length, `${attr} points at an empty element: ${id}`).toBeGreaterThan(0);
      }
    }
  }
  // tables have captions, radio groups have legends, decorative icons are hidden
  for (const t of el.querySelectorAll("table")) expect(t.querySelector("caption")?.textContent?.trim().length, "table without a caption").toBeGreaterThan(0);
  for (const f of el.querySelectorAll("fieldset")) expect(f.querySelector("legend")?.textContent?.trim().length, "fieldset without a legend").toBeGreaterThan(0);
  for (const svg of el.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden"), "svg exposed to assistive tech").toBe("true");
  for (const img of el.querySelectorAll("img")) expect(img.hasAttribute("alt")).toBe(true);
  expect(headingsDoNotSkip(el)).toBe(true);
}

function assertNoRawCodes(el: Element): void {
  const t = visibleText(el);
  for (const code of RAW_CODES) expect(t, `raw code "${code}" is visible`).not.toContain(code);
}

function assertNothingBlank(el: Element): void {
  for (const cell of el.querySelectorAll("td, dd")) {
    const hasContent = (cell.textContent ?? "").trim().length > 0 || cell.querySelector("svg, input, button") !== null;
    expect(hasContent, `blank cell: ${cell.outerHTML.slice(0, 160)}`).toBe(true);
  }
}

describe.each(SURFACES)("$name", (s) => {
  it("populated: accessible, honest, no raw codes, nothing blank", () => {
    const el = mount(s.populated());
    expect(el.querySelector("h3")?.textContent?.trim()).toBe(s.title);
    assertAccessible(el);
    assertNoRawCodes(el);
    assertNothingBlank(el);
  });

  it("loading: announced politely, keeps its heading, offers no decision", () => {
    const el = mount(s.loading());
    expect(el.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(text(el)).toMatch(/Loading .+…/);
    expect(el.querySelector("h3")).not.toBeNull();
    assertAccessible(el);
  });

  it("error: says what failed and only offers retry when it can", () => {
    const el = mount(s.error());
    expect(text(el)).toContain("Could not load");
    const retry = [...el.querySelectorAll("button")].filter((b) => text(b) === "Try again");
    const hasRetry = (s.error().props as { onRetry?: unknown }).onRetry !== undefined;
    expect(retry).toHaveLength(hasRetry ? 1 : 0);
    if (!hasRetry) expect(text(el)).toContain("Reload the page to try again");
    assertAccessible(el);
  });

  if (s.empty) {
    it("empty: explains what goes here and is not a dead end", () => {
      const el = mount(s.empty!());
      expect(text(el)).toContain(s.emptySays!);
      assertAccessible(el);
      assertNoRawCodes(el);
    });
  }

  it("two instances on one page do not share ids", () => {
    const a = mount(s.populated());
    const b = mount(s.populated());
    const ids = [...a.querySelectorAll("[id]"), ...b.querySelectorAll("[id]")].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("disabled reasons stay tied to their controls", () => {
  it("the blocked approval card links both buttons to the one visible reason", () => {
    const el = mount(SURFACES[2].populated());
    const buttons = [...el.querySelectorAll<HTMLButtonElement>("button:disabled")];
    expect(buttons.length).toBe(2);
    const ids = new Set(buttons.map((b) => b.getAttribute("aria-describedby")));
    expect(ids.size).toBe(1);
  });
});
