# Zenith vector identity

Original geometry created for the September 2026 “Revision Object” commission.
The mark is the **Shift Register**: two offset cut bands with a visible diagonal
seam. The lower-case lettering is drawn from original paths; no font was
converted to outlines. Its clipped z and i dot relate to the register geometry.

- `zenith-lockup.svg`: primary one-color horizontal mark and wordmark.
- `zenith-lockup-inverse.svg`: warm-white inverse for ink fields.
- `zenith-wordmark.svg`: lettering alone.
- `zenith-symbol.svg`: one-color master.
- `zenith-symbol-vermilion.svg`: change/signature accent.
- `zenith-symbol-inverse.svg`: inverse master.
- `zenith-symbol-16.svg`: optically simplified small treatment.
- `zenith-symbol-24.svg`, `zenith-symbol-32.svg`: pixel-size treatments.
- The favicon lives at `src/app/icon.svg`, with light/dark media treatments.

Master source: `src/components/shell/brand-geometry.ts`. Regenerate standalone
assets with `node node_modules/tsx/dist/cli.mjs scripts/zenith-brand-build.ts`.
The app consumes the same paths through its existing `Wordmark` and
`OrbitMark` exports. Their names and props remain compatible.

Minimum master symbol size: 24px; use the 16px optical version below that.
Minimum lettering width: 94px. Keep at least half a symbol's width clear on all
sides. No rotation or distortion in navigation. The enlarged closing symbol
may share the sculpture's controlled offset. Do not use the mark as a status
icon: semantic warnings, errors, approval and provider verification retain
independent labels, icons and colors.

The formal product name remains **Zenith**. The visual wordmark emphasizes
Zenith; the small `.ai` suffix in the app is supporting product nomenclature.
No trademark registration or domain ownership is implied.
