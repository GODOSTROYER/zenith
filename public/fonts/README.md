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
