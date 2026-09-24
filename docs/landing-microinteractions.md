# Bento microinteractions — research and implementation

Reviewed 24 September 2026. Scope: the eleven cards below the locked hero,
including the hosting cluster from PR #24. No new framework, pricing claim,
backend operation, hover-only information, scroll takeover or library dependency.

## Reference review

The supplied https://reactbits.dev/c/micro is a client-rendered catalogue;
the text browser could not render that route. The public React Bits repository
was inspected instead, including the TypeScript Micro directory and source for:

- **GlideSelect**: a separate sliding selection highlight; controlled value,
  selected/active distinction, and keyboard/typeahead handling. Adopt the
  moving-highlight idea, not a dropdown that this page does not need.
  https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Micro/GlideSelect/GlideSelect.tsx
- **FolderFloat**: a tangible folder/paper metaphor, lifting/spreading and
  selectable items, with optional Matter.js physics. Adopt the document lift;
  do not add a physics engine or draggable documents to a marketing card.
  https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Micro/FolderFloat/FolderFloat.tsx
- The directory also contains JellyRadio, FlipCard, HoldButton and other
  task-specific controls. Do not add a hold-to-confirm, rating, or fake action
  merely because its animation looks interesting.
  https://github.com/DavidHDev/react-bits/tree/main/src/ts-default/Micro

Additional primary references:

- Animate UI **Highlight**: controlled highlights and hover/click modes.
  https://animate-ui.com/docs/primitives/effects/highlight
- Magic UI **Animated Beam**: paths connect integration endpoints. Apply as
  a short trace of a selected node's *actual* relationships, not perpetual traffic.
  https://v3.magicui.design/docs/components/animated-beam
- Motion **hover** and **accessibility**: distinguish real mouse hover from
  emulated touch events; respond to changing reduced-motion preferences.
  https://motion.dev/docs/hover
  https://motion.dev/docs/react-accessibility
- web.dev: prefer transform/opacity; avoid unnecessary layout/paint work.
  https://web.dev/articles/animations-guide
- W3C SC 2.2.2: persistent automatic motion needs a pause/stop/hide mechanism.
  Existing agent/hosting pause controls remain. New feedback is finite.
  https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html

These are pattern references, not vendored code. The implementation is original
and uses CSS plus the browser Web Animations API. No copied component, Motion,
Matter.js or other dependency is added.

## Card-specific behavior

| Card | Trigger → feedback | End state / input fallback |
| --- | --- | --- |
| System | Select/focus a node → trace its connected paths, settle its caption; choose Proposed → introduce only the new parts | The real shared view updates immediately. Native buttons work on touch/keyboard. |
| Agents | Media-control press → tactile feedback; pointer/focus → contained surface highlight | Existing eight-second loop and pause logic untouched. No approval control is reintroduced. |
| Plan | Toggle view → sheet content settles; hover/focus → small paper lift | Same fixture plan/risk; no delayed action or stale hidden content. |
| Autonomy | Select level → highlight glides to selected row, description settles | The exact existing autonomy meanings remain. Presentation state only. |
| Estimate | Local Current/Proposed controls → shared estimate changes with a short numeral reveal | No synthetic intermediate prices, no count-up from zero. Range input and labels remain native. |
| Foundation | Select System/Plans/Actions/Exports → icon highlight and relationship description | Four native buttons make the illustration informative, not a new navigation system. |
| Ownership | Select an export → lift the document and settle its description | No fake download, drag dependency or hidden-only-on-hover contents. |
| Managed hosting | Pointer/focus → subtle surface sheen; link → directional arrow nudge | Existing ten-second scene is independent of micro feedback. |
| Multicloud | Pointer/focus → subtle surface sheen | Existing provider logos, placement animation and pause remain unchanged. |
| Ecosystem | Activate a registered provider logo → open native details and focus the matching row | Missing providers are not made into dead buttons. Oracle's existing alias is resolved. |
| Teams | Choose a situation → sliding selection surface and short content transition | No autoplay carousel; active content belongs to the visitor's selection. |

## Baked into every effect

- **Trigger, feedback, stable final state**. No perpetual new decoration and no
  delaying a selection until an animation ends.
- **Keyboard and touch**. Native buttons/disclosures/ranges; mouse sheen is fine-
  pointer-only. Touch does not get a stuck hover. Focus remains visible.
- **Reduced motion / forced colors**. Dynamic preference changes cancel transient
  animations and expose the final underlying state. Native selection backgrounds
  remain the no-JavaScript and no-animation fallback.
- **Performance**. One delegated pointer listener; at most one pending pointer
  frame. No idle frame loop, no per-frame React state, no timers, no API calls.
  Text and pill transitions use translate/transform/opacity; the short SVG trace
  is limited to the small selected connections.
- **Lifecycle**. New transient animations cancel offscreen or in a hidden tab.
  Listeners/observers/animation references are released on unmount. Existing
  agent/hosting controllers are not controlled or cancelled by this layer.
- **Interruption**. A rapid selection cancels the old effect and moves toward the
  latest value. Pill geometry is remeasured after resize/font loading.
- **Truthful state**. Animation never changes estimates, registry availability,
  workspace autonomy, deployment status or product data.

Timing tokens: 160ms feedback; 240ms content settling; 320ms selection;
560ms connection trace. These are design choices for Zenith, not research-backed
universal timing thresholds. Large card tilt, magnetically moving targets,
click-spark particle canvases, text scrambling and auto-flipping cards were
rejected because they compete with the existing product demonstrations.

## Validation contract

Run the repository's typecheck, lint and tests. The two new `.test.tsx` files
belong to the existing DOM Vitest project: runtime lifecycle/gesture tests plus
real React card-state integration tests. Browser QA should cover rapid selection,
mouse-to-touch changes, focus, native disclosure opening, narrow screens, hidden
tabs, reduced motion, forced colors and unmount/remount cleanup.
