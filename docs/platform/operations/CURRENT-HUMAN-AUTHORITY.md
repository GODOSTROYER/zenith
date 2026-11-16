# Current human authority at the default broker

Written against branch `ws/prod-default-current-membership-20261003`, based on default current-membership authority input at `dc40ee9ad590640c78659796c9b932436ea1e426` (2026-10-03). This source-input pin does not establish runtime acceptance of the additive changes or live-provider behavior. Exact integrated verification remains separate.

`platformBroker()` caches its broker and resolver objects, but its default role
port now uses the shared `currentProductRoleResolver`. Each requester check,
approval check, and execution check of a retained human approval reads current
membership for the exact human and workspace. A previously hydrated product
snapshot supplies no hosted human authority through this default port.

In hosted product mode the resolver selects `id,workspace_id,role` from
`members`, filters both IDs, and verifies the returned IDs and supported role.
Each resolution has an independent eight-second deadline. Missing membership
returns no role; failed, malformed, foreign, or late reads refuse with a fixed
sanitized error. Hosted reads do not fall back to local or empty-workspace admin
rules. Existing explicit file-mode demo rules remain in the shared helper.

Integration credentials retain the existing live credential lookup, scopes,
project/environment targets, and canonical role ceiling. Current human
membership can reduce that ceiling; it cannot restore a refused credential or
increase its authority. System principals remain nonmembers governed by the
existing canonical policy and approval checks.

An exact enabled `ZENITH_PLATFORM_BROKER_MEMORY=1` in `NODE_ENV=production`
refuses with sanitized `platform_store_unavailable` guidance before accessing
overrides, registrations, cached brokers, or default store configuration. Remove
the memory flag and configure a durable platform ledger. The flag query remains
truthful; production never silently ignores it or chooses another store. Explicit
memory remains available in development and test.

With that production guard satisfied, the store-selection order, signing,
policy bundle, scopes, history, explicit registered ports, and test overrides
are unchanged. A deliberately registered
role port still takes precedence; an operator must verify its authority contract
before admitting it to a production process. This change does not make such a
port current automatically.

## Prepared verification

`tests/capabilities/default-current-membership.test.ts` prepares 21 cases that
use the actual owning PostgreSQL broker store, committed OPA bundle, and Ed25519
grant signing and verification. The cached broker is constructed without a
registered role port. Product PostgREST member responses, credential metadata,
product scopes, and browser identities are explicit models. The cases cover
unchanged owning membership, cached requester and consumed-approver demotion or
deletion, missing hosted/local membership, failed or foreign reads, integration
attenuation, and canonical system restrictions. An eight-second deadline case
uses the real helper timer with a modeled client that ignores cancellation and
completes successfully after refusal.

Set `ZENITH_TEST_PLATFORM_PG_URL` to a disposable, explicitly owned PostgreSQL
database and `ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED=1` to require this
lane. There is no PGlite substitute. Without the URL the group is skipped; a
required invocation fails before tests. Fixture cleanup is confined to the fresh
test workspace's operation, decision, approval, grant, event, and idempotency
rows. No provider work is started. These cases are prepared, not executed in
this source revision.

The existing `tests/capabilities/platform.test.ts` wiring controls additionally
prepare production memory refusals with a fresh default, registered SQL adapter,
cached SQL broker, and test override. They observe that the wiring object and
store configuration/opening/policy ports are not accessed, and retain explicit
development/test memory positives. The registered SQL fixture uses PGlite for
this bounded admission control; it supplies no production PostgreSQL durability
or hosted identity proof. These controls are also unrun in this source revision.

## Integration and acceptance still required

The shared helper is an unchanged integration dependency:
`src/lib/capabilities/current-product-roles.ts`, SHA-256
`e5923345950b4edd06a444d42131616b8b5bff987cdb4b2eb1c8534ebeff386c`.
Root integration must add the required PostgreSQL group to the canonical gate
manifest and run compilation, affected capability tests, and full canonical
verification. Existing registered-port/store-selection tests remain acceptance
controls. Runtime results must record exact source, passed/failed/skipped counts,
and the required database lane; a skipped or modeled identity case cannot close
hosted identity acceptance.

Live Supabase/PostgREST demotion, deletion, transport failure, cancellation, and
TLS behavior remain separate proof. This source change does not make a remote
product membership read atomic with platform policy, operation claims, or a
provider call. Later mutation boundaries still need their own current authority
and SQL fences. UI/API/MCP caller identity and scope freshness, explicit
registered-role admission, explicit production PGlite admission, and broader
dispatch/outbox atomicity are outside these four owned paths.
The related PROD-DUR-04, PROD-UX-01, and PROD-LIFE-01 criteria remain open.
