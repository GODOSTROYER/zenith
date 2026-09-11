# components/ui — the kit

Every primitive a screen is allowed to reach for: Button, Input, Select, Field,
Dialog, Drawer, Popover, Table, Tabs, Chip, Callout, Card, LogViewer, Meter,
Sparkline, StatusDot, Toast and friends. `index.ts` describes the public surface.
Direct primitive imports are intentional for bundle isolation; do not route a
small control through a barrel that pulls in unrelated client surfaces.

Three files here are plumbing rather than primitives, and stay out of the
barrel: `use-modal.ts` (mount, focus trap, ESC, scroll lock) and
`modal-parts.tsx` (the scrim and titled header Dialog and Drawer both render),
used only by those two; and `use-external-value.ts`, the "adopt an external
change unless the user is mid-edit" hook a screen reaches for directly.

Rules: tokens only, no hardcoded colour (see `docs/DESIGN.md`); no component
here knows about a project, an environment or an action; `"use client"` only on
the ones that use hooks or handlers — presentational primitives stay directives-
free. Anything that mentions a domain type belongs in `screens/` or an area
folder instead.

The application uses the Revision Object foundation: precise control corners,
warm work surfaces, sentence-case labels and semantic status colors. Shared
`--dur-fast` and `--dur-base` tokens govern feedback and overlay motion. The
document theme also owns body portals. Dialogs and drawers share nested focus,
Escape and scroll-lock ownership; popovers portal outside clipping ancestors
and clamp to the visual viewport. Keep all existing control APIs and persisted
theme keys compatible.
