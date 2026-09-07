# Release governance (G45)

Prepared 2026-09-07 by W11. **Unverified: GitHub branch protection has never
been inspected from this repository, and no hosted release has ever been
made.**

> **Do not fabricate.** Do not tick a protection box because the workflow file
> looks right. A workflow that runs is not a workflow that is *required*;
> only the repository's rules decide that, and nobody here has read them.

## 1. What is actually true about CI

Verified by reading `.github/workflows/ci.yml` in this checkout:

| Item | State |
| --- | --- |
| Workflow | `CI`, on `push` to `**` and on `pull_request` |
| Jobs | `verify`, `build`, `docker` |
| Token permissions | `contents: read` only |
| Action pins | Full commit SHAs (`actions/checkout`, `actions/setup-node`) |
| Persisted checkout credentials | Disabled |
| Docker context | `.dockerignore` excludes `.data-*`, service metadata and env files |
| Concurrency | One run per ref, cancel-in-progress |
| Latest recorded run | `34106170750` at `ffb2753` — verify, production build and Docker build all passed |

What that does **not** establish: that any of these is a *required* check,
that review is required before merge, that force-push is blocked, or that the
Docker job's image was ever launched.

## 2. Branch protection checklist

Fill in by reading the repository's settings. Every box is unchecked because
nobody has looked.

- `[ ]` Default branch is protected.
- `[ ]` `verify` is a required status check.
- `[ ]` `build` is a required status check.
- `[ ]` `docker` is a required status check.
- `[ ]` Pull request required before merge.
- `[ ]` At least one approving review required.
- `[ ]` Stale approvals dismissed on new commits.
- `[ ]` Force-push to the default branch blocked.
- `[ ]` Branch deletion blocked.
- `[ ]` Administrators included in the rules.
- `[ ]` Linear history or an agreed merge strategy.
- `[ ]` Secret scanning and push protection enabled.
- `[ ]` Dependabot or an equivalent update policy agreed.
- `[ ]` Who may change these settings: `unknown`.

Inspected by `unknown` on `unknown`.

## 3. Deploy approval

Separate from merge approval: merging code is not deploying it.

| Item | Value |
| --- | --- |
| Who may deploy the hosted control service | `unknown` |
| Approval required before a deploy | `unknown` |
| Where deploy approval is recorded | `unknown` |
| Deploy is manual or automatic | `unknown` — with a single-writer volume it **must** be a stop-then-start, never a rolling deploy ([../RUNBOOK-DEPLOY.md](../RUNBOOK-DEPLOY.md) §1) |
| Rollback authority | `unknown` |
| Change window | `unknown` |
| Customer notification for a deploy that interrupts service | `unknown` |

Explicitly still required and not granted: approval for billable
provisioning, production DNS or data changes, customer messages, destructive
restores and purchases (`ATT-HANDOFF-02`, `blocked`).

## 4. Reproducible release evidence

One record per hosted release, once hosted releases exist. None do.

| Field | Value |
| --- | --- |
| Release id | `unknown` |
| App | `unknown` |
| Source digest (SHA-256 over submitted bytes) | `unknown` |
| Artifact digest (SHA-256 over built bytes) | `unknown` |
| Recipe / toolchain versions | Pinned in `package.json`: `vite@7.3.6`, `@vitejs/plugin-react@5.1.4` |
| Contract version | `source-v1`, `tracker-v1` |
| Build runner and its boundary | `unknown` |
| Job id | `unknown` |
| Builder identity | `unknown` |
| Publisher verification result | `unknown` |
| Candidate probe result (separate test DB) | `unknown` |
| Activation timestamp and fence token | `unknown` |
| Previous active release | `unknown` |
| Rollback target | `unknown` |
| Control-service commit | `unknown` |
| Approved by | `unknown` |

A digest proves byte identity, not safety, and not review. Both must be
recorded separately.

## 5. Live-job separation

- `[ ]` Unprivileged pull-request tests are separate from any job holding live
  provider credentials.
- `[ ]` No untrusted code can reach a credentialed job.
- `[ ]` Live-cloud jobs are opt-in and cost-bounded.
- `[ ]` Test resources created by a live job are cleaned up, and the cleanup
  is itself checked.
- `[ ]` No credential ever appears in a log or an evidence file.

The current CI runs no live-cloud job, so these are requirements for the job
W10 will add, not descriptions of one that exists.

## 6. Status

G45 stays `Unverified` until §2 is filled in from the actual repository
settings by a named person on a named date, §3 names an approver, and at least
one release exists with a complete §4 record.
