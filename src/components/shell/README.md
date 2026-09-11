# components/shell — chrome and context

The frame every product screen sits in: `product-chrome.tsx` (persistent
collapsible navigation, workspace picker and single 56px context bar),
`project-chrome.tsx` (authoritative project and environment controls),
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

`chrome-slot.tsx` exposes only the context bar's DOM destination. Project
controls portal there while retaining their ProjectProvider ancestry. The
project subtree is never remounted to animate navigation, collapse the rail,
or update the environment. `navigation.tsx` provides every destination to both
the desktop rail and the mobile Drawer. `workbench.css` is imported only by
the product layout; approved landing layout and brand geometry are unchanged.

The frame owns the viewport; each screen owns its primary scrolling surface.
Desktop navigation is 208px expanded and 60px collapsed. Below 900px the same
destinations use a focus-trapped Drawer with Escape and trigger-focus return.
Rail collapse persists under `zenith-shell-collapsed`; all prior keys remain.

Environment deep links synchronize with the existing provider even when only
the query changes. Manual selection validates project membership and replaces
the URL's `env` parameter, retaining other filters and the hash. The existing
`zenith-env-{projectId}` preference remains authoritative for links without an
environment. Workspace switching returns to Overview to avoid retaining a
route that belongs to the previous workspace.
