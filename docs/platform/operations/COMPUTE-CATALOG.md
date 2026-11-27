# Native VM catalog and recommendations

Written against branch `prepan`, based on implementation snapshot `eae645831e3cce46e1a11f2daf18995a00b2904d` (2026-11-27).

This is the first `prepan` implementation of native AWS, GCP, and Azure machine
discovery. It imports timestamped provider evidence, preserves native instance
names, and compares Linux shared-tenancy On-Demand base VM prices against CPU,
memory, architecture, budget, and measured-latency requirements.

The implementation has offline contract and integration tests. A real
authenticated provider collection and deployment acceptance run have not been
performed. No current prices or synthetic fixtures are bundled as a production
catalog. An operator must collect and publish a catalog before the API can answer.

## What this slice provides

| Layer | Implemented behavior | Current boundary |
|---|---|---|
| Collection | Read-only official API collectors; pagination, bounded retries, checksums, credential-free source URLs, staged archives | Explicit operator command; no background refresh schedule |
| Inventory | Native names, provider, region/zone, vCPUs, memory in MiB, architecture, CPU mode, source evidence | Unknown capabilities remain unknown; account inventory is not proof of live capacity |
| Pricing | Timestamped public USD base VM-hour rates; effective dates and exact decimal arithmetic | Linux/shared/On-Demand only; supported meter compositions only |
| Recommendation | Hard constraints before deterministic cost/latency scoring; rejection reasons and coverage | Discovery only; no provisioning, manifest edits, or permission/quota/capacity checks |
| Latency | Trusted observation input to the engine and operator CLI | No production measurement collector or REST observation store yet |
| Integration | Environment-scoped authenticated REST endpoint and operator CLI | Existing graph placement, apply flow, MCP tools, and UI are unchanged |

“4 cores, 16 GB” must become an explicit requirement. This API uses **vCPUs** and
**MiB**: 4 vCPUs and 16 GiB are `minimumVcpus: 4` and
`minimumMemoryMiB: 16384`. Physical cores, vCPUs, CPU generations, and application
throughput are not interchangeable. A larger machine can win if it satisfies the
minimums and has the better score; spare hardware does not earn a bonus.

## Provider inputs and supported joins

| Provider | Inventory and price inputs | Normalization |
|---|---|---|
| AWS | EC2 regional Price List files; optionally `DescribeInstanceTypes` and `DescribeInstanceTypeOfferings` | Native CPU/memory/capabilities plus zonal offering records; exact baseline Linux `RunInstances` price meters |
| GCP | Compute `machineTypes.aggregatedList`; Cloud Billing `services.skus.list` for Compute Engine | Retains native machine inventory; composes predefined E2, N1, N2, N2D, T2D, and T2A CPU and RAM prices |
| Azure | Subscription Resource SKUs; Retail Prices for Virtual Machines | Joins native ARM SKU capabilities/location restrictions to Linux Consumption hourly meters; keeps usable constrained-vCPU counts |

Missing, conflicting, unsupported, tiered, or incorrectly denominated prices are
unpriced, never zero. Future prices cannot win. GCP shared-core, custom, GPU, and
unsupported newer-family compositions remain visible in inventory with no price.
AWS metadata that does not establish CPU mode stays unknown. Default matching
requires sustained CPU, so price files alone generally need inventory enrichment
before producing useful AWS recommendations.

Each offer must cite the right evidence kind: pricing sources establish prices,
and native inventory sources establish hardware. AWS Price List products can
also establish hardware fields. Inventory-only evidence cannot establish a rate.

`offeringState: offered` means the imported inventory reports an offering. It does
not mean a tenant is eligible, has quota, has a compatible image, or can launch
there now. Azure subscription restrictions and GCP obsolete/deleted machine types
are retained as `catalog_only`. Restricted offers can still appear as discovery
options with explicit warnings; they are never asserted to be deployable.

