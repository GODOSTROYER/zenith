# hosted/release — apps, publishes, rollback, suspension

Everything that turns a source package into a private running app without ever
losing the healthy one. The property this directory holds is narrow and
absolute: **an app that is serving a healthy release keeps serving it unless a
candidate has been built, stored, re-verified over its own bytes and probed.**

Every phase before `activate` writes only to its own records — a job row, an
artifact, a candidate release — and the app's `activeReleaseId` is touched in
exactly one place, by one statement: a compare-and-swap on the fence token the
claimant holds.

The job runner is started by `ensureHosted()` (see `../README.md`, "Boot
order"). Import from `index.ts`.

| File | Owns | Must not |
| --- | --- | --- |
| `index.ts` | The barrel, including `startHostedJobRunner` for boot | Re-export `http.ts` |
| `deps.ts` | The seam every cross-workstream call goes through: the runtime that stages and activates (W6), the build runner and artifact store (W2), the grant check (W5), the usage ledger and event log (W8). Defaults are the real modules | Decide policy. It decides only *who is asked* — a test swaps a double for the call it needs to steer |
| `shared.ts` | The plumbing every job kind shares: `advanceTo` (write the phase and its `phaseData` *before* the side effect, so a crash resumes at the step that was in flight), the lease heartbeat, the bounded log, and the two refusals a worker owes its caller | Continue after `jobs.advance` answers `false` — that means another worker holds the job, so `advanceTo` throws `LeaseLost`, `runJob` swallows it, and the new owner reports the outcome. Silence is correct here. `ponytail:` — raw SQL for queued-job phase data (`:108`) and lease renewal (`:150`); the repository lacks both methods |
| `apps.ts` | Creating and reading apps. The app row and its owner grant commit in one `tx()` — an app without its owner grant is a locked room with the key inside. The runtime is asked to prepare its side *after* the commit | Hold a SQLite write lock across a network call. Report success for a creation that half-happened: a failed runtime call leaves an app that says on its face why it is not ready (`stateReason`). `ponytail:` — the hostname comes from `ZENITH_APP_DOMAIN` rather than the runtime (`:163`), so a summary renders while the runtime is unavailable |
| `intent.ts` | What a publish *is*, canonically, and its SHA-256 — the thing a client's job UUID is checked against. A tarball enters the hash as the SHA-256 of its bytes, not the bytes; a fixture enters as its name, from a closed allowlist | Take a path from a request. A `{ kind: "fixture", name }` source resolves to a path on the control host, so the request never supplies one |
| `publish.ts` | The pipeline: `intake → build → artifact → verify_artifact → stage → probe → activate → cleanup`, resumable by a different process without doing anything twice | Touch `activeReleaseId` anywhere but the one compare-and-swap. A worker that lost the swap fails its own job rather than replacing a newer release with an older one. `ponytail:` — raw SQL for the staged runtime ref (`:593`), since `ReleasesRepo` has no setter |
| `rollback.ts` | Putting an app back onto a release it already ran, with every record its users wrote untouched | Swap without the schema comparison. Rollback replaces *code* and leaves data, which is only safe while the older code still understands the current data; anything else is refused with both versions named |
| `suspend.ts` | Stopping admission without destroying anything: a state on the app record, and nothing else. Data, grants, artifacts, releases and the active pointer all stay | Terminate sessions. The gateway refuses on state (423) at step 3, so suspension takes effect without costing recipients their place when the app returns |
| `runner.ts` | The 250 ms ticker: reclaim expired leases, check the build slots, claim through `jobs.claim` (which bumps the fence token), then run. One interval on `globalThis`, `unref`'d | Start a second interval on a hot reload, or hold a test or script open. Assume the per-app single-flight index covers the pilot-wide build ceiling — it does not |
| `http.ts` | The `/api` layer for hosted control routes: the hosted error mapping `route()` cannot do (409 for a duplicate slug, 423 for a suspended app, 503 for an unavailable runtime), the two role checks, and the reads a screen needs | Be re-exported by `index.ts`. It imports `@/lib/server/context` and `@/lib/actions/core`, which are two of the repository's three open import cycles — see docs/MODULE-MAP.md |
