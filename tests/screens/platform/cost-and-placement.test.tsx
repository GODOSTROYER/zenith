import { describe, expect, it, vi } from "vitest";
import { CostEstimateCard } from "@/components/platform/cost-estimate-card";
import { PlacementComparison, candidateLabel } from "@/components/platform/placement-comparison";
import { button, click, headingsDoNotSkip, mount, text } from "./render";
import { estimate, placementResult, plainEstimate } from "./fixtures";

describe("<CostEstimateCard>", () => {
  it("is always titled 'Estimate' and says the total is an estimate, not an invoice", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    expect(el.querySelector("h3")?.textContent).toBe("Estimate");
    expect(text(el)).toContain("$120.00");
    expect(text(el)).toContain("per month, estimate");
    expect(text(el)).toContain("not an invoice");
    // also titled Estimate while loading, failing and empty
    for (const node of [mount(<CostEstimateCard loading />), mount(<CostEstimateCard error="x" />), mount(<CostEstimateCard />)]) {
      expect(node.querySelector("h3")?.textContent).toBe("Estimate");
    }
  });

  it("uses the context in the subtitle without dropping the not-an-invoice note", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} context="Standard SaaS on AWS in ap-south-1" />);
    expect(text(el)).toContain("Standard SaaS on AWS in ap-south-1. List prices, not an invoice.");
  });

  it("shows the catalog version and when it was computed", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    expect(text(el)).toContain("Catalog 2026-09-30.1");
    expect(text(el)).toContain("Computed");
  });

  it("shows each line with its basis, quantity times unit price, and monthly amount", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    const rows = [...el.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(4);
    const compute = rows.find((r) => text(r).includes("Container service compute"))!;
    expect(text(compute)).toContain("730 h/month x 1 task x 1 vCPU");
    expect(text(compute)).toContain("730 × $0.04048 per hour");
    expect(text(compute)).toContain("$29.55");
    expect(text(compute)).toContain("service/web");
  });

  it("flags weak price evidence on each weak line and not on strong ones", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    const row = (name: string) => [...el.querySelectorAll("tbody tr")].find((r) => text(r).includes(name))!;
    expect(row("Cache node").getAttribute("data-weak-price")).toBe("true");
    expect(text(row("Cache node"))).toContain("Weak: remembered price");
    expect(row("Database storage").getAttribute("data-weak-price")).toBe("true");
    expect(text(row("Database storage"))).toContain("Weak: derived price");
    expect(row("Managed tier").getAttribute("data-weak-price")).toBe("true");
    expect(text(row("Managed tier"))).toContain("Weak: Zenith assumption");
    expect(row("Container service compute").getAttribute("data-weak-price")).toBeNull();
    expect(text(row("Container service compute"))).toContain("Official price feed");
    expect(text(row("Container service compute"))).not.toContain("Weak");
  });

  it("explains each weak class on hover", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    const chip = [...el.querySelectorAll("tbody span[title]")].find((c) => text(c).includes("remembered price"))!;
    expect(chip.getAttribute("title")).toContain("Not read from any price feed and may be out of date");
  });

  it("summarises the weak evidence above the table, with its share of the total", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    const callout = el.querySelector('[role="status"]')!;
    expect(text(callout)).toContain("Some prices rest on weak evidence");
    expect(text(callout)).toContain("3 of 4 lines (75% of this estimate)");
    expect(text(callout)).toContain("refresh the catalog before relying on it");
  });

  it("shows no weak-evidence notice when every price is from an official source", () => {
    const e = estimate();
    e.lines = e.lines.map((l) => ({ ...l, priceVerification: "official_api" as const }));
    const el = mount(<CostEstimateCard estimate={e} />);
    expect(text(el)).not.toContain("weak evidence");
    expect(el.querySelector("[data-weak-price]")).toBeNull();
  });

  it("does not call unrecorded sources weak, and says they are unrecorded", () => {
    const el = mount(<CostEstimateCard estimate={plainEstimate() as never} />);
    expect(text(el)).toContain("Source not recorded");
    expect(text(el)).not.toContain("weak evidence");
  });

  it("lists what is included and what is not, and never reads an empty exclusion list as 'nothing excluded'", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    expect(text(el)).toContain("NAT gateway hours");
    expect(text(el)).toContain("Not included, so real bills can be higher");
    expect(text(el)).toContain("Data transfer between regions");
    const none = mount(<CostEstimateCard estimate={estimate({ excluded: [], included: [] })} />);
    expect(text(none)).toContain("No exclusions were recorded. That does not mean every cost is covered.");
    expect(text(none)).toContain("No included costs were listed.");
  });

  it("lists the usage assumptions", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    expect(text(el)).toContain("Usage this estimate assumes");
    const dl = [...el.querySelectorAll("dl")].find((d) => text(d).includes("Egress gb"))!;
    expect(text(dl)).toContain("50");
  });

  it("can drop the line table but keeps the evidence summary", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} compact />);
    expect(el.querySelector("table")).toBeNull();
    expect(text(el)).toContain("Some prices rest on weak evidence");
  });

  it("says a line-less estimate has no priced lines", () => {
    expect(text(mount(<CostEstimateCard estimate={estimate({ lines: [], monthlyUsd: 0 })} />))).toContain("This estimate has no priced lines.");
  });

  it("has empty, loading and error states", () => {
    expect(text(mount(<CostEstimateCard />))).toContain("No estimate yet");
    expect(mount(<CostEstimateCard loading />).querySelector('[aria-busy="true"]')).not.toBeNull();
    const onRetry = vi.fn();
    const failed = mount(<CostEstimateCard error="Pricing is unavailable." onRetry={onRetry} />);
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("labels its tables and keeps heading order", () => {
    const el = mount(<CostEstimateCard estimate={estimate()} />);
    expect(el.querySelector("table caption")?.textContent?.length).toBeGreaterThan(10);
    expect(headingsDoNotSkip(el)).toBe(true);
  });
});

