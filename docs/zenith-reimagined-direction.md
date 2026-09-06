# Zenith — The Revision Object

Selected creative direction and implementation reference. 6 September 2026.

The user superseded the previous observatory marketing aesthetic. This document records the selected direction and the implemented landing, rather than an unapproved proposal. Product facts and compatibility remain governed by PRODUCT.md and BRANDING.md. Product workflows retain their shared UI; the landing's editorial fonts, scale and colors are scoped to its own surface. The separate verification report owns measured checks and results.

## Three directions considered

**The Revision Object — selected.** The next change, made tangible. An orthographic infrastructure object holds two existing porcelain service slabs. A vermilion queue is proposed in the space between them, then settles into a recorded configuration after explicit simulation. One fixture continues from opening through inspection, review, evidence and all model surfaces. This makes the plan-first mechanism visible without invented commercial proof. The risk of opaque sculpture is addressed by permanent HTML labels, resource buttons, an inspector and a readable flat model view.

**The Change Ledger.** Every change has a before, an after and a record. Ruled sheets, oversized revision numerals and red manifest insertions would make the page a technical monograph. Strong for credibility and mobile reading, but less immediately memorable and too text-dominant for the opening. Its ruled evidence and audit clarity informed the selected direction.

**The Permission to Proceed.** A deliberate pause between intent and infrastructure. An imposing gate would hold the proposed queue until a deliberate action. It offered a strong campaign image but risked making approval feel restrictive and required explaining an extra metaphor. The selected direction retains the explicit action boundary using actual infrastructure objects.

The choice is the Revision Object. The other concepts are recorded as exploration, not alternate shipped themes.

## Identity and materials

The Shift Register is two offset solid shapes with a diagonal seam: an authored compact mark that echoes a revision's change in alignment. It is not a mountain, orbit or star. The original lowercase zenith wordmark uses custom path geometry; its visible .ai suffix retains the name. `src/components/shell/brand-geometry.ts` is the source of truth for both symbol and lettering. `wordmark.tsx` retains the existing OrbitMark/Wordmark export names for product callers. The symbol, wordmark, inverse, monochrome, small and favicon assets belong to the same system. Raster concept logos are never the source for production identity.

The scene uses low extruded ceramic service shapes, a ribbed proposed queue, routed connections, metal details and restrained physical shadows. Both service positions remain anchored across current, proposed, recorded and restored states. The queue carries the motion. Its proposal is vermilion; its recorded material settles into porcelain with a small vermilion revision tab. A restore undocks and removes the queue from the viewed configuration. It does not erase its historical record.

The landing uses actual self-hosted Instrument Serif 400 roman and italic, Manrope variable for body and controls, and the existing JetBrains Mono for resource names, revisions, source and estimates. OFL notices and source URLs are in `public/fonts/README.md`. Instrument Serif and Manrope are new landing roles; Space Grotesk remains the product UI face. Font display uses swap. The drawn identity is independent of these fonts.

Light landing tokens are porcelain #f4f3ee, ink #20211f and vermilion #be3e25. Dark tokens are #22241f, warm ink #f2f1e9 and accent #ff886c. Muted text, rules and raised planes have their own theme values. The inspect/review chapter and close use deliberate ink grounds in both themes. The model, Gimbal and provider chapters use the selected surrounding theme. This is an intentional pair of themes, not a generic inversion or a global product reskin. Exact tokens live in the scoped landing CSS and section modules.

Large editorial type, asymmetry, ruled evidence, restrained corners and generous empty space establish hierarchy. Small mono is reserved for facts rather than decorative slogans. No invented customer logos, pricing plan, testimonials, performance figures or hosted availability support the design.

## Atlas is one state model