Source scope matters. GCP project inventory and Azure subscription inventory are
collected for the explicit account scope. A server-wide operator catalog can
contain these scope identifiers in source URLs. Publish only catalog metadata
appropriate to share with the deployment's authenticated workspaces. Customer
private prices and account-specific eligibility require a future tenant-scoped
overlay; this catalog does not model them.

## Collect a new snapshot archive

Use the repository's supported Node 22 runtime and installed dependencies:

```sh
npm run compute:catalog -- --help
```

Network collection requires `ZENITH_LIVE_CATALOG_REFRESH=1`. The CLI never enables
that gate itself. `import`, `inspect`, and `recommend` are offline commands.
Each fetch requires either `--regions` or `--all-regions`, plus a new output
directory. Authenticated GCP/Azure fetches require explicit `--regions`; their
output regions must be included in the approved scope. Existing archives are
never replaced.

### Approved read scope

Collection also requires a current, operator-approved scope manifest selected
with `ZENITH_LIVE_SCOPE_FILE`. The repository's committed approval is preserved;
it does not grant the new `compute-catalog` operation. Prepare an operator-owned
copy with a dedicated entry under `harnesses`, granting only the provider reads
needed for the collection:

```json
{
  "compute-catalog": {
    "description": "Read-only native VM catalog collection",
    "providers": ["public", "aws", "gcp", "azure"],
    "actions": ["read"],
    "maxRunUsd": 0
  }
}
```

Public AWS price-only collection uses the `public` grant. AWS inventory uses
`aws`; authenticated GCP and Azure reads use their corresponding grants and
confirmed sandbox identities. The explicit GCP project and Azure subscription
must match the manifest. Inventory/output region checks use its provider region
allowlists. GCP/Azure APIs still return global metadata within the matched
project/subscription; a permitted output region does not imply region-confined
network responses.

Before AWS inventory collection, the operator must ensure the SDK credential
chain selects the intended approved account. This slice checks the scope grant
and inventory regions but does not verify the ambient AWS account with STS.

Review the complete copied manifest, including its identities, regions, grants,
and budgets, then approve that exact copy through the existing interactive CLI:

```sh
export ZENITH_LIVE_SCOPE_FILE=/secure/compute-catalog-scope.json
node --import tsx scripts/release/permissions-cli.ts show
node --import tsx scripts/release/permissions-cli.ts approve --by "Your name"
```

Keep `ZENITH_LIVE_SCOPE_FILE` set for the fetch commands below. Both the CLI and
collector check the scope before provider I/O; the CLI checks it before opening
token files. A missing grant, mismatched identity/region, stale digest, or expired
approval refuses collection. Offline import, inspection, and recommendation do
not need this approval. No live scope was approved or exercised by the feature's
offline verification.

### AWS

Public Price List downloads do not use AWS credentials. Add `--aws-inventory` to
explicitly use the normal AWS SDK credential chain for inventory reads. The
principal needs `ec2:DescribeInstanceTypes` and
`ec2:DescribeInstanceTypeOfferings` in the requested, enabled regions.

```sh
ZENITH_LIVE_CATALOG_REFRESH=1 npm run compute:catalog -- fetch \
  --provider aws --regions ap-south-1,us-east-1 \
  --aws-inventory --out .data/compute-catalog/raw/aws-2026-11-27
```

`--all-regions` enumerates the current public regional price index instead of a
hardcoded region list. Inventory reads fail the complete collection if the
credential cannot read a requested ordinary region. Do not assume one credential
covers every enabled region, GovCloud, or China partition. Price-index entries
for Local/Wavelength Zone locations stay distinct price-only scopes; they are
not sent to an EC2 regional SDK endpoint or assigned their parent region's price.
If regional offering inventory includes Local, Wavelength, or unrecognized zone
locations, those offerings remain visible but unpriced. Only ordinary AZ names
and IDs can inherit their parent region's price; special zones need their own
authoritative pricing join.

### GCP

Provide an explicit project, an enabled Compute API with permission to list
machine types, and an access token accepted by the Compute and Billing Catalog
APIs. Store the short-lived token in an operator-protected file. Token contents
are sent only in the Authorization header and are not archived or logged.

