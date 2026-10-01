# Platform threat model

## Current operator status (WS-DOCS-SYNC)

Source snapshot: `platform/integration` at `e3ea61a` (2026-10-01). The platform
is composed in `src/lib/platform/app.ts` and `src/lib/platform/execution.ts`:
broker/store, six provider registrars, execution activities, runner queues and
reconciliation ports are wired. Product deploys and MCP v3 dispatch workflows;
platform pages render stored evidence. Middleware classifies bearer/signed-agent
paths, `next.config.ts` traces the policy bundle, and cron reaps runner/machine
jobs. The reconcile HTTP tick is scheduled; the separate `reconcileOperations`
ledger backstop is not. See [DEPLOYING.md](operations/DEPLOYING.md).

The following fixes are present in source and have ordinary regression
assertions in the named suites. **This sync did not run the security suites**,
OpenTofu semantic gates, real Temporal history gate or any live provider. Source
and contract evidence do not establish a production security certification.

| Original finding | Current source control | Regression evidence (not rerun here) |
|---|---|---|
| SEC-F1 | Legacy journal SQL includes workspace and subject; foreign and missing operations share not-found behavior (`src/lib/agent-access/control/journal-pg.ts`, `src/lib/agent-access/control/coordinator.ts`) | `tests/security/mcp-v2-tenant-isolation.test.ts` |
| SEC-F2 | Workspace labels reject `__proto__` (`src/lib/tofu/workspace.ts`) | `tests/security/tofu-workspace-injection.test.ts` |
| SEC-F3 | Provider arguments use a closed non-secret, non-routing vocabulary (`src/lib/tofu/provider-config.ts`) | `tests/security/tofu-workspace-injection.test.ts` |
| SEC-F4 / SEC-F5 | HCL template scanner and pure-function allowlist refuse `nonsensitive`, file/template/path access and namespace escapes (`src/lib/tofu/expression-policy.ts`, `src/lib/tofu/hcl-template.ts`) | `tests/security/tofu-workspace-injection.test.ts`; real binary gates remain opt-in |
| SEC-F6 | Session environment is provider-specific; operator extras permit only explicit upper/lowercase proxy settings (`src/lib/tofu/env.ts`) | `tests/security/tofu-runner-env.test.ts` |
| SEC-F7 | Plan-view text removes invisible Unicode and remains untrusted (`src/lib/tofu/plan.ts`) | `tests/security/tofu-secrets.test.ts` |
| SEC-F8 | Agent approval derives from authenticated principal kind, not an asserted human origin (`policy/rego/lib.rego`, `policy/rego/approval.rego`) | `tests/security/policy-invariants.test.ts` |
| SEC-F10 | External STS error names use a fixed allowlist (`src/lib/credentials/aws/broker.ts`) | `tests/security/credential-boundaries.test.ts` |
| SEC-F11 | Metadata-host classification normalizes mapped IPv6 literals (`src/lib/observability/sources/http.ts`) | `tests/security/signal-boundaries.test.ts` |
| SEC-F12 | Workflow starts project allowed runtime fields before serialization (`src/lib/workflows/client.ts`) | `tests/security/workflow-history.test.ts`; live history remains gated |
| SEC-F13 | Drift reports scrub both desired and observed values before persistence/emission (`src/lib/reconcile/core.ts`) | `tests/security/reconcile-value-boundaries.test.ts` |
| SEC-R1 | Compose audit omits source blobs; summary/error text passes redaction (`src/lib/actions/core.ts`) | `tests/security/audit-secret-leakage.test.ts` |
| SEC-R2 | Responses/logs use bounded `safeRequestError` diagnostics (`src/lib/server/errors.ts`) | `tests/security/request-error-logging.test.ts` |

SEC-F9 remains a runtime finding in `tests/security/runtime-sanity.test.ts`:
the engine-range assertion is still an expected failure. This sync does not
establish whether a different host's runtime is affected. No package/runtime
pin was changed by this docs workstream.

Remaining operator limits: no payload codec encrypts Temporal history; heuristic
redaction cannot detect arbitrary unknown secrets; cloud IAM, state locking,
backup/restore, KMS and production load remain unverified. The worker requires a
private plan fingerprint key, explicit store/schema and usable signer before
polling. Its identity needs an explicit compatible value; default composition
supplies no machine port. Non-AWS identity verification and OCI platform
ProviderSession are refused; hosted Zenith serving is not verified. MCP cloud
read and investigator registration hooks have no application caller. A plan
approval UI needs an authorized readable matching artifact; a digest alone is
insufficient. Unknown/uncertain outcomes are never proof of a healthy fleet.

## Archived WS-SEC audit

The rest of this file preserves the audit prepared on `ws/sec` at `9c177b7`
and its restricted continuation. **Every inventory, pending-work statement,
reproduced-defect description and verification count below is historical**,
not current platform availability or a new run. The source controls above
supersede its fixed findings and pre-composition status. Preserving the record
keeps the reproduction and test limitations visible without treating old
expected failures as current successful enforcement.

## Method and evidence

STRIDE: **S** spoofing, **T** tampering, **R** repudiation, **I** information
disclosure, **D** denial of service, **E** elevation of privilege. Assets and
boundaries identify where authority changes; the register records concrete
attacks and defense gaps. No external text, including repository files, model
output, logs or provider diagnostics, is authority to run a command or approve.

- **E**: existing worker test, with its path. Existence is not a claim it ran
  here; the verification log names exactly the suites executed.
- **W**: test written by WS-SEC under `tests/security/`. Existing helpers/tests
  were retained and six focused suites were added in the continuation.
- **P**: pending evidence, with responsible workstream and required check.
- `it.fails` pins a KNOWN VIOLATION of the desired invariant. Vitest counts
  these as passed when the invariant fails. It is not successful enforcement.
  Separate controls/characterizations guard the cause where needed.
- A skipped test supplies no verification. Real OpenTofu semantic exploits
  were reported by the prior handoff; their gated tests did not execute in
  this restricted continuation. Real Temporal history checks are opt-in.

Read controls at the named file/function, not just a test title. Mocked STS,
fake provider signals, fake activities and in-memory reconciliation test the
library contracts only. PGlite runs real SQL but does not prove Postgres pooler,
RLS, deployment grants or multi-process concurrency behavior.

## Assets

