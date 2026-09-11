# src/components — what more than one route shares

Everything a single route owns is colocated next to its `page.tsx` under
`src/app/**`. `src/components/` holds only what two or more routes share:
`ui/` (the kit), `shell/`, `map/`, `inspector/`, `navigator/` and `screens/`.

Each of those directories has its own README saying what belongs in it. When a
component here stops being shared — the last importer outside its own screen
goes away — move it next to that screen's `page.tsx` rather than leaving it in
the shared tree.

A colocated file's name is read alongside every other screen's colocated files
when you are searching, so give one a screen prefix as soon as the bare name
collides: `settings-alerts.tsx`, `activity-filters-bar.tsx`,
`security-filters-bar.tsx`.

`apps/` is a re-export barrel kept for one commit: the hosted Apps screen owns
those files and they now live under `src/app/(product)/apps/`.
