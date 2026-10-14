import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PricingPage, { metadata } from "@/app/pricing/page";
import { PLAN_CTAS, SALES_EMAIL } from "@/app/pricing/plan-copy";
import { PLANS, ZCU_DEFINITION, listPlanViews } from "@/lib/billing/plans";

vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));

const html = renderToStaticMarkup(<PricingPage />);
const doc = new DOMParser().parseFromString(html, "text/html");
const text = doc.body.textContent ?? "";

describe("pricing page", () => {
  it("has the owner header copy and page metadata", () => {
    expect(doc.querySelector("h1")?.textContent).toBe("Zenith Pricing");
    expect(text).toContain("Deploy and manage applications in your cloud, or let Zenith host them.");
    expect(metadata.title).toBe("Pricing");
    expect(String(metadata.description)).toMatch(/Explore, Builder, Team and Enterprise/);
  });

  it("renders every plan name and price straight from the catalog", () => {
    const cards = [...doc.querySelectorAll("[data-plan]")];
    expect(cards.map((c) => c.getAttribute("data-plan"))).toEqual(Object.keys(PLANS));
    for (const plan of Object.values(PLANS)) {
      const card = doc.querySelector(`[data-plan="${plan.id}"]`)!;
      expect(card.querySelector("h2")?.textContent).toBe(plan.name);
      expect(card.textContent).toContain(plan.display.monthlyPrice);
      expect(card.textContent).toContain(plan.display.additionalUsage);
    }
    expect(text).toContain("$29/month minimum");
    expect(text).toContain("$199/month minimum");
    expect(text).toContain("$0.015 per ZCU-hour");
  });

  it("has an accessible comparison table with every owner row", () => {
    const table = doc.querySelector("table")!;
    expect(table.querySelector("caption")?.textContent).toBeTruthy();
    const heads = [...table.querySelectorAll("thead th")];
    expect(heads.map((h) => h.textContent)).toEqual(["Feature", ...Object.values(PLANS).map((p) => p.name)]);
    expect(heads.every((h) => h.getAttribute("scope") === "col")).toBe(true);
    const rowHeads = [...table.querySelectorAll("tbody th")];
    expect(rowHeads.every((h) => h.getAttribute("scope") === "row")).toBe(true);
    expect(rowHeads.map((h) => h.textContent)).toEqual([
      "Best for", "Monthly price", "Included management usage", "Additional management usage", "Architecture planning and cost estimates",
      "Application deployment and ongoing management", "Deployment approvals and audit records", "Organizational policies and team approval workflows",
      "Deployment options", "Support", "Get started",
    ]);
    for (const tr of table.querySelectorAll("tbody tr")) expect(tr.querySelectorAll("td")).toHaveLength(4);
  });

  it("defines the ZCU-hour and lists fair-use caps from the catalog", () => {
    expect(text).toContain(ZCU_DEFINITION);
    const fair = [...doc.querySelectorAll('ul[aria-label="Monthly fair-use limits"] li')].map((li) => li.textContent);
    expect(fair).toEqual([
      "Explore300 build minutes and 20 GB storage per month",
      "Builder2,000 build minutes and 100 GB storage per month",
      "Team10,000 build minutes and 500 GB storage per month",
      "EnterpriseSet by contract",
    ]);
    for (const view of listPlanViews()) {
      const { build_minutes: b, storage_gb_month: s } = view.meters;
      if (b.hardCap === undefined) continue;
      const li = fair.find((t) => t?.startsWith(view.name))!;
      expect(li).toContain(b.hardCap.toLocaleString("en-US"));
      expect(li).toContain(`${s.hardCap} GB`);
    }
  });

  it("states that nothing is charged yet and offers no checkout or payment form", () => {
    expect(text).toMatch(/Paid plans are not charged yet/);
    expect(text).toMatch(/no checkout/i);
    expect(doc.querySelector("form, input, button, iframe")).toBeNull();
    expect(html).not.toMatch(/stripe|card number|checkout\?|payment form/i);
  });

  it("links the calls to action to sign in and never to a dead sales link", () => {
    const links = [...doc.querySelectorAll("a")];
    for (const label of ["Explore free", "Choose Builder", "Choose Team"]) {
      const hrefs = links.filter((a) => a.textContent === label).map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual(["/login", "/login"]);
    }
    const sales = links.filter((a) => a.textContent === "Talk to sales");
    expect(PLAN_CTAS.enterprise.href).toBe(`mailto:${SALES_EMAIL}?subject=Zenith%20Enterprise`);
    expect(sales.length).toBeGreaterThan(0);
    for (const a of sales) expect(a.getAttribute("href")).toMatch(/^mailto:[^@\s]+@[^@\s]+\.[a-z]+/);
    expect(links.every((a) => a.getAttribute("href") && a.getAttribute("href") !== "#")).toBe(true);
  });
});