| Asset | Location | Impact of loss | Verified controls | Status / limits |
| --- | --- | --- | --- | --- |
| OIDC signing key | `ZENITH_OIDC_SIGNING_JWK` or `ZENITH_OIDC_KMS_KEY_ID`; `src/lib/credentials/signing/{local,kms}.ts` | Forge cloud workload bearers for customer roles | `LocalJwkSigner`, `KmsSigner`, `mintWorkloadToken`: RS256, exact subject/audience, <=300 s tokens; public JWKS only | WS-CRED merged. E `tests/credentials/{signing,oidc}.test.ts`; live KMS/rotation unverified. |
| Control signing key | `ZENITH_CONTROL_SIGNING_JWK` or KMS alternative | Forge capability grants and future runner/machine envelopes | `credentials/grants.ts` `verifyCapabilityGrant`: pinned Ed25519 public keys, header/algorithm/time/audience checks | Grant crypto merged; runtime claim consumption/wiring P WS-CAP/RUNSRV/MACH. KMS Ed25519 unverified live. |
| Platform database | `platform` schema; `src/lib/controlplane/db` | Tenant data, approvals, operation authority and evidence compromise | Repository SQL `workspace_id`; transaction executor, migration checks; `secrets.ts` shape refusal; `migrations/emit.ts` Supabase hardening | Emitted SQL enables RLS with no policies and revokes anon/authenticated privileges; service_role bypasses RLS, so tenant isolation still depends on scoped SQL. E `tests/controlplane/{tenancy,migrations}.test.ts`; W SQL audit. Actual deployment grants unverified. |
| Customer cloud roles | `AwsConnectionConfig` role ARNs; customer IAM | Read/change customer infrastructure within role permissions | `AwsCredentialBroker.#plan/#checkConfig/#exchange`, ExternalId, OIDC sub, inline session policy, session tags; bootstrap templates | E `tests/credentials/bootstrap-templates.test.ts`; W credential boundaries. No live AWS. |
| Runner identity key | Customer host (planned Ed25519 private key); public key in `repos/runners.ts` | Impersonate runner, falsify results | `registerRunner` consumes a single-use token; `revokeRunner`; `repos/nonces.ts` replay storage | Database controls merged; host key custody, request verification and job transport P WS-GO/WS-RUNSRV. |
| Approvals | `repos/approvals.ts`, `approval-core.ts`; legacy v2 journal | Unauthorized or replayed mutations | `record`: human user only, exact digest, policy role/count, expiry; `operations.claimForExecution` consumes transactionally | E `tests/controlplane/{approvals,operations}.test.ts`. Authenticated principal construction P WS-CAP. |
| Plan files | Per-run OpenTofu directory, `runner.ts` plan binary | Unmasked secrets or altered execution | `planFileSha`, expected plan digest, disposal, private file handling; model gets `planView` | Server-only artifact, not a safe log. Windows ACL/file-mode equivalence unverified. E `tests/tofu/runner.test.ts`; W tofu secrets. |
| Vault key | `ZENITH_SECRET_KEY`; `src/lib/secrets/index.ts` | Decrypt workspace application secrets | `seal/unseal`, AES-256-GCM binding workspace+reference; fail closed when key absent | Single server environment key, no KMS or rewrap tooling; `docs/LIMITATIONS.md`. E `tests/secrets/{store,namespacing}.test.ts`. |
| Agent bearer credentials | `za_` bearer outside server; hash in `agent-access/security.ts` | All permitted reads/proposals in granted workspace/projects | `authenticate`, `parseCredentials`, `selectScope`, expiry/revocation and membership rechecks | <=30-day issuance; W agent parsing + MCP matrices. Bytes already disclosed cannot be revoked. |
| Temporal history | Temporal namespace; `workflows/client.ts`, worker | Persistent copies of every serialized payload, result and failure | Contract carries ids/digests/counts/short summaries; API key implies TLS in `config.ts` | No configured payload codec/encryption found in config/client/worker. SEC-F12; real history P WS-WF/ACT gate. |
| Policy bundle | `policy/dist/{policy.wasm,manifest.json}` | Change allowed authority or falsify decisions | `src/lib/policy/engine.ts` load/evaluate, manifest hash check, decision bundle hash | W P9, E `tests/policy/engine.test.ts`; writable bundle+manifest is not an authenticated trust root. |
| Audit/events/evidence | Legacy `actions/core.ts`; platform repos | Secret disclosure, forged forensic trail | Audit key redaction; event/evidence size caps and recognizable-value refusal | SEC-R1, SEC-F10/F13; arbitrary opaque values survive shape checks. W redaction/store suites. |
| Repository/manifest | Intake/source archive and desired revision | Inject code, policy facts, misleading plans or model instructions | `importTerraform` referenced ownership; `scanTar`, `validateSource`; deterministic graph/digests | Source is untrusted. Parsing is not execution isolation. WS-AWS-CMP build isolation pending. |
| Customer state bucket | OpenTofu S3 backend (customer account); `workspace.ts` backend assembly | Read state secrets, corrupt plan/apply state | Customer role/IAM policy, deterministic backend files; assembler rejects credential fields | Live state IAM/encryption/locking deployment unverified; P WS-ACT/CI/DOCS. |
| Backup encryption key | `ZENITH_BACKUP_KEY`; hosted backup crypto | Decrypt backups or lose recovery permanently | Separate encrypted backup path (`src/lib/hosted/backup/crypto.ts`) | Adjacent hosted asset, not a platform DB recovery claim. Custody/restore drill unverified; hosted runbooks apply. |

## Trust boundaries