| State | Active revision and content | Viewed presentation |
| --- | --- | --- |
| Initial | 08: atlas-api and atlas-worker; no queue bindings | Proposed 09 is intentionally visible; atlas-jobs is selected |
| Current inspection | 08 remains active | Two services, no queue |
| Proposed inspection | 08 remains active | Add atlas-jobs; atlas-api publishes to it, atlas-worker consumes from it |
| Explicit simulation complete | 09 contains the queue and both bindings | Recorded configuration and retained audit entry |
| Historical inspection | Active revision is unchanged | Read-only 08 or 09, with the viewed and active revisions clearly named |
| Restore | New 10 uses the 08 configuration | Two services; 09 remains in history |
| Review and run again | New 11 contains the queue and bindings | Another recorded simulation; history continues to append |
| Reset demonstration | Local history returns to baseline 08 | Initial proposal 09 becomes visible again |

The initial proposal is intentional: the opening must make the next change visible. It does not mean revision 09 has already run. The baseline record is the only initial audit entry.

Historical viewing preserves the active revision, run stage and approval state. It is separate from the explicit **Restore previous demo revision** action. Restore creates a new revision with the baseline configuration; it does not move the active revision number backward. Subsequent runs and restores append later numbers. Only **Reset demonstration** clears the page's in-memory demo history. Reloading also creates a fresh local demonstration; this is not persisted workspace audit history.

Static estimates use the existing fixture model: $14 for two small services with one replica each, $15 with one nano queue, +$1/month. The interface labels these synthetic configuration estimates, not a billing quote. Restore displays the reverse delta. A queue binding supplies configuration; the application still implements publish/consume behavior, retries and duplicate handling.

## Implemented page sequence and key copy

### Opening

The sticky masthead provides the authored identity, real navigation, theme control and runtime-aware entry action. The hero starts immediately with **See the change. / Before you ship.**; the second line is italic. No eyebrow precedes the headline.

Supporting copy: **Your application. Its infrastructure. The next change. Zenith is a local-first deployment and operations platform that puts the plan in your hands.**

The hero includes the real runtime-aware CTA directly, plus **Explore the change** linking to the demonstration. CTA routing remains conditional: configured signed-out visitors create an account, workspace members open Zenith.ai, and unconfigured/local entry starts with Gimbal. The adjacent line is **Bring your own cloud. Keep your model.**

The object is labeled **Interactive simulation**, **ATLAS / R09** initially and **Synthetic example**. Its HTML service labels select the relevant resource and navigate to the inspector. The footer sentence is **One queue. Two bindings. A readable plan.** The hero consumes the same current/viewed revision state as the lower demo, so later records and history views update it too.

### Dark inspection and review

Heading: **The difference / is the point.** Supporting copy: **Review the queue and both bindings before the change runs. The next revision starts with your decision.**

Current/proposed buttons change inspection state. Resource buttons expose actual fixture properties and explicit queue_publish / queue_consume bindings. The neighboring evidence rail names the proposal, estimated cost and application responsibility. It contains the checkbox **I have reviewed the plan and estimate.** and the separate **Run simulation** button. Both review and deliberate activation are required. Hover, scrolling, section entry, history viewing and Gimbal greetings cannot start execution.

The simulation progresses through three locally timed steps and then displays **Simulation complete**, the active recorded revision and an explicitly simulated `sim://atlas/revisions/09/atlas-jobs` output. This is not a live deployment URL. No provider is contacted. Completion uses neutral lifecycle meaning; it is not Verified.

The audit trail has **View revision 08**, **View revision 09** and subsequent records. Historical views identify both viewed and active revisions and show configuration facts rather than pretending to be a new plan. A separate restore button creates 10 while preserving 09. The restored state offers **Review the queue again**, which leads to proposal 11 and requires review/activation again. **Reset demonstration** resets only the local example.

### One model, four surfaces

System Map, Source, API and Navigator are keyboard-operable tabs over the selected manifest and revision. System Map shows explicit relationships and counts. Source shows the real typed fixture structure with reserved example image references. API uses the existing endpoint schema as an illustrative request; it sends no request. Navigator is labeled a scripted illustration, explains typed actions and approval boundaries, and reflects historical, proposed and completed states from the same demo.

No source tab invents a second fixture or silently introduces the queue when viewing revision 08. A historical 09 view after restore still shows the queue because it is reading that record; active revision 10 remains unchanged.

### Gimbal and autonomy

