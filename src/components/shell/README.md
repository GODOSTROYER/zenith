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

The action catalog arrives with `/api/bootstrap`, projected from the live
server registry. Product layouts do not import execution handlers to render
navigation. The shell context keeps its identity when its inputs do not change.
Route `loading.tsx` boundaries reuse `ScreenLoading` so the existing chrome
remains interactive while the next screen loads.
