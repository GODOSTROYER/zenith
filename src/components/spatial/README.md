# Change rehearsal

`ChangeRehearsal` is a read-only projection of the actual deployed and proposed
manifests and their `Changeset`. It does not plan, approve, execute, mutate graph
positions, or infer deployment health. The caller retains those responsibilities.

The component accepts `currentManifest: Manifest | null`, `proposedManifest`,
`changeset`, `environmentName`, optional `selectedId`, `onSelect`, and `className`.
Selection accepts node and binding IDs; a retargeted binding identifies the union
of its current and proposed endpoints. An explicit `null` clears controlled
selection. Without a controlled ID the first change is initially selected.

The HTML comparison controls, resource list, binding description and estimates
remain available with WebGL disabled. The renderer is progressively imported only
when the scene is visible. At most twelve resources are shown spatially; the HTML
list includes every resource and announces the bounded representation. Selected
offscreen resources replace the final available slots rather than moving all
other modules. The graph remains the editable source of presentation positioning.

There is one reusable set of beveled/cylindrical geometry and one WebGL canvas.
Pixel density is capped at 1.5 (1 on low-power devices). Shadows are disabled on
low-power devices. Selected affected modules lift over a finite 380ms transition;
unchanged modules stay anchored. Reduced-motion and low-power clients receive
the same final state immediately. There is no idle render loop. Intersection and
document visibility stop rendering; teardown disposes every geometry, material,
wire buffer, shadow map, observer, listener and renderer. No landing fixture or
demonstration state machine is imported.

Focused verification: `npx vitest run tests/spatial` and
`npx eslint src/components/spatial tests/spatial`.