Heading: **An intent. A plan. / Your decision.** Gimbal uses the shared product character renderer in a neutral state, starts in low-power mode, and offers Low power, Still poses and Follow system options. Its voluntary greeting is personality, never deployment evidence. The existing reduced-motion, low-power and WebGL fallback behaviors remain in force.

The five-level autonomy explorer displays the real shared policy meanings and states **Policy explanations · no workspace setting is changed**. Deployment approval policies and budgets still apply. The state guide retains Planning, Awaiting approval, Applying, Verified and Blocked, plus Neutral lifecycle examples. Verified explicitly requires authoritative non-simulated provider evidence. Completing this page's simulation cannot produce that state.

### Providers and export

Heading: **Your cloud. / Clear boundaries.** Registry-fed provider rows show the current connection limits. Sandbox simulates without provisioning. LocalStack supports local S3 buckets and SQS queues, with services, routes and other emulated behavior remaining simulated. AWS Preview exports real Terraform without in-app apply, account reads or live account verification. Kubernetes and Google Cloud appear under **On the horizon** as **Planned**; Microsoft Azure and the explicit Oracle roadmap entry say **Coming later**. None is presented as a working connection, and their provider IDs/status values are unchanged.

**The system stays yours.** The export illustration retains `orrery.manifest.json`, Terraform files and an operations README. The setup-guide link points to existing documentation. The illustration is not a nonworking download control. No data namespaces, export compatibility or historical provenance is renamed by the presentation.

### Close

Heading: **Make your next change / a clear one.** Supporting copy: **Start with an editable blueprint. Make the next decision with the whole system in view.** The same runtime-aware CTA returns beside **Explore the guide**. A large vermilion symbol signs the ink end field. Footer links are real destinations and the line reads **The next change, made tangible.**

## Responsive and motion contract

Desktop places the monumental headline beside the object and the inspector beside the review rail. The hero headline uses clamp(76px, 8.2vw, 132px), .92 leading and -.035em tracking, with explicit breakpoint overrides. On narrower screens, content stacks in reading order, the mobile navigation opens real controls, provider rows become compact document flow and four model tabs remain directly available. Source/API content may scroll inside its own code viewport; understanding the system does not require dragging the scene.

The native scene is decorative and hidden from assistive technology. Every meaningful label, resource control, selected state and execution action lives in HTML. An authored SVG pose is immediately available while WebGL initializes or when it fails. The renderer loads lazily when visible, responds to tab visibility and reduced-motion changes, and accounts for low-power conditions. Existing services remain fixed; only the queue and its related representation change. There is no continuous orbit or scroll-triggered apply. Reduced motion shows stable poses and advances the local simulation without theatrical timed delays.

The exact state transitions live in `use-revision-demo.ts`; the fixture is in `demo-fixture.ts`; both physical scene and all model surfaces derive from them. Changes to presentation must preserve this single source of state.

## Generated composition references

Three preview concepts were generated using the built-in imagegen tool and visually inspected. They informed material, hierarchy and chapter rhythm. They are design references, not deployed screenshot evidence or exact product specifications.

- Opening: `C:\Users\user\.codex\generated_images\01a0772e-562d-7252-a244-7a414fcbd57a\exec-f2853004-e84a-402d-9be4-5814d0e6a07d.png`
- Dark review: `C:\Users\user\.codex\generated_images\01a0772e-562d-7252-a244-7a414fcbd57a\exec-dec6c475-cb5b-41ea-9a06-d3d2b7c05cad.png`
- Lower sequence: `C:\Users\user\.codex\generated_images\01a0772e-562d-7252-a244-7a414fcbd57a\exec-923831fe-4815-49df-bce6-b17ebc38e4aa.png`

The common prompt requested premium full-bleed UI mockups, matte orthographic ceramic service slabs, a ribbed vermilion queue, precise bindings, Instrument Serif display type, Manrope-like body text, technical mono and the exact Atlas fixture. It excluded generic mountain/orbit logos, glow, glass, bento cards, invented customer proof and browser/device frames. The opening requested a 1440×1000 porcelain hero; review requested a 1440×1000 dark plan with $14→$15 estimate and explicit Run simulation; lower requested a 1440×1300 one-model/provider/closing sequence.

