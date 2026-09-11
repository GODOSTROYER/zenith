"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Menu, Moon, Sun, X } from "lucide-react";
import { Wordmark } from "@/components/shell/wordmark";
import { LandingCta } from "./landing-cta";
import type { Cta } from "./cta";

const LINKS = [
  { href: "#change-demo", label: "The change" },
  { href: "#model-surfaces", label: "The platform" },
  { href: "#providers", label: "Providers" },
];

export function LandingHeader({ cta }: { cta: Cta }) {
  const [open, setOpen] = useState(false);
  const [light, setLight] = useState(true);
  useEffect(() => {
    const sync = () => setLight(document.documentElement.dataset.theme === "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const preference = window.matchMedia("(prefers-color-scheme: light)");
    const followSystem = () => {
      try {
        if (localStorage.getItem("orrery-theme") !== "system") return;
        if (preference.matches) document.documentElement.dataset.theme = "light";
        else document.documentElement.removeAttribute("data-theme");
      } catch { /* An explicit theme selection still works without storage. */ }
    };
    preference.addEventListener("change", followSystem);
    return () => { observer.disconnect(); preference.removeEventListener("change", followSystem); };
  }, []);
  const toggleTheme = () => {
    const next = !light;
    if (next) document.documentElement.dataset.theme = "light";
    else document.documentElement.removeAttribute("data-theme");
    setLight(next);
    try { localStorage.setItem("orrery-theme", next ? "light" : "dark"); } catch { /* The selected theme still applies without persistence. */ }
  };
  return (
    <header className="zenith-header">
      <div className="zenith-header-inner">
        <a href="#main" aria-label="Zenith home" className="zenith-home"><Wordmark size={29} /></a>
        <nav className="zenith-desktop-nav" aria-label="Main navigation">
          {LINKS.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}
          <Link href="/guide">Guide <ArrowUpRight size={12} aria-hidden="true" /></Link>
        </nav>
        <div className="zenith-header-actions">
          <button type="button" className="zenith-icon-button" aria-label={`Switch to ${light ? "dark" : "light"} theme`} title={`Switch to ${light ? "dark" : "light"} theme`} onClick={toggleTheme}>{light ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}</button>
          <Link href="/login" className="zenith-sign-in">Sign in</Link>
          <LandingCta cta={cta} className="zenith-header-cta" />
          <button type="button" className="zenith-icon-button zenith-menu-button" aria-expanded={open} aria-controls="zenith-mobile-nav" aria-label={open ? "Close navigation" : "Open navigation"} onClick={() => setOpen(!open)}>{open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}</button>
        </div>
      </div>
      {open && <nav id="zenith-mobile-nav" className="zenith-mobile-nav" aria-label="Mobile navigation" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); document.querySelector<HTMLButtonElement>('.zenith-menu-button')?.focus(); } }}>
        {LINKS.map((link) => <a key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}<ArrowUpRight size={18} aria-hidden="true" /></a>)}
        <Link href="/guide" onClick={() => setOpen(false)}>Workspace guide<ArrowUpRight size={18} aria-hidden="true" /></Link>
        <LandingCta cta={cta} />
      </nav>}
    </header>
  );
}
