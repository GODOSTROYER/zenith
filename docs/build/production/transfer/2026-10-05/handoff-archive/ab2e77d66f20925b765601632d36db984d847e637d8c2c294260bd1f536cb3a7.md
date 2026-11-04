# Kubernetes onboarding native gates, 2026-10-04

The canonical platform PostgreSQL lane now requires every reviewed human
Kubernetes linking scenario. A passing pending-connection model cannot substitute
for the actual native capture, membership, row-lock and verification controls.

The committed contract is exactly 21 expanded cases in
`tests/controlplane/kubernetes-connection-link.test.ts`, under
`human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]`.
The lane sets `ZENITH_TEST_KUBERNETES_CONNECTION_LINK_REQUIRED=1`; the source's
required admission refuses missing PostgreSQL or a platform schema older than 13
before its hooks. The canonical lane uses current schema 14. Canonical
`public.members` comes from migration 0001, and the fixture uses three distinct
opened PostgreSQL connections plus a tenant-encrypted FILE vault. Hosted
association, human request selection and namespace API responses are explicit
models. Production FILE, custom and separate-store activation stays refused.

The new named table preserves the cases after source deletion. The source also
contributes one genuine discovered suite. The successor therefore requires
1,012 unique identities: the unchanged 990 predecessor, 21 named cases and that
one discovered suite. Historical cohort assertions remove only the exact 22 new
IDs; the production manifest and report validator require the complete successor.
The separate PostgreSQL lane still requires 80 identities, and packaged workers
still require all 22 native checks.

Report fixtures pin the exact source and expanded names, then reject each missing,
failed, skipped, pending, malformed, foreign-file, PGlite or substituted case.
They also reject suite-only, zero, duplicate and reduced evidence. Deleting trusted
source removes its discovered suite but leaves all 21 named requirements intact.
The checker, backend matcher, command exit and execution binding are unchanged.

`connections.captureVerification` is individually classified as a scoped
capability constructor: it reads the exact tenant connection and current native
editor/admin member through a genuine opened owner, then returns a private,
one-use capture. `connections.recordCapturedVerification` is a workspace-bound
write: it requires the same private capture and owner, the original raw tuple,
and fresh native membership after the connection-row wait. Mandatory native
cases cover owning success, foreign/revoked scope, copied/wrong-owner/reused
captures, configuration and microsecond drift, and current member demotion,
removal and workspace changes. A structural PGlite handle supplies no native
capture authority, and neither function receives a blanket exemption.

The reviewed CI dependency creates and verifies the canonical agent roles before
platform migration 14 applies its conditional narrow grants. Its existing order
assertion is retained byte for byte. Migration 14, emitted migration 0016, the
canonical initializer, grants and native repository guards are outside this
registration change.

The separate reviewed MIX fixture correction changes serialized JSON parameters
to the locked driver's canonical text-to-JSONB cast. This packet only updates the
existing native-37 source pin to the accepted fixture bytes. Its 37 case identities
and production custody/history/schema guards remain unchanged.

The reviewed native verification precision correction preserves the captured raw
timestamp text until PostgreSQL casts it. This registration pins its strengthened
native fixture source while retaining the same 21 names. Private capture, owner,
scope, membership, row-lock and original-tuple predicates remain unchanged by
that transport correction. The original native-21 run with 19 passes and two
failures remains a failed receipt, with no success inferred here.

This is an authored source registration, with no author imports, compiler, lint,
tests, services, database or Docker execution, installation or commits. It does
not establish native onboarding acceptance, hosted topology, browser authority,
live Kubernetes access, durable multi-process idempotency or end-to-end worker
success. The earlier platform run with 18 MIX failures remains a failed receipt;
its source identities are used only to pin the predecessor. The parent owns
independent source review and actual native-21/model-50 checks, followed by the
complete canonical lanes.

Parent verification commands, unrun by this author:

```sh
npx vitest run tests/ci/gate-manifest.test.ts tests/ci/platform-coverage.test.ts --maxWorkers=1
ZENITH_TEST_KUBERNETES_CONNECTION_LINK_REQUIRED=1 npx vitest run tests/controlplane/kubernetes-connection-link.test.ts --maxWorkers=1
node scripts/ci/run-gate.mjs platform-postgres --run
node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution
```

These commands require the existing authorized physical PostgreSQL fixture,
canonical platform and agent initialization, exact lane environment and pinned
tools. Independent review and parent runtime evidence remain required.