Known raster inaccuracies are not implementation requirements: generated wordmarks differ; the opening has a superseded eyebrow and lacks the direct hero entry CTA; revision labels use old 01/02 numbering; lower diagram arrows are not authoritative; the lower image is taller than requested. The authored code, actual identity geometry and state contract above supersede those approximations. Verification claims belong in the separate report.

### Initial rendering and state color

The landing preloads its three critical WOFF2 files. Measured local Georgia and
Arial fallback metrics keep the heading and body geometry stable while they
load. The SVG revision object is immediately visible; native WebGL enhancement
starts after fonts settle and two paint frames, and remains visibility gated.
The dark review stage has a fixed height (400px desktop, 280px small mobile) and
a reserved notice row so revision changes cannot move or zoom unchanged services.

Vermilion belongs to proposed change and the identity. The landing state glossary
uses a separate berry error token (#932553 light / #ff8fbb dark) for Blocked;
warning, applying, planning and verified retain their distinct semantic hues,
labels and icons. This scoped illustration does not recolor the shared product
workflows or change Gimbal's behavioral contract.

## Interaction storyboard and access contract

| Control and trigger | Initial state and result | Keyboard | Mobile | Reduced motion |
| --- | --- | --- | --- | --- |
| Current / Proposed buttons | Active08; proposed09 visible. Switch the viewed configuration while services stay anchored. | Native buttons, Tab then Enter/Space; pressed state announced. | Same direct buttons above the object. | Final object poses replace interpolation. |
| Resource label or button | Queue selected. Select API, worker or queue to expose its actual binding capabilities. Hero labels also navigate to the inspector. | Native links/buttons; selected state exposed. | Touch targets and a readable stacked inspector. | Same selection, no motion required. |
| Review checkbox + Run simulation | Unchecked and Run disabled. Checking alone does nothing; Run explicitly advances three synthetic steps and records09. | Labelled checkbox, Space then a separate button activation. Progress is a polite status. | Plan follows the object; same explicit boundary. | Local steps complete without theatrical delays. |
| Audit revision buttons | Baseline08 retained. View any retained configuration without changing active revision, approval or history. | Native buttons with pressed state; unavailable during a run. | Audit rows wrap beneath the plan. | Immediate historical pose. |
| Restore previous demo revision | Available after a completed simulation. Recreates08 configuration as new10;09 remains retained. | Native button; outcome labelled simulated. | Same explicit action and deleted-data limitation. | Queue disappears into the final restored pose. |
| Review again / Reset | After10, review proposal11 with a fresh approval. Reset instead clears only this page's demonstration and returns to08/proposal09. | Native buttons; disabled reset explains an active run. | Same controls. | Immediate poses. |
| System Map / Source / API / Navigator | Map selected, all consume the same viewed manifest. Change surface without changing revision or execution. | Roving tab focus; Left/Right, Home/End; named tab panels. | Four direct tabs; code has a native scroll region. | Immediate content switch. |
| Theme control | Porcelain on a new landing visit; saved preference wins. Toggle the intentional light/dark themes using the existing storage key. | Named button, visible focus; action label updates. | Same control in the masthead. | Immediate theme change. |
| Navigation disclosure | Closed on small screens. Opens ordinary links and the shared entry action; selecting a link closes it. | Button announces expansion; Escape from menu returns focus. | Visible menu button, no drag gesture. | Immediate disclosure. |
| Gimbal greeting and motion | Neutral, low power. Voluntary greeting is personality only. Motion options never alter a workflow state. | Named greeting button and labelled native select. | Same controls and static fallback. | Still pose and greeting text; no idle animation. |
| Autonomy explanations | Approve explanation selected. Choose any of five real policy descriptions; no workspace setting is written. | Native pressed buttons; new description politely announced. | Five direct choices. | Identical text behavior. |

All essential navigation, copy, descriptions, review evidence and controls are
semantic HTML. Pointer movement and scroll position grant no approval. No
horizontal scroll trap, mandatory introduction, custom cursor, or drag-only
operation is present. The source/API regions use ordinary native scrolling.
