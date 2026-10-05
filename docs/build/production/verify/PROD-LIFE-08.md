# PROD-LIFE-08 GitHub source binding lifecycle

## 1. What was built

Audit result: revocation by signed webhook (installation deleted/suspend, repositories removed), the install/OAuth bind
flow, per-repository read-only installation tokens and immutable-source acquisition already existed. Gaps closed here:

- Migration 30 `0030_github_revocation_reason.ts`: nullable `revoked_reason` on `platform.github_source_bindings` and `reason` on
  `platform.github_binding_events` (check-constrained to user_unbind, installation_deleted, installation_suspended, repositories_removed).
  Descriptive only; `revoked_at` stays the single authority bit.
- `src/lib/sources/github/store.ts`: `getState` returns `revokedReason`; `revoke` records `user_unbind`; `bind` clears the reason.
- `src/lib/sources/github/webhook-store.ts`: webhook revocations record the reason in the binding row and audit event.
- `src/app/api/platform/v1/github/_lib/admin.ts` (extracted verbatim from the callback route): fresh-human-admin guard,
  installation-then-tenant lock order, shared by callback, binding API and inspect. `_lib/json.ts`: strict small-JSON helpers.
- Explicit API (human admin browser only, agent credentials refused): `GET/POST /api/platform/v1/github/binding`
  (state; begin bind returning the fixed github.com install URL, PKCE proof in httpOnly cookie, completed by the existing callback),
  `POST /api/platform/v1/github/binding/unbind` (`{version}` CAS). Registered browser-only in `_lib/bearer-paths.ts`.
- `GET /api/platform/v1/github/inspect?ref&root&repository`: static build detection.
- `src/lib/sources/github/inspect.ts`: resolves ref to a commit via `createGithubImmutableSourceAccess` (installation token minted per
  call, `repository_ids:[bound id]`, `contents:read`), downloads the commit tarball with the bounded intake reader, runs
  `analyzeRepository` over file text. Returns build roots (monorepo), Dockerfile path or buildpack plan, and `buildSource`
  `{repo, ref: commitSha, dockerfile}` shaped like the existing `BundleSource` input. Nothing is written to disk or executed.
- UI: `/platform/source` (`source/page.tsx`, `source/source-panel.tsx`): status with revocation reason, bind, unbind, inspect;
  platform nav link now points here.
- Tests: `tests/sources/github-lifecycle.test.ts`, `tests/sources/github-inspect.test.ts`.

## 2. Acceptance mapping

| Clause | Implementation | Test |
|---|---|---|
| Bind | binding POST + callback (existing fence/OAuth/CAS) + UI | existing `tests/sources/github-callback.test.ts` (callback still the completer) |
| Remove / unbind | `binding/unbind` -> `store.revoke` CAS, reason `user_unbind` | github-lifecycle "explicit unbind" |
| Uninstall / revoke | signed webhook deleted/suspend/removed, reasons recorded | github-lifecycle (3 events), existing github-webhook.test.ts |
| Revoked blocks builds | `getBinding` refuses revoked; `createGithubAccess`/immutable access never mint a token or fall back to anonymous | github-lifecycle "blocks source access", github-inspect "revoked" |
| Webhooks cannot restore | unsuspend/created/added are no-ops | github-lifecycle "never restore" |
| Private-source acceptance | token scoped to bound repo id, read-only, only on codeload request, absent from result | github-inspect "private repository" |
| Monorepo/Dockerfile/buildpack, no host execution | static analysis only; denylist test over inspect, sources/github, analysis, github routes | github-inspect (detection + "no host-execution primitive") |

## 3. Verification commands (other machine, Node 22)

```
npx vitest run tests/sources tests/middleware/platform-bearer.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts
```
Expected: all pass. The lifecycle test needs POSIX (private secret file) and is skipped on Windows. Postgres variant: existing
webhook tests honor `ZENITH_TEST_PLATFORM_PG_URL`; run `tests/sources/github-webhook.test.ts` with it set.

## 4. Known gaps and orchestrator updates

- Migration 30 is registered after 20 in `migrations/index.ts`; the assembler must reconcile contiguity with other waves, then run
  emit-sql, update migrations inventory/`migrations.test.ts`/DEPLOYING doc. No new table, only two columns (tenancy unchanged: both keyed by workspace_id).
- Possible existing-test touchpoints: `tests/docs/operator-docs.test.ts` and `tests/middleware/platform-bearer.test.ts` enumerate github routes/paths; they were not run.
- Monorepo subdirectory is detected and the Dockerfile path is repository-relative, but the existing `BundleSource`/snapshot has no build-context subdirectory field; passing the root as build context belongs with the LIFE-09 executor and was not changed.
- Buildpack plans are detected and reported but are not buildable until a Dockerfile exists (source-bundle requires one); stated in the API and UI.
- One binding per workspace remains (existing schema). No live GitHub App evidence; all HTTP is mocked.
- A suspended installation that is later unsuspended requires an explicit re-bind.
- Hard deletion of a binding is deliberately not offered: revocation preserves versions so old callbacks and retained approved snapshots cannot recreate authority.

## 5. Suggested ledger implementationStatus

`source_complete_binding_api_ui_static_inspection_runtime_acceptance_pending`
