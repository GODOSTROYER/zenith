# components/shell — chrome and context

The frame every product screen sits in: `product-chrome.tsx` (workspace bar),
`project-chrome.tsx` (project bar and environment picker),
`command-palette.tsx`, `activity-bell.tsx`, `wordmark.tsx`, and the two
contexts — `shell-context.tsx` (workspace bootstrap, role) and
`project-context.tsx` (the polled project payload).

`project-context.tsx` is the single source of the project payload; screens read
it through `screens/project-data.ts`, never directly. `error-boundary.tsx`
wraps anything that can throw mid-edit. Nothing here knows about a specific
screen's layout.
