# J8 COST-02: placement usage contract

Base: `3a9de905`. Status: `implementation_complete_verification_pending`. Acceptance: "Include egress/NAT/IPv4/IO/requests/backups; reject infeasible budgets/residency/availability; estimates never represented as hard billing caps."

The existing cost model, extended-dimension refusal, solver feasibility and disclosures remain intact. MCP now admits `interAzGb`, `storageIoMillions` and `crossRegionBackupCopyGb` under `constraints.usage`; every field is finite, nonnegative and optional. Unknown fields remain refused. The placement schema is deliberately version 2. Golden placement digest: `sha256:05139168b57e9e2c3b1d294cdd8df1df278cff54f15f64b526ef88effddf8531`; catalog digest: `sha256:867079703e9075c65511e5436cf714f9f970925be30f3d980fa3db5c07051804`.

`tests/cost/mcp-placement-usage.test.ts` covers preservation, explicit zero and invalid/unknown usage. Existing placement and MCP transport tests prove authorization, strictness, estimate wording, budget/residency/availability refusal and no mutation. The MCP golden and three assertions in `tests/agent-v3/placement{,-transport}.test.ts` were updated from version 1 to version 2 because the handoff explicitly requires this contract change. The handler contract pin also uses the new exact schema digest. No assertion was deleted or relaxed.

`tests/cost/aws-published-vector.test.ts` pins the independent [AWS-owned get-vanilla header signature](https://raw.githubusercontent.com/awslabs/aws-c-auth/main/tests/aws-signing-test-suite/v4/get-vanilla/header-signature.txt), using [AWS's vector context](https://raw.githubusercontent.com/awslabs/aws-c-auth/main/tests/aws-signing-test-suite/v4/get-vanilla/context.json). Fake example credentials are assembled at runtime. The signer now orders repeated query values, applies RFC3986 escaping to query keys/values and excludes an old Authorization header when signing again. This is a published-vector contract check, not live Cost Explorer verification or a claim that the entire AWS signing suite has been executed.

## Mac commands

```sh
export PATH="$HOME/.local/sdk/node22:$PATH"
npx vitest run tests/placement tests/cost tests/agent-v3/catalog.test.ts tests/agent-v3/placement.test.ts tests/agent-v3/placement-transport.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: zero failures. Real billing, PostgreSQL and actual collector cases remain explicitly gated, and skipped cases are not passes. For the real PostgreSQL cost/store cases, start the lean service and set `ZENITH_TEST_PLATFORM_PG_URL` using the commands in `COST-03.md`, then run `tests/cost/actual-spend-store.test.ts tests/cost/optimizer-settings.test.ts` with the same worker limits.

No cloud call, browser acceptance, deployment, migration or dependency edit was performed. No hard billing cap is introduced. The initial connection-read test timed out without assertion changes; the successor result is recorded in `J8-COST-REPORT.md`.
