# Coherent unit fixtures, 2026-10-04

The trusted psql-error fixture supplied only the platform verifier prerequisite.
The canonical migration script now checks both agent and platform verifier files
before connecting or running DDL, so the fixture stopped before its modeled psql
failure. Add the missing agent verifier file in that disposable scratch directory.
Keep the missing-prerequisite refusal, failure phase, marker and credential/SQL
suppression assertions unchanged. Neither verifier nor migration script changes.

Document the four existing external OAuth environment settings from
`src/lib/agent-access/control/oauth.ts`, including the required issuer/JWKS pair,
exact issuer, supported client claim and bounded subject claim. Current browser
consent and signed-token scope/expiry checks remain authority; documentation does
not claim external OAuth or browser acceptance.

This packet is source only. Root verification must run the affected schema-verifier
and operator-docs suites, then retain the original failed whole-unit report until a
coherent successor passes. No tests, compiler, services or provider calls were run
by the author, and no production authentication or database authority changed.
