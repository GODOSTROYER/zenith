# PROD-LIFE-05: L2 live acceptance successor

This is an additive harness packet; existing implementation/contract evidence remains in the combined requirement docs. No live acceptance was run, no requirement was verified, and no test expectation was weakened.

Files: `scripts/acceptance/live/{azure,gcp,oci,dns}/**`, `deploy/live-sandbox/{azure,gcp,oci}/**`, [cloud campaign](../LIVE-ACCEPTANCE-CLOUDS.md). Acceptance maps to **oci-runner-replacement, oci-lost-response, oci-deletion, oci-mysql-refusal**; the campaign table lists every subclause and required independent readback. Contract tests are `scripts/acceptance/live/dns/offline.test.ts`; the real gated successor is `clouds.live.test.ts`.

Mac offline command (Node 22, no services/cloud):
```bash
npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/offline.test.ts --no-file-parallelism --maxWorkers=2
npx eslint scripts/acceptance/live
npx tsx scripts/acceptance/live/oci/run.ts --plan --packet scripts/acceptance/live/oci/packet.json.example
```
Expected: zero failed/skipped offline cases and zero credential reads/network calls in plan.

Mac real command, **only after owner approval**: start the canonical operated Wave 5 API/worker/runner fixture through its release harness. Its exact startup/packet-emitter join is absent on this base and must be supplied by that owner before running; do not invent a replacement startup. Provision only owned disposable targets and apply the existing real browser approvals. Put its non-secret packet, owner-approved permissions, short-lived provider credential FILE references and API token FILE outside the clean frozen checkout, as specified in the campaign.

```bash
export ZENITH_LIVE_OCI=1
export ZENITH_LIVE_OCI_CREDENTIAL_FILE="$HOME/.zenith-live/oci-credential-ref.json"
export ZENITH_LIVE_API_TOKEN_FILE="$HOME/.zenith-live/api-token"
npx tsx scripts/acceptance/live/oci/run.ts --packet "$HOME/.zenith-live/PROD-LIFE-05-packet.json" --permissions "$HOME/.zenith-live/PROD-LIFE-05-permissions.json" --out "$HOME/.zenith-live/PROD-LIFE-05-evidence.json"
# Recovery reuses the same immutable packet and needs fresh reviewed authority if it expired:
npx tsx scripts/acceptance/live/oci/run.ts --cleanup --packet "$HOME/.zenith-live/PROD-LIFE-05-packet.json" --permissions "$HOME/.zenith-live/PROD-LIFE-05-permissions.json" --out "$HOME/.zenith-live/PROD-LIFE-05-cleanup-evidence.json"
```
Expected: each clause's selected checks passed_live, consumed human destructive approvals for exact scoped environments, independently empty complete paginated inventories. Run the other provider entry points for clauses spanning clouds. Sovereign, faults, ACME renewal, traffic/data and private connectivity must each be actually operated; no status-only or mocked substitutes.

Lean Mac profile: one fixture/provider at a time; one worker; two small replicas at most; 8 GiB host/4 GiB Docker; stop only owned resources and keep private packets for recovery.

Remaining: Wave 5 fixture emission/startup and `zenith_live_run` tagging joins, AWS partition receipt for mixed scenarios, provider initialization/IAM admission, owner-created live accounts and live verification. No new migrations/tables/store functions. Assembler registers the custom vitest config in the gate manifest and attaches sanitized artifacts to the ledger at one coherent commit. Suggested status: `implementation_complete_verification_pending` for this harness slice; overall acceptance stays pending.

