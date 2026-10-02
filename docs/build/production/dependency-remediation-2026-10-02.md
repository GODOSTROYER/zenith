**Dependency remediation, 2026-10-02, PROD-CI-07, baseline `99c64ca`**

The updated locked audit now reports **zero known findings**, and the frozen
mandatory audit checker exits 0 against this checkout. An isolated fresh
installation and all eight real-package compatibility checks pass. Next
production build, representative application tests, full serial Vitest 4
execution, the canonical real workflow lane and the refreshed mandatory
security audit now pass root's independent verification. Actual Linux
installation/build and real SMTP/TLS acceptance remain **unproven**.

The initial audit workstream recorded eight vulnerable package entries and
24 GHSA IDs. No exceptions are authorized. This workstream changes the
dependency inputs separately from that frozen audit and runtime-admission
patch. Runtime engines remain `>=22.22.2 <23`; Node 22.23.3 is the verification
runtime. Every lock update uses `--package-lock-only --ignore-scripts`; no
installation, services, automatic force fix or shared dependency tree is used
before the resource grant. After the grant, an own fresh
`npm ci --ignore-scripts --no-fund` succeeded on Darwin arm64: 782 packages
added, 783 audited and zero reported findings. Its heap was limited to 768 MB.
Lifecycle scripts were not exercised by this install.

Step 1 adds exact, version-scoped leaf overrides: brace-expansion 1.1.21 on
major 1 and 5.0.12 on major 5, Undici 8.10.2 on major 8, E2B's exact optional
`undici8` alias to `npm:undici@8.10.2`, and Next's PostCSS child to 8.5.23.
The brace and root Undici replacements meet their existing parent ranges.
The E2B alias and Next child are exact upstream pins, so their overrides need
compatibility proof; updating the root HTTP package alone leaves the alias
vulnerable. A refreshed complete locked audit then reports three package
entries: Nodemailer, Vitest and its mocker, covering six distinct GHSA IDs.

Before applying the major versions, the bounded compatibility plan is:

- Nodemailer 10.0.9: review the official 10.0 migration and patch notes, then
  exercise the real package offline with a buffered stream transport. Verify
  module/default exports, `createTransport`, URL options parsing, promise
  `sendMail`, string recipient/envelope/MIME output and `close`. Run both
  existing alert and hosted invitation delivery suites. Their test shims
  exercise application handling; the new real-package test must complement
  those shims. Neither stream output nor a shim proves a real SMTP/TLS
  handshake or a deployed server's credentials policy.
- Vitest 4.1.11: review the tagged 4.x migration guide, retain the committed
  Node/DOM projects, timeouts, aliases, isolation and JSX behavior, then run
  representative mock-heavy Node/DOM tests and the real JSON report gates.
  No config changes are justified before a reproduced compatibility failure.
  Constructor mocks, `restoreAllMocks` state changes, module-runner behavior
  and reporters require attention in root's full-suite and Temporal checks.
- Next/PostCSS: load PostCSS through Next's own resolver, prove the overridden
  version processes ordinary CSS and emits a source map, then require a
  production Next build with the exact lock. Parser tests alone do not clear
  the override's integration risk.
- Brace-expansion and Undici: verify both brace branches and the root/alias
  HTTP package resolutions; preserve scoped overrides so unrelated major
  versions and E2B's safe Undici 7 dependency are not rewritten.

