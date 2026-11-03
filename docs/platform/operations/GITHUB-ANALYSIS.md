# GitHub repositories as Gimbal input

Written against branch `codex/github-source-gimbal-2026-11-03`, based on `codex/production-2026-10-02` at `e70820e2576dcef0eb3a462d1c9ec25917cf82a8` (2026-11-03), with the source changes in this PR. Live-provider acceptance remains pending.

This guide covers GitHub sign-in, independent repository connections, source analysis, project proposals, and Claude Code continuation. GitHub login identifies a user; a GitHub App installation grants repository access. They are separate connections and can be removed separately.

## User flow

1. Sign in using an enabled provider. Existing users can connect GitHub from **Account → Sign-in** without creating another Zenith account. Follow [GitHub authentication setup](../../github-auth.md) to enable the provider.
2. Open **Repositories** in the workspace navigation. Connect the Zenith GitHub App, choose **Only select repositories** on GitHub, and authorize the GitHub identity check. Zenith lists repositories visible to that user and installation. Only repositories the user administers can be delegated to a shared Zenith workspace.
3. Select a repository to connect. Each connection has its own stable ID and version. Adding a second repository keeps the first connection. Discovery is bounded to 1,000 repositories and reports truncation; use the explicit repository connection flow if the desired repository is outside the discovery window.
4. In a project's **Repository** page, attach a connected repository and choose a branch/ref, application directory, and build-context directory. Attaching a source records input metadata; it does not deploy or copy files into the project. The build context defaults to the repository root so a nested application can use shared packages. Detaching leaves a versioned tombstone so a stale browser cannot restore an old selection.
5. Open **Gimbal**, select a repository, inspect it, and review the exact commit and detected build candidates. Choose **Static analysis** or **Model-assisted analysis**. Static is the default and sends no source to a model. Model mode requires explicit confirmation that redacted source will be processed by the configured model provider.
6. Choose analysis only, or choose a project and environment for an infrastructure proposal. A targeted run captures the current working manifest and its revision. Static proposals use the target environment's class. A targetless proposal uses staging assumptions and must be reviewed before use.
7. Review requirements, evidence, unresolved questions, coverage, and the manifest diff. The approved proposal records the exact repository identity, commit, grant version, build-context proof (when present), and reviewed project revision. Adoption uses the canonical project action and refuses if the working copy changed. It preserves existing infrastructure and V2 settings while adding or updating detected components.
8. Use **Continue in Claude Code** to copy or download the bounded handoff. For authenticated follow-up reads and returned source-change proposals, connect Claude Code to Zenith's existing MCP endpoint with explicit source-export and project/environment grants; see [MCP source continuation](../MCP.md). A handoff file does not grant GitHub access: Claude Code must use the user's own authorized checkout.

## Removing access and deleting content

| Action | Effect |
|---|---|
| Remove GitHub sign-in | Removes that login identity, subject to the last-login-method guard. Repository grants remain independently managed. |
| Detach a project's repository | Removes the current project attachment. Other projects and the workspace's repository grant remain available. |
| Revoke one workspace connection | Advances that repository's grant version and blocks further source use, saved analysis reads, adoption, and handoffs for its old authorization. Other connected repositories remain available. |
| Change selected repositories or uninstall/suspend the GitHub App | GitHub's signed events revoke the affected grants. Every new source operation also verifies current provider access and refuses when it cannot confirm it. |
| Reconnect | Requires a fresh GitHub authorization and creates a new authorization version. Renamed/transferred repositories retain their stable provider identity and project references when reconnected through discovery. Old approvals and runs do not regain authority. |
| Delete analysis content | Removes task/conversation/requirements/result payloads and cancels resumable work. An advancing row version prevents late workers from restoring the payload. Source identifiers, usage counters, and existing approval/audit records remain. |

GitHub installation changes happen in GitHub's own settings. Zenith's local revoke action does not uninstall the App or alter another workspace's access. The UI links to installation settings and explains these differences. Organization approval is handled by GitHub's hosted flow; there is no separate persisted organization-approval workflow in Zenith.

## Operator setup and upgrade

Use Node 22.22.2 or a compatible release in the repository's declared Node 22 range. Web and execution workers must use the same platform database and Temporal address/namespace/task queue.

