"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { OrbitMark, Wordmark } from "@/components/shell/wordmark";
import { LandingCta } from "./landing-cta";
import type { Cta } from "./cta";
import { CHAPTERS } from "./landing-state";
import { useHeaderState } from "./landing-motion";
import { GLASS, useLiquidGlass } from "./liquid-glass";

const LINKS = CHAPTERS.filter((c) => c.nav).map((c) => ({ href: `#${c.id}`, label: c.nav as string }));

/** A floating liquid-glass capsule; its text follows whatever it floats over (`data-tone`). */
export function LandingHeader({ cta }: { cta: Cta }) {
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useHeaderState(header);
  useLiquidGlass(bar, GLASS.bar, { tone: true });
  return (
    <header ref={header} className="zenith-header" data-solid="false" data-glass-skip>
      <div ref={bar} className="zenith-header-inner" data-tone="dark">
        <Link href="/" aria-label="Zenith home" className="zenith-home"><span className="zenith-home-mark"><OrbitMark size={30} /></span><span className="zenith-home-word"><Wordmark size={26} /></span></Link>
        <nav className="zenith-desktop-nav" aria-label="Main navigation">
          {LINKS.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}
          <Link href="/guide">Guide <ArrowUpRight size={12} aria-hidden="true" /></Link>
        </nav>
        <div className="zenith-header-actions">
          <Link href="/login" className="zenith-sign-in">Sign in</Link>
          <LandingCta cta={cta} className="zenith-header-cta" />
          <button type="button" className="zenith-icon-button zenith-menu-button" aria-expanded={open} aria-controls="zenith-mobile-nav" aria-label={open ? "Close navigation" : "Open navigation"} onClick={() => setOpen(!open)}>{open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}</button>
        </div>
      </div>
      {open && <nav id="zenith-mobile-nav" className="zenith-mobile-nav" aria-label="Mobile navigation" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); document.querySelector<HTMLButtonElement>('.zenith-menu-button')?.focus(); } }}>
        {LINKS.map((link) => <a key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}<ArrowUpRight size={18} aria-hidden="true" /></a>)}
        <Link href="/guide" onClick={() => setOpen(false)}>Workspace guide<ArrowUpRight size={18} aria-hidden="true" /></Link>
        <Link href="/login" onClick={() => setOpen(false)}>Sign in<ArrowUpRight size={18} aria-hidden="true" /></Link>
      </nav>}
    </header>
  );
}
