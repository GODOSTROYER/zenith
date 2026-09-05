# components/navigator — the agent surface

`navigator-screen.tsx` is the screen; `command-bar.tsx` takes the instruction,
`autonomy-dial.tsx` sets how far it may go alone, `run-panel.tsx` and
`step-card.tsx` show a run as it happens, `run-history.tsx` is what it has
done. `glyph.tsx` renders the compact static mark; `gimbal-character.tsx`
loads the procedural 3D gyroscope only when visible. `gimbal-renderer.ts` owns
GPU resources and the visibility-aware animation loop. `gimbal-contract.ts`
defines the five workflow states; `gimbal-state.ts` maps authoritative
run signals to those states, and `gimbal-status.tsx` supplies the adjacent
icon and exact text label.

This is the only area allowed to use the `nav-accent` token — agent activity
must stay recognisable at a glance (see `docs/DESIGN.md`). Planning and
execution live in `src/lib/navigator`; nothing here decides what a run does.
Gimbal motion is likewise presentational: it reads the run state and never
creates, approves, executes, or changes a step.

`/gimbal` previews the living gyroscope. Its state controls never execute
provider actions. A simplified dark face sits at the center of three true 3D
rings, each moving across all axes at different, slowly varying rates. State
changes preserve orbit phase and ease expressions, orientation and color over
roughly a second. A filtered energy pulse gradually decays over several seconds;
settled states continue a calm orbit. Small blinks/winks occur at irregular
5–12 second intervals. Hover gives a glance; tap or keyboard activation gives
a wink (a blink during Applying or Blocked), with a cooldown.

The renderer creates its own geometry and materials; it downloads no GLB,
texture atlas or decoder. The earlier full-body assets remain in `public/gimbal`
as an archive, documented in `docs/gimbal-assets.md`. The SVG fallback matches
the new face-and-rings silhouette. Rendering is capped at 30fps, or 20fps with
lower geometry resolution and pixel ratio in low power. Reduced motion and
Still stop frames; offscreen and hidden views pause without catching up.
All geometry/materials are disposed once on unmount or context loss. A saved
hide preference keeps the companion optional.

Completion alone is not verification. The current provider executor does not
produce authoritative whole-run verification evidence, so completed runs show
Completed, not Verified. A verifier must persist typed `NavigatorRun.verification`
before the green state is eligible. Goal text and model wording never select
a pose. The existing LLM endpoint only translates command grammar; a general
conversational assistant is not introduced by this visual integration.
