# WS-SEC security harness

This suite records executable security invariants and their limits. A green run
includes expected failures for known defects; it does not mean those defects are
fixed. Synthetic canaries, mocked STS, fake provider ports and in-memory stores
are labelled in the test headers. Nothing here proves live cloud acceptance.

Owned paths: `tests/security/**`, `tests/_support/security/**`, and
`docs/platform/THREAT-MODEL.md`. Application fixes belong to their workstreams.
The continuation leaves changes uncommitted for the orchestrator.

## Run

From this worktree, with the existing shared dependencies:

```powershell
npx tsc --noEmit
npx eslint tests/security tests/_support/security
npx vitest run tests/security
npx vitest run tests/controlplane tests/policy tests/tofu
$env:ZENITH_SEC_PRINT_COVERAGE='1'
npx vitest run tests/security/redaction-coverage.test.ts tests/security/credential-boundaries.test.ts
Remove-Item Env:ZENITH_SEC_PRINT_COVERAGE
```

OpenTofu tests discover the real binary and skip when it cannot execute. Set
`ZENITH_TOFU_BIN` to an authorized absolute executable path when PATH discovery
is unsuitable. Provider-download tests stay behind their existing env gates.
This sandbox cannot execute the installed WinGet OpenTofu/Temporal binaries;
their presence on PATH is not proof that a test ran.

`ZENITH_SEC_TEMPORAL=1 npx vitest run tests/security/workflow-history.test.ts`
(set the variable with `$env:ZENITH_SEC_TEMPORAL='1'` in PowerShell) opts into
real Temporal history scans, real workflows and fake activities. The shared
`tests/workflows/support.ts` harness starts its own server on a random port and
may download a test server if the CLI cannot execute. Default runs never start
it. No Docker, WSL, LocalStack, real AWS or another project's ports are needed.
Never use ports 4566/54329/7233/8181 or `ssc-*` containers.

## Layout and evidence

| Suite | Boundary / evidence |
| --- | --- |
| `support`, `driver-inert` | Canary scanner, tenant harness, corpus, driver expression oracle test themselves. |
| `mcp-v1-tenant-isolation`, `mcp-v2-tenant-isolation` | Actual reader/control dispatch, synthetic two-tenant product store; v2 test journal is in-memory. Inventory guards cover added tools. SEC-F1 is an existence oracle. |
| `mcp-secret-leakage`, `redaction-coverage`, `audit-secret-leakage` | Real wire reader and action/audit paths; exact coverage ratchets and SEC-R1. |
| `tofu-workspace-injection`, `tofu-secrets`, `tofu-runner-env` | Structural corpus tests plus executable OpenTofu checks when available. SEC-F2/F3/F4/F5/F6/F7 remain defects. |
| `policy-invariants` | Catalog properties against the shipped OPA wasm, including SEC-F8. |
| `digest-canonical`, `runtime-sanity`, `agent-credentials` | Canonical hashing, prototype keys, Unicode behavior, runtime fidelity and bearer parsing. SEC-F9 pins the permissive Node engine range. |
| `controlplane-sql-scoping` | Static discovery of tenant tables/repository functions and SQL interpolation audit. Complements, never replaces, the dynamic worker tenancy sweep. |
| `credential-boundaries` | Real broker with mocked STS: tenant matrix, ExternalId, signed/verified OIDC, session revocation, credential coverage ratchet; SEC-F10 (external error names). |
| `signal-boundaries` | Real fabric -> investigation -> summary using fake signals, unavailable propagation, plaintext-secret characterization and HTTP request options; SEC-F11 (mapped metadata literals). |
| `store-value-boundaries` | Real in-memory PGlite event/evidence writes. Recognized shapes are rejected; opaque shapes are preserved. |
| `reconcile-value-boundaries` | Real controller, fake drivers and in-memory persistence. Observed values are scrubbed; expected attributes can survive in drift desired fields (SEC-F13). |
| `workflow-history` | Default: actual client start functions with intercepted transport, SEC-F12. Opt-in: actual server history with fake activities, compliant payload scan and leak characterization. |
| `request-error-logging` | Real errorResponse/logger with stderr intercepted; generic HTTP 500 omits credentials while server error message/stack leaks them (SEC-R2). |

