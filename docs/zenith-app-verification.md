# Zenith application reimagining — delivery and verification

Branch: `test/zenith-app-reimagined`. Base: freshly fetched `origin/master` at `8a974387c14f3f400e20f067190d2ec2c614345f`, containing the approved landing and authentication corrections. This work is a local test-branch delivery; it has not been merged or deployed. Existing unrelated work was preserved.

## Design and implementation

The Revision Object identity now extends through the application. The workbench uses porcelain/ink surfaces, vermilion interaction and change emphasis, selective Instrument Serif titles, Manrope controls and explanatory text, and JetBrains Mono technical data. The approved vector wordmark, optical symbol variants, font assets and licenses are reused. Success, warnings/production, errors and Navigator retain separate semantic colors and text/icon cues.

The shared design contract is in [zenith-app-design-contract.md](zenith-app-design-contract.md). A 208px collapsible navigation rail, 60px compact rail and 56px context bar replace the stacked shell. Below 900px, navigation becomes a drawer. Each route owns its working scroll area; logs and appropriate master/detail lists have bounded independent scrolling. Document-root theme tokens also reach portaled dialogs, drawers and popovers.

Three interactions use authoritative application data:

1. **Change rehearsal:** deployed and working manifests supply exact resource/binding identities. One bounded porcelain scene compares current/proposed states; affected modules separate while unchanged modules remain anchored. HTML selection, costs and configuration details remain available without WebGL. The scene displays at most twelve resources spatially, with every resource available in the HTML list.
2. **Connected inspector:** graph resources, revision changes, deployment steps, findings, audit actions and Navigator steps use consistent identity/context framing. Read-only historical details preserve current working-copy semantics. Dismissal returns focus to the trigger.
3. **Plan to execution:** existing permission and approval boundaries feed recorded deployment phases, logs, outputs and final outcomes. Navigator distinguishes neutral action completion from simulated deployment completion and evidence-gated verification.

Motion uses 150/220/380ms tokens. Spatial rendering is progressive, visibility-aware, pixel-density capped and explicitly disposed. Reduced-motion paths retain the same final information. Gimbal gains a porcelain material option while preserving the landing's existing material and its hide/still/low-power behavior.

No package or lockfile changes were needed. Compatibility identifiers, persisted keys, cookies, provider/action IDs, Terraform/export names and user-defined domains remain intact. The landing retains its scoped composition and rendering, and `/` remains static with build-time provider registration.

## Route coverage

All nineteen page routes were inventoried. The landing is preserved; the other eighteen share the new application foundation. Screen-specific implementation was divided between coordinated Astra agents using high reasoning.

| Route / surface | Delivered treatment | Browser evidence |
| --- | --- | --- |
| `/` | Approved identity and composition preserved; corrected LocalStack explanatory copy | Final landing viewport compared with the baseline |
| `/overview` | Project/environment ledger, working/deployed estimates, budgets, bounded recent activity | Populated workspace and earlier empty workspace |
| `/p/[slug]` | Readable map nodes, selected-edge labels, tools, inspector, change rehearsal and deployment dock | Populated graph, exact queue inspector, empty graph, current/proposed review, restricted project |
| `/p/[slug]/source` | Editor hierarchy, technical typography, dirty/validation states and review controls | Populated manifest, invalid JSON, preserved draft while collapsing navigation |
| `/p/[slug]/deploys` | History/detail workspace, phase progression, logs and explicit simulated outputs | Three recorded Sandbox deployments, selected run, outputs and connected step detail |
| `/p/[slug]/revisions` | Source/target comparison, persistent pagination, change inspection and restore semantics | r1→r2 and r2→r3 comparisons, inspector, restore review/cancel |
| `/p/[slug]/observe` | Health/cost/drift evidence, log status and unavailable/undeployed distinctions | Populated simulated signals and undeployed production-class test environment |
| `/p/[slug]/security` | Finding ledger, environment context, review detail and permission-aware remediation | Empty state and real configuration-policy finding for qa-production |
| `/p/[slug]/activity` | Audit ledger, filters, actor/scope and connected details | Populated actions, text filtering and recorded Navigator action |
| `/p/[slug]/settings` | Eight grouped sections, anchored navigation, forms, health errors and confirmations | Workspace/environment forms, invalid name, new production-class Sandbox environment |
| `/p/[slug]/navigator` | Task-first request/plan/approval/history, compact Gimbal/context | Working-copy action, deploy approval, actual simulated execution, cancellation and recorded receipt |
| `/login` | New auth composition and shared controls | Signed-out form on a separate loopback origin |
| `/signup` | Shared auth identity and account form | Signed-out form |
| `/forgot-password` | Shared recovery form | Signed-out form; no recovery email sent |
| `/reset-password` | Recovery-session boundary and useful next action | Missing recovery-session guidance; no password changed |
| `/onboarding` | Compact setup rail, provider facts, blueprint/import/blank choices | Workspace creation, provider choice, blueprint project and separate blank project |
| `/guide` | Revised orientation and project-specific next steps | Populated guide and empty-project orientation |
| `/preview/[deploymentId]/[serviceId]` | Branded output inspection with outcome gates | Actual Sandbox local preview from r3 |
| `/gimbal` | Porcelain companion/state preview and motion controls | Still selected, keyboard switch to Low power |