**Use a coordinated maintenance window for this schema change.** Migration 60 changes the binding key from one row per workspace to one row per repository. Older binaries allow a database ledger ahead of their own version and still assume a single binding. Drain old workers, stop old web instances/source mutations, migrate, and start only the new web/worker build before allowing multiple connections. Do not run mixed old/new source readers after enabling imports, and do not roll back to an older binary against a database with multiple grants. Roll forward, or restore a reviewed pre-upgrade backup during maintenance if rollback is required.

1. Back up the platform database using the existing operational procedure.
2. Apply the canonical platform migrations through **61** with `npm run migrate:platform`, then verify `npm run migrate:platform -- --status`. Migration 60 converts the single workspace binding into independently versioned repository grants and adds discovery/project-source metadata. Migration 61 adds analysis payload expiry, immutable request fingerprints, worker capability leases, and workspace admission limits.
3. Apply the normal Supabase migrations, including **0028_github_waitlist_identity.sql** and generated **0029_platform_core.sql**. The generated 0029 file supports databases that already applied 0027; historical files are unchanged. The platform's checksummed ledger recognizes canonical migrations applied by either route. Do not expose `platform` through the Supabase Data API.
4. Configure the separate GitHub OAuth App for login as described in [github-auth.md](../../github-auth.md). Enable `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=google,github` only after the Supabase provider and callbacks are configured. This build-time public setting contains provider names only.
5. Configure the repository GitHub App using [BUILDS.md](BUILDS.md) and [GITHUB-WEBHOOKS.md](GITHUB-WEBHOOKS.md): Contents read-only, Metadata read-only, exact callback/setup URLs, signed lifecycle webhooks, and narrowly mounted credentials. No repository write permission is needed for import or analysis.
6. Set `ANTHROPIC_API_KEY` on **execution workers only** for model-assisted analysis. The web process queries short-lived, non-secret capability leases scoped to the Temporal address, namespace, and task queue. A stale lease (90 seconds) is unavailable. Static analysis still needs an execution worker but no model key.
7. Restart workers and web processes after migration/configuration. Confirm a model-enabled worker is polling before enabling model mode for users.

The first release keeps repository connection, analysis creation, project attachment, deletion, and adoption restricted to current workspace administrators. Private repository delegation also requires current GitHub repository-admin permission. Broader collaborator sharing needs a separate explicit sharing policy; a user's ability to read private code alone does not authorize sharing it with a workspace.

## Analysis boundaries and cost controls

- Source resolution records immutable GitHub repository identity and a commit SHA. Runtime access checks the exact binding rather than selecting an arbitrary repository for the workspace. Public access is an explicit choice and never a fallback for a revoked binding.
- Intake reads bounded archives with cancellation, streamed-byte limits, path checks, file/count limits, and existing binary/generated/dependency exclusions. Documentation, workflow files, and tests can be retained as supporting evidence. Coverage reports retained files, exclusions, truncation, and files read by tools; a successful run does not imply that every repository file was read.
- Raw archives are not written to the analysis store. Workers keep at most six redacted snapshots / 64 MiB for five minutes, with fresh authorization on every use. Build-source custody remains separate and uses the existing exact-byte integrity pipeline.
- Source text, tasks, model responses, and resumed conversations pass the same versioned redactor before model use or checkpoint persistence. It masks recognized credentials, secret assignments, private keys, and authenticated URLs while preserving line references. Arbitrary secrets without recognizable structure cannot be reliably detected. Use static mode for repositories that must not be processed by an external model.
- Claude requests omit readable thinking summaries. The API's opaque signed/encrypted thinking blocks are preserved unchanged only for tool-call continuation in expiring checkpoints and are never included in API views or handoffs. Unexpected readable thinking or incompatible legacy history requires a fresh analysis rather than rewriting signed blocks. See Claude's [tool-continuation protocol](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows).
- Repository files, including `AGENTS.md`, `CLAUDE.md`, README instructions, and test scripts, are untrusted evidence. The tool registry is fixed: bounded listing/reading/search, static analysis, evidence-validated requirement refinement, and proposal generation. Analysis never runs package installation, tests, shell commands, repository hooks, or source instructions.
- Model refinements must cite existing paths and line numbers and can amend only bounded, recognized requirements. They remain explicitly marked inferences. Model tool arguments never grant repository, workspace, approval, deployment, or MCP authority.
- Each run uses the existing token, tool-call, elapsed-time, and spend ceilings. Admission additionally serializes on a workspace quota row: defaults are **3 active runs** and **$20 in reserved/recorded model spend over a rolling 24-hour window**. Static runs consume a concurrency slot but reserve no model spend. Operators can set reviewed per-workspace overrides in `platform.coding_agent_workspace_limits` within its database bounds.
- Retry keys identify the original actor, source, task, mode, budgets, target, and reviewed manifest. Retrying the same request returns the original run; reusing a key for changed inputs conflicts. A resume is a separate explicit action with ceilings that can only increase within platform limits.
- Model calls are at least once: a crash after a provider response but before durable checkpoint commit can repeat the call. Recorded budgets and reservations are application controls, not a provider-side billing guarantee. Retain provider billing alerts as an independent operational control.