Nodemailer's 10.0 migration requires Node 20+, includes ESM/CommonJS builds,
and maintains the transporter type shape. Zenith's two consumers already
check namespace/default exports, pass an SMTP URL and plain string recipient,
await `sendMail` and close in `finally`. The real-package checks and root's
application caller suites now pass; real SMTP/TLS remains outside that proof.
[Official 10.0 release](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.0),
[10.0.9 patch](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.9),
[SMTP API](https://nodemailer.com/smtp).

The tagged Vitest guide supports the existing `projects`, `extends: true`
and `maxWorkers` configuration. The repository does not configure removed
pool options, advanced runners or a browser provider. Existing constructor
arrow mocks and cleanup assumptions may nevertheless fail in individual
tests; they must be repaired by their owners without weakening assertions.
[Official tagged Vitest 4.1.11 migration guide](https://github.com/vitest-dev/vitest/blob/v4.1.11/docs/guide/migration.md).

The six remaining advisory IDs after step 1 are
[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) for
Vitest/mocker and the five mail advisories
[GHSA-6vj9-mwq6-2f5v](https://github.com/advisories/GHSA-6vj9-mwq6-2f5v),
[GHSA-8vvx-rff5-p5rq](https://github.com/advisories/GHSA-8vvx-rff5-p5rq),
[GHSA-g57g-f23g-4646](https://github.com/advisories/GHSA-g57g-f23g-4646),
[GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j), and
[GHSA-prgh-xp8r-p3m5](https://github.com/advisories/GHSA-prgh-xp8r-p3m5).
Upstream's minimum current-major candidates covering them are Nodemailer
10.0.9 and Vitest/mocker 4.1.11. Root authorized these major candidates after
the review and bounded plan, with complete compatibility proof still required.

Step 2 pins Nodemailer 10.0.9 and Vitest 4.1.11 (including matching mocker).
The first ordinary metadata update, then a `--prefer-dedupe` retry, both hit
an npm 10.9.9 Arborist null `edgesOut` failure while expanding optional peers
through a newer Vite/devtool/browser graph. Root approved the scoped
`vitest.vite: "$vite"` override to retain the existing compatible Vite 7.3.6.
The ordinary lock-only update then succeeded. No peer checking, optional
package inclusion or dependency validation was suppressed, and npm/Node were
not switched. This override keeps the review within the existing Vite major.

The eight new real-package checks passed with Vitest 4.1.11, one worker and
a 512 MB heap (one file, 8 passed, 0 failed, 0 skipped). They verified all
three brace locations, both Undici 8 resolutions while preserving E2B's
Undici 7, Next's PostCSS processing/source map, Nodemailer's ESM/CommonJS
exports and SMTP URL parsing, and buffered MIME/envelope output. No SMTP or
HTTP network connection was opened. These results complement rather than
replace the required application caller and production build checks.

The actual `npm ls --all --json` completed with exit 0. Vitest/mocker are
4.1.11 and Vitest resolves Vite 7.3.6, inside its published
`^6.0.0 || ^7.0.0 || ^8.0.0` peer range. The unchanged Node/DOM project
configuration loaded for the targeted Node run and subsequent focused/full
Node/DOM runs. Comparing the new JSON report with the frozen Vitest 3.2.7
Temporal report found identical top-level and suite keys. The observed
passing assertions add `tags: []`; names, status and count fields are
preserved. This observed shape comparison does not replace executing the
real report-gate fixtures or examining failing/skipped reports. Owned test
ESLint and diff whitespace checks pass. The lockfile integrity checker passes:
920 registry packages carry SHA-512 integrity; six additional packages are
bundled in parent tarballs. Those lock counts cover more than this platform's
783 audited installed packages and are not Linux installation evidence.

Root subsequently advanced the candidate onto independently verified baseline
`4a6bab7` and found three TypeScript errors during broader verification
(exit 2). Vitest 4's generic `ReturnType<typeof vi.fn>` includes constructable
mocks, so two assignments to native dialog methods and one asynchronous
activity invocation no longer type-check. With the two test paths explicitly
authorized, the repair uses `Mock<HTMLDialogElement["showModal"]>` and
`Mock<HTMLDialogElement["close"]>` in the landing waitlist suite, and a
callable `Mock<(...args: unknown[]) => Promise<unknown>>` activity map in the
destroy workflow suite. Only type imports and annotations change: assertions,
constructor semantics and timing remain intact, with no `any` casts added.
The focused Node/DOM run passes all 17 tests (dialog 6, destroy 11; 2 files,
0 failed, 0 skipped), with one worker and a 512 MB heap. Owned ESLint and
whitespace checks pass. Root's post-repair full type check passes (exit 0);
the original failed type-check log is retained and hashed in the JSON.
Earlier audit/install/report hashes and raw logs are preserved.

Root completed independent verification against HEAD
`4a6bab7597ea3710875e19383d3a224409e902e4` plus the reviewed seven-file
dirty patch, with every candidate file matching the frozen hashes and lock
`edd1349503c4dd7ef0510223e17f7e9de03049336cacee2fe0bb2d8b1a882500`.
These are Darwin arm64 results on Node 22.23.3, not Linux results:

- Representative compatibility: 19 files, 502 passed, 0 failed, 0 skipped,
  exit 0 (17.3 seconds). This includes both mail caller suites, constructor
  mocks, Node/DOM rendering, existing JSON gates, the security checker and
  five real OpenTofu ephemeral network tests.
- Full TypeScript verification, owned ESLint, diff check, Go formatting,
  Go vet and Go tests: all exit 0.
- Full serial Node/DOM suite: 794 files, 16,062 passed, 0 failed and 194
  skipped, exit 0 (914.4 seconds). The 194 skipped scenarios remain
  unexecuted; this result does not clear their gated contracts.
- Canonical real workflow lane: 40 files, 861 passed, 0 failed, 0 skipped,
  all 37 required groups passed, exit 0 (295.08 seconds). The receipt binds
  source and lock hashes and records the observed successful process exit.
  External Temporal mTLS remains explicitly unverified and a release blocker.
- Next 15.5.24 production build with scoped PostCSS 8.5.23: exit 0
  (179.94 seconds), providing the required CSS/build integration proof.
  The build retains nonfatal `module.createRequire` parsing and experimental
  SQLite warnings; it is not presented as a warning-free build.
- Mandatory security audit: exit 0, zero known findings, no exceptions
  (1.28 seconds).

The companion JSON retains each step's lock/audit hashes, changed resolutions
and verification status. Raw audit responses remain in private logs outside the repository.
Results from macOS or Linux-configured lock metadata are not Linux execution
proof. The companion JSON hashes root's representative results, original
failed type check, passing checks, complete-suite reports, workflow receipt,
production build and mandatory audit. The audit clearance concerns known
registry findings at this lock and date. Buffered mail and mocked caller
tests do not prove real SMTP/TLS. Actual Linux install/build and external
Temporal mTLS acceptance remain separate required proof; no exceptions are
granted.