```sh
ZENITH_LIVE_CATALOG_REFRESH=1 npm run compute:catalog -- fetch \
  --provider gcp --regions asia-south1,us-central1 \
  --gcp-project your-project-id --gcp-token-file /secure/gcp-access-token \
  --out .data/compute-catalog/raw/gcp-2026-11-27
```

The collector follows the global aggregated inventory and billing pagination.
Import restricts the normalized offers and coverage to the requested regions.
Partial or unreachable inventory scopes fail collection and offline import,
including top-level and scoped incomplete-result warnings. Native
`NO_RESULTS_ON_PAGE` empty pages remain valid. This implementation does not
silently accept an incomplete pagination chain.

### Azure

Provide an explicit subscription and an ARM access token with Resource SKUs read
access, including `Microsoft.Compute/skus/read`. The inventory endpoint uses the
token; the public Retail Prices endpoint does not receive it. This collector uses
Azure's public commercial endpoints.

```sh
ZENITH_LIVE_CATALOG_REFRESH=1 npm run compute:catalog -- fetch \
  --provider azure --regions centralindia,eastus \
  --azure-subscription 00000000-0000-0000-0000-000000000000 \
  --azure-token-file /secure/azure-arm-access-token \
  --out .data/compute-catalog/raw/azure-2026-11-27
```

Resource SKUs may return subscription-wide inventory; the Retail Prices request
filters requested regions, and import filters the final inventory to the same
scope. Server-provided continuations must remain on their allowlisted host and
API path. Redirects are not followed.

Source URLs reject credential query parameters, including OAuth refresh/ID and
session-token aliases. Native `NextToken`, `pageToken`, and `$skiptoken` cursors
remain supported. These checks supplement the operator's responsibility to
provide credential-free evidence; they do not establish a snapshot's authenticity.

### Archive properties

An archive contains `manifest.json` and individually checksummed
`snapshot-00000.json` files. Each snapshot keeps its native API response, source
URL, retrieval time, provider kind, and response hash. The manifest separately
hashes the exact stored envelope bytes. This detects archive corruption; hashes
are not provider signatures or proof that a manually supplied snapshot is true.

Collection writes into a private staging directory and publishes it only after
every page succeeds. Failure removes staging files. Files use mode `0600` and
new directories `0700`. These protections supplement the operator's disk and
credential controls. Archive metadata can still identify projects/subscriptions.

## Import, inspect, and publish

Import verifies every archive file and its page chain, normalizes AWS one region
at a time, then validates the merged catalog before atomically writing the
explicit output. A bad import leaves the previous catalog file intact.

```sh
NODE_OPTIONS=--max-old-space-size=6144 npm run compute:catalog -- import \
  --snapshots .data/compute-catalog/raw/aws-2026-11-27 \
  --snapshots .data/compute-catalog/raw/gcp-2026-11-27 \
  --snapshots .data/compute-catalog/raw/azure-2026-11-27 \
  --version 2026-11-27.1 \
  --out .data/compute-catalog/catalog-2026-11-27.1.json

npm run compute:catalog -- inspect \
  --catalog .data/compute-catalog/catalog-2026-11-27.1.json
```

Choose the snapshot by setting the server's `ZENITH_COMPUTE_CATALOG_PATH` to the
absolute catalog filename. Without it, the server reads
`$ZENITH_DATA/compute-catalog/catalog.json`; `ZENITH_DATA` defaults to `.data`.
Subsequent imports can atomically replace that configured file. Keep old versioned
archives/catalogs for comparison and rollback. In replicated deployments the
operator must distribute the selected file to every instance; this slice does
not provide shared object-store publication or a refresh scheduler.

The reader caches a validated snapshot by file identity and modification state.
An atomic replacement is read and validated on the next request; a malformed or
missing replacement fails closed instead of silently serving a prior success.

`--input <file>` also accepts one or more small offline native-response envelopes:

