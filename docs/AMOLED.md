# AMOLED Dark

## Scope and audit

Implemented against `GODOSTROYER/zenith` master at
`516797728d3717456663f803dcadb2a3bc843892`. The source inventory contains 33
page routes, 139 component source/style files and 31 stylesheets. The audit
traced theme declarations, local palette overrides, hardcoded color values,
native/third-party controls, theme-dependent renderers and portal roots. Source
coverage is distinct from the representative browser coverage below.

The application uses Next.js App Router, Tailwind v4 semantic CSS variables and
its own UI kit. There was no theme provider or account-backed preference API.
Dark was the `:root` palette, Light an attribute override, and each theme menu
held its own state. The implementation extends that architecture without a new
dependency or duplicate settings page.

### Implementation decisions from the audit

1. Keep the original Dark/Light core token values. Add AMOLED overrides for
   surfaces, reading white, control borders and elevation, inheriting Dark's
   brand/status accents.
2. Share preference parsing and application between the synchronous head script
   and runtime. Put System/storage synchronization at the root, so routes without
   a theme control still respond and desktop/mobile menus cannot disagree.
3. Extend the existing menus with an accessible, mutually exclusive AMOLED
   choice. Preserve the existing storage key and unsaved landing-to-app behavior.
4. Adapt local palette islands: landing diagrams/glass, waitlist page/dialog,
   admin console/portals, root error boundary and loading/navigation surfaces.
5. Bridge React Flow's own variables and strengthen actual control/focus edges
   separately from decorative dividers. Leave layout, typography and brand art
   intact.
6. Verify bootstrap/runtime behavior, contrast, existing suites and production
   compilation; capture actual browser evidence through the build CI gate.

## Theme contract

| Preference | Storage value | Resolved document |
| --- | --- | --- |
| Light | `light` | `data-theme="light"` |
| Dark | `dark` | no `data-theme` attribute (existing contract) |
| AMOLED Dark | `amoled` | `data-theme="amoled"` |
| System | `system` | Light or Dark according to the OS |

All preferences use `localStorage["zenith-theme"]`. The document's
`data-theme-preference` records the preference separately from the resolved
appearance, including when storage is unavailable. No cookies, network calls,
new account fields or libraries are needed.

On a full load, missing/invalid preferences use the existing default: Light on
`/`, Dark elsewhere. Client navigation retains the already displayed preference.
When another tab removes or corrupts its stored value, an open page retains its
current resolved appearance. Storage read/write failures never prevent switching.
The root lifecycle owns one media-query listener and one storage listener, with
cleanup; individual menu instances only subscribe to the shared preference.

### AMOLED tokens

| Purpose | Token | Value |
| --- | --- | --- |
| Page / canvas ground | `bg0` | `#000000` |
| Navigation / chrome | `bg1` | `#080908` |
| Cards / inset panels | `bg2` | `#11130f` |
| Popovers / elevated surfaces | `bg3` | `#1a1d17` |
| Primary text | `ink` | `#e6e6df` |
| Decorative separator | `line` | `#30352d` |
| Essential graph lines | `line-strong` | `#818575` |
| Control boundaries | `control-line` | `#747b6c` |

Secondary text, brand actions, Navigator purple, production amber and semantic
success/warning/error/info colors retain Dark values. Native controls receive
`color-scheme: dark`. Detached surfaces use a restrained hairline plus shadow.

## Source coverage

| Area | Treatment |
| --- | --- |
| Product overview, persistent rail/header, mobile navigation | Existing semantic tokens; existing menu extended, synchronized across mounted controls |
| System Map, nodes, bindings, controls, context menu, inspector | Existing node/edge tokens plus explicit React Flow variable bridge; no topology/layout changes |
| Deployment/revision/security/activity workflows | Shared cards, tables, labels, drawers, confirmation dialogs and states inherit root tokens |
| Source editor and imports | Native textarea/code blocks retain semantic colors; explicit control borders and focus cues |
| Observe charts, costs, health, logs | Existing SVG Sparkline/Meter and custom LogViewer use semantic tokens; no Monaco/xterm/chart library exists in this version |
| Navigator, Gimbal, plan/review interfaces | Root colors and existing renderer theme observation; clearer command-input focus |
| Workspace/account/integrations/hosted-app screens | Tokenized kit and route content; upload-control boundary adapted |
| Auth, onboarding, guide, legal pages, preview missing/simulation states | Root tokens; existing selector locations retained |
| Landing and interactive examples | Semantic aliases preserve original fallback colors in Light/Dark; AMOLED maps surfaces, text, lines, animated pills/tiles and glass |
| Waitlist page and native dialog | Local field, control, status and overlay tokens; AMOLED root propagation through the top layer |
| Admin console and portaled panels | Black neutral surfaces with existing purple admin identity |
| Skeletons, boot splash, navigation curtains, route errors and 404 | Semantic tokens/AMOLED loading override; standalone root error has a minimal independent fallback; token-based not-found page replaces Next's OS-only body-color override |

Actual provider logos and decorative sky/Gimbal/3D materials keep their artwork
colors. A small neutral plate preserves the dark lettering in the AWS logo.
Customer application documents and cross-origin hosted frames are not recolored;
they own their appearance and do not share the Zenith-origin preference store.

This master does not contain GitHub OAuth/repository import UI. The integrations
route manages agent access; hosted source inputs are fixture/archive based.
There is no GitHub workflow to claim as visually verified in this change.

## Verification

`npm run test:themes` runs the production app in a disposable local demo
environment, using the installed Chromium/Chrome browser and the existing
`playwright-core` dependency. Run `npm run build` first. A missing browser is a
failure, not a silent skip. The CI build job runs this gate and retains its
screenshots and machine-readable results as `theme-browser-evidence` for 14 days.

The browser check is intended to cover real theme selection, mobile nested
menus, persistence/refresh, System/cross-tab propagation, pre-hydration paint,
portals and representative product/public screens in Light, Dark and AMOLED.
Mounted map, source-editor and log/chart checks switch themes through the real
menu and preserve graph zoom, unsaved text and log filtering while checking
computed colors. Below-fold landing bento and native waitlist-dialog screenshots
cover the public surfaces. Because local demo identity normally replaces the
waitlist CTA, the dialog case holds and then releases the real `/api/me` response
to exercise the existing visitor/loading state; it does not replace auth data.
Integrations and invitations deliberately verify the demo's unavailable and
signed-out callouts. Their exact API endpoints' expected 503/401 resource errors
are retained in the console report and excluded from unexpected-error failures;
other console errors and all uncaught page errors still fail the gate.
A deliberately missing URL verifies the actual HTTP 404 page and its recovery
link in every theme/viewport, including its expected 404 resource-console entry.
Read the produced results and PR verification record for what actually passed;
the existence of a script does not establish a successful run.

Focused unit/DOM tests execute the exact bootstrap script and exercise menu
activation, radio semantics, keyboard focus restoration, simultaneous selectors,
storage failures, invalid values, System changes and lifecycle cleanup. Contrast
tests check text on all surfaces/tints and AMOLED control/focus/graph boundaries.

The implementation environment initially could not launch Chromium because its
required local socket was denied. The cloud browser also could not reach the
local preview. Those attempts are not recorded as passed visual checks. CI and
PR evidence must be consulted separately.

Real OAuth sessions, privileged admin data, live cloud deployments, customer app
content and physical OLED hardware are outside the isolated demo browser run.
