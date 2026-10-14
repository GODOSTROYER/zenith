import type { PlanView } from "@/lib/billing/plans";

/**
 * Presentational copy for /pricing only. Every number (prices, the usage rate, fair-use caps) is read from the plan
 * catalog in `@/lib/billing/plans`; nothing here repeats one.
 */
/** The contact address already published in the terms of service; there is no separate sales mailbox. */
export const SALES_EMAIL = "support@tryzenith.cloud";

export interface PlanCta { label: string; href: string | null }

export const PLAN_CTAS: Readonly<Record<string, PlanCta>> = Object.freeze({
  explore: { label: "Explore free", href: "/login" },
  builder: { label: "Choose Builder", href: "/login" },
  team: { label: "Choose Team", href: "/login" },
  enterprise: { label: "Talk to sales", href: `mailto:${SALES_EMAIL}?subject=Zenith%20Enterprise` },
});

export const HEADER_TITLE = "Zenith Pricing";
/** Public status line: the same facts as PLAN_NOTICE, worded for visitors. */
export const PUBLIC_STATUS = "These are Zenith's launch prices, approved on 13 October 2026. Paid plans are not charged yet: " +
  "billing starts once payment processing and our terms review are complete, so there is no checkout on this page.";
export const HEADER_LEAD = "Deploy and manage applications in your cloud, or let Zenith host them.";

export const ctaFor = (plan: PlanView): PlanCta => PLAN_CTAS[plan.id] ?? { label: plan.name, href: null };

const grouped = (n: number): string => n.toLocaleString("en-US");
export const fairUseLine = (plan: PlanView): string => {
  const { build_minutes: b, storage_gb_month: s } = plan.meters;
  return b.hardCap === undefined || s.hardCap === undefined
    ? "Set by contract"
    : `${grouped(b.hardCap)} build minutes and ${grouped(s.hardCap)} GB storage per month`;
};
