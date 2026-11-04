# WS-OCI-MORE — the OCI drivers that are still unsupported

Workstream: WS-OCI-MORE (new; orchestrator brief) — Branch ws/oci-more — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-oci-more
Base: platform/integration (WS-DRIVER-FIX merged: unsupported OCI types no longer carry a throwing
compile stub; capability matrix --strict has 0 problems — keep it that way)

## Situation
`oci:oke_cluster` (kubernetes_cluster), `oci:mysql_db_system` (mysql) and `oci:compute_instance`
(compute_instance) are registered as unsupported. Read src/lib/providers/oci/** first: the transport
port (`OciApiTransport`, runner-only `oci.http`), `ociCompileContext` (compartment/tenancy), NSG
ownership (`<label>_nsg`, `local.<label>_nsg_id`), freeform tags with `_` keys, vault conventions
(`zenith-vault`, `zenith-secrets-key`, VAULT_SECRET admin passwords), prevent_destroy unless
deletionPolicy allows, observe honesty (404 alone is never `missing`), the allowlist data
(src/lib/providers/oci/allowlist.ts — the Go runner enforces the same list via a golden fixture in
go/internal/oci/testdata; regenerate it with scripts/generate-oci-allowlist.ts if you add read paths).

## Objective (same conventions, `contract` evidence)
1. `oci:mysql_db_system` — private, admin password from Vault (VAULT_SECRET, never plaintext), HA
   (high availability flag) and backup mapping, own NSG, deletion protection.
2. `oci:compute_instance` — no public IP, NSG, encrypted boot volume, instance principal capable,
   cloud-init via metadata only from the spec (never secrets), OS Management agent plugin enabled for
   the machine plane; runtime reads instance state.
3. `oci:oke_cluster` — private endpoint (or restricted), VCN-native pod networking, enhanced cluster
   with workload identity, node pool in private subnets with the node NSG; publishes endpoint/CA/OIDC
   as locals for a Kubernetes session.
Add the read paths these drivers need to OCI_ALLOWLIST (minimal, per capability) and regenerate the Go
golden; keep `secret.write` disabled.

## Owned paths
src/lib/providers/oci/** ; tests/providers/oci/** ; deploy/oci/** (policy statements for the new
resource families, least privilege) ; go/internal/oci/testdata/allowlist.json (regenerated only) ;
docs/platform/CAPABILITY-MATRIX.md (regenerate with `npx tsx scripts/docs/capability-matrix.ts`).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/providers/oci tests/providers/oci
- npx vitest run --maxWorkers=2 tests/providers/oci tests/runners/oci tests/docs/capability-matrix.test.ts
- npx tsx scripts/docs/capability-matrix.ts --strict (0 problems)
- (in go/) go test ./internal/oci/... (Windows Go at C:\Users\user\.local\sdk\go\bin\go.exe with
  GOTOOLCHAIN=local; say if it cannot run)