Use [the threat model](../../docs/platform/THREAT-MODEL.md) for prioritized
findings, verified controls, residual risks and the verification record.

## Shared helper API

Import `../_support/security` from these suites (or the equivalent relative
path in another module). `policy.ts` and `coverage.ts` can be imported directly.

- `canarySecret(label, shape?, { stable? })`, `canarySet`: deterministic fake
  secrets. Default seed is `zenith-security-canaries-v1`; optional override is
  `ZENITH_SECURITY_CANARY_SEED`. Non-stable calls mix a counter for uniqueness.
- `deepScanForCanaries(value, canaries, options?)`: scan nested values AND keys,
  arrays, Maps, Sets, Errors/causes, Buffers and `toJSON`, with a node budget.
  Recognizes raw, escaped, URL/form, hex, base64/base64url (all three alignments)
  and registered PEM/JWT fragments. It cannot recognize unknown secrets,
  arbitrary transformations or every partial fragment. Treat budget exhaustion
  as an incomplete scan, not evidence of safety.
- `assertNoCanaries(value, canaries, invariantSentence)` / `expectNoCanaries`:
  failures name the invariant and output path, with masked canary descriptions.
- `tenantMatrix(spec)`: principal x target calls, `.table()`, `.violations()` and
  `.assertIsolated(options)`. `refused(kind, details)` adapts non-throwing APIs.
- `twoTenantFixture`, `phantomId`: pure product-store fixtures with matching
  project slugs and planted canaries in logs/findings/env/deployment fields.
- `injectionCorpus`, `injectionsFor`, `injectionStrings`: hostile external data
  covering prompt, shell, traversal, ANSI/NUL/bidi, oversize, JSON/YAML/HCL,
  template, SQL, HTTP headers, URLs and log forgery.
- `assertDriverStringsInert`, `liveInterpolations`, `EXPRESSION_ATTACKS`:
  driver compile-output interpolation checks; an escaped `$${`/`%%{` is inert.
  The semantic oracle was verified with real OpenTofu in the prior handoff;
  this continuation's real-tofu checks skipped.
- `measureCoverage`, `expectCoverage`: position x canary-shape redaction matrix
  with an exact gap ratchet. Throws are recorded as no returned leak, not proof
  of redactor availability. Stable canaries keep regex-dependent results fixed.
- `policyInputFor`, `patchOf`, `emptyPlanFacts`, catalog dimensions: independent
  policy inputs, deliberately separate from `tests/policy/support.ts`.
- `jsonParseKeyBug`, `skipIfJsonParseBroken`, `JSON_PARSE_BUG_REASON`: targeted
  skips for tests that require faithful JSON parsing on affected runtimes.

## Add a tenant surface

Copy the adapter pattern in `mcp-v1-tenant-isolation.test.ts`:

1. Enumerate the actual exported tool/route inventory. Assert each entry has a
   matrix row so new capabilities cannot silently escape the suite.
2. Create alpha/bravo principals, targets and canaries. Add an attacker with
   `ownAccess: "none"`, and poison grants separately where relevant.
3. Call the REAL dispatcher/repository under the principal's authenticated
   scope. Do not implement the access check inside the test adapter.
4. Put phantoms inside that caller's OWN project/environment. Compare foreign
   and nonexistent objects with otherwise identical arguments.
5. Run `assertIsolated({ canariesByWorkspace })`. Own targets must succeed,
   foreign/phantom targets must refuse, and existence must stay hidden.

`noExistenceLeak: false` needs a written, narrow reason. Existing MCP target-
workspace mode compares different refusal levels; poison grants already name
the foreign id (`skipExistenceCheck`). The internal credential API exposes
workspace-mismatch vs missing diagnostics deliberately; public WS-CAP routes
must hide that distinction. None of these exceptions waive tenant isolation.

## Add an output surface

Plant canaries through the module's real input path, using `twoTenantFixture`
or `canarySet`. Scan every response, thrown Error/serialized error, event,
evidence/audit row, model summary and persisted record. Require nonempty output
and a planted pre-sanitization canary so a disconnected harness cannot pass.
Scan output keys and byte payloads, not only `JSON.stringify(result)`.

