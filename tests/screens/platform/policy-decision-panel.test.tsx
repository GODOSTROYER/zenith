import { describe, expect, it, vi } from "vitest";
import { PolicyDecisionPanel } from "@/components/platform/policy-decision-panel";
import { button, click, headingsDoNotSkip, mount, text } from "./render";
import { decision, POLICY_VERSION } from "./fixtures";

describe("<PolicyDecisionPanel>", () => {
  it("states the outcome in words", () => {
    const needs = mount(<PolicyDecisionPanel decision={decision()} />);
    expect(text(needs)).toContain("Needs approval");
    expect(text(needs)).toContain("Policy allows this change only after a person approves it.");
    expect(text(needs)).not.toContain("require_approval");

    const denied = mount(<PolicyDecisionPanel decision={decision({ outcome: "deny", approval: undefined, reasons: [{ code: "prod_db_delete_denied", message: "Deleting a production database is not allowed." }] })} />);
    expect(text(denied)).toContain("Blocked");
    expect(text(denied)).toContain("It cannot be approved or run.");

    const allowed = mount(<PolicyDecisionPanel decision={decision({ outcome: "allow", approval: undefined, reasons: [{ code: "allowed_read_only", message: "Read-only requests are allowed." }] })} />);
    expect(text(allowed)).toContain("Allowed");
  });

  it("shows the rule's message and keeps the machine code in a disclosure", () => {
    const el = mount(<PolicyDecisionPanel decision={decision()} />);
    expect(text(el)).toContain("Environment autonomy level 2 is below the level (5)");
    const details = el.querySelector("details")!;
    expect(text(details)).toContain("autonomy_below_capability");
    expect(text(details)).toContain("zenith.rules.approval.autonomy_below_capability");
    expect([...el.querySelectorAll("li")].filter((li) => !li.closest("details")).map(text).join(" ")).not.toContain("autonomy_below_capability");
  });

  it("does not leave the 'why' empty when policy gave no reason", () => {
    const el = mount(<PolicyDecisionPanel decision={decision({ reasons: [] })} />);
    expect(text(el)).toContain("Policy did not record a reason for this decision.");
  });

  it("explains who must approve", () => {
    const el = mount(<PolicyDecisionPanel decision={decision({ approval: { count: 2, minRole: "admin", separationOfDuties: true } })} />);
    expect(text(el)).toContain("2 different people, each with the admin role or higher, must approve it.");
    expect(text(el)).toContain("The person who requested the change cannot be one of them.");
  });

  it("does not guess a requirement when policy asked for approval but gave none", () => {
    const el = mount(<PolicyDecisionPanel decision={decision({ approval: undefined })} />);
    expect(text(el)).toContain("did not say how many people or which role");
  });

  it("describes constraints in plain language and keeps exact values behind a disclosure", () => {
    const el = mount(<PolicyDecisionPanel decision={decision({ outcome: "allow", approval: undefined, constraints: { maxLines: 1000, maxWindowHours: 24, somethingNew: true } })} />);
    expect(text(el)).toContain("At most 1000 log lines can be read per request.");
    expect(text(el)).toContain("Logs can only be read from the last 24 hours.");
    expect(text(el)).toContain("Limit on something new: true.");
    const exact = [...el.querySelectorAll("details")].find((d) => text(d).includes("Exact values"))!;
    expect(text(exact)).toContain("maxLines");
  });

  it("omits the limits section when there are none", () => {
    const el = mount(<PolicyDecisionPanel decision={decision()} />);
    expect(text(el)).not.toContain("Limits that apply");
  });

  it("shows the policy version as a short hash with the full value on hover", () => {
    const el = mount(<PolicyDecisionPanel decision={decision()} />);
    const code = [...el.querySelectorAll("code")].find((c) => c.getAttribute("title") === POLICY_VERSION)!;
    expect(code.textContent).toBe(POLICY_VERSION.slice(0, 12));
    expect(text(el)).toContain("Policy version");
  });

  it("has empty, loading and error states", () => {
    expect(text(mount(<PolicyDecisionPanel />))).toContain("No policy decision yet");
    const loading = mount(<PolicyDecisionPanel loading />);
    expect(loading.querySelector('[aria-busy="true"]')).not.toBeNull();
    const onRetry = vi.fn();
    const failed = mount(<PolicyDecisionPanel error="Policy service unreachable." onRetry={onRetry} />);
    expect(text(failed)).toContain("Could not load the policy decision");
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps heading order", () => {
    expect(headingsDoNotSkip(mount(<PolicyDecisionPanel decision={decision({ constraints: { maxLines: 5 } })} />))).toBe(true);
  });
});
