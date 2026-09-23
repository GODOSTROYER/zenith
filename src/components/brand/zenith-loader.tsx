/**
 * The Zenith loader: the mark assembling itself, in the identity's cut-register language.
 *
 * The two pieces of the symbol slide in from opposite sides and snap into register; a light
 * sweeps along the slant; a small four-point star, the zenith, glints at the top bar's tip (the
 * same star that crowns the landing's ray). While the wait goes on, the pieces breathe a hair out
 * of register and back, and the light and the star return on each beat.
 *
 * One markup source serves React (`<ZenithLoader />`) and plain DOM (the page curtain), so the
 * styles live in globals.css under `.zl`. Reduced motion shows the assembled mark, breathing softly.
 */
import { ZENITH_SYMBOL_PATHS } from "@/components/shell/brand-geometry";

const STAR = "M0 -5.2 L.9 -.9 L5.2 0 L.9 .9 L0 5.2 L-.9 .9 L-5.2 0 L-.9 -.9Z";

/** `tone` is the ground the loader sits on: porcelain pieces on a dark ground, ink pieces on a light one; "auto" follows the product theme's text colour. */
export function zenithLoaderMarkup(id: string, size = 64, tone: "dark" | "light" | "auto" = "dark") {
  const clip = `zl-clip-${id}`, sheen = `zl-sheen-${id}`;
  return `<svg class="zl" data-tone="${tone}" width="${size}" height="${size}" viewBox="-4 -8 40 40" aria-hidden="true" focusable="false">
<defs>
<clipPath id="${clip}"><path d="${ZENITH_SYMBOL_PATHS[0]}"/><path d="${ZENITH_SYMBOL_PATHS[1]}"/></clipPath>
<linearGradient id="${sheen}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<path class="zl-bar" d="${ZENITH_SYMBOL_PATHS[0]}"/>
<path class="zl-stroke" d="${ZENITH_SYMBOL_PATHS[1]}"/>
<g clip-path="url(#${clip})"><rect class="zl-sheen" x="-14" y="-4" width="10" height="40" fill="url(#${sheen})"/></g>
<g transform="translate(29 4)"><path class="zl-star" d="${STAR}"/></g>
</svg>`;
}

export function ZenithLoader({ id, size = 64, tone = "dark", className }: { id: string; size?: number; tone?: "dark" | "light" | "auto"; className?: string }) {
  return <span className={className} style={{ display: "inline-flex", lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: zenithLoaderMarkup(id, size, tone) }} />;
}
