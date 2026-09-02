# components/navigator — the agent surface

`navigator-screen.tsx` is the screen; `command-bar.tsx` takes the instruction,
`autonomy-dial.tsx` sets how far it may go alone, `run-panel.tsx` and
`step-card.tsx` show a run as it happens, `run-history.tsx` is what it has
done, `glyph.tsx` is the mark.

This is the only area allowed to use the `nav-accent` token — agent activity
must stay recognisable at a glance (see `docs/DESIGN.md`). Planning and
execution live in `src/lib/navigator`; nothing here decides what a run does.