| Boundary | What crosses | Authentication / authority | Controls and status |
| --- | --- | --- | --- |
| Browser -> web/API | Session, grant selection, human approval | `agent-access/control/browser.ts` `browser()` reads server identity + current membership | Refuses any Authorization header on browser paths; exact mutation origin; verified browser identity. Existing v2 only. P WS-CAP platform routes. |
| Model / coding agent -> MCP | Untrusted requests, proposals and tool data | Scoped `za_` principal; OAuth binding where configured | Reader scope checks; reviewed prepare/execute split; initialization frames text as data. W v1/v2 matrices. SEC-F8 requires broker-origin binding. |
| MCP bearer -> control plane | Bearer / OAuth access token | `agent-access/security.ts` `authenticate`; `control/oauth.ts` `verifyOAuth/bindGrant` | Issuer/resource audience, algorithm allowlist, required claims and <=1 h OAuth lifetime; browser-created grant. E OAuth tests; external IdP trusted. |
| Control plane -> platform DB | Tenant reads/writes, claims, leases | Trusted server principal and SQL handle | Tenant SQL, atomic claims/approvals/grants; DB service role access. W static audit + E tenancy sweep. No general RLS fallback. |
| Capability broker -> execution worker | Capability request, operation/digest/fence grant | Crypto exists in `credentials/grants.ts`; future authenticated broker | P WS-CAP dispatch/auth bindings, WS-ACT real activities. No end-to-end production grant-to-apply claim. |
| Worker -> Temporal history | Inputs, results, failures, signals, heartbeats | Temporal connection/namespace + optional TLS/API key | Deterministic definitions, contract payloads. Serialization happens before workflow code; SEC-F12. No payload encryption configured. |
| Worker -> credential broker -> cloud | Verified grant, connection, temporary credentials | `AwsCredentialBroker.withSession`; caller must first verify signed grant | Workspace/purpose/role-account checks, ExternalId/sub, session policy; callback scoped + revocation. Mocked STS W/E only; trusted callbacks can access credentials. |
| Control plane -> runner | Signed request/job, results, probes | Planned Ed25519 request/JWS authentication (RUNNER-PROTOCOL) | DB token/nonces/revocation exist. Transport, aud, skew, probe egress P WS-RUNSRV/GO; no `go/` implementation in this checkout. |
| Control plane -> zenithd | Fixed operation, machine target, output | Planned machine key / signed request | Fixed-code, argv/unit allowlists/default-off exec are RUNNER-PROTOCOL requirements, P WS-GO/MACH; only machine contract/store is present. |
| Worker/runner -> customer cloud | STS federation, provider APIs, OpenTofu state | Customer observe/deploy roles and customer trust policy | Exact OIDC subject/ExternalId, least-privilege session policy. Customer policy correctness and provider semantics remain external. |
| Repository -> importer/analysis/build | Archive paths, config, package metadata, code | No authority from repository content | `scanTar`, `validateSource`, importer closed vocabulary; analysis hostile-input tests. CodeBuild design ADR-0016; cloud build isolation P WS-AWS-CMP/ACT. |
| Cloud/log -> fabric/incident/model/UI | Raw diagnostics, signals, evidence excerpts | No instruction authority | `sanitizeLog`, `sanitizeText`, JSON quoting and DATA frame in `summarizeForModel`; unknown/unavailable preserved. W composed signal suite. Models and browsers require independent policy/rendering guards. |

## STRIDE by component

Each cell names a concrete defense or an explicit pending control. Evidence is
shared where a single integration property covers several threat categories.

| Component | S | T | R | I | D | E | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Web/API | `browser()` server identity | Exact Origin | Legacy audit; SEC-R1 | Membership + response redaction | Existing body/rate limits; broader quotas unverified | Current member role; platform auth P WS-CAP | E `tests/agent-control-capabilities.test.ts`; P route matrix |
| MCP v1/v2 | `authenticate/verifyOAuth` | Exact proposal/review digest | Journal operation events | `project/checkTarget`, redaction; SEC-F1 | HTTP result/body caps | `Coordinator.execute`, browser review | W MCP matrices/leakage; E coordinator/OAuth |
| Capability broker (pending) | Auth principal construction | Grant op/digest/ws/fence | Durable operation/event rows | Workspace route matrix | Idempotency/leases | Catalog + policy + human approval | P WS-CAP; E DB primitives only |
| Policy engine | Trusted input origin required | Wasm/manifest integrity | Bundle hash in decision | Inputs should contain facts, not values | Fail closed loading/evaluation | Escape hatches denied, autonomy floor; SEC-F8 | W `policy-invariants.test.ts`; E policy suites |
| Approval service | `record` human-only | Proposal digest/policy version | Distinct approver + decision row | Tenant-scoped list | Bounded expiry | Role/count/separation checks | E `tests/controlplane/approvals.test.ts`; route binding P |
| Operations/leases | Principal/tenant input from broker | `claimForExecution/assertFence` | Append events and uncertain states | SQL workspace filter | Durable idempotency, lease TTL | Atomic approved -> running claim | E operations/leases; W SQL audit |
| Worker/Temporal | Namespace/TLS configuration | Deterministic workflow/plan digest | Durable history | Contract payloads; SEC-F12 | Timeouts/cancellation/retry policies | Side effects confined to activities | E workflow tests; W client boundary; P history gate |
| Credential broker | Grant ws/role-account/sub binding | Signed token, valid session policy | `credential.assumed/denied` | Closure credentials + redact; SEC-F10 | Expiry/revoke, failed audit refusal | Observe/deploy purpose | W credential boundaries; E credentials |
| OpenTofu runner | Version pin + cloud session | Config/lock/plan digest | Structured plan/output records | Explicit child env, sensitive masking | Byte/time caps, tree kill | Forbidden constructs; SEC-F3/F4/F5 | W tofu suites; E tofu; tree kill blocked here |
| Runner/zenithd | Planned signatures/aud | Planned nonce/skew/job checks | Planned host audit + DB result | Host key/credential confinement | Planned job/probe budgets | Planned fixed kinds/argv/exec opt-in | E runners DB tests; P WS-RUNSRV/GO/MACH |
| Observability | Broker-scoped source construction | Query validation, per-env filtering | Source/native/simulated labels | Shape/key redaction; SEC-F11 | Source deadlines/body/series caps | Read-only interfaces | E obs suites; W signal composition |
| Incident engine | Environment/graph match | Deterministic signatures/rules | Evidence IDs and unknown status | Bounded/redacted quoted summaries | Probe timeout/concurrency/input caps | Proposes only; policy dry-run | E hostile tests; W signal composition |
| Analysis | No repository authority | `analysis/snapshot.ts` `checkEntryPath`; `analyzeRepository` bounds | Evidence/assumption records | Env names-only intake | Snapshot/file/root/byte budgets | `proposeArchitecture` validates a proposal, does not deploy | E `tests/analysis/hostile.test.ts`; P live GitHub intake |
| Reconciliation | Scoped store/provider session | Lease-fenced atomic commit | Unknown and drift events | Observed-value scrubbing; SEC-F13 | Bounded observe deadlines/scheduler | Repair policy and no automatic uncertain retry | E reconcile suites; W value boundaries |

## Threat register

Fully qualified paths are repository-relative; module shorthand such as
`tofu/plan.ts` means `src/lib/tofu/plan.ts`, `repos/...` means
`src/lib/controlplane/db/repos/...`, and `control/...` means
`src/lib/agent-access/control/...`. P means planned or pending verification,
never a currently enforced end-to-end control.

