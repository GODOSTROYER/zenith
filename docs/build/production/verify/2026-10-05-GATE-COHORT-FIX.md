# 8031 gate cohort verification correction

This packet changes only the two CI contract tests and this handoff. Production gate declarations, validators, required flags, workflow selection and source implementations remain unchanged. The prepared source is 8031ce0 plus independently reviewed SQL5 (freeze 3d5f36c7, review 76fe7088), copied read-only by root.

The earlier unit report retained 18758 passed, 41 failed and 1506 skipped. Twenty-four failures in these two test files comprised historical identity counts that included three successor discovery suites, one stale OAuth fixture hash and missing cleanup network coverage. SQL5 adds a fourth discovered native suite to the prepared candidate. The current canonical manifest requires 1117 unique identities. Historical helpers remove only these four exact IDs; every existing literal predecessor count/hash stays unchanged, including 1113/1059/1012/990/907/906/799 and earlier cohorts. Unknown future suite identities remain visible.

| Successor source | Exact native suite | ID suffix |
| --- | --- | --- |
| tests/controlplane/incident-stability.test.ts | incident stability [postgres] | cf040b5e5c94 |
| tests/controlplane/machine-runbooks.test.ts | machine runbook store [postgres] | 48256d3185de |
| tests/capabilities/field-ownership-broker.test.ts | propose field ownership [postgres] | 25d4762caf8a |
| tests/controlplane/ownership-transfers.test.ts | ownership transfer immutable service-role custody [postgres] | 9a92131565d1 |

New source/report models check exact current and historical identity sets, missing/failed/skipped/PGlite evidence, an unknown successor and source deletion. Generic discovery does not persist after source deletion: the current source-presence assertions detect that removal, while adding explicit literal native scenarios to the production manifest remains a separately owned follow-up. Root must register the three SQL5 native ownership cases and any separately reviewed incident cases without changing the original requirements.

The cleanup source remains in the real platform PostgreSQL lane. Coverage checks all 46 cleanup plus 54 settlement literal cases and its discovered native suite, exact backend, both mandatory flags, actual child environment composition, PostgreSQL/OpenTofu prerequisites, executable filters and source deletion. The 100 literal requirements remain after file deletion and missing reports fail. No TOFU-lane substitution or skip waiver is added.

The OAuth fixture source pin changes from 7cfe2cf85fb454be9508a0e50469e278f0e2b032b2c1b457f36ab38f8366f3f7 to c4d522048dd2174c7bc31d78a85f5db9949f45451238131764d847a721c3ebb4. The new bytes exactly equal the accepted A17R2 frozen postimage (freeze 70e77327; B review 85f82c75). Its 46 names and ordered name hash remain unchanged. The reviewed mutation replaces synthetic delegated-destroy setup with genuine saved original native plans and authenticated paired consumption; captures actual state bytes and verifies native hold/JTI and committed grant/member mutations. Hosted association and policy remain explicitly modeled. The fixture itself is read-only in this packet; this is a source rebind, not a new authority claim.

The original 80 PostgreSQL, 58 workflow, 127 Linux guest identities with three exact optionals, four direct package cases, five signed-helper cases and 22 worker checks remain unchanged. No model report is native runtime evidence.

Author checks: source inventory, exact dependency bytes, all old literal test declarations, source-pin provenance, Git stage/HEAD preservation and private patch forward/reverse only. Compiler, lint, project imports, tests, PostgreSQL, OpenTofu, Docker, services and commits were not run. Independent C review and root execution are required.

Root verification in the coherent candidate:

```sh
node node_modules/vitest/vitest.mjs run --project=node tests/ci/gate-manifest.test.ts tests/ci/platform-coverage.test.ts --maxWorkers=1 --no-file-parallelism
npm run typecheck
```

Then rerun the strict canonical platform gate with its genuine prerequisites and source-bound report; preserve the prior failure report and require every current identity. Root owns serial native execution and integration.