Shared shell verification includes project/environment switching, search, notification access, light/dark theme menus, drawer dismissal and focus restoration. Secondary Settings, permissions, recovery, failure and stream-interruption contracts also have focused automated coverage; the matrix does not imply every possible backend state was manually induced on every route.

## Live workflow exercised

The browser session used an isolated **Zenith UI Lab** workspace with **Revision Lab** and **Quiet Lab** projects. Only the Sandbox provider executed. The new **qa-production** environment has production classification and approval safeguards but uses a Sandbox connection; it was never deployed.

- Created Revision Lab from Standard SaaS: seven resources/nodes and eight bindings. Reviewed and explicitly ran r1, with a $74.50/month configuration estimate.
- Changed queue `jobs` from small to standard through the inspector's plan/confirm boundary. Reviewed the actual deployed/working comparison and $3/month increase, then ran simulated r2 at $77.50/month estimated.
- Set the isolated workspace's Navigator autonomy to Approve. Planned and approved worker replicas 1→2. Completion changed the working copy only; it did not claim deployment verification.
- Reviewed a two-step deployment request, including explicit high-risk step approval. Executed it through Navigator. Actual events produced r3, twelve completed provider steps, recorded outputs and a **Simulation complete** outcome; the target estimate was $84.50/month. A separate pending request was cancelled without execution.
- Compared revisions, opened a change inspector and confirmed dismissal restored the initiating control's focus. Reviewed restoration of an earlier configuration and cancelled; the dialog explicitly retained history and excluded deleted-data/application-write recovery.
- Entered invalid Source JSON, checked validation/disabled save behavior, collapsed navigation without losing the draft, then restored the original draft without saving.
- Switched environments and verified qa-production did not inherit Sandbox deployment/health state. Created the separate empty Quiet Lab project, inspected its zero-resource state, and switched back through the project selector. Access to Atlas from the isolated workspace returned the project-unavailable screen.
- Filtered recorded Activity, opened notifications and search, checked Settings validation, and exercised keyboard dismissal/restoration of mobile navigation and connected details.

Test data remains in Zenith UI Lab for review. No existing project configuration or real infrastructure was changed by visual QA.

## Narrow adjacent fixes

The visual work exposed several bounded defects, covered where behavioral tests were warranted: modal focus lifecycle/return; nested interactive elements; same-route deployment query selection; revision-page retention; stream cursor reset on URL changes; removed-binding identity; log-follow behavior at the retention limit; Observe log selection preservation; Settings health errors; environment URL synchronization; command-palette action destinations; reduced-motion map centering/zoom; and simulation labels on outputs and Navigator receipts. Original recorded audit text remains available unchanged in a labeled disclosure.

LocalStack copy was reconciled with actual adapter/preflight behavior: local S3/SQS operations are supported; application service/route emulation remains labeled simulation. AWS Preview remains planning and Terraform export, with no in-app AWS apply/live account verification. Roadmap providers retain their registry availability, including Oracle's explicit coming-later treatment.