| Threat / attack | Verified control(s), file/function | Evidence | Residual risk / pending work |
| --- | --- | --- | --- |
| 1. Malicious repository: traversal, unsafe config, executable source | `hosted/source/tar.ts` `safeEntryPath/scanTar`, `validate.ts` `validateSource`; `importers/terraform.ts` `importTerraform` yields referenced resources; `tofu/workspace.ts` `assembleWorkspace` | E `tests/hosted/source/validate.test.ts`, `tests/analysis/hostile.test.ts`; W `tofu-workspace-injection.test.ts` | Importers/analysis parse, not sandbox. Hostile build code still executes in its build environment; SEC-F5 second-wall bypass. P WS-AWS-CMP/ACT customer CodeBuild isolation. |
| 2. Prompt injection in repository files: make model treat text as authority | MCP initialization instructions (`agent-access/{http,control/http}.ts`); `tofu/plan.ts` `planView` untrusted marker; `incidents/sanitize.ts` + `summarizeForModel` DATA frame/JSON quoting | W `tofu-secrets.test.ts`, `policy-invariants.test.ts`, `signal-boundaries.test.ts`; E `tests/analysis/hostile.test.ts`, `tests/incidents/hostile.test.ts` | Framing cannot prove a model obeys it. SEC-F7 invisible characters; SEC-F8 spoofable origin if broker trusts body. Human/policy approval remains the mutation boundary. |
| 3. Malicious log content: forged records, terminal escapes, injected instructions | `observability/redact.ts` `sanitizeLog`; `escape.ts`; `incidents/sanitize.ts` `sanitizeText`; reader log scope/warning and event log exclusion (`agent-access/zenith-reader.ts`) | E `tests/observability/{escape,redact}.test.ts`; W MCP leakage + signal boundaries | Unrecognized plaintext secrets and encoded blobs survive heuristics. Quoted malicious prose remains data, not proof of model safety. |
| 4. Malicious Terraform/OpenTofu output: bogus actions, huge or secret-bearing plan | `tofu/plan.ts` `parseShowJson/normalizePlan/planView`; runner byte caps; `tofu/ui-stream.ts` `renderUiStream` | E `tests/tofu/plan.test.ts`; W `tofu-secrets.test.ts` | Short sensitive echoes (<8 chars), unmarked provider secrets and Unicode invisibles remain limits. SEC-F4 can unmask sensitive values. Real binary unavailable here. |
| 5. Compromised agent: abuse scope, replay proposal, skip review | `agent-access/security.ts` auth/scope/expiry; `control/browser.ts` browser-only review; `Coordinator.execute` fingerprint/auth checks; policy origin rules | W credentials parsing, MCP matrices, policy P7; E `tests/agent-control-{coordinator,journal}.test.ts` | SEC-F8; a requester may approve when separation is not required. Device-flow phishing remains possible; client names are unverified labels. Bytes already read cannot be recalled. |
| 6. Compromised coding connector: steal OAuth or forge broader grant | `control/oauth.ts` `verifyOAuth/bindGrant` pins issuer, resource audience, algorithm, claims/lifetime and browser-created grant | E `tests/agent-control-oauth.test.ts`; W MCP matrices | Connector reads all permitted data, including redaction gaps. Plugin provenance is a separate repository/workstream; historical production-hardening evidence is not a live installer verification here. |
| 7. Cloud credential theft: credentials escape session, output or host | `AwsCredentialBroker.withSession` callback/revocation; `aws/session.ts` closure/serialization; `tofu/env.ts` `buildChildEnv`; exact/pattern output redaction | W credential boundaries, tofu env/secrets; E `tests/credentials/broker-aws.test.ts` | Trusted callback can read `client.config.credentials()`/child env and return or throw it; characterization records unsanitized callback errors. SEC-F10 error-name leak. Tofu child holds live credentials; SEC-F5 file reads and SEC-F6 extras worsen blast radius. |
| 8. Confused deputy: grant another tenant's connection, misuse ExternalId/OIDC subject | `AwsCredentialBroker.#plan/#checkConfig/#exchange`: workspace equality, account-bound role, required ExternalId, purpose/session policy; `workloadSubject` forbids colon injection | W `credential-boundaries.test.ts` matrix and signed JWT; E credentials/bootstrap templates | `withSession` accepts claims, not a JWS; caller MUST verify them first. Crypto verification does not alone validate digest/ws/fence at execution. P WS-CAP claim/consumption wiring; customer trust policy must pin exact sub/aud/issuer. |
| 9. Cross-tenant access: name foreign project, operation, resource or evidence | Reader `project`, control `checkTarget`; `controlplane/db/repos` SQL `workspace_id`; human approvals/store tenant checks | W MCP matrices + SQL audit + store canaries; E `tests/actions/workspace-isolation.test.ts`, `tests/controlplane/tenancy.test.ts` | SEC-F1 legacy operation existence oracle and id-only journal SQL. Internal broker foreign/missing diagnostics differ; public caller must collapse them. Legacy product snapshots rely on application tenancy. |
| 10. SSRF: attacker-chosen probe/webhook/backend URLs | `alerts/webhook-policy.ts` `resolveWebhookTarget`: HTTPS, no userinfo/fragment, permitted ports, every DNS address checked; `deliver.ts` address-pinned lookup/no redirects. Obs `normalizeBaseUrl`, `getJson`: operator config, metadata host filter, redirect refusal | E `tests/alerts/webhook-policy.test.ts`; W `ssrf-address-oracle.test.ts`, `signal-boundaries.test.ts` | Observability intentionally permits private http(s) backends, arbitrary ports; no webhook policy, DNS resolution check or connect pinning there. SEC-F11 mapped metadata bypass; DNS rebinding unaddressed on that path. P WS-RUNSRV/GO probe policy; tenant endpoint exposure needs new SSRF boundary. |
| 11. Metadata-service access: steal instance identity | Webhook private/metadata classifier includes AWS/Alibaba/IPv6/named hosts; obs `isMetadataHost` rejects canonical hosts | W SSRF differential oracle and mapped-host defect; E webhook tests | SEC-F11; obs aliases/DNS are not resolved against metadata. OpenTofu/worker egress may reach IMDS independently. P WS-CI/DOCS worker network controls/IMDS configuration; P WS-GO link-local probe refusal. |
| 12. Webhook abuse: exfiltrate secrets, redirect bearer, huge response, forged notification | `alerts/deliver.ts`: pinned address, redirect refusal, response cap, HMAC with encrypted signing-reference path; webhook URL/port policy | E `tests/alerts/delivery.test.ts`, `tests/alerts/webhook-policy.test.ts`; W address oracle | Operator URLs are an egress primitive; delivery is at-least-once under ambiguous outcomes. Key custody and legacy credential migration need deployment evidence. |
| 13. Arbitrary code execution (builds/provisioners) | `assembleWorkspace` rejects provisioner/connection/remote-state constructs; Dockerfile/CI `npm ci --ignore-scripts`; ADR-0016 customer CodeBuild design | W assembler corpus; E `tests/tofu/workspace.test.ts`; P WS-AWS-CMP/ACT build boundary tests | SEC-F5. Tofu is not an OS sandbox; env allowlist/time limit do not confine filesystem/network. Hostile builds require isolated customer execution, not merely trusted parsing. |
| 14. Supply-chain dependency compromise: malicious package/provider/tool | Lockfile integrity gate (`scripts/ci/lockfile-integrity.mjs`, `.github/workflows/ci.yml`), script-free install, Dependabot; `tofu/providers.ts` exact sources/versions/hash locks and readonly init | E `tests/tofu/providers.test.ts`; W tofu environment/workspace; P WS-CI actual GitHub gate run | `npm audit` is informational, not blocking. `checkTofuVersion` checks a version string, not binary checksum; CI verifies downloaded tools, deployment must too. No Go module exists here; no Go dependency/vulnerability run claimed. |
| 15. Runner compromise: forge job result, replay identity, misuse cloud proxy | `repos/runners.ts` registration-token consumption/revocation; `repos/nonces.ts` `remember`; jobs store settlement; RUNNER-PROTOCOL defines signatures/skew/aud/kinds | E `tests/controlplane/runners.test.ts`; P WS-RUNSRV/GO signature/replay/job-aud/proxy-action tests | Transport/host implementation absent. Compromised customer runner possesses customer identity and can lie about results; reconciliation/uncertain are detection/recovery, not prevention. |
| 16. zenithd compromise: shell injection, unrestricted root actions | `src/lib/machines/types.ts` and RUNNER-PROTOCOL fixed-code/argv/unit allowlist/default-off exec requirements | P WS-GO/WS-MACH implementation + machine target matrix | Those requirements are not implemented transport controls in this checkout. Host-root compromise exceeds the daemon boundary. |
| 17. TOCTOU plan -> apply: rotate sensitive value or swap verified binary plan | `tofu/engine.ts` `applyVerifiedPlan` replans; `runner.ts` `apply/planFileSha` binds checked file and digest; `plan.ts` sensitive HMAC fingerprints; v2 fingerprint recheck | E `tests/tofu/runner.test.ts`; W `tofu-secrets.test.ts` rotation; E coordinator tests | Show->apply window and cloud drift remain; provider plan staleness is external. Default fingerprint key derives from public config/lock digests: WS-ACT must supply server-secret-derived key for low-entropy secrets (ledger follow-up). Real apply checks skipped here. |
| 18. Approval replay: approve stale digest or consume twice | Legacy journal `review/claim` phase/digest/expiry and atomic transition; `repos/approvals.ts` `record/consume`, `operations.claimForExecution`, `repos/grants.ts` `consume` | E `tests/agent-control-journal*.test.ts`, `tests/controlplane/{approvals,grants,operations}.test.ts`; W policy shape checks | DB primitives do not prove platform route authentication/dispatch. P WS-CAP authentic principal, fresh policy and transactionally consumed grants. |
| 19. Stale authorization: revoke/demote while request is running | `Coordinator.execute` reauthentication before/after dispatch, authorize/fingerprint/application authority digest checks; no positive credential membership cache | E `tests/agent-control-coordinator.test.ts`; W MCP matrix attackers | In-flight external effects cannot be undone. Ambiguous post-dispatch authority change is uncertain. Platform worker authorization recheck P WS-CAP/ACT, not inherited automatically from legacy coordinator. |
| 20. Operation duplication: retries, repeated start, expired lease actor | `workflows/client.ts` `startOnce`: stable `op-` id and reject duplicate completed operation; `repos/idempotency.ts` scope+input binding; `leases.ts` fence, operations atomic claim | E `tests/controlplane/{operations,leases}.test.ts`, `tests/workflows/{client,failures}.test.ts`; W workflow client boundary | No global exactly-once cloud effect guarantee. Uncertain outcomes need observation/operator recovery. Legacy `actions/core.ts` idempotency is process-local. |
| 21. Cloud eventual consistency: stale observation masquerades as desired/success | `reconcile/observe.ts` `failureObservation`, `core.ts` observation/report separation; fabric unavailable; workflows stop unknown verification as uncertain | E reconcile/workflow failure tests; W signal/reconcile composition | Contract tests only, no live AWS verify steps. Provider lag can persist; do not report missing/unknown as healthy or auto-retry uncertain mutations. P WS-ACT live acceptance. |
| 22. DNS takeover (dangling records): deleted target still has public DNS | `policy/rego/approval.rego` `production_network_identity_change`, `lib.rego` `touches_network_identity` consumes `dnsChanges` | E policy scenarios/plan facts; W policy invariants; P WS-AWS-NET/REC dangling target deprovision test | No dedicated dangling-record detection/cleanup found in merged reconciliation/drivers. General missing-resource drift is not that control. |
| 23. Destructive data action: delete DB/stateful resource without protection | `policy/rego/deny.rego` `production_database_delete/production_destroys_data`; approval admin rule; `src/lib/policy/plan-facts.ts` stateful/destroysData facts; legacy engine stateful-deletion block | E `tests/actions/stateful-deletion.test.ts`, `tests/policy/plan-facts.test.ts`; W policy P2/P6 | Facts depend on correct driver/plan classification. Backup presence/restoreability is not checked by these rules. P WS-ACT/driver destructive live acceptance. |
| 24. Dependency confusion: ambiguous/private package namespace fetched publicly | `tofu/providers.ts` fully qualified provider sources + hash locks; npm lockfile gate pins registry.npmjs.org + SHA512 | E `tests/tofu/providers.test.ts`; P WS-CI dependency namespace review when private packages appear | No `.npmrc`, `go.mod` or `go.sum` found in checkout. No private-package-specific routing guarantee or Go scan claimed. Exact version does not make a compromised upstream safe. |
| 25. Secret leakage via plans/logs/events/MCP: raw or encoded value reaches model/history | Primary control: references-only callers; `normalizePlan` sensitivity/echo scrub, MCP redaction, signal sanitizers, event/evidence `assertNoSecretValues`, reconciliation observed-value scrub; `server/errors.ts` `errorResponse` hides unexpected error text on HTTP only | W tofu/MCP/audit/coverage/store/signal/reconcile/request-error-logging suites; E observability/incidents hostile tests | SEC-R1/R2/F4/F7/F10/F12/F13; exact coverage tables below. Repos reject recognizable shapes, do not scrub arbitrary opaque credentials. Generic HTTP errors still leak via raw server error logs (SEC-R2). No secret guarantee follows from a heuristic filter. |
| 26. Temporal history exposure: extra node specs, result/failure credentials persist | `workflows/types.ts` contract; client API-key TLS; deterministic definitions accept operation references | W `workflow-history.test.ts` default serializer tests; E workflow contract/config/client tests; P WS-WF/ACT real history gate | SEC-F12: start functions forward input objects unchanged. No codec/encryption configured. Activity results/failures are serialized before workflow-side redaction; production activity hooks pending. History access/retention is external. |
| 27. Policy bundle tampering: replace wasm/manifest to widen authority | `src/lib/policy/engine.ts` load validates wasm, manifest hash, entrypoint; evaluation fail closed; decision records carry bundle digest; CI rebuild gate | W policy P9; E `tests/policy/engine.test.ts` | Missing manifest loads wasm without an external expected hash. Writable wasm AND manifest can be consistently replaced. Bundle hash is provenance data, not signature authentication. Deployment filesystem/image custody is the trust root. |
| 28. Runtime/engine defects: parsing changes object identity/digest | `tests/_support/security/runtime.ts` detects JSON.parse key corruption; CI/Dockerfile Node 22 pins; canonical/digest tests | W `runtime-sanity.test.ts`, `digest-canonical.test.ts` (SEC-F9) | Node 24.19 defect reproduced here; two parser-dependent tests skipped. `engines.node >=22.16` admits it. Node 22 behavior not run here. Digest has no domain separation, normalizes neither Unicode nor non-JSON values; callers must use fixed JSON contracts. |

