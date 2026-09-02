# Known limitations (kept honest, updated at each phase)

Status legend: ✅ implemented · 🟡 partial · ⬜ not yet built

## Platform
- ✅ Canonical manifest, diffing/changesets, cost model, validation
- ✅ Typed action registry with plan/execute/audit/idempotency + autonomy enforcement
- ✅ Durable JSON/JSONL store (single-process ceiling by design; SQL swap is contained to `src/lib/db`)
- 🟡 Multi-tenancy: optional Supabase auth (email/password, confirmation, reset; `/login`, `/signup`) gives real identity, and actions/audit carry the signed-in user; without keys it is still one local demo user. One workspace per install. `requiredRole` is enforced on execute against the member's role (planning stays open); the Navigator header is bound to a boot-time secret so audit attribution cannot be forged
- ⬜ Real network security, rate limiting, encryption at rest

## Providers
- ✅ Sandbox: full simulated execution, honest labeling, chaos/failure injection
- 🟡 AWS Preview: real plan shapes + real Terraform export; **no real cloud apply** (requires credentials; deliberately disabled)
- ✅ LocalStack: AWS-shaped local testing; selectable in onboarding and Settings, driven by registry availability
- ⬜ Kubernetes, GCP, Azure (Planned; not selectable, and refused at plan time before any revision is written)
- ⬜ Customer-side runner / short-lived workload identity (designed in docs, not implemented)

## Import & migration
- 🟡 Docker Compose / Dockerfile import with explained mapping report; all three importers are reachable from onboarding and the map's import dialog
- 🟡 Terraform import: reference-level resource detection only, labeled preview
- ⬜ Live cloud-resource discovery

## Operations
- ✅ Deploy plan → apply → streamed progress → activation URL → revisions → rollback (sandbox)
- 🟡 Logs/health/cost are sandbox-synthetic (honest: generated, labeled simulated); the sandbox replays only its last 200 log lines on connect, and search, filter and download operate on what is loaded
- ⬜ Real metrics ingestion, alert delivery channels (email/slack)

## Navigator (agent)
- 🟡 Deterministic goal planner over the typed action registry with autonomy levels, approvals, audit; LLM parsing only if `ANTHROPIC_API_KEY` present (labeled)
- ⬜ Learned preferences, incident post-mortems, multi-step self-healing beyond policy rules

## Product UI (browser-verified 2026-09-02)
- ✅ Overview, System Map (computed strata, pending-diff ghosting, bind mode), Inspector with plan-first edits, Changes review → deploy → live SSE progress → "Live." activation panel with URL + connection outputs, Navigator plan→approve→execute→summary, Source read/validate/save (project.updateManifest), Deploys/Revisions/Observe/Security/Activity/Settings screens, onboarding
- 🟡 Keyboard focus in the System Map does not pan the viewport, so a node scrolled out of view can be focused invisibly; the import report is rendered by two separate components (onboarding and the map dialog) rather than one shared one; activity search covers the actions loaded so far, while the actor/action/result filters run against the whole trail
- ⬜ `project.delete` action (Settings danger zone shows an honest disabled state)

## Testing
- ✅ Engine state-machine tests, action/importer/deploy/navigator/role/provider/store unit tests (87 across 12 files), e2e smoke (happy + failure/rollback), `npm run lint` clean
- ⬜ Visual regression, accessibility automation, load tests (structure noted in docs/ARCHITECTURE.md)