## Automated verification

Final full test run: **1,080 tests passed in 114 files**, 15.59 seconds on the development host. TypeScript and repository-wide ESLint passed. Production builds include lint/type validation and static generation. The final responsive badge-class correction was additionally linted and included in the final production snapshot build.

- Full suites cover authentication/session behavior, roles and workspace isolation, actions/engine approval and cancellation, provider honesty, destructive/stateful safeguards, rollback, streams and recovery, editor validation, route histories, primitive keyboard/focus behavior and renderer lifecycle.
- Both-theme contrast tests passed, including semantic text on base and tinted surfaces. Measured minima across the tested palette combinations: 4.61:1 light and 5.11:1 dark.
- Isolated `npm run smoke` passed blueprint → estimated plan → simulated deployment/output → intentional failure → rollback. The smoke directory was verified to be inside the isolated build snapshot.
- `npm run gimbal:verify` passed archived GLB checks. These verify historical assets, not the current procedural renderer; separate renderer tests cover the active implementation.
- `git diff --check` passed. No new dependency was added. No failing repository check remains known.

The independent reviewers used **gpt-6-astra with high reasoning**. Visual/functional review found and resolved deployment scroll ownership, inspector tab overflow, long-plan scrolling, same-route deployment selection, simulated-receipt clarity and narrow Navigator badge layout. Accessibility review found zero remaining nested interactive JSX in its scan. Source review and automated results are distinguished from manual browser evidence.

## Performance and capture conditions

Host: Windows 10.0.26200, Node 24.19.0, Next 15.5.24, React 19.1.0, TypeScript/Tailwind 4, native Three. Browser QA used the running Turbopack development server on localhost:3400. Signed-out auth pages used 127.0.0.1:3400 to keep the existing localhost session intact.

Builds used an isolated source snapshot and the installed dependencies, with no environment or application-data files copied. A separate `ORRERY_DATA` directory prevented interference with the running server. Root `.next` was untouched. The build report records exact hashes, elapsed time, build ID, warnings and final snapshot freshness.

Representative Next first-load JS: System 106 kB, Overview 123 kB, Revisions 131 kB, Navigator 134 kB, Deploys 135 kB, Settings 140 kB, Source 148 kB, Observe 149 kB; the static landing remains 142 kB. These are build summaries, not measured network transfers or Core Web Vitals. The snapshot's parent-lockfile workspace-inference warning is nonblocking.

Desktop inspection used approximately 1707×960 CSS pixels, DPR 1.125. Mobile used **391×844 CSS pixels** and tablet **768×1024**, confirmed through rendered DOM dimensions. Tested route document widths/heights stayed bounded to those viewports, with route-owned scrolling. The in-app capture tool produces an oversized backing image under viewport emulation: some mobile originals are 521×1125 with unused canvas outside the rendered page. The gallery discloses its presentation mask and links the unmodified original captures. Some files named `.png` contain JPEG-encoded capture bytes, also documented by the generator.

Motion clips are sampled screen recordings with the actual frame timestamps preserved, not full-frame-rate smoothness measurements. The deployment recording predates the final simulation-receipt wording correction; the latest receipt screenshot and tests show the corrected presentation. It retains the real approval, events and simulated outcome.

## Remaining verification limits

- Browser inspection and responsive DOM measurements were performed on this host; there was no physical-device/Safari run, screen-reader session, 200% text-zoom audit, or browser-forced network/WebGL failure campaign.
- Reduced motion, unavailable WebGL, cleanup, stream interruptions, permissions and several loading/error paths have automated coverage. Gimbal Still/Low power were exercised in the UI. This is not a claim that every accessibility/failure combination received manual browser testing.
- No production infrastructure, live AWS apply, real LocalStack endpoint operation, external recovery-email delivery or password reset was exercised. Sandbox outcomes are explicitly simulated.
- No Lighthouse/Core Web Vitals score, sustained GPU frame-time trace, or production-network loading benchmark is claimed. Progressive rendering limits and build bundle evidence are recorded; the sample videos are for reviewing sequence and timing.

The local evidence gallery, full report, original captures, timing manifests and build logs accompany the branch delivery outside the repository.
