"use client";

import Link from "next/link";
import { useRef } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Cta } from "./cta";
import { GLASS, useLiquidGlass } from "./liquid-glass";

export function LandingCta({ cta, className = "" }: { cta: Cta; className?: string }) {
  return <Link href={cta.href} className={`zenith-cta ${className}`} data-zenith-cta>{cta.label}<ArrowUpRight size={18} aria-hidden="true" /></Link>;
}

/** The same CTA as a clear liquid-glass lens, for the opening's sky. */
export function GlassCta({ cta, className = "" }: { cta: Cta; className?: string }) {
  const lens = useRef<HTMLAnchorElement>(null);
  useLiquidGlass(lens, GLASS.button);
  return <Link ref={lens} href={cta.href} className={`zenith-cta zenith-cta-glass ${className}`} data-zenith-cta>{cta.label}<ArrowUpRight size={18} aria-hidden="true" /></Link>;
}
