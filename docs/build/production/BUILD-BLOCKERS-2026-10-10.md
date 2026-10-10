# Builder-facing blockers, 10 October 2026

Current integrated source is `273b93ee1321900018a49366719eb2e3cc51909c`. Focused f99 R4 repair passed582/0 with two gated J4 cases; actual-child J4 regressions on975a passed3/0/0. Full Node/DOM, complete J4 acceptance, process-custody successor, and exact-source CI remain pending.

The typecheck failure at975a came from missing `NODE_ENV` in the new test process environment. The reviewed one-line `NODE_ENV:"test"` repair is integrated at273b93ee. Full non-incremental5120MiB compiler and new-test ESLint both exited0 with empty private outputs.

The terminal CI run is for predecessor84a only. Verify failed eight stale112-vs-113 count assertions; Go failed in BuildKit builder setup before test events. Actual systemd acceptance was never reached. Fresh CI for the integrated source is pending.

Next, finish the full Node/DOM and canonical engine/native gates on one clean source, then inspect all jobs on that exact push. Complete actual J4 acceptance. Follow the local default journey J1 -> UX-01 -> OBS-04 -> MACH-03 -> OBS-02 -> MACH-04. MACH-04 requires separate real Linux PID1 lifecycle and actual default-stack delivery legs.

PostgreSQL17 `pg_dump` and `pg_restore` 17.11 are installed at `/opt/homebrew/opt/libpq@17/bin`; no PATH/service changes or acceptance run. Temporal CLI1.9.1 is available. Docker is available; DRV3/4 acceptance remains pending; DRV4 also needs reviewed native-ARM64 digests for PostgreSQL17, MySQL8.4, and MinIO. Keep AirPlay Receiver off while authorized local tests need port5000, per current user instruction; do not repeat Settings changes.

Cloud spending, DNS/private-app access, retention choices and production sign-off remain separate decisions.

J4 setup review found that ordinary J1 starts recurring schedulers before the fresh-database zero-row checks. An explicit deferred-worker harness and canonical resume are being implemented in isolated ownership; deferred setup cannot count as J1 readiness. J4 must run before J2 creates provider connections in that fresh full-schema database. Shipping runtime, migrations and maintenance preconditions remain unchanged.