```json
{
  "schemaVersion": 1,
  "snapshots": [
    {
      "kind": "aws_instance_types",
      "region": "ap-south-1",
      "url": "https://ec2.ap-south-1.amazonaws.com/?Action=DescribeInstanceTypes",
      "retrievedAt": "2026-11-27T00:00:00.000Z",
      "data": { "InstanceTypes": [] }
    }
  ]
}
```

This example deliberately contains no hardware or price. Supply complete actual
responses, including every continuation page and required price/inventory join.
Repeated `--input` files are joined together. Duplicate native offers across
separately imported archives are rejected; use one consistent snapshot revision
per scope. Re-importing an old snapshot does not renew its price freshness.

## Request a recommendation

Save the requirement below as `requirements.json`:

```json
{
  "minimumVcpus": 4,
  "minimumMemoryMiB": 16384,
  "allowedArchitectures": ["x86_64"],
  "requireSustainedCpu": true,
  "hoursPerMonth": 730,
  "instanceCount": 1,
  "costWeight": 1,
  "latencyWeight": 0,
  "limit": 10
}
```

```sh
npm run compute:catalog -- recommend \
  --catalog .data/compute-catalog/catalog-2026-11-27.1.json \
  --request requirements.json
```

The same requirements are the JSON body of:

```text
POST /api/platform/v1/environments/<environment-id>/compute-recommendations
```

The REST handler uses existing session/linked-agent authentication, environment
ownership, `placement.solve` authorization, and admission/no-store behavior. A
linked agent needs the existing plan scope. It enforces explicit manifest
provider/region/residency requirements and the tightest applicable budget. Unknown
geography cannot satisfy a residency rule. The reused geography registry is
limited; adding worldwide residency metadata is a separate workstream.

The body cannot supply a catalog, path, connection list, latency evidence, or
apply flag. Scoped authorization runs before body validation, so malformed
requirements cannot reveal the existence of a forbidden environment. The
operator catalog is read only after authorization. Missing or
invalid catalogs return a redacted 503. As with existing placement POSTs, method
gating during read-only maintenance also blocks this endpoint.

The response contains environment/project/workspace IDs, a `policy` summary,
and `result`. The result includes `chosen` (or `null`), alternatives, total
considered/eligible/rejected counts, at most 500 rejection details, a truncation
flag, coverage, source evidence, score components, and cost exclusions.
`hourlyComputeUsd` and `monthlyComputeUsd` are decimal strings for the requested
instance count; the original per-instance rate is `offer.price.hourlyUsd`.

Every candidate is `discoveryOnly: true` and `costScope: compute_only`. A verified
workspace connection changes `requiresConnection`; it does not establish launch
eligibility. The request can restrict providers or provider-qualified regions;
an explicit empty allowlist denies all offers.

## Latency evidence and scoring

Hard filters run before scoring: hardware, architecture/CPU mode, server policy,
price validity/freshness, budget, and any required latency coverage or limit.
Defaults require x86_64, sustained CPU, prices retrieved within 24 hours, and
cost-only ranking. The caller can tighten or configure price freshness up to the
schema's 720-hour maximum; this never guarantees that a provider's published
catalog is instantaneously current.

For every eligible offer, the lower score wins:

```text
costWeight * monthlyComputeUsd / costReferenceUsd
  + latencyWeight * weightedAudienceRttP95Ms / latencyReferenceMs
```

Weights must sum to 1. Default reference values are $150 and 80 ms. References
are fixed across candidates, so adding an unrelated expensive option cannot
change the scale of existing scores. Ties use exact monthly cost, then stable
offer ID. Hardware equivalence and application performance are not inferred from
this preference score.

Positive latency weight or `maxRttP95Ms` requires named, positively weighted
audience groups. Every group must have a fresh, trusted `rtt_p95_ms` observation
for the candidate provider/region, with at least 100 samples. Default freshness
is 60 minutes; future, stale, undersampled, missing, or wrong-metric evidence
cannot satisfy the requirement. A hard RTT limit applies to each group. The
weighted mean of audience p95 values is **not** a global p95 or application SLO.

