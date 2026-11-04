# WS-EPHEMERAL integration handoff

Branch: `ws/ephemeral`; HEAD remains `ec3176f`. All changes are uncommitted.
The supplied checkout was clean at the wave-6 base, with no prior WS-EPHEMERAL
implementation commit or remaining checklist beyond the task's two items.

## Implemented

- `src/lib/drivers/types.ts`: additive C5 `ephemeral` field with the pinned shape.
- `src/lib/tofu/workspace.ts`: deterministic ephemeral JSON blocks; duplicate
  detection; provider, ownership, label, body, forbidden-block and HCL checks;
  revalidation of queued workspaces against exact provider pins. Ephemeral
  addresses do not enter the state-backed `addressMap`.
- `src/lib/providers/azure/drivers/data/mysql.ts` and `mysql-bootstrap.ts`:
  fresh private MySQL with generated credentials. Existing Key Vault compilation
  creates a dedicated database-owned, protected vault. `ephemeral.random_password`
  seeds `azurerm_key_vault_secret.value_wo` with a stable version marker.
  `ephemeral.azurerm_key_vault_secret` reads the persisted version into MySQL's
  `administrator_password_wo`. The server's write-only version marker is a
  deterministic 48-bit hash of the public secret version. This avoids a mismatch
  when retrying a partial apply or replacing a server; collisions are possible
  with probability about 1 in 2^48. Restore/Replica paths remain password-free.
  Referenced/external nodes emit no resources. Inline credentials are refused.
- `src/lib/providers/oci/drivers/data/mysql.ts`: documents why CREATE stays
  disabled. The real checked-in oracle/oci 9.7.1 schema has `admin_password`,
  without write-only or provider-side Vault password references.
- New tests: `tests/tofu/ephemeral.test.ts`, `ephemeral-network.test.ts`,
  `tests/providers/azure/mysql.test.ts`, `tests/providers/oci/mysql.test.ts`.

The bootstrap vault is part of the MySQL node's fragment, not an environment
secret node: existing environment secret sync therefore cannot overwrite the
generated value. It exports only the existing vault/secret URI locals. This
does not copy the ephemeral password into Zenith's sealed vault; doing so would
require an execution/resolver contract outside these owned paths.

## Verification actually run

| Exact command | Result |
| --- | --- |
| `npx vitest run --maxWorkers=1 tests/tofu/ephemeral.test.ts tests/tofu/ephemeral-network.test.ts tests/providers/azure/mysql.test.ts tests/providers/oci/mysql.test.ts` | 67 passed, 0 failed, 8 skipped; 3 files passed, 1 skipped. |
| `npx eslint src/lib/tofu/workspace.ts src/lib/drivers/types.ts src/lib/providers/azure/drivers/data/mysql.ts src/lib/providers/azure/drivers/data/mysql-bootstrap.ts src/lib/providers/oci/drivers/data/mysql.ts tests/tofu/ephemeral.test.ts tests/tofu/ephemeral-network.test.ts tests/providers/azure/mysql.test.ts tests/providers/oci/mysql.test.ts` | Exit 0; 0 errors, 0 warnings. |
| `npx vitest run --maxWorkers=1 tests/tofu tests/providers/azure tests/providers/oci` | 1,375 passed, 4 failed, 48 skipped; 42 files passed, 2 failed, 5 skipped. |
| `npx tsc --noEmit` | Exit 1; 1 error in unowned `src/lib/platform/credentials.ts:161`. Run once. |
| `$env:ZENITH_TEST_TOFU_NETWORK='1'; npx vitest run --maxWorkers=1 tests/tofu/ephemeral-network.test.ts tests/providers/azure/mysql.test.ts tests/providers/oci/mysql.test.ts` | 23 passed, 0 failed, 8 skipped; 2 files passed, 1 skipped. All 8 real-tofu checks skipped because tofu cannot launch. |
| `git diff --check` | Exit 0; 0 whitespace errors (run twice before this note and once afterward). |
| `tofu version` | Failed to launch the installed WinGet `tofu.exe`: no application associated with the file. No version/schema/cloud proof obtained. |
| `taskkill /?` | Exit 0; confirms the Windows utility exists. |

