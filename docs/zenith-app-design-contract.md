# Zenith application — Revision Object workbench

Base: `8a974387c14f3f400e20f067190d2ec2c614345f`, freshly fetched master containing the approved landing. Work branch: `test/zenith-app-reimagined`. No merge or deployment.

## Direction

A precise operational workbench in warm porcelain and ink. One compact navigation rail, one context bar, and a clearly owned working surface. The brand appears through material, typography and aligned rules; operational information takes priority over decorative composition.

The approved landing is preserved. The previous documentation boundary retaining navy/mint product UI is superseded by this commission. Persisted identifiers, APIs, action semantics, authentication and permissions remain compatible.

## Shared foundation

Root tokens apply to document-body portals as well as screens. Existing token names remain stable.

| Token | Light | Dark |
| --- | --- | --- |
| bg0 | #f4f3ee | #22241f |
| bg1 | #eeeee6 | #282b24 |
| bg2 | #faf9f5 | #2c2f28 |
| bg3 | #ffffff | #35382f |
| ink | #20211f | #f2f1e9 |
| ink-mute | #606259 | #b4b7ab |
| ink-faint | #686a60 | #afb2a5 |
| signal | #be3e25 | #ff886c |
| signal-strong | #a6321d | #ffa18b |
| on-signal | #ffffff | #22241f |
| ok | #287047 | #84d5a5 |
| warn / prod | #855c13 | #efc26e |
| err | #932553 | #ff8fbb |
| info | #286b88 | #88c7e4 |
| nav-accent | #6552a0 | #bca8ee |

Manrope: body 14px/1.55, controls 13px, metadata 12px, operational headings 16–20px. Instrument Serif: selective page titles 34px/1.08, mobile 30px; onboarding up to 44px. JetBrains Mono: code, logs, resource IDs, revisions, timings and numerical evidence. Tabular figures remain available through tnum. Shared page title class: `app-page-title`; section class: `app-section-title`; overline labels are unnecessary.

Spacing 4/8/12/16/24/32. Product page gutters 20px narrow, 28px desktop. Control radius 3px, panels 5px, chips 2px. Ordinary surfaces use fine rules; shadows are reserved for detached overlays. Controls are 36px regular/32px compact, 44px coarse pointers. Mobile inputs 16px. Focus is a 2px offset signal outline. Inactive status indicators always retain readable text/icon meaning.

Motion tokens: `--dur-fast:150ms`, `--dur-base:220ms`, `--dur-slow:380ms`; `--ease-swift:cubic-bezier(.2,.75,.25,1)`. No route remounts or repeated row entrance effects. Reduced motion retains information with immediate state changes.

## Shell and scrolling

Persistent desktop rail: 208px expanded, 60px collapsed. Below 900px: dismissible navigation drawer with visible menu/context controls. Context bar target 56px; project/environment controls must remain visible, production explicitly named and amber-marked. Preserve all destinations, workspace/project/environment switching, search, notifications, account, theme and Guide.

The app owns viewport height and each route owns one primary vertical scroll region. Map is a fixed working canvas. Deploys uses an intentional history/detail workspace; logs alone may scroll independently. Tables may scroll horizontally in a named region. No global marketing overflow/heading rules.

## Shared interfaces

- `components/screens/page-heading.tsx`: integrator-owned heading helper. Screens may use `.app-page-title` directly.
- `components/screens/connected-detail.tsx`: integrator-owned read-only detail surface using the shared Drawer. Props `open`, `onClose`, `title`, optional `resourceId`, `environment`, `context`, `children`, `footer`. Historical data remains read-only; mutable graph inspector retains its existing APIs.
- `ChangeRow` in shared.tsx may accept optional `onSelect` and `selected`, without changing existing rendering semantics for callers.
- Neutral spatial component lives in `components/spatial/`. It accepts real current/proposed manifests, changeset and selected ID, never landing fixtures or execution actions. Spatial and system owners agree exported props before integration.
- Deployment phase events and targets remain authoritative. The system owner controls `components/deploy/**`; history and Navigator consume its exports and request changes from that owner.

## Ownership for this commission

| Owner | Exclusive paths |
| --- | --- |
| Integrator | globals.css, fonts.css, root layout, shared screen helpers, client data spine, configs/dependencies, docs, integration |
| Foundation | components/ui/**, components/theme/**, associated UI tests (coordinate theme-contrast with integrator) |
| Shell | components/shell/**, app/(product)/layout.tsx and p/[slug]/layout.tsx; no root layout |
| System/execution | components/map/**, inspector/**, deploy/**, p/[slug]/page.tsx, associated tests |
| Entry/workspace | components/auth/**, guide/**, screens/onboarding/**, onboarding-flow.tsx; auth/onboarding/guide/overview/preview routes and route helpers |
| History/source | p/[slug]/{source,revisions,deploys}/** and their tests |
| Operations | p/[slug]/{observe,security,activity,settings}/** and their tests |
| Navigator | components/navigator/**, p/[slug]/navigator/**, /gimbal, associated tests |
| Spatial | new components/spatial/** and its tests; coordinate with system owner |

No leaf edits a shared or another owner's file. Direct primitive imports follow the actual index.ts performance convention. No dependencies are needed unless a concrete missing capability is demonstrated.

## Three signature interactions

1. Change rehearsal: actual deployed manifest → working manifest; exact resource/binding identities, readable current/proposed details, selected environment and estimated cost. Only changed modules separate; unchanged objects remain anchored. Keyboard selection and static fallback expose the same facts.
2. Connected inspector: stable IDs, shared detail header and restrained 220ms disclosure. Selection retains task context and focus returns to its trigger. Historical views never silently edit current resources.
3. Plan to execution: existing plan/approval succeeds → retained change summary and real phase progression. Stream interruption, failed/cancelled states and provider-returned outputs remain explicit. Simulation never becomes verified.

## Verification

Baseline captures precede visual edits. Test workflows use an isolated test workspace and controlled Sandbox/local providers. Verify all 19 route families and representative populated/empty/loading/error/restricted states. Final screenshot/recording artifacts live outside the repository. Record actual viewports, renderer conditions and limitations; source review is not browser evidence.

The completed route inventory, exercised Sandbox workflows, narrow adjacent fixes, verification results and remaining manual-test limits are recorded in [zenith-app-verification.md](zenith-app-verification.md).
