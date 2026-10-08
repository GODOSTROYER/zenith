# Azure, GCP, OCI and DNS live acceptance

Build packet for L2-LIVE-CLOUDS. No cloud, DNS, ACME, browser or paid action was executed on this PC. Offline tests model responses; they are contract evidence only. No requirement or release flag is promoted.

## Entry points and authority

`npx tsx scripts/acceptance/live/{azure,gcp,oci}/run.ts` and `npx tsx scripts/acceptance/live/dns/run.ts <provider>` are real entry points. They check Node 22, a clean checkout at the packet's exact commit, provider opt-in and an owner-approved `permissions.json` before opening credential files or making a request. DNS also needs `ZENITH_LIVE_DNS=1`. Missing opt-in exits 3 (NOT RUN); invalid configuration exits 2; failed/incomplete evidence exits 1. Exit 0 means the selected checks and scoped cleanup passed, never that an entire requirement is verified.

The owner supplies a permissions file matching `zenith.live-cloud-permissions.v1`. The example is deliberately unapproved and expired. It binds the parsed packet SHA256, cost/duration ceiling, expiry, exact HTTPS origins/path prefixes, DNS suffixes, retained bootstrap resource IDs and teardown targets. Changing any packet field invalidates approval. Every request and page rechecks permission. No inline token, ambient credential, privileged fallback, shell command or approval API is accepted.

Compose integration also requires the existing root scope approval, supplied through `ZENITH_LIVE_SCOPE_FILE` as a separate approved root manifest. Its strict schema and approval digest stay unchanged. The `non-aws-dns-live` observer grant must permit the selected provider read, control-plane read and owned teardown; the real destroy path still proves ownership and consumes human approval. Root per-run/per-provider/total budgets and lifetime ceilings apply alongside the exact L2 packet envelope, and root expiry is rechecked for subsequent calls. In particular the shipped OCI budget is zero and every shipped root approval is absent; a person must approve an appropriate envelope before any live campaign.

`--plan --packet <file>` opens only that non-secret packet. It prints scenario coverage, provisional estimate, dependencies and reverse cleanup order, with zero credential reads/network calls. Estimates must include managed DB/cluster minimum billing, egress, latency/residency constraints and orphan contingency; they are supplied by the Wave 5 cost/release packet emitter, not live price discovery. Budget alerts are notifications, not a hard spending cap.

## Operated fixture seam (Wave 5 join, explicit)

This base lacks the Wave 5 release/MAN fixtures. The harness does not reimplement their provisioning, authority, approval, fault injection or managed service code. The small join is `Packet` in `scripts/acceptance/live/dns/contracts.ts`: the release fixture producer emits one provider-scoped packet containing environment IDs in producer-before-consumer order, immutable operation/plan IDs, independent read URLs and exact JSON-pointer assertions. The person still approves fixture execution and destroy in the real browser. Until this packet is emitted from the operated fixture, the live scenarios cannot close acceptance.

Examples contain REPLACE fields and intentionally wrong commit/run IDs. They are plans, not executable proof. Replace every check's assertions with the full clause mapping below; asserting only a status is insufficient. Operations must return a bound terminal ID and environment; mixed plan reads reuse `verifyMixedEvidence`. New fault/materialization scenarios need separate operation receipts and independent readbacks; one happy-path receipt cannot cover failure scenarios.

