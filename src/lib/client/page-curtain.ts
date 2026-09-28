"use client";
/**
 * A page-to-page transition in the landing's sheet language. A sheet in the destination's colour
 * rises over the current page with rounded shoulders while that page recedes and dims (as the sky
 * recedes under the porcelain on the landing). Navigation happens once it covers the screen, and
 * the sheet dissolves when the next page is on screen.
 *
 * The sheet lives on <body>, outside React, so it survives the route change. Reduced motion and
 * browsers without the Web Animations API navigate directly.
 */
import { zenithLoaderMarkup } from "@/components/brand/zenith-loader";

const EASE = "cubic-bezier(.32, .72, 0, 1)";
const RISE_MS = 620;
const REVEAL_MS = 480;

export interface CurtainOptions {
  /** The sheet's colour; use the destination page's ground so the reveal is seamless. */
  color: string;
  /** The page that recedes beneath the sheet. */
  recede?: HTMLElement | null;
}

let running = false;

export function curtainNavigate(href: string, navigate: (href: string) => void, { color, recede }: CurtainOptions) {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (running || reduce || typeof document.body.animate !== "function") { navigate(href); return; }
  running = true;
  const source = window.location.pathname + window.location.search;

  const sheet = document.createElement("div");
  sheet.setAttribute("role", "status");
  sheet.setAttribute("aria-label", "Loading Zenith");
  sheet.dataset.pageCurtain = "";
  sheet.style.cssText = `position:fixed;inset:0;z-index:2147483000;pointer-events:auto;background:${color};border-radius:40px 40px 0 0;box-shadow:0 -30px 90px rgba(8,9,13,.38);transform:translateY(100%);will-change:transform`;
  // If the next page takes a moment, the Zenith loader assembles in the middle of the sheet.
  const mark = document.createElement("span");
  mark.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);line-height:0;opacity:0";
  mark.innerHTML = zenithLoaderMarkup(`curtain-${Date.now()}`, 60, isLight(color) ? "light" : "dark");
  sheet.appendChild(mark);
  document.body.appendChild(sheet);
  mark.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 120, fill: "forwards", easing: "ease-out" });

  const rise = sheet.animate(
    [{ transform: "translateY(100%)", borderRadius: "40px 40px 0 0" }, { transform: "translateY(0)", borderRadius: "0px 0px 0 0" }],
    { duration: RISE_MS, easing: EASE, fill: "forwards" },
  );
  const recession = recede?.animate(
    [{ transform: "none", filter: "brightness(1)" }, { transform: "translateY(-3%) scale(.965)", filter: "brightness(.55)" }],
    { duration: RISE_MS, easing: EASE, fill: "forwards" },
  );

  const dissolve = () => {
    const out = sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: REVEAL_MS, easing: "ease-out", fill: "forwards" });
    out.finished.catch(() => undefined).finally(() => { sheet.remove(); recession?.cancel(); running = false; });
  };
  rise.finished.catch(() => undefined).then(() => {
    try { navigate(href); } catch { dissolve(); return; }
    const started = performance.now();
    // The URL changes when the next page commits; give it two frames to paint, then dissolve.
    const wait = () => {
      if (window.location.pathname + window.location.search !== source) { requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(dissolve, 60))); return; }
      if (performance.now() - started > 8000) { dissolve(); return; }
      requestAnimationFrame(wait);
    };
    wait();
  });
}

/** Whether a CSS colour (hex or rgb()) is light, so the loader on it takes ink pieces. */
function isLight(color: string) {
  let r = 0, g = 0, b = 0;
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  } else {
    const nums = color.match(/[\d.]+/g)?.map(Number);
    if (nums && nums.length >= 3) [r, g, b] = nums;
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

/** The ground colour of the product pages (login, signup, the app) in the current theme. */
export function productGround() {
  return getComputedStyle(document.documentElement).getPropertyValue("--bg0").trim() || "#22241f";
}
