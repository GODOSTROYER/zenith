"use client";
import Link from "next/link";
import { Activity, AppWindow, BookOpen, Boxes, Code2, GitCompareArrows, LayoutDashboard, Plus, Radar, Rocket, Settings, ShieldCheck, Sparkles } from "lucide-react";
import { cx } from "@/lib/format";

export const PROJECT_DESTINATIONS = [
  { seg: "", label: "System", icon: Boxes },
  { seg: "source", label: "Source", icon: Code2 },
  { seg: "deploys", label: "Deploys", icon: Rocket },
  { seg: "revisions", label: "Revisions", icon: GitCompareArrows },
  { seg: "observe", label: "Observe", icon: Radar },
  { seg: "security", label: "Security", icon: ShieldCheck },
  { seg: "activity", label: "Activity", icon: Activity },
  { seg: "navigator", label: "Navigator", icon: Sparkles },
  { seg: "settings", label: "Settings", icon: Settings },
] as const;

/** Match a whole route segment, so /source-export never selects /source. */
export function isDestinationActive(pathname: string, href: string, exact = false) {
  return pathname === href || (!exact && pathname.startsWith(`${href}/`));
}

export function ShellNavigation({ pathname, slug, projectName, collapsed = false, onNavigate }: {
  pathname: string;
  slug?: string;
  projectName?: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const item = (href: string, label: string, Icon: typeof Boxes, exact = false, navigator = false) => (
    <Link key={href} href={href} onClick={onNavigate}
      aria-current={isDestinationActive(pathname, href, exact) ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cx("workbench-nav-link", navigator && "workbench-nav-navigator")}>
      <Icon size={17} strokeWidth={1.65} aria-hidden="true" />
      <span className={collapsed ? "sr-only" : "workbench-nav-label"}>{label}</span>
    </Link>
  );
  return (
    <nav aria-label="Main navigation" className="workbench-navigation" data-collapsed={collapsed}>
      {item("/overview", "Overview", LayoutDashboard)}
      {item("/apps", "Apps", AppWindow)}
      {slug && <div className="workbench-nav-group" aria-label="Project sections">
        {!collapsed && <p className="workbench-nav-caption" title={projectName}>{projectName ?? "Project"}</p>}
        {PROJECT_DESTINATIONS.map(({ seg, label, icon }) => item(`/p/${slug}${seg ? `/${seg}` : ""}`, label, icon, !seg, seg === "navigator"))}
      </div>}
      <div className="workbench-nav-group">
        {item("/onboarding?step=3", "New project", Plus, true)}
        {item("/guide", "Guide", BookOpen)}
      </div>
    </nav>
  );
}