## Retention and trust

Analysis content expires after seven days. A worker-owned maintenance loop removes up to 100 expired or invalidated run payloads every 30 seconds, deletes expired discovery sessions, and publishes the worker capability lease. Reads refuse expired content immediately even if cleanup is delayed. Revoke/reconnect before cleanup still invalidates the old binding version. Cleanup failures are logged without payloads; operators should monitor worker availability and the expiry backlog.

Discovery sessions retain repository metadata for ten minutes and never persist user OAuth or installation tokens. API tokens are minted for the current operation and exact repository. Application records are isolated by tenant predicates and service-only database access/RLS. Analysis JSON is redacted tenant content, not application-encrypted ciphertext; use the deployment's encrypted database volumes, encrypted backups, access controls, and documented backup-retention policy. Deleting current analysis payloads does not retroactively erase backups or immutable operation/audit records.

Handoffs contain source identity, bounded redacted findings, requirements, coverage, proposal metadata, and continuation instructions. They omit tokens and full repository text. Handoff expiry is capped by the run's retention deadline. Scoped MCP reads recheck current workspace/project/environment grants and repository authority on each call. Source-change returns contain an exact base commit and a proposed commit or patch digest with changed-file metadata. They go through the existing proposal broker and do not apply patches, push branches, open pull requests, adopt manifests, or deploy automatically.

Generic MCP operation reads reveal source-stage details only with the same current export and source authorization. Non-human REST operation reads and mutation replays expose metadata only; use scoped MCP source tools for source context. Source-capable MCP requests use nonpersistent responses so a durable event-stream replay cannot bypass later repository or consent revocation. Human operation/audit review remains available through the existing browser permission boundary.

## Release acceptance

Local tests cover source authority, independent grants, discovery, revocation, migrations, route guards, waitlist identity SQL, static/model boundaries, redaction, manifest preservation, browser DOM behavior, and MCP consent. The PR records the actual executed suites; a skipped test is not acceptance evidence.

Before rollout, complete these checks against a disposable staging workspace:

1. Apply migration 60 to a database with an existing single-repository binding and historical binding events; apply 61; verify RLS/service grants, no checksum drift, and preservation of previous approvals.
2. Run the native PostgreSQL contract/race lane. PGlite tests verify SQL behavior but do not establish multi-connection lock behavior or production role memberships.
3. Exercise real Supabase GitHub login/link/unlink with admitted and waiting users, hidden provider email, an existing Google account with a different GitHub email, cancelled consent, and last-login protection.
4. Install the GitHub App for selected repositories A and B. Connect both, verify branch/commit inspection, revoke A, and confirm B still works. Test organization approval, repository removal, uninstall, suspension, webhook replay, missed-event manual sync, rename/transfer, and reconnect. A read-only collaborator must not be able to delegate a private repository to the workspace.
5. Run static analysis with no model key. Then run model analysis with a worker-only key and confirm the web host has no key. Revoke access during a model call and confirm the result cannot be published or exported.
6. Change the project manifest during an analysis and confirm stale adoption fails. Verify V2 policy/placement, environment references, and existing infrastructure survive a reviewed proposal.
7. Exercise deletion/expiry while a worker is running; verify no later checkpoint or outcome restores source-derived payloads. Verify a revoked-and-reconnected grant does not revive old runs.
8. Connect Claude Code through real OAuth/MCP with explicit export and target grants, inspect the handoff, return a commit/patch proposal, and verify it needs the normal review path. A generic read grant must not expose private analysis.
9. Perform browser visual/accessibility checks on login, discovery, repository attachment, analysis progress, diff review, conflict recovery, revoke, and handoff screens. DOM tests do not replace this final browser check.

Automatic PR creation/code writeback, a hosted Claude Code execution environment, repository-wide embedding/index maintenance, multi-repository analysis in one run, GitHub Enterprise Server, and persisted organization-approval requests are outside this implementation. One workspace can connect multiple repositories; each analysis run pins one repository and can select an application directory within it.
