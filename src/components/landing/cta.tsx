"use client";
/**
 * The one part of the landing page that depends on who is asking.
 *
 * Everything else about the front door is the same for everyone and is
 * prerendered at build time (see src/app/page.tsx). The CTA is not, so it is
 * the only thing that goes to the network — `GET /api/me`, three booleans.
 *
 * The label must not flicker: the page paints the signed-out label immediately,
 * at the width of the widest label it could ever become, and swaps the text in
 * place when the answer lands. Nothing moves; `aria-busy` says the value is
 * still provisional so a screen reader is not told a wrong thing confidently.
 */
import { useJson } from "@/lib/client/api";
import { cx } from "@/lib/format";

export interface Me {
  signedIn: boolean;
  hasWorkspace: boolean;
  /** false = local demo mode: no accounts, so "signed out" is not a state */
  configured: boolean;
}

/** Every label the CTA can take. The box is always as wide as the widest. */
const LABELS = ["Create account", "Open Zenith.ai", "Start with Gimbal"] as const;
type Label = (typeof LABELS)[number];

/** The default until `/api/me` answers: signed out, no workspace. */
const SIGNED_OUT: Me = { signedIn: false, hasWorkspace: false, configured: true };

export interface Cta {
  href: string;
  label: React.ReactNode;
}

/** The same three states the server used to compute, from the same two facts. */
export function ctaFor(me: Me): { href: string; text: Label } {
  // Demo mode (no accounts configured) has no signed-out state at all.
  if (me.configured && !me.signedIn)
    return { href: "/signup", text: "Create account" };
  return me.hasWorkspace
    ? { href: "/overview", text: "Open Zenith.ai" }
    : { href: "/onboarding", text: "Start with Gimbal" };
}

/**
 * The CTA's destination and label. One fetch for the whole page — the four
 * places the CTA appears share this object, so they can never disagree.
 */
export function useCta(): Cta {
  // refreshMs 0: fetched once. Nothing on this page changes who you are.
  const { data, loading } = useJson<Me>("/api/me", 0);
  // A refused or failed /api/me (the auth middleware answers 401 to a signed-out
  // caller) is not a reason for a broken front door: keep the signed-out
  // default, which is a working link either way.
  const me = data ?? SIGNED_OUT;
  const { href, text } = ctaFor(me);
  return { href, label: <CtaLabel text={text} pending={loading && data === undefined} /> };
}

/**
 * Width-stable label. Every candidate occupies the same grid cell, so the
 * track is sized by the longest one and the swap costs no layout shift. The
 * hidden ones are `visibility: hidden`, which also keeps them out of the
 * accessibility tree — no screen reader reads four labels.
 */
function CtaLabel({ text, pending }: { text: Label; pending: boolean }) {
  return (
    <span className="inline-grid" aria-busy={pending || undefined}>
      {LABELS.map((l) => (
        <span
          key={l}
          className={cx("col-start-1 row-start-1 whitespace-nowrap", l !== text && "invisible")}
        >
          {l}
        </span>
      ))}
    </span>
  );
}
