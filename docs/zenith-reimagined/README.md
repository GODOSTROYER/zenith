# Zenith reimagined — test branch handoff

The Revision Object makes the next infrastructure change tangible: an anchored
porcelain system, a vermilion proposed queue, and an explicit transition into a
recorded configuration. The new Shift Register symbol and original vector
wordmark share this geometry. Instrument Serif, Manrope and JetBrains Mono give
display, controls and evidence distinct roles.

Branch: `test/zenith-reimagined`, created from remote default `master` at
`7f63ae7747cf6dda90465ca79fc7ca137efa3540` after checking status and fetching.
The pre-existing `.gitignore` addition for `.vercel` is preserved, uncommitted
and excluded from this change. No merge, push or deployment was performed.

## Experience and assets

- [Desktop opening](previews/desktop-light.png) · [Dark opening](previews/desktop-dark.png)
- [Mobile opening](previews/mobile-light.png) · [320px](previews/mobile-320.png) · [Tablet](previews/tablet-light.png)
- [Review](previews/desktop-demo-proposed.png) · [Recorded09](previews/recorded-09.png) · [Historical08](previews/historical-08.png) · [Restored10](previews/restored-10.png)
- [System Map](previews/platform.png) · [Source](previews/source.png) · [API](previews/api.png) · [Navigator](previews/navigator.png)
- [Gimbal](previews/gimbal.png) · [Providers](previews/providers.png) · [Close](previews/closing.png)
- [Actual simulation recording](previews/simulation.webm): 10.2 seconds, 1280×900, 25fps VP8. This is browser footage, not generated imagery.
- [No-WebGL mobile opening](previews/mobile-no-webgl.png)
- [Complete direction, storyboard and interaction contract](../zenith-reimagined-direction.md)
- [Vector identity and usage](../../public/brand/README.md) · [Font licenses and provenance](../../public/fonts/README.md)

The three PNGs under `concepts/` are generated composition references, not
screenshots or exact product specifications. Their source/prompt provenance and
known inaccuracies are recorded in the direction document. All files under
`previews/` are actual local production-browser captures; no generated raster
is used in the shipped page. SVG geometry and scene materials are authored in
source. Existing Gimbal asset provenance remains intact.

## Product contract

The synthetic Atlas fixture uses the actual manifest schema and cost model:
`atlas-api` and `atlas-worker`, then `atlas-jobs` with `queue_publish` and
`queue_consume` bindings. The estimate changes from $14/month to $15/month.
Initial active 08 is distinct from proposed 09. Review plus explicit Run simulation
records 09; history inspection is read-only; restoring the 08 configuration
creates 10 and retains 09. Repeating appends later revisions; reset/reload resets
only this in-memory demonstration. Restore does not recover deleted data.

The original shared `/api/me` CTA hook is unchanged. Signed-out/configured users
see Create account → `/signup`; workspace users see Open Zenith.ai → `/overview`;
otherwise Start with Gimbal → `/onboarding`. One shared request resolves all
primary CTA instances with stable widths. Sign-in, guide and onboarding paths
remain available. With configured authentication, guide/onboarding retain the
existing sign-in gate; this commission does not bypass authentication.

Provider availability still comes from build-time `ensureEngine()` registration,
plus the explicit unregistered Oracle roadmap entry. Sandbox is simulated;
LocalStack supports real local S3/SQS within preflight limits; AWS Preview plans
and exports real Terraform without in-app apply, account reads or live
verification. Kubernetes/GCP are Planned; Azure/Oracle are Coming later.
Simulation completion stays neutral and never becomes Verified.

Only the landing, necessary identity/shared brand assets, metadata, docs and
verification tooling changed. Product workflows, provider/action/API identifiers,
configuration variables, cookies, storage keys, persisted data, package identity,
Terraform addresses and export filenames remain compatible. No dependency or
lockfile changes were necessary.

## Verification

Installed versions were rechecked: Next 15.5.24, React 19.1.0, TypeScript 5.9.3,
Tailwind 4.3.3, Three 0.185.1. Local runtime used an isolated `.data-zenith-preview`
directory; builds used `.data-zenith-build`. Existing application data was not
used for the simulation or smoke test.

