# WS-FIX-EPHEMERAL-REAL

Branch: `ws/fix-ephemeral-real`; base HEAD: `3030d6aeb66379c0caf926c1038ef5e55780c51a`.
Changes are in the working tree for the orchestrator to review and commit.
The earlier `ephemeral-HANDOFF.md` records the original WS-EPHEMERAL work.

## Cause and correction

The reported failure happens after a successful real plan/apply, when the test
reads raw `.tfstate` and expects `terraform_data.input` and `output` to be plain
strings. Those dynamic attributes use cty's type/value encoding in raw state:
`{ "type": "string", "value": "checked" }`. Correct that expectation rather
than changing the ephemeral renderer or feeding an ephemeral value into a
state-backed attribute. The resource input stays the public literal `checked`.

This explanation follows the documentation and pinned cty encoding below; this
sandbox did not reproduce the failure or verify the correction with real tofu.
There is no production-code or fixed-contract change.

## Regression proof in the gated suite

- Keep the schema validation and both refusals: sensitive non-ephemeral output
  and ordinary `terraform_data.input` cannot persist an ephemeral password.
- A test-only single-character alphabet forces the real random 3.9.1 provider
  to generate a known 32-character canary. This is provider generation, without
  mocks or passing the complete canary as a configuration literal. It is not a
  production password policy; the general schema test retains its class minima.
- Keep the successful length-dependent precondition, digest-verified apply,
  resource-type/name leakage checks, and empty re-plan assertion.
- Check the canary's absence from raw `show -json` at initial/reverified/re-plan
  inspection, normalized plans, `planView`, the actual production `planEvidence`
  projection, apply output/results, outputs and raw state. No ledger write or
  end-to-end execution-worker evidence persistence is claimed.
- Add a deliberately false length precondition (31 rather than 32), requiring
  a real plan exit 1 with the precondition diagnostic and public error message.
  Check that its returned diagnostic/result does not disclose the canary.

## Sources read

- [OpenTofu 1.12 custom conditions](https://opentofu.org/docs/v1.12/language/expressions/custom-conditions/#ephemeral-values-usage):
  ephemeral values may flow into `condition`, not `error_message`.
- [OpenTofu 1.12 ephemeral resources](https://opentofu.org/docs/v1.12/language/ephemerality/ephemeral-resources/):
  opened values are temporary and only accepted in supported contexts.
- [OpenTofu 1.12 write-only attributes](https://opentofu.org/docs/v1.12/language/ephemerality/write-only-attributes/):
  ordinary managed-resource attributes cannot accept ephemeral values;
  write-only attributes appear as null in plan/state.
- [OpenTofu 1.12 terraform_data](https://opentofu.org/docs/v1.12/language/resources/tf-data/):
  input is persisted and reflected in output, which retains the input's type.
- [OpenTofu v1.12.5 go.mod](https://github.com/opentofu/opentofu/blob/v1.12.5/go.mod):
  pins `github.com/zclconf/go-cty v1.18.0`.
- [cty v1.18.0 marshalDynamic](https://github.com/zclconf/go-cty/blob/v1.18.0/cty/json/marshal.go#L173-L188):
  dynamically typed values are serialized with `value` and `type` fields.
- [Random 3.9.1 ephemeral password schema](https://github.com/hashicorp/terraform-provider-random/blob/v3.9.1/docs/ephemeral-resources/password.md):
  `override_special` with `special = true`, the disabled other character classes,
  and `min_special = length` support the deterministic test canary.
- [OpenTofu v1.12.5 changelog](https://github.com/opentofu/opentofu/blob/v1.12.5/CHANGELOG.md):
  no condition-flow or state-encoding change is listed for 1.12.5.

## Integration

Run outside this sandbox with working OpenTofu 1.12.5 and provider-registry
access (no cloud account needed):

```powershell
$env:ZENITH_TEST_TOFU_NETWORK='1'
npx vitest run --maxWorkers=1 tests/tofu/ephemeral-network.test.ts
```

All five checks must execute; a skipped suite is not real verification. The
default suite remains gated behind `ZENITH_TEST_TOFU_NETWORK=1` and a launchable
tofu binary. No provider pins, dependencies, renderer decisions, or ownership
boundaries were changed. No `.git` writes, WSL, Docker, or cloud provisioning.

## Verification actually run here

| Command | Result |
| --- | --- |
| `npx vitest run --maxWorkers=1 tests/tofu/ephemeral.test.ts tests/tofu/ephemeral-network.test.ts` (before edits) | 44 passed, 0 failed, 4 skipped; 1 file passed, 1 skipped. |
| Same command (after edits) | 44 passed, 0 failed, 5 skipped; 1 file passed, 1 skipped. |
| `$env:ZENITH_TEST_TOFU_NETWORK='1'; npx vitest run --maxWorkers=1 tests/tofu/ephemeral-network.test.ts` | 0 passed, 0 failed, 5 skipped; 1 file skipped. Not real-tofu proof. |
| `npx eslint src/lib/tofu tests/tofu` | Exit 0; 0 errors, 0 warnings. |
| `npx tsc --noEmit --incremental false` | Exit 0; 0 errors, whole repository. Run once; incremental caching disabled to avoid writing outside owned paths. |
| `git diff --check` | Exit 0; 0 whitespace errors. |
| `tofu version` (two attempts) | Both failed to launch the installed WinGet `tofu.exe`: no application associated with the file. No binary version was observed. |

Vitest was limited to the owned ephemeral suites, with one worker, per the
shared-machine override. The broader `tests/tofu` suite was not run here.
