"use client";
/** Platform navigation: a labelled landmark whose current page is exposed to assistive technology, not only by colour. */
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/format";

export const PLATFORM_LINKS: readonly { href: string; label: string }[] = [
  { href: "/platform", label: "Operations" },
  { href: "/platform/environments", label: "Environments" },
  { href: "/platform/releases", label: "Releases" },
  { href: "/platform/runbooks", label: "Runbooks" },
  { href: "/platform/readiness", label: "Readiness" },
  { href: "/platform/runners", label: "Runners" },
  { href: "/platform/source", label: "GitHub source" },
  { href: "/platform/plugins", label: "Plugins" },
  { href: "/platform/connections", label: "Connections" },
  { href: "/platform/connections/aws", label: "Connect AWS" },
  { href: "/platform/standing-grants", label: "Standing grants" },
  { href: "/platform/settings", label: "Workspace policy" },
];

/** Exact match for the root, prefix match elsewhere; the most specific link wins so only one is current. */
export function currentHref(pathname: string | null, links = PLATFORM_LINKS): string | undefined {
  if (!pathname) return undefined;
  const hits = links.filter((l) => (l.href === "/platform" ? pathname === "/platform" || pathname.startsWith("/platform/operations") || pathname.startsWith("/platform/deployments") : pathname === l.href || pathname.startsWith(`${l.href}/`)));
  return hits.sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function PlatformNav({ children }: { children?: ReactNode }) {
  const current = currentHref(usePathname());
  return <nav aria-label="Platform navigation" className="mb-6 border-b border-line pb-4">
    <ul className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
      {PLATFORM_LINKS.map((l) => <li key={l.href}><Link href={l.href} aria-current={current === l.href ? "page" : undefined} className={cx("rounded-ctl px-1 py-0.5 text-signal hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal", current === l.href && "font-medium underline underline-offset-4")}>{l.label}</Link></li>)}
      {children && <li className="text-signal">{children}</li>}
    </ul>
  </nav>;
}
