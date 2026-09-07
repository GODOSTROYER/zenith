# Hosted Revision 2 implementation ownership

Starting point: `4231dda67fb5a0f57c4bd87117fa5af3c4c083de`, preserving the completed UI work. Feature branch: `codex/zenith-hosted-r2`. Existing unrelated changes remain untouched. No push, merge, provisioning, customer messages or destructive recovery is authorized.

The supplied implementation instruction refers to a separate Revision 2 report (sections 01–25, A01–A09, D01–D09 and page 47). That report is not present in the supplied attachment or repository. Its location has been requested. Do not invent page/workstream mappings or freeze report-dependent security contracts before it is read.

This scoped assignment supersedes the historical repository table only for the paths listed below. Unlisted paths retain existing ownership. All workers use gpt-6-astra with high reasoning.

| Owner | Exclusive writable paths in this preparation wave | Scope |
| --- | --- | --- |
| Integrator | `docs/hosted/OWNERSHIP.md`, `docs/hosted/CHECKPOINT.md`, `docs/hosted/DECISIONS.md`, `docs/OWNERSHIP.md`, `docs/RUNNING.md`, `docs/LIMITATIONS.md` | Starting point, audit synthesis, unresolved decisions, directly affected documentation and integration |
| Identity/access audit worker | `docs/hosted/requirements.json`, `docs/hosted/requirements.md` | Provisional extraction from the supplied instructions; mark all unavailable PDF mappings explicitly |
| Independent verification worker | `.github/workflows/ci.yml`, `.dockerignore`, `tests/ci/release-gates.test.ts`, `.data-hosted-baseline-20260907/**` | Fresh isolated baseline evidence; blocking existing build gates, existing Gimbal check, least-privilege CI, excluded local state/credentials and regression coverage |
| Control audit worker | `src/lib/navigator/server-actions.ts`, `src/lib/navigator/run.ts`, `tests/navigator/server-actions.test.ts`, `tests/navigator/executor.test.ts` | Reproduce and narrowly correct existing cross-workspace Navigator mutation admission and stale human-role execution; preserve current local demo behavior, public action signatures and persistence model |
| Runtime audit worker | `scripts/hosted-spike/cloudflare-preflight.ts`, `scripts/hosted-spike/cloudflare-client.ts`, `scripts/hosted-spike/README.md`, `tests/hosted-spike/cloudflare-preflight.test.ts` | Standalone opt-in, GET-only inspection harness for two test app release/broker binding configurations; no application adapter, provisioning, dispatch, customer data access or claimed isolation proof |
| Build audit worker | None | Independent CI review; source/provider research |
| Integrator — SQLite feasibility | `scripts/hosted-spike/sqlite-feasibility.ts`, `tests/hosted-spike/sqlite-feasibility.test.ts` | Real SQLite primitive tests in a fresh OS-temporary directory only; no application imports, authority migration or selected production driver |

The CI corrections and existing Navigator workspace-isolation correction are independently specified by the supplied instructions. The Navigator change is an adjacent functional fix, not a hosted authorization implementation: existing workspace/project IDs and member roles remain its inputs; denial returns the existing error envelope before mutation or model invocation. It must not add a second permission authority or change membership bootstrap policy. Permission migration, hosted domain contracts, provider provisioning, application data and build execution are not part of this preparation wave. Broad implementation assignments require the report, agreed contracts and an updated table.

The inspection harness uses an isolated script-level contract derived only from explicit attachment constraints: two distinct app keys, release names, broker names and D1 IDs; immutable Cloudflare API origin; GET-only calls; strict binding allowlists; bounded/redacted responses and errors. It cannot mark app access, network isolation, candidate health, build execution or D02/D08 compliance as passed. Report mapping stays provisional. Operator configuration names resources; credentials stay in the CLI process environment and are never written to evidence.

Only the integrator may change shared types, dependency manifests/lockfile, configuration or permission authority. Use isolated test directories. Do not run smoke or recovery commands against developer state. Every implementation handoff includes changed files, actual check results and missing evidence.

## Revision 3 (2026-09-07, branch `zenith/hosted-r3`, integrator: Claude)

The Revision 2 preparation table above is historical. Revision 3 ownership is the workstream table in [PLAN-R3.md](PLAN-R3.md) section 2: each of W1–W11 writes only inside its exclusive paths; the integrator (W0) owns the contracts, configuration, edge/middleware and boot wiring, navigation, `package.json`, the Dockerfile and the documents not listed under W11. Requested edits outside a workstream's paths are handed to the integrator in that workstream's final report and applied by the integrator alone.