| Requirement | Mandatory operated scenarios / independent readback |
|---|---|
| LIFE-04 | `azure-source-binding`: immutable source context digest and account/container provenance; `azure-data-plane`: exact scoped roles plus Blob/Key Vault read; `azure-source-build`: ACR run succeeded and image digest read independently; `azure-sovereign`: a separate sovereign-account packet proves its configured authority/ARM hosts. Public Azure does not satisfy sovereign acceptance. |
| LIFE-05 | `oci-runner-replacement`: kill/restart an owned runner inheriting the durable journal, same receipt/request/resource identity; `oci-lost-response`: lost launch stays uncertain, no second launch; `oci-deletion`: absent resource and complete family listing, work request only corroborates; `oci-mysql-refusal`: exact unsafe-secret-sink refusal. Fault injection belongs to the Wave 5/runner fixture, not this observer. |
| LIFE-06 | Per GCP/Azure/OCI: `dns-owned` reads exact record/endpoint tags, value, ownership marker and reviewed proof digest; `dns-foreign` and `dns-unreadable` require explicit ownership refusal (not cancellation/timeout) with no approvable destroy operation. Finally wait for exact human-approved destroy and independent empty record inventory. Foreign records remain unchanged. |
| MIX-01 | `mixed-authorities`: at least two provider/account/region/backend/connection identities independently observed. |
| MIX-02 | `mixed-immutable-plans`: parent approval and immutable child-set/subplan/semantics digests, dependency order, stable addresses, durable receipts, resume. |
| MIX-03 | `mixed-output-scope`: producer provenance, typed output/secret references, changed effect requires new review unless exact preauthorization. Never put secret values in the packet. |
| MIX-04 | `mixed-failure-order`: separate cycle, partial success, timeout, expiry, cancellation, outage, drift, migration and reverse-teardown observations; no automatic destructive compensation. |
| MIX-05 | `mixed-connectivity`: actual protected/private routes, CIDR overlap refusal, DNS/TLS/identity/secret binding, independent firewall/private endpoint readback. Database public exposure is never silently accepted. |
| MIX-06 | `mixed-traffic`: protected fixture endpoint returns the supplied fresh nonce after a DB write/read through actual GCP compute, Azure PostgreSQL and AWS functions, with independent provider/DB readbacks. The AWS job supplies its partition evidence; a renamed local/mock tier is insufficient. |
| MIX-07 | `mixed-recovery-economics`: fixture injects one-provider outage and recovery, independently probes traffic before/after; read measured transfer/latency/residency and catalog economics. |
| MAN-01 | `managed-substrate`: default composition/session opener, owned source build and release, actual managed cluster/provider state and traffic; no injected mock ports. |
| MAN-02 | `managed-serving`: each registry/gateway/DNS/TLS/secret/storage/DB integration has a real readback. |
| MAN-03 | `domain-proof-renewal`: DNS TXT proof plus a renewed certificate on a trusted TLS socket, exact hostname, validity and changed issuer/serial/expiry readback from the operated ACME renewal; `managed-data-catalog`: tenant storage separation, DB export/restore nonce, autoscaling and promised catalog services. |
| REL-01/02/04 | Evidence, budgets, scope, cleanup and checkpoint support only. Complete release journey/dossier/signoff remains the release job's scope. OPS and MAN-04..07 remain with their owners. |

## Credentials and bootstrap

Keep every file outside the checkout, mode 0600, and never upload it as evidence. `ZENITH_LIVE_API_TOKEN_FILE` contains the control-plane integration token. `ZENITH_LIVE_<PROVIDER>_CREDENTIAL_FILE` names a JSON file:

- Azure: `{provider:"azure", account:<subscription>, region:<region>, tokenFiles:{<exact HTTPS origin>:<token FILE path>}}`. Obtain audience-specific short-lived Entra tokens through the approved GitHub environment federation. ARM, Blob, Vault and ACR tokens have separate audiences. Blob XML readback exposes HTTP status/content hash only.
- GCP: `{provider:"gcp", account:<project ID>, region:<region>, accessTokenFile:<short-lived impersonated token FILE>}`.
- OCI: `{provider:"oci", account:<compartment OCID>, region:<region>, securityTokenFile:<short-lived RPST FILE>, privateKeyFile:<ephemeral PoP private-key FILE>}`. Requests use standard OCI RSA-SHA256 signatures. No user API key is accepted.

All three credential references may additionally specify `trafficTokenFiles:{<approved exact HTTPS origin>:<application bearer token FILE>}` for protected fixture traffic. Cloud and control-plane credentials are never reused for application endpoints. Private-network-only endpoints may omit it.

`deploy/live-sandbox/<provider>/main.tf` creates scoped observer trust/roles and 50% actual/80% forecast monthly budget alerts. Observer credentials have no deploy/destroy/IAM management authority; provisioning stays with the existing reviewed Zenith connection and browser policy. All application resources need `zenith_live_run=<run ID>` in Azure tags, GCP labels and OCI freeform tags, alongside existing Zenith workspace/environment ownership metadata. Label/tag creation is a fixture-emitter join; this job does not add tag adoption to production callers.