For redaction, build several meaningful positions (neutral string, assignment,
URL, JSON blob, error name/message, encoded form). Run `measureCoverage`, inspect
the table with `ZENITH_SEC_PRINT_COVERAGE=1`, then record the observed gaps.
`expectCoverage` fails for new leaks AND repaired gaps. Remove repaired gaps
from code and the threat model together; never widen the map to hide regression.

## Known defects and runtime skips

Use `it.fails("SEC-Fxx (severity): invariant ...", ...)` for a reproduced defect
outside WS-SEC ownership. It asserts the desired invariant and is counted by
Vitest as passed when that invariant fails. Guard ambiguous failures with a
separate CONTROL/characterization test proving the actual data path or leak.
Once the owner fixes the code, change `it.fails` to `it`, update the
characterization and finding status, and rerun the focused suite. Do not label
expected failures as fixes or count them as successful security enforcement.

Use `skipIfJsonParseBroken(ctx)` only where the test depends on JSON.parse
fidelity. Do not skip unrelated canonical/digest invariants. The affected Node
24.19 runtime skips two digest tests and emits the reason; CI pins Node 22.

## Pending integration hooks

| Owner | Required hook and test |
| --- | --- |
| WS-CAP | Build `PolicyInput.principal` and `context.origin` from authentication only; request-body spoofing test (SEC-F8). Matrix over every `/api/platform/v1` route. Human-only, digest-bound, single-use approvals with separation of duties. Grants bind operation/digest/workspace/fence; consume transactionally. Collapse broker foreign/missing diagnostics. |
| WS-MCP | MCP v3: every tool gets a tenant row and inventory guard; scan full wire responses with two-tenant canaries. |
| WS-RUNSRV / WS-GO | Signature, skew, nonce, replay, revocation, job JWS `aud` and grant constraints; probes refuse metadata/link-local. Reuse `assertNoEgressBypass` in `ssrf-address-oracle.test.ts` against the Go classifier table or TS twin. No Go implementation exists in this checkout yet. |
| WS-MACH | Target matrix, argv-only operations, unit-name regex, default-off `machine.exec`; apply request signature/replay tests to zenithd transport. |
| WS-AWS-NET / CMP / DATA / WS-K8S | Use `assertDriverStringsInert` in EVERY driver contract suite. Specs cannot compile to live interpolation; secrets cannot reach observe/expectedAttributes output (SEC-F5/F13). Test endpoint/proxy configuration denial and DNS dangling-target handling. |
| WS-OBS / WS-INC / WS-ANALYZE | Add new source/analysis surfaces to corpus and scanner; preserve unavailable/unknown. Operator URLs require DNS/metadata safeguards before tenant exposure (SEC-F11). Verify real provider behavior only in gated acceptance. |
| WS-WF / WS-ACT | Refuse/project runtime workflow properties (SEC-F12), run the opt-in real-history gate, scan activity results/failures/heartbeats, and keep credentials/plan/specs outside history. No payload encryption is configured today. |
| WS-UI | Approval screens render repository/log/cloud text inertly, distinguish unknown/sensitive/simulated, and submit the exact reviewed digest. Presentational components are merged; route wiring remains. |
| WS-REC | Scrub expectedAttributes/drift desired values (SEC-F13); canary scan platform-store commits as well as controller returns. Preserve fencing, unknown observations and attribute-name-only events. |
| WS-TOFU / WS-CRED / legacy actions | Fix SEC-F2..F7/F10 and SEC-R1 in owned production modules, then flip pinned expected failures and update ratchets. |
| Request/logger owner | SEC-R2: scrub all unexpected error fields before server-log output; a generic HTTP error is not proof that logs omit credentials. |

Existing worker suites remain authoritative and are not replaced here:
`tests/controlplane/tenancy.test.ts`, `tests/credentials/*`,
`tests/incidents/hostile.test.ts`, `tests/observability/{escape,redact}.test.ts`,
`tests/analysis/hostile.test.ts`, `tests/reconcile/boundary.test.ts`.
