# Known limitations (kept honest, updated at each phase)

Status legend: ✅ implemented · 🟡 partial · ⬜ not yet built

## Platform
- ✅ Canonical manifest, diffing/changesets, cost model, validation
- ✅ Typed action registry with plan/execute/audit/idempotency + autonomy enforcement
- ✅ Durable JSON/JSONL store (single-process ceiling by design; SQL swap is contained to `src/lib/db`)
- 🟡 Multi-tenancy: optional Supabase auth (email/password, confirmation, reset; `/login`, `/signup`) gives real identity, and actions/audit carry the signed-in user; without keys it is still one local demo user. One workspace per install; `requiredRole` is declared on actions but not yet enforced
- ⬜ Real network security, rate limiting, encryption at rest

## Providers
- ✅ Sandbox: full simulated execution, honest labeling, chaos/failure injection
- 🟡 AWS Preview: real plan shapes + real Terraform export; **no real cloud apply** (requires credentials; deliberately disabled)
- ⬜ Kubernetes, GCP, Azure (Planned; not selectable)
- ⬜ Customer-side runner / short-lived workload identity (designed in docs, not implemented)

## Import & migration
- 🟡 Docker Compose / Dockerfile import with explained mapping report
- 🟡 Terraform import: reference-level resource detection only, labeled preview
- ⬜ Live cloud-resource discovery

## Operations
- ✅ Deploy plan → apply → streamed progress → activation URL → revisions → rollback (sandbox)
- 🟡 Logs/health/cost are sandbox-synthetic (honest: generated, labeled simulated)
- ⬜ Real metrics ingestion, alert delivery channels (email/slack)

## Navigator (agent)
- 🟡 Deterministic goal planner over the typed action registry with autonomy levels, approvals, audit; LLM parsing only if `ANTHROPIC_API_KEY` present (labeled)
- ⬜ Learned preferences, incident post-mortems, multi-step self-healing beyond policy rules

## Product UI (browser-verified 2026-08-26)
- ✅ Overview, System Map (computed strata, pending-diff ghosting, bind mode), Inspector with plan-first edits, Changes review → deploy → live SSE progress → "Live." activation panel with URL + connection outputs, Navigator plan→approve→execute→summary, Source read/validate/save (project.updateManifest), Deploys/Revisions/Observe/Security/Activity/Settings screens, onboarding
- 🟡 Inspector panel clips at narrow (<1400px) windows; deleted bindings don't ghost on the map (listed in Changes panel instead); app log lanes don't split stdout/stderr
- ⬜ `project.delete` action (Settings danger zone shows an honest disabled state)

## Testing
- ✅ Engine state-machine tests, action/importer/deploy/navigator unit tests (29), e2e smoke (happy + failure/rollback)
- ⬜ Visual regression, accessibility automation, load tests (structure noted in docs/ARCHITECTURE.md)