## Prioritized findings

No production code was changed by WS-SEC. Owners should fix the named boundary,
then flip the expected failure and update the characterization/ratchet.

| ID / severity | Reproduced defect and reachability | Location / owner | Pinned evidence |
| --- | --- | --- | --- |
| **SEC-F5 HIGH** | Comments split forbidden HCL function/reference tokens: `${file/**/(...)}`, nested `try`, template directives and `path/**/.cwd` bypass regex; prior real-tofu evidence reads a workspace file. Host/child environment read is conditional on OS path and an unescaped fragment reaching assembler. | `tofu/workspace.ts` `FORBIDDEN_CALL/FORBIDDEN_REF/scanExpressions`; WS-TOFU + all drivers | W `tofu-workspace-injection.test.ts`: real semantic checks skipped in continuation; prior handoff reports OpenTofu 1.12.5 execution. Use parser/allowlisted expression construction, not a widened regex alone. |
| SEC-F4 MED | `nonsensitive()` is accepted and can expose a sensitive value in a model plan. | `tofu/workspace.ts` forbidden functions; WS-TOFU | W assembler known-gap test (real semantic gate skipped here). |
| SEC-F8 MED | Integration/navigator principal with `context.origin: human` bypasses agent-specific approval rules in tested policy cases. | `policy/rego/approval.rego` `agent_high_risk_requires_approval`; WS-POL/CAP | W `policy-invariants.test.ts` P7 expected failures. Authenticate origin independent of request body. |
| SEC-F9 MED runtime | Node 24.19 JSON.parse key corruption reproduced by runtime harness; engine range permits affected versions. | `package.json` engine range, runtime; WS-CI/FOUND | W runtime expected failure; two explicit digest skips. Pin/validate supported runtime; package change outside WS-SEC. |
| SEC-F3 MED latent | `providerConfig` accepts endpoints/proxies/CA/profile/assume-role options despite credential-key scan. Not manifest-reachable today. | `tofu/workspace.ts` `providersFile`; WS-TOFU/CAP/drivers | W assembler expected failure. Add configuration allowlist before any manifest exposure. |
| SEC-R1 MED | Compose YAML blob is recorded verbatim in legacy action audit; audit error/summary also bypass redaction. | `src/lib/actions/core.ts` `audit/redact`; legacy action owner | W `audit-secret-leakage.test.ts`, `redaction-coverage.test.ts`. Remove blob values from audit, scrub error fields. |
| **SEC-F10 MED** | Synthetic STS credential in external `Error.name` reaches denial error and `data.stsError`, though message redaction works. Reachability requires upstream/error adapter to supply such a name; no live AWS exploit claimed. | `credentials/aws/broker.ts` `errorName/#exchange/#denied`; WS-CRED | W `credential-boundaries.test.ts` CONTROL, characterization and expected failure. Use bounded stable error codes; redact all external text. |
| **SEC-F12 MED caller boundary** | All four workflow starts forward extra runtime `nodes/inputs` with secret canaries to serialization. TypeScript input types do not validate deserialized objects. Current public route reachability not proven. | `workflows/client.ts` `startDeploy/startDayTwo/startRemediation/startReconcile`; WS-WF/CAP/ACT | W four serializer expected failures + compliant controls. Real history characterization gated, not run. Project/validate input before client start, and guard activities before results/failures enter history. |
| **SEC-R2 MED** | `errorResponse` emits unexpected Error message/stack to stderr without redaction, including a synthetic DB URL password and AWS access id. HTTP 500 body is generic and safe in the control test; the server log is not. | `src/lib/server/errors.ts` `errorResponse`, `src/lib/log.ts` `serialise/emit`; request/logger owner | W `request-error-logging.test.ts` wire control, actual log characterization and expected failure. First observed in existing `tests/reconcile/route.test.ts` output. Scrub all external error fields before logging. |
| SEC-F1 LOW | Legacy v2 foreign operation id yields 403; phantom 404. Journal lookup SQL is id-only before app tenant check. | `agent-access/control/{journal,journal-pg}.ts`; legacy control owner | W v2 matrix characterization + expected failure. Scope lookup in SQL and hide existence. |
| SEC-F7 LOW-MED | Bidi/zero-width/TAG text passes model plan view (and MCP free-text stripping is limited). | `tofu/plan.ts` `viewText`; WS-TOFU/MCP | W `tofu-secrets.test.ts` expected failure. Treat sanitized text as untrusted regardless. |
| SEC-F6 LOW hardening | Session extras validator is a denylist admitting dynamic loader/SDK endpoint/credential-file variables. Real broker currently supplies only AWS session variables. | `tofu/env.ts` `validateExtraEnv`; WS-TOFU | W env expected failure. Enforce session-specific allowlist. |
| **SEC-F11 LOW operator config** | IPv4-mapped metadata literals evade observability hostname filter, while canonical hosts are rejected. Endpoints are trusted operator config today. | `observability/sources/http.ts` `isMetadataHost/normalizeBaseUrl`; WS-OBS | W signal endpoint expected failure. Normalize address equivalents; add DNS/connect egress guard before tenant endpoint exposure. |
| **SEC-F13 LOW driver contract** | Credential-shaped `expectedAttributes` survives in drift `fields[].desired` while observed values are scrubbed. Fake driver reproduction; no live driver leak claimed. Real platform store may reject recognized shape on commit, but controller/in-memory return already leaks. | `reconcile/core.ts` -> `resources/computeDriftV2`; observation-only scrub in `reconcile/observe.ts`; WS-REC/drivers | W `reconcile-value-boundaries.test.ts` expected failure + characterization. Scrub both comparison sides before reports/returns. |
| SEC-F2 LOW | `__proto__` label accepted then dropped by prototype assignment; address map claims it. Manifest naming prevents present public input reachability. | `tofu/workspace.ts` resource/output/local merge; WS-TOFU | W assembler expected failure. Reject special keys or use null-prototype records. |

