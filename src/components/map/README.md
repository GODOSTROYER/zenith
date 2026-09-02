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
