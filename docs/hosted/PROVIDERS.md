# Provider configuration — decision record and environment matrix (G34)

Prepared 2026-09-07 by W11 against `ffb2753` on `zenith/hosted-r3`.

G34 is a **Decision** row, not a Missing one: the code paths exist or are being
written, and what is absent is a set of accounts, terms acceptances, domains
and an approved budget. This file is the list of those decisions, one per
capability, with the exact variable that flips each from *blocked* to
*available*.

Rules this file obeys:

- **No capability is advertised because a variable could be set.** Absence is
  reported as blocked, naming the missing input. Nothing degrades into a
  simulation.
- **"Verified" means verified in this repository**, by a test or a run
  recorded in `docs/hosted/CHECKPOINT.md`. Nothing here has been verified
  live.
- **Every cost is `unverified`** unless a dated official source is cited from
  the gap analysis. A cited base price is a base price, not a bill.
- **No account was created, no terms accepted, no purchase made, no provider
  contacted.** That needs explicit approval (`ATT-HANDOFF-02`, `blocked`).

## 0. Approvals not yet given

| Approval | State | Blocks |
| --- | --- | --- |
| Cost envelope | The plan's $300 is an **unconfirmed planning envelope**, not permission to spend and not a cap — provider billing lags. | Every billable row below. |
| Billable provisioning | Not approved. | Cloudflare, E2B, host, domain, off-host storage, email. |
| Terms acceptance | Not given for any provider. E2B's terms in particular need clarification for customer-code execution and adversarial testing. | E2B; any provider whose terms restrict running third-party code. |
| Production DNS changes | Not approved. | Control and app domains. |
| Real external email | Not approved. | Invitation delivery. |
| Owner / accountable person per provider | `unknown` for all. | Incident response, [OPERATOR-ACCESS.md](OPERATOR-ACCESS.md). |

## 1. Runtime

Two implementations behind one `HostedRuntime` interface (`R3-03`).

| | `local` | `cloudflare` |
| --- | --- | --- |
| What it is | The control service serves immutable artifacts itself and runs the fixed broker against per-app SQLite files. Real, single host, labelled as such. | Workers for Platforms dispatch + D1 + a fixed broker worker, over the real API. |
| Variables | `ZENITH_RUNTIME=local` (default) | `ZENITH_RUNTIME=cloudflare`, `ZENITH_CF_ACCOUNT_ID`, `ZENITH_CF_NAMESPACE`, `ZENITH_CF_API_TOKEN` |
| Verified in this repo | Being built by W6 in this wave. Not yet landed at the time of writing. | An offline, GET-only binding/settings **inspection** harness with 84 synthetic tests (`scripts/hosted-spike/`). It makes no Cloudflare calls by default. |
| Unverified live | Two apps on distinct hosts under a real proxy; admission before invocation under load. | Everything. No account, no credentials, no namespace, no request has ever been made. |
| Approval | None. Runs on the host you already pay for. | Billable + account + token issuance. |
| Cost | Host cost only; see §5. | **Unverified.** The gap analysis records that Cloudflare's official Workers for Platforms pricing page listed a **$25/month base** when checked on 2026-09-07 (`https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/`). Usage, D1, storage and egress are **separate and unpriced here**. A base price is not a bill. |

### Cloudflare caveats carried forward from DECISIONS.md

None of these is closed by choosing Cloudflare; each is a gate to prove.

- **Binding isolation.** Editable releases need a strict allowlist. The fixed
  broker owns its one D1 binding; editable code gets no database, dispatch,
  service, mTLS or Durable Object binding. Read every deployed binding back.
- **Outbound policy.** Outbound Workers do not cover every binding path.
  Durable Object and mTLS paths need separate denial.
- **Private assets.** Assets must be admitted before dispatch, and
  namespace-wide asset deduplication needs tenant-aware artifact identity.
  Direct worker and preview URLs must be tested.
- **Release immutability.** Script upload can *replace* an existing name. A
  digest in a name is not create-only; ownership, fencing and readback are.
- **D1 transactions.** Zero affected rows do not throw. Version, idempotency
  and quota conditions must be enforced inside the transaction and tested
  against real D1.
- **Request quotas.** Native rate limiting is eventually consistent and is not
  an exact daily ledger.
- **Storage quota.** A strict 100 MB *physical* cap has not been demonstrated.
  Revision 3 discloses a **logical-byte** quota instead (`R3-12`); that is a
  different contract and must be stated as such to customers.

