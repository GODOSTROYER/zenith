"use client";
/** Public entry state is fetched once and shared by every landing action. */
import { useJson } from "@/lib/client/api";
import { cx } from "@/lib/format";

export interface Me {
  signedIn: boolean;
  hasWorkspace: boolean;
  configured: boolean;
  waitlistRequired?: boolean;
}
const LABELS = ["Create account", "Open Zenith", "Continue setup", "Join waitlist", "Check access", "Start with Gimbal"] as const;
type Label = (typeof LABELS)[number];
// A real, safe destination while identity is loading or unavailable.
const SIGNED_OUT: Me = { signedIn: false, hasWorkspace: false, configured: true, waitlistRequired: true };
export interface Cta {
  href: string;
  label: React.ReactNode;
  signedIn?: boolean;
  pending?: boolean;
}
export function ctaFor(me: Me): { href: string; text: Label } {
  if (me.configured && me.waitlistRequired)
    return { href: "/waitlist", text: me.signedIn ? "Check access" : "Join waitlist" };
  if (me.configured && !me.signedIn)
    return { href: "/signup", text: "Create account" };
  return me.hasWorkspace
    ? { href: "/overview", text: "Open Zenith" }
    : { href: "/onboarding", text: me.configured ? "Continue setup" : "Start with Gimbal" };
}
export function useCta(): Cta {
  const { data, loading } = useJson<Me>("/api/me", 0);
  const me = data ?? SIGNED_OUT;
  const { href, text } = ctaFor(me);
  const pending = loading && data === undefined;
  return { href, label: <CtaLabel text={text} pending={pending} />, signedIn: me.signedIn || !me.configured, pending };
}
function CtaLabel({ text, pending }: { text: Label; pending: boolean }) {
  return <span className="inline-grid" aria-busy={pending || undefined}>
    {LABELS.map(label => <span key={label} className={cx("col-start-1 row-start-1 whitespace-nowrap", label !== text && "invisible")}>{label}</span>)}
  </span>;
}
