# Fresh CI repair verification, 2026-10-02

Root independently verified clean commit
`4a6bab7597ea3710875e19383d3a224409e902e4` in a new worktree with a fresh
dependency installation on Saivedant Hava's Mac. The completed local results
below do not establish remote CI success, live-cloud acceptance or production
approval. The branch has not yet completed a new GitHub run.

| Check | Passed | Failed | Skipped | Result |
|---|---:|---:|---:|---|
| Full Node and DOM suite | 16,054 | 0 | 194 | 793 files; 779 passed, 14 skipped |
| Canonical Temporal/platform/public-source lane | 861 | 0 | 0 | 40 files; all 37 required groups pass |
| OPA | 213 | 0 | 0 | Verified generated bundle matches fresh build |
| Go race tests | 226 top-level + 539 subtests | 0 | 3 | Uncached race run; Linux-only cases skipped on macOS |
| Earlier independent platform PostgreSQL lane | 1,324 | 0 | 0 | Fresh PostgreSQL 16.15; all 39 required groups pass |

These suites overlap. Their counts must not be added together. PostgreSQL
verification is bound separately to `e9ee01f4dd87f6dda2ad7c734e079fc444d09aed`;
its test/runtime changes are included in the clean reference above. Earlier
Supabase SQL checks applied and reapplied all 14 committed files on disposable
PostgreSQL and rejected corrupted platform migration names and checksums.
Neither bare PostgreSQL lane proves Supabase/PostgREST, production TLS or pooler
acceptance. Both PostgreSQL containers were deleted.

Fresh `npm ci --ignore-scripts` installed 791 packages. Typecheck, whole-tree
lint, Go formatting/vet, emitted SQL, strict capability documentation, all 18
AWS policy templates and both ledger render checks passed. Canonical sandbox
smoke and Gimbal asset verification also passed. Real OpenTofu network gates
were enabled in the full suite. Functional/security test deadlines and the
single-worker resource limit were preserved.

Canonical workflow evidence is retained as
[fresh-workflows-4a6bab7.json](evidence/fresh-workflows-4a6bab7.json). It binds
the clean commit, manifest/source hashes, dependency lock, installed versions
and environment hash, and records command exit 0. Standard Vitest JSON does not
export individual case IDs; trusted source/backend/suite groups supply the
current identity boundary. Canonical coverage for the other program gates
remains incomplete. Raw full-suite logs remain outside Git and were not
converted into fictional JSON case evidence.

Remaining blockers are explicit: 194 full-suite skips, external Temporal mTLS,
private-source and live provider acceptance, real browser proof on the newly
pushed commit, packaged worker startup on both architectures, and production
installation/recovery. The current integrated lock still has eight audited
package entries covering 24 advisory IDs. A separate zero-finding candidate
requires complete compatibility/build/Linux proof before integration; no
security exceptions were granted.

Private raw logs and exact commands remain under
`/Users/saivedanthava/.codex/zenith-production/logs/prod-fresh-*`. New GitHub
artifacts contain sanitized evidence only. Historical wave-8 proof and the
11-success/3-failure baseline run remain intact.