## 2. Build

Three runners, one interface (`R3-05`). Hosted mode refuses to build when none
is configured — it does not fall back.

| | `recipe-local` | `e2b` | `docker` |
| --- | --- | --- | --- |
| What it is | The platform's pinned recipe in a child process with a clean environment, timeout and memory cap — **on the control host**. | The pinned recipe inside a disposable E2B sandbox. | The pinned recipe inside a container on a local daemon. |
| Variables | `ZENITH_BUILD_RUNNER=recipe-local` | `ZENITH_BUILD_RUNNER=e2b`, `E2B_API_KEY` | `ZENITH_BUILD_RUNNER=docker` + a reachable daemon |
| Isolation claim | **None beyond process boundaries.** Labelled *not a hostile-code sandbox*. Defensible only because `R3-04` means no submitted code is executed: the recipe runs esbuild/rollup transforms over submitted *sources*, and submitted `vite.config.*`, scripts and lockfiles are rejected at intake. | Disposable VM per build. | Container per build. |
| Verified in this repo | Being built by W2. Toolchain pinned in `package.json`: `vite@7.3.6`, `@vitejs/plugin-react@5.1.4`. | `e2b@2.46.1` is installed. The adapter is contract-tested with an injected SDK double. **No sandbox has ever been created.** | Not verified. |
| Unverified live | Memory/time caps under a hostile fixture; that a rejected input really never reaches a shell. | Everything: network egress restrictions, controller access, teardown, artifact extraction before teardown, inter-job contamination, timeout behaviour. | Everything. Docker Desktop's Linux engine pipe is unavailable on this machine; CI builds an image but runs no customer build. |
| Approval | None to run, but **do not select it for a deployment serving anyone but the founder.** | Billable + **terms clarification required** for customer-code execution and adversarial testing. Not an approved dependency. | None. |
| Cost | Host CPU only. | **Unverified.** The gap analysis is explicit: do not treat the plan's E2B price example as a current quote, and do not assume a paid plan is required. Recheck the selected plan against the actual workload before procurement. | None beyond the host. |

E2B's own documentation records that **default network access is open** and
that domain allowlisting has shared-hosting and protocol caveats; controller
and public-service access need explicit configuration. Those are configuration
gates to prove live, not properties inherited by adding the SDK.

## 3. Artifacts and backup storage

| | `filesystem` | `s3` |
| --- | --- | --- |
| Variables | `ZENITH_BACKUP_TARGET=filesystem`, `ZENITH_BACKUP_DIR`, `ZENITH_BACKUP_KEY` | `ZENITH_BACKUP_TARGET=s3`, `ZENITH_BACKUP_S3_BUCKET`, `ZENITH_BACKUP_S3_ENDPOINT`, `ZENITH_BACKUP_KEY`, plus AWS-style credentials |
| What it gives | A WAL-safe encrypted copy on a path you choose. Off-host **only if the path is off-host** — a directory on the same volume is not a backup. | Real off-host object storage. Against LocalStack it is real S3 semantics on this machine; against a cloud endpoint it is a real off-host copy. |
| Verified in this repo | Being built by W8. | LocalStack S3 is already **real** for the existing product (`s3:CreateBucket` verified with `HeadBucket`, listed back by drift detection). That establishes the adapter, not off-host durability. |
| Unverified live | A restore from it. | A real cloud bucket, its region, its retention policy, its access controls, and a restore from it. |
| Approval | None. | Billable + account + region decision (feeds [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md)). |
| Cost | None. | **Unverified.** No provider, plan, storage class or region selected. |

`ZENITH_ARTIFACT_DIR` (default `<ZENITH_DATA>/artifacts`) holds the
content-addressed store. It is on the same volume by default; a host loss
loses it unless it is in the backup set.

`ZENITH_BACKUP_KEY` must be **distinct from `ZENITH_SECRET_KEY`** and
recoverable independently of the host. Custody is `unknown`. There is no
key-rotation tooling and no re-wrap command for the existing secret store; the
same limitation applies to backups until W8 proves otherwise.

## 4. Email (invitation delivery)

