# components/inspector — the right-hand panel

`inspector.tsx` is the shell (panel on a wide screen, drawer below 1400px) and
picks one editor per target: `service-editor`, `resource-editor`,
`route-editor`, `binding-editor`, or one of the three `add-*-form` files.
`binding-list.tsx` is the Connections tab all three node editors share,
`env-panel.tsx` is the service Env & secrets tab.

`editor-parts.tsx` holds what the editors share (SizeField, CostHint, Facts,
useUpstreamGuard, StaleNotice); `logic.ts` is the pure half — drafts, update
inputs, edit issues, nodeLabel, idempotency keys — and is tested directly.
`plan-first.tsx` is the inline plan-then-apply control; every mutation here
goes through it. No editor calls an action endpoint itself.
