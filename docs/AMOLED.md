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
| Dropdown menus | All 43 shared Select controls across 27 application files use themed, portaled listboxes with keyboard and touch support |
| Skeletons, route errors and 404 | Contextual loading inside the content area; standalone root error has a minimal independent fallback; token-based not-found page replaces Next’s OS-only body-color override |

Actual provider logos and decorative sky/Gimbal/3D materials keep their artwork
colors. A small neutral plate preserves the dark lettering in the AWS logo.
Customer application documents and cross-origin hosted frames are not recolored;
they own their appearance and do not share the Zenith-origin preference store.

This master does not contain GitHub OAuth/repository import UI. The integrations
route manages agent access; hosted source inputs are fixture/archive based.
There is no GitHub workflow to claim as visually verified in this change.

## Dropdown and loading follow-up

Single-value Select controls render a visible combobox button and a listbox on
the themed body. Menus use the existing surface, ink, signal and control-border
tokens; clamp to the visual viewport; and provide 44px choices on touch devices.
Arrow keys, Home/End, PageUp/PageDown, typeahead, Enter/Space, Escape and normal
Tab order work without opening an operating-system popup. An expanded select
owns its first Escape inside a dialog; closing it leaves the containing dialog
open. A hidden native select preserves form data, required validation, reset,
refs and the existing change-event contract. There are no production callers of
the retained native multi-row/multiple listbox compatibility mode.

The audit covers Zenith application source and public controls. Independently
packaged customer fixture applications keep their own UI. Date inputs retain
their semantic calendar control; they are not option dropdowns.

Product navigation no longer intercepts internal links to play a logo curtain,
and the root boot splash no longer imposes a minimum display duration. Actual
pending routes/data use overview, card, canvas, list, editor, settings or
conversation skeletons inside the content area. The loaded shell remains
available. Placeholders have one polite loading announcement, decorative shapes
hidden from assistive technology, a restrained opacity pulse, and no animation
when reduced motion is requested. The landing page's deliberate exit transition
remains local to the landing page; it does not run on product tabs.

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
It also opens real Select menus, checks text contrast and mobile bounds, exercises
selection/cancel/focus, holds real project GET/SSE responses to inspect skeletons,
and observes ordinary tab navigation for transient blocking curtains. Both normal
and reduced-motion states are checked. The unauthenticated integrations and
invitation routes assert their exact protected API refusal and recovery UI;
only the matching, validated resource-error log is classified as expected. All
other resource errors and every uncaught page error remain failures.
A deliberately missing URL verifies the actual HTTP 404 page and its recovery
link in every theme/viewport, including its expected 404 resource-console entry.
Read the produced results and PR verification record for what actually passed;
the existence of a script does not establish a successful run.

Focused unit/DOM tests execute the exact bootstrap script and exercise menu
activation, radio semantics, keyboard focus restoration, simultaneous selectors,
storage failures, invalid values, System changes and lifecycle cleanup. Contrast
tests check text on all surfaces/tints and AMOLED control/focus/graph boundaries.
Select regressions additionally cover forms/reset/required fields, asynchronous
options, disabled choices, nested dialogs/popovers and real pointer sequences.

The implementation environment initially could not launch Chromium because its
required local socket was denied. The cloud browser also could not reach the
local preview. Those attempts are not recorded as passed visual checks. CI and
PR evidence must be consulted separately.

Real OAuth sessions, privileged admin data, live cloud deployments, customer app
content and physical OLED hardware are outside the isolated demo browser run.