| Item | State |
| --- | --- |
| Variables | `ZENITH_SMTP_URL` (carries the password; never echoed), `ZENITH_ALERT_FROM`, `ZENITH_INVITE_FROM`, and the `nodemailer` package installed. |
| Provider | `unknown`. Not selected. |
| Verified in this repo | The existing alert path sends real SMTP when configured, and reports the missing variable or `npm install` as the delivery failure rather than dropping silently. Hosted invitations use a **separate** transactional outbox (`R3-11`, W5), not the alert outbox. |
| Unverified live | That an invitation reaches an external mailbox. |
| Semantics | Provider acceptance is recorded as **sent**. *Delivered* requires stronger evidence and is a different state; bounces are retained. Do not report sent as delivered. |
| Delivery-payload subtlety | A hash-only token record cannot recreate the secret a retried email needs, so a bounded **encrypted delivery payload** with its own retention and key scope is required (`R3-11`). |
| Approval | Sending real external email needs explicit approval. |
| Cost | **Unverified.** No provider, plan or volume estimate. |

## 5. Domains, TLS and host

| Item | Decision | State |
| --- | --- | --- |
| Control origin | `ZENITH_CONTROL_ORIGIN` | `unknown`. Default `http://localhost:3400` is local only. |
| App domain | `ZENITH_APP_DOMAIN`, apps at `<slug>.<app-domain>` | `unknown`. Default `apps.localhost` resolves in browsers without DNS — a development convenience, not a deployment. |
| Separation | The app domain must be a **different registrable domain** from the control origin, so an app host can never receive a platform cookie. | Decided (`R3-09`); domains not registered. |
| DNS | Wildcard `*.<app-domain>` | Not registered. Registrar `unknown`. |
| TLS | Certificate for the control host and a **wildcard** for `*.<app-domain>` | Not issued. Issuer `unknown`. `ZENITH_APP_SCHEME=https` is required for the `__Host-` cookie. |
| Control host | One always-on instance with a persistent volume | `unknown`. See [RUNBOOK-DEPLOY.md](RUNBOOK-DEPLOY.md) §1 and §7 — a platform with an ephemeral filesystem, Vercel included, cannot host this. |
| Region | Feeds the data map | `unknown`. |
| Approval | Billable + DNS changes. | Not given. |
| Cost | **Unverified.** Host, domain and certificate costs unpriced. |

## 6. Identity

| Item | State |
| --- | --- |
| Provider | Supabase Auth — already in use by the existing product, so this is a continuation, not a new selection. |
| Variables | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (**build arguments**, inlined at build time), `SUPABASE_SERVICE_ROLE_KEY` (server-only). |
| Region | `ap-south-1` (Mumbai) for the existing project, per the project's own operating notes. **Not re-verified from the Supabase dashboard in this session.** Recorded in [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) with that caveat. |
| Verified in this repo | Sign-in, confirmation, reset, OAuth wiring behind `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS`, workspace membership. The OAuth handshake itself has never been exercised against a real provider in this repo. |
| Unverified live | The one that matters for hosted: that a token issued **before** sign-out is rejected afterwards, on the deployed Auth version. `R3-10` selects `auth.getUser()` for grant-sensitive endpoints; the integration test is W5/W10's and has not run. |
| Fail-closed | With `ZENITH_HOSTED_MODE=1`, missing or partial auth configuration must refuse, never fall back to the local demo admin. |
| Approval | Existing project; no new spend identified. Plan and quota fit for a pilot: `unknown`. |
| Cost | **Unverified.** |

## 7. Summary — what one decision unblocks

| Decision to make | Unblocks | Register rows |
| --- | --- | --- |
| An always-on host with a persistent volume, and its region | The entire hosted journey, backups, RPO/RTO measurement | G33, G22, G27, G36 |
| Two registrable domains + wildcard DNS + TLS | App hosts, cross-domain exchange, recipient journey | G12, G14, G30 |
| Off-host backup target + key custody | Backup, clean-host restore, revocation reconciliation | G22, G23 |
| A build runner that is not the control host | Honest isolation for anything beyond a founder demo | G06, G25 |
| Cloudflare account + token + namespace | The edge runtime and all seven caveats in §1 | G02, G14–G16 |
| Email provider + approval to send | Real invitation delivery, sent-vs-delivered evidence | G11, G38 |
| An approved cost envelope with a named owner | Every billable row above | G20, G40 |

Until each of those is made and recorded here with a date and an accountable
name, G34 stays a **Decision** row and every capability it gates stays
blocked-with-reason.
