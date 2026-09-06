# Orrery font files

These are the unchanged variable WOFF2 subsets previously downloaded by
`next/font/google` for Space Grotesk (300–700) and JetBrains Mono (100–800).
They are bundled here so compilation and production builds do not fetch fonts.
`src/app/fonts.css` retains the original subset ranges and fallback metrics;
the root layout preloads the two Latin subsets.

Space Grotesk: `36966cca54120369-s.p.woff2` (Latin),
`b7387a63dd068245-s.woff2` (Latin extended), `e1aab0933260df4d-s.woff2` (Vietnamese).

JetBrains Mono: `bb3ef058b751a6ad-s.p.woff2` (Latin),
`939c4f875ee75fbb-s.woff2` (Latin extended), `f911b923c6adde36-s.woff2` (Vietnamese),
`67957d42bae0796d-s.woff2` (Greek), `0aa834ed78bf6d07-s.woff2` (Cyrillic),
`886030b0b59bc5a7-s.woff2` (Cyrillic extended).

Both families use the SIL Open Font License 1.1. The complete upstream notices
are included alongside the binaries. Sources:
https://github.com/google/fonts/tree/main/ofl/spacegrotesk and
https://github.com/google/fonts/tree/main/ofl/jetbrainsmono.

## Zenith editorial additions — 2026-09-06

The landing uses Instrument Serif 400 roman/italic for display, Manrope variable
200–800 (400–700 in use) for body and controls, and the existing JetBrains Mono
for code, resource names, revisions and estimates. The product UI retains its
original font roles. All added files are self-hosted; no runtime font-service
request is made. `font-display: swap` keeps the first frame readable.

Official Google Fonts Latin WOFF2 subsets, downloaded 2026-09-06:

- `instrument-serif-latin.woff2` (21,032 bytes):
  https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjg.woff2
- `instrument-serif-italic-latin.woff2` (22,128 bytes):
  https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjjH7M.woff2
- `manrope-latin-variable.woff2` (24,836 bytes):
  https://fonts.gstatic.com/s/manrope/v20/xn7gYHE41ni1AdIRggexSg.woff2
- `instrument-serif-og.ttf`: server-side social-card font, because Satori
  requires a supported font format rather than WOFF2:
  https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-2zI.ttf

Licenses: `Instrument-Serif-OFL.txt` and `Manrope-OFL.txt`, wording retained from
https://github.com/google/fonts/tree/main/ofl/instrumentserif and
https://github.com/google/fonts/tree/main/ofl/manrope. Both are SIL OFL 1.1.
The original Space Grotesk and JetBrains Mono notices above remain historical
provenance and active product dependencies.

The landing also declares metric-adjusted local Georgia/Georgia Italic and Arial
fallbacks, measured against its headline and body copy. These use fonts already
installed on the visitor's device; no system font files are distributed.