## Redaction coverage: measured gaps, not blanket guarantees

Measurements use stable synthetic values from the fixed default canary seed.
The exact maps are ratcheted in `redaction-coverage.test.ts` and
`credential-boundaries.test.ts`. `ALL` is the ten shapes: AWS access id, AWS
secret key, AWS session token, JWT, PEM private key, Zenith agent token, GitHub
token, Slack token, password and hex key. `SINGLE` excludes PEM; `PW` is
password/hex/Zenith token. The table lists ONLY surviving shapes; absent tested
cells were covered. A `-`/unmeasured position is not a coverage claim.

| Redactor | Position | Shapes that survive |
| --- | --- | --- |
| MCP `security.ts redact` | Neutral key / JSON blob | ALL except Zenith token |
| MCP | Free text, KEY=value, URL query | SINGLE except Zenith token |
| MCP | Connection URI / postgres userinfo | Password, hex |
| MCP | Object key | SINGLE |
| MCP | Base64 in neutral key | ALL |
| Tofu `redactOutput` | Free text / JSON blob | AWS secret key, AWS session token, hex, password, Zenith token |
| Legacy audit `core.ts redact` | Value key / neutral key / JSON blob / base64 neutral key / neutral env pair | ALL |
| Legacy audit | Free text / KEY=value / bearer / URL query / object key | SINGLE |
| Legacy audit | Connection URI / https or postgres userinfo | PW |
| Credential `redactCredentials` | Free text / JSON blob | GitHub, Slack, password, hex |
| Credential | Base64 | AWS access id, AWS secret key, GitHub, Slack, password, hex, Zenith token |

