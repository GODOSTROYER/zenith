# WS-FIX-OCI-MYSQL-REAL — OCI MySQL write-only password vs the real oracle/oci 9.7.1 schema

Workstream: WS-FIX-OCI-MYSQL-REAL (orchestrator brief) — Branch ws/fix-oci-mysql-real — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-fix-oci-mysql-real
Base: ws/integrate-w6 (WS-EPHEMERAL merged: OCI MySQL create with an ephemeral admin password)

## Failure (orchestrator ran it outside the sandbox with real tofu 1.12.5 + oracle/oci 9.7.1)
tests/providers/oci (mysql): "OCI MySQL real pinned tofu validate negative controls (network) > refuses an
ephemeral password in admin_password_wo" fails with `expected false to be true` — real `tofu validate`
ACCEPTS what the negative control expected it to refuse. Your sandbox cannot run tofu, so this was never
run against the real provider.

## Do
Establish from the pinned provider schema (tests/providers/oci/fixtures/schema-9.7.1.json and the oracle/oci
9.7.1 docs) whether `oci_mysql_mysql_db_system` supports a write-only admin password and how ephemeral
values may be passed. Then make the driver correct for the real schema (src/lib/providers/oci/drivers/data/mysql*),
and make the negative control test something tofu genuinely rejects (or replace it with a positive real
validate plus a static check that no plaintext password reaches state/plan views). Keep the safety rule:
the admin password is never stored in state, plan views or evidence.

## Owned paths
src/lib/providers/oci/drivers/data/mysql*, tests/providers/oci/*mysql*.

## Verification
- npx vitest run --maxWorkers=2 tests/providers/oci ; npx tsc --noEmit ; npx eslint src/lib/providers/oci tests/providers/oci
