# components/ui — the kit

Every primitive a screen is allowed to reach for: Button, Input, Select, Field,
Dialog, Drawer, Popover, Table, Tabs, Chip, Callout, Card, LogViewer, Meter,
Sparkline, StatusDot, Toast and friends. `index.ts` is the public surface —
import from `@/components/ui`, never from a file inside here.

Rules: tokens only, no hardcoded colour (see `docs/DESIGN.md`); no component
here knows about a project, an environment or an action; `"use client"` only on
the ones that use hooks or handlers — presentational primitives stay directives-
free. Anything that mentions a domain type belongs in `screens/` or an area
folder instead.
