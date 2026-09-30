import { describe, expect, it, vi } from "vitest";
import { DriftList, groupFindings, repairSentence } from "@/components/platform/drift-list";
import { button, click, headingsDoNotSkip, mount, text } from "./render";
import { driftReport } from "./fixtures";

describe("<DriftList>", () => {
  it("groups findings by class, most worrying class first, with a sentence for each", () => {
    const el = mount(<DriftList report={driftReport()} />);
    const sections = [...el.querySelectorAll("section[data-drift-class]")];
    expect(sections.map((s) => s.getAttribute("data-drift-class"))).toEqual(["missing", "changed", "extra"]);
    expect(text(sections[0])).toContain("The configuration says these should exist, but the provider does not have them.");
    expect(text(sections[1])).toContain("Changed");
    expect(text(sections[2])).toContain("Not in the configuration"); // the class `extra` is shown as a label, not a code
    expect(text(el)).not.toMatch(/\bextra\b/);
  });

  it("orders findings within a class by severity, then address", () => {
    const el = mount(<DriftList report={driftReport()} />);
    const changed = el.querySelector('section[data-drift-class="changed"]')!;
    const order = [...changed.querySelectorAll("li > div:first-child > span.font-mono")].map(text);
    expect(order).toEqual(["resource/db", "service/web"]); // high before medium
  });

  it("shows severity in words", () => {
    const el = mount(<DriftList report={driftReport()} />);
    expect(text(el)).toContain("High severity");
    expect(text(el)).toContain("Medium severity");
    expect(text(el)).toContain("Low severity");
  });

  it("explains repairability from each finding's own flags", () => {
    expect(repairSentence({ repairable: false, autoRepairEligible: false })).toContain("will not repair this");
    expect(repairSentence({ repairable: true, autoRepairEligible: true })).toContain("Eligible for automatic repair where the environment's autonomy level and policy allow it");
    expect(repairSentence({ repairable: true, autoRepairEligible: false })).toContain("never repaired automatically");

    const el = mount(<DriftList report={driftReport()} />);
    const item = (addr: string) => [...el.querySelectorAll("li")].find((li) => li.querySelector(".font-mono")?.textContent === addr)!;
    expect(text(item("service/web"))).toContain("Auto-repair eligible");
    expect(text(item("resource/db"))).toContain("Repair needs approval");
    expect(text(item("resource/db"))).toContain("never repaired automatically");
    expect(text(item("firewall/old"))).toContain("Not repairable");
    expect(text(item("firewall/old"))).toContain("Zenith will not repair this");
  });

  it("lists changed attributes with desired and observed values, masking secrets", () => {
    const el = mount(<DriftList report={driftReport()} />);
    const web = [...el.querySelectorAll("li")].find((li) => li.querySelector(".font-mono")?.textContent === "service/web")!;
    const rows = [...web.querySelectorAll("tbody tr")].map((r) => [...r.children].map(text));
    expect(rows[0]).toEqual(["image", "web:4", "web:3"]);
    expect(rows[1]).toEqual(["db_password", "(sensitive)", "(sensitive)"]);
    expect(text(el)).not.toContain("hunter2");
  });

  it("shows a value the provider did not report as 'Not reported', never blank", () => {
    const report = driftReport({
      unobserved: [],
      findings: [{ address: "a", class: "changed", severity: "low", repairable: true, autoRepairEligible: true, explanation: "x", fields: [{ attribute: "size", desired: "large", observed: undefined }] }],
    });
    const el = mount(<DriftList report={report} />);
    expect([...el.querySelectorAll("tbody tr")].map((r) => [...r.children].map(text))).toEqual([["size", "large", "Not reported"]]);
  });

  it("lists resources that could not be checked and says they are not reported as matching", () => {
    const el = mount(<DriftList report={driftReport()} />);
    const section = el.querySelector('section[aria-label="Could not be checked"]')!;
    expect(text(section)).toContain("resource/cache");
    expect(text(section)).toContain("not reported as matching");
  });

  it("never says 'No drift' while resources could not be checked", () => {
    const el = mount(<DriftList report={driftReport({ findings: [] })} />);
    expect(text(el)).not.toContain("No drift found");
    expect(text(el)).toContain("No differences in what Zenith could read");
    expect(text(el)).toContain("1 resource could not be checked, so this is not a clean result.");
  });

  it("says 'No drift found' only for a clean report, and scopes the claim for a simulation", () => {
    const real = mount(<DriftList report={driftReport({ findings: [], unobserved: [] })} />);
    expect(text(real)).toContain("No drift found");
    expect(text(real)).toContain("Everything Zenith could read matches");
    const sim = mount(<DriftList report={driftReport({ findings: [], unobserved: [], simulated: true })} />);
    expect(text(sim)).toContain("simulated");
    expect(text(sim)).toContain("That is a statement about the simulation");
  });

  it("labels a simulated report as simulated", () => {
    expect(text(mount(<DriftList report={driftReport({ simulated: true })} />))).toContain("simulated");
    expect(text(mount(<DriftList report={driftReport()} />))).not.toContain("simulated");
  });

  it("selects a finding only when the host handles selection", () => {
    const plain = mount(<DriftList report={driftReport()} />);
    expect(plain.querySelectorAll("button")).toHaveLength(0);
    const onSelect = vi.fn();
    const el = mount(<DriftList report={driftReport()} onSelect={onSelect} selectedAddress="service/web" />);
    click(button(el, "resource/db"));
    expect(onSelect).toHaveBeenCalledWith("resource/db");
    expect(button(el, "service/web").getAttribute("aria-pressed")).toBe("true");
  });

  it("gives the host a slot for actions on a finding", () => {
    const el = mount(<DriftList report={driftReport()} renderActions={(f) => <button type="button">Propose repair for {f.address}</button>} />);
    expect(button(el, "Propose repair for resource/db")).toBeDefined();
  });

  it("has a clear empty state for no report, with the host's action", () => {
    const el = mount(<DriftList checkAction={<button type="button">Check now</button>} />);
    expect(text(el)).toContain("Drift has not been checked yet");
    expect(text(el)).toContain("Zenith cannot say whether anything differs");
    expect(button(el, "Check now")).toBeDefined();
  });

  it("has loading and error states", () => {
    expect(mount(<DriftList loading />).querySelector('[aria-busy="true"]')).not.toBeNull();
    const onRetry = vi.fn();
    const failed = mount(<DriftList error="The drift check failed." onRetry={onRetry} />);
    expect(text(failed)).toContain("Could not load the drift report");
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows when it was checked, and keeps heading order", () => {
    const el = mount(<DriftList report={driftReport()} />);
    expect(text(el)).toContain("Checked");
    expect(text(el)).toContain("9f86d081884c");
    expect(headingsDoNotSkip(el)).toBe(true);
  });
});

describe("groupFindings", () => {
  it("drops empty classes and keeps the documented order", () => {
    const g = groupFindings(driftReport().findings);
    expect(g.map((x) => x.class)).toEqual(["missing", "changed", "extra"]);
    expect(groupFindings([])).toEqual([]);
  });
});