Azure federation pins the exact repository/protected environment subject. GCP additionally pins numeric owner/repository IDs and ref. OCI uses an IdentityPropagationTrust template with five exact claim validations; the owner must configure the non-admin exchange client or an approved instance-principal caller. Token exchange itself still requires caller authentication; this is not an anonymous GitHub-to-OCI exchange. No admin client fallback. OCI policy condition names and service permissions require actual provider/tenancy admission before use; do not infer it from HCL syntax.

Primary references: [Microsoft federation trust](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust), [Google pipeline federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [OCI JWT-to-RPST trust and authenticated exchange](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/token_exchange_grant_type_workload_id-federation.htm).

## Inventory, teardown and evidence

Supply complete service-specific inventories of every created family. Azure RG resource lists omit registry images and some child DNS records, so add those inventories. GCP assets can be eventual and do not replace complete Compute/DNS/Storage/Artifact Registry lists. OCI lists each created family within the exact compartment, including DNS record sets and Object Storage objects. GCP zonal Compute `items` may be absent for an empty list: set `emptyListKind: "compute#instanceList"` only for that documented API; an unrecognized object is never interpreted as zero resources. Typed-empty descriptors use `/items` for Compute/Storage, `/rrsets` for Cloud DNS record sets, and `/managedZones` for Cloud DNS zones. Confirm the DNS response-kind literals against the real Mac readback before acceptance. GCP inventory URLs must omit response masks, grouping and partial-success flags; unreachable resources refuse completion. Storage object lists may use `emptyListKind: "storage#objects"`; the runner rejects nonempty grouped prefixes, so use a flat, unfiltered listing of all owned versions. See [Google Storage objects list](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list). Each inventory specifies items/id/tags JSON pointers and provider pagination. Retained bootstrap IDs must be individually reviewed. DNS record sets and registry images without their own tags use `parentOwnership`: independently read the parent's run tag and require the child ID prefix or exact DNS target values to match its current owned endpoint. DNS A/CNAME records need the value binding, not merely a zone name. Raw unbound children refuse cleanup. The real control-plane destroy path still performs its own ownership/proof/approval checks.

Cleanup runs in `finally`, reverse environment order. It requests the existing read-only teardown review, waits for a person and requires consumed approval plus the bound destroy result. Failed consumer cleanup stops destructive producer cleanup. All configured inventories are scanned regardless; pagination, duplicates, unreadable/foreign resources and permission expiry fail closed. Leak scans retry 12 times (5 seconds apart). Credentials revoked, SIGKILL, permission expiry, absent human approval or unavailable services can prevent physical cleanup; there is no false guarantee. The owner must retain the same packet and run `--cleanup` after restoring authority. SIGINT/SIGTERM requests bounded cleanup. No raw provider errors, tokens, bodies or credential paths enter evidence.

Evidence has ledger-compatible `level`, `commit`, `environment`, `result` plus selected requirement/check IDs, parsed packet digest and cleanup counts. Keep the private packet alongside the evidence locally. Artifact path is attached by the verifier when adding a ledger record. Never write `verified`, count NOT RUN as passed, or use selected probes as whole-requirement proof.

## Exact Mac campaign

Node 22; macOS ARM64, 8 GiB RAM, Docker 4 GiB. Run one provider/fixture at a time, one worker, two tiny application replicas at most, bounded 1-hour exercise plus cleanup authority. Use the operated Wave 5 default API/worker/runner installation; its owner supplies the canonical startup command after integration. No Docker/Temporal/kind/browser/cloud startup is performed by this runner. That unresolved startup/packet join is recorded, not substituted with mocks.

Offline checks (no cloud prerequisites):

```bash
node --version # 22.x
npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/offline.test.ts --no-file-parallelism --maxWorkers=2
npx eslint scripts/acceptance/live
for p in azure gcp oci; do
  npx tsx "scripts/acceptance/live/$p/run.ts" --plan --packet "scripts/acceptance/live/$p/packet.json.example"
done
```

Expected: offline tests pass with zero skips; all plans report zero credential reads/network calls. The denied permission example cannot start a live run.

Provider validation (Mac, no apply, no credentials; downloading pinned provider packages is separate from cloud acceptance):

```bash
for p in azure gcp oci; do
  tofu -chdir="deploy/live-sandbox/$p" init -backend=false
  tofu -chdir="deploy/live-sandbox/$p" validate
done
tofu fmt -check -recursive deploy/live-sandbox
```

Expected: all modules validate with initialized providers. Retain failure diagnostics; HCL validation does not prove live IAM syntax, permission propagation or budget delivery. Owner bootstrap/apply is a separate approved action, never implied by these commands.

Only after accountable live approval and operated fixtures exist, freeze the clean integrated commit. Store packet, token references, permissions and new evidence paths outside the checkout. Set the environment names in the credential section; use one provider at a time:

```bash
export ZENITH_LIVE_AZURE=1 # or ZENITH_LIVE_GCP=1 / ZENITH_LIVE_OCI=1
export ZENITH_LIVE_API_TOKEN_FILE="$HOME/.zenith-live/api-token"
export ZENITH_LIVE_SCOPE_FILE="$HOME/.zenith-live/approved-root-scope.json"
export ZENITH_LIVE_AZURE_CREDENTIAL_FILE="$HOME/.zenith-live/azure-credential-ref.json"
npx tsx scripts/acceptance/live/azure/run.ts --packet "$HOME/.zenith-live/azure-packet.json" --permissions "$HOME/.zenith-live/permissions.json" --out "$HOME/.zenith-live/azure-evidence.json"
# Same flags and provider-specific credential FILE variable for gcp/run.ts and oci/run.ts.
export ZENITH_LIVE_DNS=1
npx tsx scripts/acceptance/live/dns/run.ts azure --packet "$HOME/.zenith-live/dns-azure-packet.json" --permissions "$HOME/.zenith-live/dns-permissions.json" --out "$HOME/.zenith-live/dns-azure-evidence.json"
# Resumable cleanup, exact original packet, reviewed renewed permission and new output:
npx tsx scripts/acceptance/live/azure/run.ts --cleanup --packet "$HOME/.zenith-live/azure-packet.json" --permissions "$HOME/.zenith-live/permissions.json" --out "$HOME/.zenith-live/azure-cleanup-evidence.json"
```

Expected: selected complete checks report passed_live, all human-approved teardown operations succeed, and every independently queried inventory is empty except individually retained bootstrap IDs. Missing probes, sovereign prerequisite, Wave 5 join, consent or read authority means incomplete/failed, never verified.

The gated Vitest successor is optional orchestration of those same entry points:

```bash
export ZENITH_LIVE_AZURE_PACKET_FILE="$HOME/.zenith-live/azure-packet.json"
export ZENITH_LIVE_PERMISSIONS_FILE="$HOME/.zenith-live/permissions.json"
export ZENITH_LIVE_AZURE_EVIDENCE_FILE="$HOME/.zenith-live/azure-vitest-evidence.json"
npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/clouds.live.test.ts --no-file-parallelism --maxWorkers=2 -t "live azure"
```

For GCP/OCI replace the three AZURE variables and test filter. DNS uses `ZENITH_LIVE_DNS_PROVIDER`, `ZENITH_LIVE_DNS_PACKET_FILE`, `ZENITH_LIVE_DNS_EVIDENCE_FILE` and filter `live DNS/ACME`. Unselected or ungated tests are explicitly skipped, not passed; inspect counts separately from the standalone receipt.

## Integration and remaining work

The assembler joins the Wave 5 packet emitter, existing permissions envelope and run-tag insertion, registers this custom offline config/gated file in gate manifest, and adds artifact records on the final coherent commit. Existing provider/core/installer/migrations/dependencies/workflows are untouched. No new table or tenancy/inventory classification is needed. Ledger rows touched retain evidence/history and receive implementation_complete_verification_pending with a harness-slice note; no whole-requirement completion is claimed.
