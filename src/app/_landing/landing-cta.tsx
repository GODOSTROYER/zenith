"use client";

import Link from "next/link";
import { useRef, type MouseEventHandler } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Cta } from "./cta";
import { GLASS, useLiquidGlass } from "./liquid-glass";

export function LandingCta({ cta, className = "" }: { cta: Cta; className?: string }) {
  const waitlist = cta.href === "/waitlist" && !cta.signedIn;
  return <Link href={cta.href} className={`zenith-cta ${className}`} data-zenith-cta data-waitlist-trigger={waitlist ? "" : undefined} aria-haspopup={waitlist ? "dialog" : undefined}>{cta.label}<ArrowUpRight size={18} aria-hidden="true" /></Link>;
}

/** The same CTA as a clear liquid-glass lens, for the opening's sky. */
export function GlassCta({ cta, className = "", onClick }: { cta: Cta; className?: string; onClick?: MouseEventHandler<HTMLAnchorElement> }) {
  const lens = useRef<HTMLAnchorElement>(null);
  const waitlist = cta.href === "/waitlist" && !cta.signedIn;
  useLiquidGlass(lens, GLASS.button);
  return <Link ref={lens} href={cta.href} className={`zenith-cta zenith-cta-glass ${waitlist ? "zenith-cta-waitlist" : ""} ${className}`} aria-haspopup={waitlist ? "dialog" : undefined} data-waitlist-trigger={waitlist ? "" : undefined} onClick={onClick} data-zenith-cta>{waitlist && <span className="zenith-waitlist-dot" aria-hidden="true" />}{cta.label}<ArrowUpRight size={18} aria-hidden="true" /></Link>;
}
