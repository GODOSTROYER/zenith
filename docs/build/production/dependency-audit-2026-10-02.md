**Dependency audit — 2026-10-02, baseline `37be734`**

PROD-CI-06 runtime admission is repaired. PROD-CI-07 vulnerability clearance
remains **BLOCKED**: the current lock reports **eight vulnerable package
entries, four moderate and four high, covering 24 distinct GHSA IDs**. There
are no approved exceptions. Package manifests, lockfiles, Dockerfiles and CI
workflows have not changed in this workstream. The structured companion
[report](dependency-audit-2026-10-02.json) records the lock/report hashes,
affected nodes, ranges, dependency edges, upstream patch versions and
verification limits. Raw npm responses and upstream advisory records stay in
private local logs outside the repository.

The supported policy is `>=22.22.2 <23`, matching the existing package/lock
engines; validation used Node 22.23.3 and npm 10.9.9 on macOS arm64. Setup,
doctor, hosted admission and recipe Node metadata now share the strict stable
version parser in `src/lib/node-runtime.ts`. It rejects 22.22.1, Node 20,
Node 23+, partial versions and suffixes. Setup retains its reporting/seeding
behavior; doctor retains its nonzero exit for blocking problems. Hosted local
demo admission retains its existing behavior, while hosted mode rejects
unsupported versions. This patch does not add a global boot admission rule.

Source contract version 1, recipe id `vite-react-v1`, package pins, accepted
source format and serialized job schema stay unchanged. The recipe's Node
field now advertises the actual supported range; existing provenance is not
rewritten or newly certified. Actual runner/container versions require the
root workstream's separate verification.

The package entries and their scope are:

| Entry | Locked and installed versions | Production/build/dev reachability |
| --- | --- | --- |
| `nodemailer` | 9.1.1 | Production alert and hosted invitation mail paths load the SMTP transport. |
| `undici` | 8.10.1; alias `undici8` 8.10.0 | Kubernetes HTTP client, DOM tests and E2B build SDK. E2B prefers the alias on Node ≥22.19.0. |
| `e2b` | 2.46.1 | Production hosted build SDK; inherits Undici findings. |
| `postcss` | Next's nested 8.4.31 | Platform Next CSS/build processing; also installed as a production dependency. |
| `next` | 15.5.24 | Inherits the nested PostCSS findings. |
| `brace-expansion` | 1.1.18; two instances of 5.0.9 | Lint/parser dependency chains and production `e2b → glob → minimatch` tooling. |
| `vitest` | 3.2.7 | Dev/test verification tool; mocking middleware can activate the vulnerable route. |
| `@vitest/mocker` | 3.2.7 | Vitest's dev/test dependency. |

These reachability classifications are inferences from committed call sites,
installed SDK code and locked dependency edges, not successful exploit proofs.
For example, WebSocket/interceptor/Pool features have distinct prerequisites;
finding the HTTP package in the graph does not prove every feature is exposed.
Next's nested PostCSS is also distinct from the Vite recipe's parser instance.
No uncertain exploitation condition is treated as clearance.

The advisory inventory below uses the affected ranges returned by npm for
these installed versions. Patch versions were checked against the official
GitHub advisory API on 2026-10-02; the JSON report also records each advisory's
upstream publication/update dates. Separate branch patches exist for some
packages; only the relevant current-major targets appear here.

