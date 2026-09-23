"use client";
/**
 * The first moment of every full page load (the landing, sign in, the app): the ink ground with the
 * Zenith loader assembling. It is server-rendered, so it is on screen with the very first paint, and
 * it lifts away (rounded lower shoulders, the landing's sheet language in reverse) once the page has
 * hydrated and its fonts are in, never sooner than a short beat so the mark can finish assembling.
 * Client-side navigations keep the root layout, so it does not return; those use the page curtain.
 * Without JavaScript it steps aside on its own (CSS), and previews of users' own apps never show it.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ZenithLoader } from "./zenith-loader";

/** Time (from navigation start) the mark needs to assemble once. */
const MIN_VISIBLE_MS = 900;
/** Never wait longer than this for fonts. */
const FONT_CAP_MS = 1600;
const LIFT_MS = 760;

export function BootSplash() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<"show" | "lift" | "gone">("show");
  const excluded = pathname?.startsWith("/preview");

  useEffect(() => {
    if (excluded) return;
    let cancelled = false;
    const fonts = document.fonts?.ready ?? Promise.resolve();
    const cap = new Promise((resolve) => window.setTimeout(resolve, FONT_CAP_MS));
    let timer: number | undefined;
    Promise.race([fonts, cap]).then(() => {
      if (cancelled) return;
      timer = window.setTimeout(() => setPhase("lift"), Math.max(0, MIN_VISIBLE_MS - performance.now()));
    });
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [excluded]);

  useEffect(() => {
    if (phase !== "lift") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setPhase("gone"), reduce ? 260 : LIFT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (excluded || phase === "gone") return null;
  return (
    <div className="zenith-boot" data-phase={phase} role="status" aria-live="polite">
      <span className="sr-only">Loading Zenith</span>
      <ZenithLoader id="boot" size={76} />
    </div>
  );
}