Measured successes: MCP secret-named/value fields, both env-pair positions,
bearer headers and tested HTTPS userinfo; tofu assignments/userinfo/bearer/query;
legacy audit secret-named fields/secret-named env pairs; credential secret
assignment and tested bearer shapes. Generic Error serialization removes fields
in parts of the legacy ratchet; it does not prove action audit error text is
redacted. That separate characterization confirms it is not.

Additional characterizations: arbitrary plaintext password in a matching
log signature survives fabric -> incident -> model summary; events/evidence
reject AWS access-id/GitHub/Slack/PEM/JWT canaries but retain the other five
opaque shapes in a neutral value. Neither repository scrubs stored input.
Reconciliation preserves unrecognized plaintext attributes, omits attribute
values from drift events, and needs SEC-F13 handling for expected attributes.
Encoding/fragment transformations beyond scanner knowledge remain unverified.

## Assumptions and scope limits

- The control-plane/worker host, its operator, signing-key configuration,
  broker callback code, provider drivers and policy input construction are
  trusted computing base. Sessions reduce accidental leakage; they do not
  sandbox trusted code that deliberately extracts credentials.
- Customer account/root compromise, control-plane host compromise, Vercel,
  Supabase, Temporal Cloud/self-hosted administrators, OIDC provider and model
  provider custody are external trust assumptions. Least privilege and
  [operator access](../hosted/OPERATOR-ACCESS.md) reduce blast radius; this suite
  does not prove operational access reviews, encryption custody or restore RPO.
- Observability endpoints are operator configuration. A future tenant setting
  changes that boundary and requires SSRF checks before exposure. Private
  metrics backends are intentional, so the webhook private-address denylist
  cannot be copied blindly without a backend-specific egress policy.
- Control-store tenancy is SQL/application scoping; static mention of
  `workspace_id` alone cannot prove predicate semantics. Emitted Supabase SQL
  enables RLS with no policies and limits schema grants, while the service role
  bypasses it. That protects against direct client roles, not a wrong-tenant
  service query. The TypeScript migration path does not add this Supabase-only
  hardening. The existing dynamic tenancy inventory sweep is indispensable.
  Application authority and legacy journal are separate stores, not a
  cross-store atomic transaction.
- DoS controls are local budgets/caps/timeouts and existing route limits, not
  a platform-wide availability proof. Windows process-tree termination could
  not run successfully under this sandbox: three existing tofu tests fail.
- No live customer cloud, KMS, hosted restore, Temporal Cloud, model behavior,
  Go runner or zenithd transport was exercised. No Docker/WSL/LocalStack was
  used. No contract, dependency, source production file or `.git` was changed.
- The ledger is a status snapshot: WS-CRED/DB/POL/TOFU/OBS/WF/INC/ANALYZE/CI
  are integrated; WS-CAP/RUNSRV/GO/MACH/drivers remain in progress here. WS-REC
  code and merge are present even though the ledger still says in progress.
  Presentational WS-UI components do not mean platform pages are wired.

## Pending hooks and ownership

