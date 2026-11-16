import { describe, expect, it, vi } from "vitest";
import { InvestigationView } from "@/components/platform/investigation-view";
import { button, click, headingsDoNotSkip, mount, text } from "./render";
import { investigation } from "./fixtures";

describe("<InvestigationView>", () => {
  it("prints the reading note: evidence is data, hypotheses are rules", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    expect(text(el)).toContain("Evidence is observed data; hypotheses are rule-based.");
    expect(text(el)).toContain("not a probability");
  });

  it("shows the request path in order with each hop's status in words", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    const hops = [...el.querySelectorAll("li[data-hop-status]")];
    expect(hops.map((h) => text(h))).toEqual([
      "DNSdns_record/appHealthy",
      "Load balancerload_balancer/mainHealthy",
      "Firewallfirewall/web-to-dbFailing",
      "Databaseresource/dbUnknown",
    ]);
    expect(hops.map((h) => h.getAttribute("data-hop-status"))).toEqual(["healthy", "healthy", "failing", "unknown"]);
    expect(text(el)).not.toContain("load_balancer ");
  });

  it("says nothing is known when no hop was traversed", () => {
    const el = mount(<InvestigationView investigation={investigation({ path: [] })} />);
    expect(text(el)).toContain("nothing about the request path is known");
  });

  it("sorts hypotheses by confidence and shows the number from the data", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    const titles = [...el.querySelectorAll("article h5")].map(text);
    expect(titles).toEqual(["The database security group blocks the web service", "The latest deployment introduced a regression"]);
    const meters = [...el.querySelectorAll('[role="meter"]')];
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual(["82", "18"]);
    expect(text(el)).toContain("82%");
    expect(text(el)).toContain("18%");
    expect(text(el)).toContain("Highest confidence");
    expect(el.querySelectorAll("article")[0].getAttribute("data-rank")).toBe("0");
  });

  it("does not invent a confidence when the number is unusable", () => {
    const inv = investigation();
    inv.hypotheses[0] = { ...inv.hypotheses[0], confidence: Number.NaN };
    const el = mount(<InvestigationView investigation={inv} />);
    expect(text(el)).toContain("Confidence unavailable for this hypothesis.");
    expect(el.querySelectorAll('[role="meter"]')).toHaveLength(1);
  });

  it("shows supporting and contradicting evidence in expandable sections with counts", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    const summaries = [...el.querySelectorAll("summary")].map(text);
    expect(summaries).toContain("Supporting evidence (2)");
    expect(summaries).toContain("Supporting evidence (1)");
    expect(summaries).toContain("Contradicting evidence (1)");
    const support = [...el.querySelectorAll("details")].find((d) => text(d.querySelector("summary")!) === "Supporting evidence (2)")!;
    expect(text(support)).toContain("The database security group does not allow port 5432 from the web service.");
    expect(text(support)).toContain("Failed");
    expect(text(support)).toContain("aws.ec2.DescribeSecurityGroups");
  });

  it("reports evidence a hypothesis cites that is missing from the investigation", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    expect(text(el)).toContain("cites evidence ev_missing, but it is not included in this investigation");
  });

  it("shows remediation risk and 'needs approval' from the data", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    const rem = el.querySelector("article h6 + ul > li")!;
    expect(text(rem)).toContain("Allow the web service to reach the database on port 5432");
    expect(text(rem)).toContain("Firewall modify"); // a readable fallback, not the capability code
    expect(text(rem)).toContain("high");
    expect(text(rem)).toContain("Needs approval");
    expect(text(rem)).toContain("Reversible: the added rule can be removed.");
    expect(text(rem)).toContain("The web service can open connections to the database again.");
    expect(text(rem)).not.toContain("firewall.modify");
  });

  it("uses catalog titles when given", () => {
    const el = mount(<InvestigationView investigation={investigation()} capabilityTitles={{ "firewall.modify": "Modify firewall rules" }} />);
    expect(text(el)).toContain("Modify firewall rules");
  });

  it("says 'Runs without approval' only when the data says approval is not required", () => {
    const inv = investigation();
    inv.hypotheses[1].remediations[0] = { ...inv.hypotheses[1].remediations[0], approvalRequired: false, risk: "low" };
    const el = mount(<InvestigationView investigation={inv} />);
    expect(text(el.querySelector("article h6 + ul > li")!)).toContain("Runs without approval");
  });

  it("draws no propose button unless the host handles it", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    expect([...el.querySelectorAll("button")].some((b) => text(b).includes("Propose"))).toBe(false);
  });

  it("proposes a fix through the host and says what that does", () => {
    const onPropose = vi.fn();
    const el = mount(<InvestigationView investigation={investigation()} onProposeRemediation={onPropose} />);
    click(button(el, "Propose this fix"));
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(onPropose.mock.calls[0][0].id).toBe("rem_1");
    expect(onPropose.mock.calls[0][1].id).toBe("h_high");
    expect(text(el)).toContain("Nothing runs until policy and any required approval allow it.");
  });

  it("disables proposing with a reason when the host says so", () => {
    const onPropose = vi.fn();
    const el = mount(<InvestigationView investigation={investigation()} onProposeRemediation={onPropose} proposeDisabledReason="Only editors can propose fixes." />);
    const b = button(el, "Propose this fix");
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("title")).toBe("Only editors can propose fixes.");
    click(b);
    expect(onPropose).not.toHaveBeenCalled();
  });

  it("does not claim 'nothing is wrong' when no hypothesis matched", () => {
    const el = mount(<InvestigationView investigation={investigation({ hypotheses: [] })} />);
    expect(text(el)).toContain("No hypothesis matched the evidence");
    expect(text(el)).toContain("not the same as nothing being wrong");
    expect(text(el)).toContain("1 check passing, 1 failing and 1 inconclusive");
  });

  it("labels a simulated investigation and its evidence", () => {
    const inv = investigation({ simulated: true });
    inv.evidence[0] = { ...inv.evidence[0], simulated: true };
    const el = mount(<InvestigationView investigation={inv} />);
    expect(text(el)).toContain("simulated");
    expect(text(mount(<InvestigationView investigation={investigation()} />))).not.toContain("simulated");
  });

  it("lists recent changes and every check that ran", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    expect(text(el)).toContain("What changed recently");
    expect(text(el)).toContain("Revision r7 was deployed");
    expect(text(el)).toContain("All checks that ran (3)");
  });

  it("renders evidence text as text, never as markup", () => {
    const inv = investigation();
    inv.evidence[0] = { ...inv.evidence[0], finding: '<img src=x onerror="window.__xss=1">' };
    const el = mount(<InvestigationView investigation={inv} />);
    expect(el.querySelector("img")).toBeNull();
  });

  it("has empty, loading and error states", () => {
    expect(text(mount(<InvestigationView />))).toContain("No investigation yet");
    expect(mount(<InvestigationView loading />).querySelector('[aria-busy="true"]')).not.toBeNull();
    const onRetry = vi.fn();
    const failed = mount(<InvestigationView error="The investigation could not be loaded." onRetry={onRetry} />);
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("keeps heading order (h3 card, h4 sections, h5 hypotheses, h6 fixes)", () => {
    const el = mount(<InvestigationView investigation={investigation()} />);
    expect(headingsDoNotSkip(el)).toBe(true);
  });
});