| Check | Observed result |
| --- | --- |
| Pre-change baseline | 88 test files / 932 tests passed |
| Full regression suite | 89 test files / 937 tests passed |
| Final focused landing checks | 3 files / 10 tests passed after the scene-layout fixes |
| Typecheck and lint | Passed; final production build also completed both checks |
| Production build | Passed; `/` remains statically prerendered, 21.9kB route / 141kB First Load JS reported by Next |
| Engine smoke | Happy deployment and deliberate failure/rollback passed using a copy of the existing smoke script with only its scratch data path changed |
| Gimbal assets | `npm run gimbal:verify` passed |
| Browser functional matrix | 16 checks passed, zero unexpected errors |
| Fixed-stage/fallback follow-up | 8 checks passed, zero unexpected errors |
| Final loading comparison | 4 checks passed, zero unexpected errors |
| Independent review | Astra high: Ship for branch review; no remaining material findings |

The functional matrix covered all CTA identities, one identity request, delayed
and failed responses, explicit approval, every demo phase, historical viewing,
restoration/reset, all four model tabs, native keyboard arrows/Home/End and visible
focus, both themes at 320/390/768/1440px, reduced motion, unavailable WebGL, Gimbal
fallback/greeting and delayed fonts/renderer. Mobile scene stages remain 280px;
desktop remains 400px, with the same document position across all six inspected
states. Real signup/login screens were opened without submitting credentials.
The in-app browser was used for the visual review. Its exposed API lacked video,
network/device emulation and identity mocking, so installed Playwright/Chrome
provided those supplemental capabilities in isolated local contexts.

The design detector ran once. Its five advisory findings were two existing
Space Grotesk declarations retained for product UI, two intentional Instrument
Serif declarations, and a semantic accent rule on the changed queue node. The
independent reviewer accepted those choices. Key text/focus token contrast ratios
are at least 4.84:1; sampled light muted text is 5.58:1 and dark muted text 7.69:1.
This is not a claim of accessibility certification.

An intermediate browser harness waited for the intentionally hidden mobile
header CTA. It was corrected to wait for the visible hero CTA; affected checks
then passed. Review also identified contradictory post-run rail labels, missing
read-only historical views, label overlap and a stage that resized with plan
text. All were corrected and confirmed in refreshed captures. A TypeScript
narrowing error in the final deferred-renderer refinement was caught and fixed
before the successful final build. No unresolved baseline or regression failure
is being omitted.

## Loading and rendering observations

Final cold-cache lab: Chrome 152.0.7977.82, Windows 11 Home 10.0.26200, DPR 1.
Desktop 1440×1000 is unthrottled. Mobile 390×844 uses 150ms latency, 1.6Mbps down,
0.75Mbps up and 4× CPU throttling. Headline `H1#zenith-title` was LCP in both runs.
These are individual local lab runs, not field Core Web Vitals or INP.

| Final run | LCP | CLS | Longest main-thread task |
| --- | ---: | ---: | ---: |
| Cold desktop | 972ms | 0 | 779ms |
| Throttled mobile | 2996ms | 0.000026 | 1571ms |

The earlier mobile observations ranged 2.10–3.70s LCP and 0.1003–0.1236 CLS before
font/layout work. The final implementation preloads critical fonts, reserves
label/stage geometry, uses measured local fallback metrics, and waits for text
to paint before initializing native graphics. No sustained frame-rate claim is
made. Source caps revision transitions at 30fps, DPR at 1.5 (1 for low power),
pauses offscreen/hidden rendering, stops settled revision RAF loops and disposes
geometry, materials, textures, shadows and contexts. The complete SVG frame
remains usable while native rendering loads or fails.

Material limits: WebGL initialization still causes substantial long tasks under
4× CPU throttling. Validation used desktop Chrome with emulated mobile sizes,
not physical iOS/Android devices or Safari/Firefox. No cloud account was verified,
no infrastructure provisioned, and no authenticated account flow was submitted.
The demo history is intentionally local and resets on reload.

Raw evidence is retained in [verification/](verification/): the original 16-check
report, fixed-stage follow-up, final renderer comparison, font measurements,
design-detector output and independent review. For reproduction, start a local
production server on 3401 and run `node scripts/zenith-landing-qa.mjs` with installed
Chrome. `ZENITH_QA_URL`, `ZENITH_QA_ONLY`, `ZENITH_QA_REPORT`,
`ZENITH_QA_ARTIFACTS` and `ZENITH_QA_FRESH` allow bounded reruns.

Five independent roles—repository/product analysis, brand/art direction,
3D/motion, frontend/state implementation, and independent review—were delegated
using the requested `gpt-6-astra` with high reasoning. The root agent integrated
shared files and dependencies. The requested subagent model was available.