describe("<PlacementComparison>", () => {
  it("compares the chosen option with its alternatives, labelled by where they run", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    const heads = [...el.querySelectorAll('thead th[scope="col"]')].map(text).filter((t) => t !== "Comparison");
    expect(heads[0]).toContain("AWS ap-south-1");
    expect(heads[0]).toContain("Chosen");
    expect(heads[1]).toContain("AWS ap-south-1 + Azure centralindia");
    expect(text(el)).not.toContain("cand_aws_mumbai"); // ids are not the label
  });

  it("labels every cost as an estimate with its catalog version", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    const row = [...el.querySelectorAll("tbody tr")].find((r) => text(r.querySelector("th")!) === "Monthly estimate")!;
    const cells = [...row.querySelectorAll("td")].map(text);
    expect(cells[0]).toContain("$120.00");
    expect(cells[0]).toContain("estimate · catalog 2026-09-30.1");
    expect(cells[1]).toContain("$98.40");
    expect(text(el)).toContain("Costs are estimates");
  });

  it("flags candidates whose price rests on weak evidence", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    const row = [...el.querySelectorAll("tbody tr")].find((r) => text(r.querySelector("th")!) === "Monthly estimate")!;
    expect(text(row.querySelectorAll("td")[0])).toContain("3 weak prices");
    // the alternative keeps only the official-feed line
    expect(text(row.querySelectorAll("td")[1])).not.toContain("weak");
  });

  it("shows where each component runs in words", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    const db = [...el.querySelectorAll("tbody tr")].find((r) => text(r.querySelector("th")!).startsWith("resource/db"))!;
    const cells = [...db.querySelectorAll("td")].map(text);
    expect(cells[0]).toContain("AWS ap-south-1");
    expect(cells[1]).toContain("Azure centralindia");
    expect(cells[1]).toContain("azure:postgres_flexible");
  });

  it("shows estimated latency, cross-cloud traffic with its cost, the score and warnings", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    const row = (label: string) => [...el.querySelectorAll("tbody tr")].find((r) => text(r.querySelector("th")!).startsWith(label))!;
    expect(text(row("Latency"))).toContain("India 38 ms");
    expect(text(row("Latency"))).toContain("India 61 ms");
    expect(text(row("Latency"))).toContain("estimated");
    const traffic = [...row("Traffic").querySelectorAll("td")].map(text);
    expect(traffic[0]).toBe("None");
    expect(traffic[1]).toContain("service/web → resource/db");
    expect(traffic[1]).toContain("Across clouds");
    expect(traffic[1]).toContain("$4.50/mo estimate");
    expect(traffic[1]).toContain("+23 ms");
    expect(text(row("Solver score"))).toContain("41.25");
    expect(text(row("Solver score"))).toContain("lower is better");
    expect(text(row("Warnings"))).toContain("Traffic between the web service and the database leaves AWS");
  });

  it("lists options that were ruled out, with reasons", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    const section = el.querySelector('section[aria-label="Ruled out"]')!;
    expect(text(section)).toContain("cand_us_east");
    expect(text(section)).toContain("Violates the India data residency requirement.");
  });

  it("says when a rejected option has no recorded reason", () => {
    const el = mount(<PlacementComparison result={placementResult({ rejected: [{ id: "x", reasons: [] }] })} />);
    expect(text(el)).toContain("No reason was recorded.");
  });

  it("keeps the price lines per option behind a disclosure, with weak evidence flagged inside", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    const detail = [...el.querySelectorAll("details")].find((d) => text(d.querySelector("summary")!).includes("(chosen): price lines"))!;
    expect(text(detail)).toContain("Weak: remembered price");
  });

  it("states the assumptions, catalog version and determinism", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    expect(text(el)).toContain("50 GB of internet egress per month.");
    expect(text(el)).toContain("Price catalog 2026-09-30.1");
    expect(text(el)).toContain("seed-7f3a");
  });

  it("does not recommend anything when nothing meets the constraints, and says why", () => {
    const el = mount(<PlacementComparison result={placementResult({ chosen: undefined, alternatives: [] })} />);
    expect(text(el)).toContain("No placement meets every constraint");
    expect(text(el)).toContain("not recommending one");
    expect(text(el)).toContain("Violates the India data residency requirement.");
    expect(el.querySelector("table")).toBeNull();
  });

  it("has empty, loading and error states", () => {
    expect(text(mount(<PlacementComparison />))).toContain("No placement result yet");
    expect(mount(<PlacementComparison loading />).querySelector('[aria-busy="true"]')).not.toBeNull();
    const onRetry = vi.fn();
    const failed = mount(<PlacementComparison error="The solver is unavailable." onRetry={onRetry} />);
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("uses column and row headers and keeps heading order", () => {
    const el = mount(<PlacementComparison result={placementResult()} />);
    expect(el.querySelector("table caption")?.textContent).toBe("Placement options compared");
    expect(el.querySelectorAll('tbody th[scope="row"]').length).toBeGreaterThan(4);
    expect(headingsDoNotSkip(el)).toBe(true);
  });
});

describe("candidateLabel", () => {
  it("names providers and regions, sorted and deduplicated", () => {
    expect(
      candidateLabel({
        assignments: {
          a: { provider: "azure", region: "centralindia", nativeType: "x" },
          b: { provider: "aws", region: "ap-south-1", nativeType: "y" },
          c: { provider: "aws", region: "ap-south-1", nativeType: "z" },
        },
      })
    ).toBe("AWS ap-south-1 + Azure centralindia");
    expect(candidateLabel({ assignments: {} })).toBe("No assignments");
    expect(candidateLabel({ assignments: { a: { provider: "newcloud", region: "r1", nativeType: "x" } } })).toBe("Newcloud r1");
  });
});
