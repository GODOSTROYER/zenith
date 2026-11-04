import { describe, expect, it, vi } from "vitest";
import { OperationStatusBadge } from "@/components/platform/operation-status";
import { OperationTimeline } from "@/components/platform/operation-timeline";
import { OPERATION_STATUS_LABEL, UNCERTAIN_EXPLANATION } from "@/components/platform/labels";
import type { OperationStatus } from "@/lib/controlplane/types";
import { button, click, headingsDoNotSkip, mount, text } from "./render";
import { event, operation } from "./fixtures";

const STATUSES = Object.keys(OPERATION_STATUS_LABEL) as OperationStatus[];

describe("<OperationStatusBadge>", () => {
  it.each(STATUSES)("%s shows a human label, never the code", (status) => {
    const el = mount(<OperationStatusBadge status={status} />);
    expect(text(el)).toBe(OPERATION_STATUS_LABEL[status]);
    expect(text(el)).not.toContain("_");
    // the sentence is available on hover and the icon is decorative
    expect(el.querySelector("[title]")?.getAttribute("title")?.length).toBeGreaterThan(20);
    expect(el.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("can print its sentence beside the badge", () => {
    const el = mount(<OperationStatusBadge status="awaiting_approval" explain />);
    expect(text(el)).toContain("A person must approve this exact proposal");
  });

  it("explains an uncertain outcome in the agreed words", () => {
    const el = mount(<OperationStatusBadge status="uncertain" explain />);
    expect(text(el)).toContain(UNCERTAIN_EXPLANATION);
  });

  it("does not present success as verification", () => {
    const el = mount(<OperationStatusBadge status="succeeded" explain />);
    expect(text(el)).not.toMatch(/verified/i);
    expect(text(el)).toContain("confirmed the next time Zenith observes");
  });
});

describe("<OperationTimeline>", () => {
  const events = [
    event("operation.proposed", { seq: 1, id: "e1", actor: { kind: "user", id: "u", name: "Riya Shah" } }),
    event("policy.evaluated", { seq: 2, id: "e2", data: { outcome: "require_approval" } }),
    event("operation.approved", { seq: 3, id: "e3", actor: { kind: "user", id: "u2", name: "Dev Patel" } }),
    event("operation.started", { seq: 4, id: "e4" }),
  ];

  it("renders one plain sentence per event, in sequence order", () => {
    const el = mount(<OperationTimeline events={[...events].reverse()} operation={operation({ status: "running" })} />);
    const items = [...el.querySelectorAll("ol > li")].map((li) => text(li.querySelector("p")!));
    expect(items).toEqual([
      "Riya Shah proposed this change.",
      "Policy requires a person's approval before this runs.",
      "Dev Patel approved this proposal.",
      "Execution started.",
    ]);
    expect(text(el)).toContain("Running");
  });

  it("never shows a raw event code outside the details disclosure", () => {
    const el = mount(<OperationTimeline events={events} />);
    const visible = [...el.querySelectorAll("p")].map(text).join(" ");
    expect(visible).not.toMatch(/operation\.|policy\.evaluated/);
    // the code is still reachable, inside "Details"
    const details = el.querySelector("details");
    expect(details?.textContent).toContain("operation.proposed");
  });

  it("groups by correlation id and labels each flow when there are several", () => {
    const el = mount(
      <OperationTimeline
        events={[
          event("operation.proposed", { seq: 1, id: "a1", correlationId: "corr_deploy_aaaaaaaa" }),
          event("incident.opened", { seq: 2, id: "b1", correlationId: "corr_incident_bbbbbbbb" }),
          event("operation.approved", { seq: 3, id: "a2", correlationId: "corr_deploy_aaaaaaaa" }),
        ]}
      />
    );
    const headings = [...el.querySelectorAll("h4")].map(text);
    expect(headings).toHaveLength(2);
    expect(headings[0]).toContain("corr_dep");
    expect(headings[0]).toContain("2 events");
    expect(headings[1]).toContain("1 event");
    expect(el.querySelectorAll("ol")).toHaveLength(2);
  });

  it("omits flow headings for a single flow", () => {
    const el = mount(<OperationTimeline events={events} />);
    expect(el.querySelectorAll("h4")).toHaveLength(0);
  });

  it("explains an uncertain operation, from the operation status or from an event", () => {
    const a = mount(<OperationTimeline events={events} operation={operation({ status: "uncertain" })} />);
    expect(text(a)).toContain(UNCERTAIN_EXPLANATION);
    expect(text(a)).toContain("Nothing will retry this automatically");
    expect(a.querySelector('[role="status"]')).not.toBeNull(); // a warn callout is announced politely

    const b = mount(<OperationTimeline events={[event("operation.uncertain", { id: "u1" })]} />);
    expect(text(b)).toContain(UNCERTAIN_EXPLANATION);
  });

  it("says why a failed operation failed, as text, and warns that changes may have been made", () => {
    const el = mount(<OperationTimeline events={events} operation={operation({ status: "failed", error: "ECS refused the task definition" })} />);
    expect(text(el)).toContain("ECS refused the task definition");
    expect(text(el)).toContain("Some changes may have been made");
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("labels simulated events as simulated and does not show them as verified real state", () => {
    const el = mount(<OperationTimeline events={[event("resource.verified", { data: { simulated: true } })]} />);
    expect(text(el)).toContain("simulated");
    expect(text(el)).toContain("No real infrastructure was read");
  });

  it("renders event text as text, never as markup", () => {
    const el = mount(<OperationTimeline events={[event("operation.failed", { data: { message: '<img src=x onerror="window.__xss=1">' } })]} />);
    expect(el.querySelector("img")).toBeNull();
    expect(text(el)).toContain('<img src=x onerror="window.__xss=1">');
  });

  it("keeps secret-looking data keys out of the details", () => {
    const el = mount(<OperationTimeline events={[event("resource.applied", { data: { region: "ap-south-1", password: "hunter2", api_token: "t0k3n" } })]} />);
    expect(text(el)).toContain("ap-south-1");
    expect(text(el)).not.toContain("hunter2");
    expect(text(el)).not.toContain("t0k3n");
  });

  it("has an empty state that says what goes here", () => {
    const el = mount(<OperationTimeline events={[]} />);
    expect(text(el)).toContain("No events recorded yet");
    expect(text(el)).toContain("as the change is proposed, approved and run");
  });

  it("has a loading state that is announced and keeps the heading", () => {
    const el = mount(<OperationTimeline events={[]} loading />);
    expect(el.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(text(el)).toContain("Loading the timeline");
    expect(el.querySelector("h3")?.textContent).toBe("Timeline");
    expect(text(el)).not.toContain("No events recorded yet");
  });

  it("has an error state with a working retry", () => {
    const onRetry = vi.fn();
    const el = mount(<OperationTimeline events={[]} error="The event stream dropped." onRetry={onRetry} />);
    expect(text(el)).toContain("Could not load the timeline");
    expect(text(el)).toContain("The event stream dropped.");
    click(button(el, "Try again"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not offer a retry button it cannot honour", () => {
    const el = mount(<OperationTimeline events={[]} error="Unavailable." />);
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(text(el)).toContain("Reload the page to try again");
  });

  it("keeps heading order", () => {
    expect(headingsDoNotSkip(mount(<OperationTimeline events={events} />))).toBe(true);
  });
});
