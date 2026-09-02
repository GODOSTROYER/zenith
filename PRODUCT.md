# PRODUCT.md — Orrery

**What it is.** A bring-your-own-cloud deployment and operations platform for
small SaaS teams and solo builders. One canonical application manifest — a
typed graph of services, resources, routes, and explained *bindings* — drives
every surface: the living System Map, the Source view, the REST API, and the
Navigator agent, all through one registry of typed actions (plan → cost/risk
preview → execute → audit → undo).

**Mechanism in one sentence.** Every change becomes a readable plan with a
visible cost before it applies; every deploy streams durable progress, ends
in an unmissable live URL, and leaves a rollback point.

**Audience.** Startup founders, solo developers, small engineering teams,
AI-native builders who don't want to assemble ten disconnected infra tools.
Technically literate, allergic to overclaim (the category incumbent burned
them: hidden costs, dead controls, no URL after deploy).

**Differentiators (all shipped, all true).**
- Plan-first: cost deltas and risk on every change, before apply.
- The activation moment: "Live." panel with URL, copy/open, outputs.
- A map that cannot lie: layout computed from the model, no drag-fictions.
- Navigator: agent control through the same typed, audited actions, with a
  5-level autonomy dial and approval boundaries.
- Honest provider labels: Sandbox & LocalStack **Available**, AWS **Preview**
  (real Terraform export; apply disabled without credentials), K8s/GCP/Azure
  **Planned**. Simulated things say simulated; costs say estimate.
- No lock-in: manifest + real Terraform + operations README export;
  LocalStack → real AWS is one deleted override file.

**Voice.** Calm staff-level platform engineer. Errors name their fix.
Never overclaims. Celebrates once, quietly.

**Brand commitments.** Name "Orrery" (placeholder, user may rename later).
Working wordmark: orbital ring + satellite dot. Visual world: "observatory
at night" per docs/DESIGN.md (authoritative): bg0 #0a0d13 grounds, hairline
structure, mint-teal `signal` accent, periwinkle `nav-accent` reserved for
the Navigator, amber marks production, Space Grotesk + JetBrains Mono,
dark-first with a considered light theme.

**Platform.** Next.js 15 web app, local-first today (localhost:3400).
No pricing, no customers, no testimonials yet — the landing page may NOT
invent commercial claims; it demonstrates the product with real product
vocabulary and clearly synthetic demo data ("atlas" system).

**Uninventable facts:** prices, customers, benchmarks, hosted availability.
CTA reality: "Open Orrery" → /overview when a workspace exists, else
"Begin" → /onboarding. Secondary: GitHub repo (private), docs in-repo.