Process-termination diagnostic (one controlled child, explicit environment):

```powershell
node -e 'const {spawn}=require("node:child_process"); const root=process.env.SystemRoot||"C:\\Windows"; const env={SystemRoot:root,PATH:root+"\\System32"}; const child=spawn(process.execPath,["-e","setTimeout(()=>{},3000)"],{env,stdio:"ignore",windowsHide:true}); const started=Date.now(); setTimeout(()=>{const killer=spawn(root+"\\System32\\taskkill.exe",["/pid",String(child.pid),"/T","/F"],{env,windowsHide:true}); killer.stdout.on("data",b=>process.stdout.write(b)); killer.stderr.on("data",b=>process.stdout.write(b)); killer.on("error",e=>process.stdout.write("taskkill spawn code: "+e.code+"\n")); killer.on("close",code=>process.stdout.write("taskkill exit: "+code+"\n"));},100); child.on("close",code=>process.stdout.write("controlled child duration ms: "+(Date.now()-started)+", exit: "+code+"\n"));'
```

Node exited 0; taskkill reported `ERROR: Access denied` and exited 1. The child
ended by its own timer after 3,088 ms. This explains the three 20-second timeout
failures at `tests/tofu/process.test.ts:98`, `:106`, `:118`. The process runner
and these tests were not changed; rerun them outside the restricted sandbox.

## Required outside-scope integration work

1. `tests/providers/azure/more-compile.test.ts:201-204`: replace the obsolete
   blanket CREATE-refusal assertion with a positive Default bootstrap contract
   after removing `sourceServerId`/`restoreTime` from its restore fixture. Keep
   the Replica/HA refusal and successful non-HA Replica assertions. The new
   owned `mysql.test.ts` already exercises Default, restore, replica and invalid
   inputs. No test was weakened or edited outside ownership.
2. `src/lib/platform/credentials.ts:161`: TS2345 because `req.purpose` is
   `CredentialPurpose` (includes `secret.write`) while the local helper at
   line 100 accepts only `observe | deploy`. After the AWS dispatch and before
   line 150, explicitly reject non-AWS purposes outside `observe | deploy`
   using the existing `deny("purpose_capability_mismatch", ...)`, so the call
   is narrowed without a cast. Align broader secret-write support separately
   if that is intended by the owning workstream. This file was not edited.
3. OCI CREATE needs a provider version/schema with a write-only MySQL password
   sink or provider-side Vault reference, plus an appropriate pinned lockfile.
   No invented `admin_password_wo` was shipped, and provider pins were unchanged.
   Gated OCI tests demonstrate rejection of both an invented write-only sink
   and an ephemeral value passed to the existing state-backed argument.
4. Run the gated suites with a working OpenTofu 1.12.5 binary. Azure positive
   schema validation, OCI negative controls and random ephemeral plan/apply
   checks have not executed here. No live cloud provisioning was attempted.

## Provider references checked

- [AzureRM 5.7.0 MySQL write-only schema](https://github.com/hashicorp/terraform-provider-azurerm/blob/v5.7.0/internal/services/mysql/mysql_flexible_server_resource.go)
- [AzureRM 5.7.0 Key Vault write-only schema and read-side value clearing](https://github.com/hashicorp/terraform-provider-azurerm/blob/v5.7.0/internal/services/keyvault/key_vault_secret_resource.go)
- [AzureRM 5.7.0 ephemeral Key Vault secret](https://github.com/hashicorp/terraform-provider-azurerm/blob/v5.7.0/website/docs/ephemeral-resources/key_vault_secret.html.markdown)
- [Random 3.9.1 ephemeral password](https://github.com/hashicorp/terraform-provider-random/blob/v3.9.1/docs/ephemeral-resources/password.md)
- OCI prerequisite is verified against `tests/providers/oci/fixtures/schema-9.7.1.json`.

No dependency changes, `.git` writes, commits, network cloud calls, WSL or
Docker use. Deviation: OCI CREATE remains blocked by its real pinned schema;
Azure uses ephemeral readback after vault persistence to preserve retry safety.
