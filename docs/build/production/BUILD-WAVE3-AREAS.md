# Building machine: wave 3 areas (7 October 2026)

**Status: wave 3 is merged** into `prod/compose` on 7 October 2026 (all ten worker branches plus the verifier branch through `80bb7352`; migrations 30 to 36, aggregate `0022_platform_core.sql`). The building machine is idle on these areas; the table below is kept as the record of who built what. Verification instructions: [VERIFY-QUEUE.md](VERIFY-QUEUE.md), section Wave 3.

For the verifying agent. The building machine is now building these requirements in parallel with your verification. Pull and merge (`git pull --no-rebase`) before every push. Avoid editing the areas below unless a verification fix truly requires it; if you must, keep it minimal and note it in RESULTS so the builder merges carefully.

| Builder worker | Requirement(s) | Main areas touched |
|---|---|---|
| Gap fixes | OBS-02 composition, LIFE-11 MySQL | `src/lib/platform/agent-ports.ts`, `src/lib/observability/sources/factory.ts`, `src/lib/machines/telemetry.ts` callers; `src/lib/portability/engines/mysql.ts` (in-process `mysql2` path, approved dependency) |
| DUR-A | DUR-01, DUR-02 | durable intent/outbox, operation authority vs projections |
| DUR-B | DUR-03, DUR-04 | approval-bound executable semantics, dispatch re-authorization |
| DUR-C | DUR-05, DUR-06 | encrypted plan handoff, artifact cleanup, state backend recovery |
| DUR-D | DUR-07, DUR-08 | uncertain external mutation resolution, build/cleanup dedup receipts |
| OBS-01 | OBS-01 | canonical observe/diagnose/propose/remediate/verify engine |
| MACH-02 | MACH-02 | Kubernetes guest credential resolution |
| UX-02 | UX-02 | MCP/SDK/CLI OAuth client interoperability |
| MACH-06 | MACH-06 | bounded evaluated coding agents |
| LIFE-07 | LIFE-07 | Kubernetes full lifecycle (StatefulSets, CronJobs, persistent data, NetworkPolicy) |

Not touched by the builder until you finish default-stack steps 3a to 3c: installer (`scripts/deploy/installation.mjs`, `docs/platform/INSTALLATION.md`), default composition, PKG-04/05. COST-01/02 wait until COST-03 verification is recorded.

`mysql2@3.24.5` was added with user approval (lock-only plus one `package.json` line, complete audit zero findings). Run `npm ci` after pulling.

New platform migrations from this wave use versions 30 to 39 and ship in a new `0022_platform_core.sql`; `0016` to `0021` stay byte-identical.
