---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: ["src/app/_landing/landing.tsx","src/app/_landing/system-diagram.tsx","src/app/_landing/before-chapter.tsx","src/app/_landing/gimbal-companion.tsx"]
---

# Surface brief — Zenith landing (/)

Scope: the marketing front door at `/` (src/app/page.tsx + src/app/_landing/*). Mode: Persuade.

Audience: founders, solo developers and small teams who need to understand infrastructure before changing it. Job: understand Zenith, inspect a concrete proposal, and enter the product through the real runtime-aware CTA. Proof: one synthetic example system (an upload-and-process application) read by every chapter, with Gimbal as a persistent curated guide. No invented customers, commercial claims, live cloud availability or pricing plan. Provider rows come from the registry and state exact current limits.

Chosen direction: **Your cloud, in full view.** The sky at its zenith as the opening (night gradient, stars, nebula, ridges, a beacon) with the brand lettering across the viewport; porcelain daylight for the chapters with bold Manrope headlines, one paragraph at most, big rounded ink cards and the two-column feature pattern with round-icon rows; night again for the cloud roadmap and the close. One language throughout: porcelain and ink surfaces, the mark's vermilion as the only accent, one control family. GSAP and Lenis motion, reduced-motion gated. The Atlas story and the infrastructure sculpture are retired; one example system carries every chapter with Gimbal as a persistent guide in the bottom-right corner.

Memorable moment: the light that travels the system's connections in story order, and the pulse that stops at the approval gate until it lights: nothing on the page runs without the person's decision. No scroll-triggered apply, invented live URL or simulated Verified state.

Sequence: “Welcome to zenith” over the sky with the real entry CTA, See the system, the tagline and the marks row; a pinned one-sentence statement; Only the real facts; We map the system (feature row with the interactive system in an ink card, a light travelling the connections); What changes when you grow? (one ink card: orbs that grow with the sizing, one estimate); Keep the tools you already use (the linking and approval flow with a pulse that waits at the gate, three boundary cards); And you stay in control (a dial beside an ink card with the five real levels); Your cloud. Your call. (the constellation); The system stays yours (the original close's fanned sheets) and Reach the zenith (night close with the mark and the footer). No code, terminal, JSON or API request anywhere on the page.

State contract: one shared state in `landing-state.ts` feeds every chapter and Gimbal (view, selected part, growth step, path, observed part, demonstration autonomy level, agent step, walkthrough, companion, suggestion history). The example system is real product manifests: current $22.00, proposed $30.00 (+$8.00) from the product cost model, plan items from `diffManifests`. Growth steps price illustrative sizings with the same tables and say so. Walkthroughs add emphasis only and restore selections. Suggestions: 12 s settled reading, once per chapter, 45 s cooldown, four per session, dismissed for the session. Nothing on the page reads or writes a workspace or contacts a provider.

Accessibility and motion: HTML controls/labels own interaction and meaning; the decorative native scene has an immediate authored SVG fallback and reduced-motion stable poses. Existing service positions remain fixed. Gimbal uses the shared renderer, neutral greeting, low-power/still/system options and existing state evidence rules. Verified requires authoritative non-simulated provider evidence. The autonomy explorer changes explanations only, never workspace settings.

Source of truth: docs/DESIGN.md, docs/BRANDING.md and docs/zenith-reimagined-direction.md. Measured validation and any remaining limitations belong in the dedicated verification report; this brief does not assert test or deployment results.