The engine accepts observations through `ComputeRecommendationContext`. The
operator CLI can load a measured JSON array with `--latency-file`; fields are
`provider`, `region`, `audienceId`, `metric`, `valueMs`, `sampleCount`, `observedAt`,
and `source`. `--now` permits reproducible offline comparisons. These are trusted
operator inputs, not customer request evidence.

The REST endpoint has no measured-latency data source wired yet. A REST request
that requires latency evidence therefore receives no eligible candidates with
explicit missing-latency reasons. Cost-only results keep unknown latency as
`null`; geographical distance is not substituted for measurement.

## Cost and operational limits

The quote is base VM rate × requested hours × requested count. It excludes boot
and data disks, storage operations, backup, IP addresses, NAT, load balancers,
network transfer, extra licenses/support, burst/usage surcharges, billing
minimums and rounding, taxes, credits, negotiated discounts, commitments, and
Spot/preemptible pricing. A compute subtotal below the budget does not prove that
an application deployment fits its budget. The existing graph-cost engine remains
the place for modeled supporting infrastructure; native offers are not yet
translated into its deployment size aliases.

Bounds are explicit: 450 MiB per HTTP response, 480 MiB per stored raw envelope,
512 MiB of raw bytes per in-memory join, 64 MiB per published catalog, 100,000
offers, and 10,000 sources. AWS joins are regional; GCP/Azure join their input
pages together. Expanded JSON objects need substantially more heap than raw
bytes, hence the larger-heap import example. Oversized scopes fail rather than
publishing partial coverage. Very large native regional files and global
GCP/Azure joins need a streaming index importer before claiming universal
catalog coverage. Catalog completeness is always `imported_snapshots`.

The fetch command retries HTTP 429/503 with bounded delay, caps page chains, and
refuses incomplete pagination or foreign continuations. It does not provision
VMs, reserve capacity, create cloud accounts, or register background jobs. No
feature test needs live cloud credentials or enables these gates.

## Next implementation steps

1. Run read-only authenticated collection against representative real accounts;
   record returned scopes, native schema compatibility, price joins, and API limits.
2. Add indexed storage/streaming imports, publication history, coverage checks,
   scheduled refresh, and alerts for stale or shrinking catalogs.
3. Add tenant-scoped eligibility/quota checks and private-price overlays.
4. Wire a measured audience-latency service and benchmark evidence with explicit
   source, sampling method, freshness, and workload compatibility.
5. Expand GCP/custom/GPU and purchase-model composition, then add full deployment
   cost and connect recommendations to the existing reviewed placement/apply flow.
6. Add the comparison UI and explain each candidate's total cost assumptions,
   evidence freshness, and deployability checks before offering provisioning.

## References and verification

Primary API references:

- [AWS bulk price files](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-ppslong.html)
- [EC2 DescribeInstanceTypes](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceTypes.html)
- [EC2 DescribeInstanceTypeOfferings](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceTypeOfferings.html)
- [AWS Local Zone pricing scope](https://docs.aws.amazon.com/local-zones/latest/ug/what-is-aws-local-zones.html)
- [EC2 billing operation/platform fields](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/billing-info-fields.html)
- [GCP machineTypes.aggregatedList](https://cloud.google.com/compute/docs/reference/rest/v1/machineTypes/aggregatedList)
- [GCP services.skus.list](https://cloud.google.com/billing/docs/reference/rest/v1/services.skus/list)
- [Azure Resource SKUs](https://learn.microsoft.com/en-us/rest/api/compute/resource-skus/list)
- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)

Implementation: `src/lib/compute-catalog/`,
`scripts/cost/compute-catalog.ts`, and the environment compute-recommendations
route. Offline tests: `tests/compute-catalog/`.

```sh
npx vitest run tests/compute-catalog tests/placement tests/cost \
  tests/auth/middleware.test.ts tests/adversarial/cross-tenant.test.ts
NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck
```