| Owner | Evidence still required |
| --- | --- |
| WS-CAP | Auth-only principal/origin, body spoof refusal, route inventory + tenant matrix, human-only/digest-bound/single-use/separation approvals, op/digest/ws/fence grant binding and atomic use; collapse internal broker diagnostic oracle. |
| WS-MCP | MCP v3 tool inventory matrix and wire canary scan. |
| WS-RUNSRV / WS-GO | Ed25519 signature/skew/nonces/replay/revocation, job JWS audience, kind/SigV4 action allowlists, first-writer results, metadata/link-local probe refusal. Apply WS-SEC `assertNoEgressBypass` oracle to Go classifier or TS twin. |
| WS-MACH | Machine-target tenant matrix, argv-only fixed operations, unit-name regex, default-off exec, signed daemon requests and JSONL audit canary scan. |
| WS-AWS-NET / CMP / DATA / WS-K8S | `assertDriverStringsInert` in every driver compile contract; spec canaries absent from observe/expectedAttributes, API endpoint/proxy restrictions, dangling DNS deprovision and destructive-data facts. |
| WS-OBS / WS-INC / WS-ANALYZE | Corpus/scanner on every new source, evidence, investigation, analysis requirement/proposal and model summary; unknown/unavailable never healthy; address equivalence/DNS egress policy before tenant config. Live providers remain gated. |
| WS-WF / WS-ACT | SEC-F12 runtime input validation/projection, real history scans with secret-bearing activity results/errors/heartbeats, secret-derived plan fingerprint key, credentials inside session only. Deploy encryption/retention decisions explicitly. |
| WS-UI | Browser approval content inertness; exact reviewed digest submission; sensitive/unknown/simulated states preserved when pages are wired. |
| WS-REC | SEC-F13 both comparison sides scrubbed; platform commit/return canary scans, fenced writes, no automatic uncertain retry. |
| Request/logger owner | SEC-R2 unexpected Error message/name/stack sanitization at the server log boundary; keep request attribution without secret values. |
| WS-CI / WS-DOCS | Approved runtime, worker download hashes/egress/IMDS controls, actual CI branch gate evidence, signing/vault/backup custody and recovery drills. |

The [suite README](../../tests/security/README.md) provides concrete helper
recipes and integration points. Planned controls need executable evidence
before their status changes to implemented.

## Verification log (continuation, 2026-10-01)

Runtime: Node 24.19.0 / V8 13.6.233.17-node.51, Windows managed sandbox. Baseline
working tree was clean at `9c177b7`. Prior handoff's 220 passed / 2 skipped is
historical; this sandbox cannot execute the installed OpenTofu binary.

| Command | Observed result |
| --- | --- |
| Baseline `npx tsc --noEmit` | Exit 0, 0 diagnostics. |
| Baseline `npx eslint tests/security tests/_support/security` | Exit 0, 0 diagnostics. |
| Baseline `npx vitest run tests/security` | 16 files passed; 212 passed, 0 failed, 10 skipped. |
| `npx vitest run tests/controlplane tests/policy tests/tofu` | 23 files passed, 1 failed, 3 skipped; 523 passed, 3 failed, 28 skipped. |
| `npx vitest run tests/tofu/process.test.ts` | Reproduced in isolation: 15 passed, 3 failed, 0 skipped. Timeout, grandchild-tree and AbortSignal termination all time out. |
| `$env:ZENITH_SEC_PRINT_COVERAGE='1'; npx vitest run tests/security/redaction-coverage.test.ts` | 1 file / 9 passed, 0 failed, 0 skipped; tables measured above. |
| `$env:ZENITH_SEC_PRINT_COVERAGE='1'; npx vitest run tests/security/credential-boundaries.test.ts tests/security/signal-boundaries.test.ts tests/security/store-value-boundaries.test.ts tests/security/reconcile-value-boundaries.test.ts tests/security/workflow-history.test.ts` | Initial development run: 2 files passed, 3 failed; 17 passed, 7 failed, 2 skipped. Harness type/fixture errors corrected; desired-value leakage isolated as SEC-F13. |
| `npx vitest run tests/security/credential-boundaries.test.ts tests/security/signal-boundaries.test.ts tests/security/store-value-boundaries.test.ts tests/security/reconcile-value-boundaries.test.ts tests/security/workflow-history.test.ts` | Corrected run: 5 files passed; 27 passed, 0 failed, 2 skipped. |
| `npx vitest run tests/security/request-error-logging.test.ts tests/security/reconcile-value-boundaries.test.ts tests/security/store-value-boundaries.test.ts` | 3 files passed; 8 passed, 0 failed, 0 skipped. |
| `npx vitest run tests/credentials tests/observability tests/incidents tests/reconcile tests/analysis tests/workflows/client.test.ts tests/workflows/config.test.ts` | 52 files passed; 1391 passed, 0 failed, 12 skipped (one credential bootstrap gate and eleven real Temporal client scenarios). Existing Temporal support attempted a download; network was denied and runtime scenarios did not run. |
| `npx vitest run tests/security` after six added suites | 22 files passed; 242 passed, 0 failed, 12 skipped. Earlier intermediate 21-file run: 239 passed, 0 failed, 12 skipped. |
| `$env:ZENITH_SEC_PRINT_COVERAGE='1'; npx vitest run tests/security/redaction-coverage.test.ts tests/security/credential-boundaries.test.ts` | 2 files passed; 17 passed, 0 failed, 0 skipped; all four redactor tables printed. |
| `npx tsc --noEmit` development checks | Initial new-suite check: 7 diagnostics; next: 3 optional-report diagnostics; next: 1 stderr-spy overload diagnostic. All corrected in owned tests. Final result recorded below. |
| `npx eslint tests/security tests/_support/security` subsequent checks | Every run exited 0 with 0 diagnostics. |
| Final `npx tsc --noEmit` | Exit 0; 0 diagnostics, after all six test suites were added and corrected. |
| Final `npx eslint tests/security tests/_support/security` | Exit 0; 0 errors, 0 warnings. |
| `git diff --check`; documentation path/LF/invisible-character checks | Exit 0; only the eight owned new files are untracked; no tracked source modifications. New files use LF and contain no raw bidi/zero-width characters; fully qualified source references resolve. |

Full security: 12 skips comprise eight real OpenTofu tests, two Node JSON.parse-
dependent digest tests, and two opt-in real Temporal history tests. The opt-in
gate was not enabled. Real Postgres/cloud/provider-download checks were not
enabled. All skipped checks remain unverified.
Direct OpenTofu/Temporal execution returned access denied; a targeted taskkill
probe of a newly created test child also returned access denied. This explains
the local termination failure but does not prove its behavior on an unrestricted
host. Owner/orchestrator must rerun those three tests outside this sandbox.

Continuation corrections to handoff assumptions: event/evidence repositories
DO reject recognized secret shapes; observability DOES filter canonical
metadata hosts and refuse redirects; emitted Supabase SQL DOES enable RLS
(without tenant policies). These were source-verified, not changes to the
production code. Existing test layout, deterministic canary seed, redaction
ratchets, v2 matrix exception and expected-failure convention were preserved.
SEC-F10/F11/F12/F13/SEC-R2 are additive findings. No commit was made, as required
by the continuation override; orchestrator review/commit remains the next step.
