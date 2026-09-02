# Known limitations (kept honest, updated at each phase)

Status legend: ✅ implemented · 🟡 partial · ⬜ not yet built

## Platform
- ✅ Canonical manifest, diffing/changesets, cost model, validation
- ✅ Typed action registry with plan/execute/audit/idempotency + autonomy enforcement
- ✅ Durable JSON/JSONL store (single-process ceiling by design; SQL swap is contained to `src/lib/db`)
- 🟡 Multi-tenancy: optional Supabase auth (email/password, confirmation, reset; `/login`, `/signup`) gives real identity, and actions/audit carry the signed-in user; without keys it is still one local demo user. One workspace per install, and joining it requires an invite, an operator-set `app_metadata.role`, or being its first real member. `requiredRole` is enforced on execute against the member's role (planning stays open). The Navigator's own steps run as the Navigator actor, so `runAction` never role-checks a human there — the executor separately refuses a run whose steps outrank the person who pressed Run. The `x-orrery-actor` binding covers only the HTTP `/api` surface: server actions never carry those headers, so the in-process Navigator path is trusted because it is in-process, not because it is bound
- ⬜ Real network security, rate limiting, encryption at rest for the snapshot and the logs (the secret store is encrypted; see below)

## Secrets
- ✅ **Real:** a per-workspace store at `<ORRERY_DATA>/secrets.json`, values encrypted with AES-256-GCM under `ORRERY_SECRET_KEY` (32 bytes from the environment), workspace + reference authenticated with the ciphertext. The manifest holds only `vault:<KEY>`, so no value reaches a diff, a revision, the audit log, the project payload the browser loads, or an export bundle. `system.setSecret` / `system.rotateSecret` / `system.removeSecret` are plan-first and editor-only; the security report's "Move to the secret store" fix moves a plaintext value in one action, writing the store before it commits the manifest so a failure never destroys the value
- 🟡 **Partial:** the sandbox resolves references at deploy time and logs which version it found, but starts no container, so nothing actually receives a value — the log line says so. A reference with nothing stored behind it is reported in the deploy log, not by manifest validation (which is pure and runs in the browser, and cannot read a server file)
- ⬜ **Not real:** no KMS, no HSM, no envelope encryption — one key for the whole server, held in its environment. No per-user or per-project access control: any editor in the workspace can rotate or remove any of its secrets. No versioned history (a rotation replaces the old value; it is not recoverable), no key rotation tooling (values written under an old `ORRERY_SECRET_KEY` cannot be read back, and there is no re-wrap command), no audit of *reads*, and no export of values in any form — moving to a provider means putting the values into SSM/Secrets Manager yourself, which the Terraform bundle's README shows how to do. LocalStack does not write SSM parameters: the adapter has no SSM client and Orrery will not add a dependency to emulate a store it already has

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
- ✅ Alert rules are real: four conditions (`health_degraded`, `deploy_failed`, `budget_exceeded`, `replicas_below`) per environment, evaluated every 15s from boot and again whenever the Alerts panel is read, deduplicated to one open event per rule, resolved when the condition clears, acknowledged by an editor, and recorded durably — the record outlives the rule that produced it. Conditions read the same inputs the screens do, so an alert can never disagree with the health card above it, and every event carries `simulated` (true for health-, replica- and cost-derived conditions, and for a sandbox deploy failure)
- ⬜ **Alert delivery channels do not exist.** No email, no Slack, no webhook, no push. An alert is delivered by being on screen: the Observe banner, the Alerts section, and `useProjectAlerts` for anything else in the product that wants it. If nobody opens Orrery, nobody is told — the evaluator records, it does not notify
- ⬜ Real metrics ingestion; alert conditions beyond the four above (no per-rule schedule, no "for N consecutive checks" hysteresis, so a condition that flaps faster than 15s produces one event per flap)

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
