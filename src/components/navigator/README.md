# components/navigator â€” the agent surface

`navigator-screen.tsx` is the screen; `command-bar.tsx` takes the instruction,
`autonomy-dial.tsx` sets how far it may go alone, `run-panel.tsx` and
`step-card.tsx` show a run as it happens, `run-history.tsx` is what it has
done. `glyph.tsx` renders the compact static mark; `gimbal-character.tsx`
loads the procedural 3D gyroscope only when visible. `gimbal-renderer.ts` owns
GPU resources and the visibility-aware animation loop. `gimbal-contract.ts`
defines the five workflow states; `gimbal-state.ts` maps authoritative
run signals to those states, and `gimbal-status.tsx` supplies the adjacent
icon and exact text label.

The task comes first: the request, active plan, recorded execution progress and
run history occupy the primary column. A compact Gimbal sits alongside the
workflow; autonomy, companion preferences and the state guide use disclosures.
On narrow screens the context follows the task. `navigator.module.css` scopes
this application layout away from the approved landing. Ordinary updates retain
the plan surface and its selection; progress follows recorded step statuses.

Plan steps open the shared `ConnectedDetail` surface. Explicit step environment
or recorded deployment context supplies the scope; project actions do not become
production operations because production is selected in the shell. Resource
matches are identified as the current working copy, with links to the matching
System node. A recorded deployment ID links to its exact Deploys entry. Review,
approval, cancellation and execution continue through the existing action path.

This is the only area allowed to use the `nav-accent` token â€” agent activity
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
5â€“12 second intervals. Hover gives a glance; tap or keyboard activation gives
a wink (a blink during Applying or Blocked), with a cooldown.

`GimbalCharacter` accepts `material="porcelain"` for the product workspace and
`/gimbal` preview: warm ceramic, an ink visor, restrained metal rings and softer
lighting. The SVG fallback uses the same material vocabulary. The optional prop
defaults to `"alloy"`, preserving the approved landing's existing appearance.
Material choice never changes workflow state or verification eligibility.

The renderer creates its own geometry and materials; it downloads no GLB,
texture atlas or decoder. The earlier full-body assets remain in `public/gimbal`
as an archive, documented in `docs/gimbal-assets.md`. The SVG fallback matches
the new face-and-rings silhouette. Rendering uses antialiasing, smooth geometry, 60fps motion and 2–3x pixel density
(with a 4096px drawing-buffer dimension limit). There are no quality or motion
selectors. System reduced motion stops frames without lowering visual quality;
offscreen and hidden views pause without catching up.
Visibility is checked again after the lazy renderer import; a tab or scene that
became hidden does not initialize GPU resources or consume its recovery retry.
All geometry/materials are disposed once on unmount or context loss. The saved hide preference is stored under the `zenith-gimbal-visible` key.

Completion alone is not verification. After all steps finish successfully,
`src/lib/navigator/run.ts` calls `verifyRun` from `verification.ts`, persists the
pending state, and records typed `NavigatorRun.verification` and its explanatory
note when available. Checks are bounded by a timeout; unavailable verification
leaves completed steps recorded without manufacturing evidence.

The verifier currently covers runs containing `deploy.apply`, `deploy.plan` and
`ops.investigate`, with at least one applied deployment. It checks the recorded
deployment, revision, project and connection identities, asks capable providers
to verify intended state, and rejects stale, incomplete or superseded evidence.
Unsupported actions/providers remain explicitly unverified. Sandbox results are
marked simulated, and a simulation never authorizes Verified.

`gimbal-state.ts` admits Verified only for a completed, nonempty run whose steps
are all done, include a non-read-only action, and carry passed, non-simulated,
provider-sourced evidence for the whole run with a nonempty evidence reference
and a valid timestamp no earlier than run creation. Failed checks remain Blocked;
plan-only results, simulations and ordinary completion keep their distinct
neutral labels. Goal text, model wording, greetings and finished animation never
select a verified pose. The existing LLM endpoint only translates command
grammar; a general conversational assistant is not introduced by this surface.
