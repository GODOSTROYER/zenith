# Integrated engineering candidate, 3 October 2026

Functional source `07728546bcc3489bdf8a382c646d57218b87e147` is integrated at `6814da58eacf865edb0d5a91c5642922b2ec78bb` on `codex/production-2026-10-02`. Staging merge `14af62c` and main merge preserve baseline, newer commits and original worktrees. Author and committer are Saivedant Hava on Saivedant's Mac. The source inventory and sanitized receipt digests are in [the machine report](2026-10-03-g1-integration.json).

| Executed check | Passed | Failed | Skipped | Evidence scope |
|---|---:|---:|---:|---|
| Full Node/DOM | 16,944 | 0 | 204 | Exact functional source; skip files retained in JSON |
| Temporal | 1,000 | 0 | 0 | Real local service, strict required groups and 12 bindings |
| Policy contract lane | 238 | 0 | 0 | Strict required groups and execution revalidation |
| OpenTofu | 3,900 | 0 | 8 | Real network engine; eight PostgreSQL handoff scenarios executed in separate lane |
| Platform PostgreSQL | 1,532 | 0 | 0 | Real PostgreSQL 16.15, migration7, 70 groups, 12 bindings |
| Supabase migration lane | 251 | 0 | 0 | 14 SQL files apply/reapply; name/checksum tamper refused |
| Native OPA | 213 | 0 | 0 | OPA1.19.1 |
| Darwin Go race | 241 parents + 542 subtests | 0 | 3 | Counts overlap; Linux-only skips remain Darwin skips |
| Local kind provider | 6 | 0 | 0 | Fresh local cluster |
| Local kind release | 1 | 0 | 0 | Fresh local cluster |
| Native ARM64 guest | 801 leaf cases | 0 | 3 | Source4bf, 55 parents/17 packages; unchanged Go/guest/CI input scope |
| Real fixture tamper/cleanup | 28 | 0 | 0 | Actual Linux UID/GID, mounts, ACLs, identity and partial-setup cleanup |

Compiler, lint, generated SQL/matrix/AWS templates/ledger, fresh locked install, zero-finding complete audit and full clean-clone Next production build passed. Dependency replacement preserves 27 real-glob compatibility contracts and tooling behavior; registry remains empty, with no approved exception. These results are time-bound clearance of known findings.

Both execution-worker image checks passed on exact functional source: ARM64 native in 215.99 seconds and AMD64 emulated in 277.66 seconds. Real entrypoint, schema7, signer/policy loading, polling, readiness/liveness, store/Temporal outage recovery, plan/SSM assets and idle shutdown ran. No mutation was in flight; native AMD64 and in-flight shutdown remain open. Build context was inventoried live, not an immutable copied context.

No lane totals are added. Dedicated PostgreSQL, Temporal and kind results do not rewrite original unit skips. Native guest receipt remains bound to4bf and its original lock; integrated Go/fixture/CI inputs are byte-identical, but exact-current pushed native CI is still required. Five authentic Go result goldens are committed. Three native skips cover unsupported systemd/two Go-specific OpenTofu probes; broader typed upload/package/services and signed user acceptance remain open.

All owned Docker resources, builders/cache/new images and disposable clusters were removed. Fresh clean-clone build/dependency output was removed only from its owned clone. Latest host free space:19.36GiB. One heavy local workload at a time; no global pruning or unrelated service changes.

Historical failures remain preserved: original durable16588P70F212S, combined16939P4F204S, native RE2/report failures, the initial fixture mount-ID experiment13P1F, and the initial pre-execution clean-clone helper error. Corrections retain strict gates; failed attempts do not satisfy current acceptance.

Last inspected published source24e/run37110507951 remains13 passing jobs and one dependency-security failure. This integration still needs a new complete pushed run, including current native Linux, Smoke and Gimbal gates. Local default API/browser startup, isolated private Supabase, live GitHub/AWS, TLS/pooler/operational recovery and production signoff remain unexecuted. G1 exit and all four program release statuses remain false.

Next source candidate is isolated88cc783: durable build launches and GitHub browser/webhook revocation with migrations8–10. Source independently reviewed; root combined compiler, real PostgreSQL140groups and Temporal53groups remain pending. Accepted late receipts11, corrected durable scheduler, start intents12 and mixed-provider planning are separate owned lanes. Cross-provider execution guard remains enforced.