| Advisory | Package | Affected range in this report | Relevant first patch |
| --- | --- | --- | --- |
| [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | Vitest / mocker | `>=2.1.0 <4.1.11` | 4.1.11 |
| [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | brace-expansion | `<1.1.21`; `>=4.0.0 <5.0.12` | 1.1.21 / 5.0.12 |
| [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | brace-expansion | `<1.1.20`; `>=4.0.0 <5.0.11` | 1.1.20 / 5.0.11 |
| [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | brace-expansion | `<1.1.19`; `>=4.0.0 <5.0.10` | 1.1.19 / 5.0.10 |
| [GHSA-6vj9-mwq6-2f5v](https://github.com/advisories/GHSA-6vj9-mwq6-2f5v) | nodemailer | `>=5.0.0 <10.0.2` | 10.0.2 |
| [GHSA-8vvx-rff5-p5rq](https://github.com/advisories/GHSA-8vvx-rff5-p5rq) | nodemailer | `<10.0.2` | 10.0.2 |
| [GHSA-g57g-f23g-4646](https://github.com/advisories/GHSA-g57g-f23g-4646) | nodemailer | `>=9.1.0 <10.0.9` | 10.0.9 |
| [GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j) | nodemailer | `<=10.0.5` | 10.0.6 |
| [GHSA-prgh-xp8r-p3m5](https://github.com/advisories/GHSA-prgh-xp8r-p3m5) | nodemailer | `>=9.1.0 <=10.0.4` | 10.0.5 |
| [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | postcss | `<8.5.10` | 8.5.10 |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | postcss | `<=8.5.11` | 8.5.12 |
| [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | postcss | `<=8.5.22` | 8.5.23 |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | postcss | `<=8.5.17` | 8.5.18 |
| [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) | undici | `>=8.1.0 <8.10.2` | 8.10.2 |
| [GHSA-pmjh-fq2x-6v4x](https://github.com/advisories/GHSA-pmjh-fq2x-6v4x) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |
| [GHSA-r53p-7pc4-xj5r](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |
| [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |
| [GHSA-3xpg-4rpp-hhhm](https://github.com/advisories/GHSA-3xpg-4rpp-hhhm) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |
| [GHSA-2jfj-6hjv-fm6j](https://github.com/advisories/GHSA-2jfj-6hjv-fm6j) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |
| [GHSA-2gqq-gqf2-x968](https://github.com/advisories/GHSA-2gqq-gqf2-x968) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |
| [GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |
| [GHSA-8436-99hf-9mmv](https://github.com/advisories/GHSA-8436-99hf-9mmv) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |
| [GHSA-vp8m-p9jh-q5pm](https://github.com/advisories/GHSA-vp8m-p9jh-q5pm) | undici | `>=8.10.0 <8.10.2` | 8.10.2 |
| [GHSA-rx4f-c7p8-82vq](https://github.com/advisories/GHSA-rx4f-c7p8-82vq) | undici | `>=8.0.0 <8.10.2` | 8.10.2 |

Historical installation logs report macOS eight entries (792 packages audited)
and Linux seven (800 packages audited). Those are aggregate installation
reports, not retained per-advisory JSON. Native optional dependencies explain
why installation package counts can differ, but do not establish which
moderate vulnerability entry was absent. None of the currently affected nodes
has an OS/CPU constraint. The refreshed same-lock audit with explicit
`--os=linux --cpu=x64`, all dependency categories included, also yields eight
entries and the same advisory IDs. This is a configuration comparison on
macOS, not a real Linux run. The exact historical discrepancy remains
unresolved; a clean Linux runner must retain complete audit JSON, npm version,
lock hash and include/omit flags to identify it. npm's default audit loads the
virtual lock tree; npm documents that omit flags change the packages submitted
for audit. [npm audit documentation](https://docs.npmjs.com/cli/v10/commands/npm-audit/).

The new mandatory gate, `node scripts/ci/security-audit.mjs`, performs a fresh
locked audit with dev, optional and peer dependencies included. Every finding
blocks, regardless of severity or npm's exit threshold. Registry failures,
missing/invalid locks, spawn errors, timeouts, malformed reports, inconsistent
counts and unresolved advisory identifiers also block. It never prints raw
registry errors. It accepts no exceptions: any future exception mechanism
must name the exact advisory/package/range, document reachability and
compensating controls, identify an independent reviewer and authorization,
carry a UTC expiry, and reject expired or overbroad records. None is granted
here. The actual current-lock gate exits 1 with all eight entries. CI wiring
is a root followup; existing informational installation audit output is not
vulnerability clearance.

Proposed remediation remains reviewable work, not an applied fix:

- Refresh brace-expansion to 1.1.21 and 5.0.12 within the existing parent
  ranges; this covers all three expansion advisories.
- Refresh root Undici to 8.10.2 and review a scoped E2B alias override to
  `npm:undici@8.10.2`. E2B's optional alias is exact, so a root refresh alone
  does not fix it. E2B 2.52.0 advertises the fixed alias but changes other
  dependencies; an SDK upgrade needs separate review.
- Review a Next-scoped PostCSS 8.5.23 override. It changes Next's exact child
  pin despite staying within PostCSS major 8; require production CSS/build
  compatibility proof. Avoid automatically accepting the audit's Next 16
  major recommendation.
- Review Nodemailer 10.0.9, the minimum release covering all five current
  mail advisories; major-version SMTP/types compatibility must pass first.
- Review Vitest 4.1.11 and its matching mocker. Upstream lists no fixed 3.x
  release; a major migration requires configuration, Node/DOM/full-suite and
  report/replay evidence. Independently swapping mocker across majors is not
  a justified remedy.

All candidate versions were checked in official npm metadata. Scoped override
behavior is documented by
[npm](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/#overrides).
No `audit fix --force`, blind lock refresh or operator authorization is used.

Owned verification runs only the four admission/source/audit suites, with one
worker and no services. The final count is recorded in the companion JSON and
private test report. Required followups are independent security review,
root verification, explicitly reviewed dependency remediation, actual Linux
audit retention and mandatory CI integration. Full typecheck, production build
and complete verification belong to the root workstream.
