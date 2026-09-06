# components/map — the system map

`system-map.tsx` wires the pieces and owns the selection. Around it:
`graph-model.ts` turns the manifest, changeset and health into nodes and edges
(pure, no hooks, memo keys included); `layout.ts` is the dagre pass;
`nodes.tsx` and `edges.tsx` are the React Flow renderers; `toolbar.tsx` is the
chrome; `keyboard.ts` is focus and Escape; `node-menu.tsx` is the right-click
menu; `dialogs.tsx` is import and blueprint.

Keep `graph-model.ts` free of React so the drawing stays testable. Ghost nodes
(staged removals) go through the same arrays as real ones — never a separate
path, or the map and the Changes panel start disagreeing.

Removed binding endpoints come from the exact deployed revision manifest,
never parsed display names. The revision API is read-only and workspace scoped.
Node positions remain presentation state. The toolbar owns layout space above
the canvas; the deploy dock is bounded to the map workspace. Binding labels
appear on hover/selection to avoid coincident midpoint labels in dense graphs;
the keyboard-accessible inspector Connections tab retains their full detail.
