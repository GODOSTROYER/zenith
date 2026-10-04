# Cost estimates

What Zenith's cost engine produces, what it does not, where its numbers come from
and how to refresh them. Design: [ADR-0013](../../adr/0013-placement-and-cost.md).
Code: `src/lib/placement/`.

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01).
Updated for the bounded 2026-10-05 catalog refresh; historical rates retain their original evidence dates.

**Status.** The price catalog, the cost engine and the placement solver are built as
pure libraries with contract tests. They are exposed by MCP v3, placement REST
and actions, and `/platform/placement`. Worker composition supplies
`defaultCostPort()` and execution persists estimates in `platform.cost_estimates`;
the operation detail page reads the persisted estimate. The
product's cost card (`src/app/(product)/p/[slug]/observe/cost-card.tsx`), the
onboarding preview and the deploy panel all still use the original static table in
`src/lib/cost/pricing.ts`, a static table of service sizes, five resource kinds and
routes that has no NAT, public IPv4, load balancer or egress. Those legacy screens
have not migrated to the new catalog. No estimate is a cloud bill.

## Placement recommendations (`provider: auto`)

Open `/platform/placement`, choose the project and optional environment, then
compare its working manifest. `src/lib/placement/recommend.ts` expands with
`provider: "auto"`, evaluates constraints and uses stored verified connections.
It does not recheck cloud permissions. Budget, residency, latency, availability,
provider preferences and usage constrain the estimate; infeasible or unknown
pricing is reported rather than guessed. A budget filters modeled monthly estimates;
it is not a cloud billing cap or a guarantee that actual charges stay below it.

The same read is available through `placement.recommend`
(`src/lib/actions/defs/placement.ts`), POST
`/api/platform/v1/environments/<id>/placement` and MCP
`zenith_recommend_placement` (requires the integration's `plan` scope).
`includeUnconnected` lists discovery options separately as
`requiresConnection: true`; they never displace a connected recommendation.

Review a candidate before staging `placement.apply` in the browser. It rechecks
the working-manifest hash, deterministic seed and connection eligibility, then
delegates to `project.updateManifest`. It edits desired state and keeps the
environment's existing connection. Multi-region application is refused; the
current V1-only manifest editor can also refuse V2 placement edits. Compare is
wired, but saving every suggested topology is not supported. Costs and latency
are estimates, and no provider change or deployment is performed by this read.

## Estimates, forecasts and actuals

Three different things, and **only the first exists**.

| Kind | Exists? | What it is |
|---|---|---|
| **Estimate** | Yes | A monthly USD figure computed from a resource graph, an assumed usage profile and the bundled list-price catalog. Deterministic: the same inputs give the same number, and `computedAt` is the catalog snapshot time, never the clock. Typed `kind: "estimate"`. |
| **Forecast** | **No** | Nothing projects spend from observed usage or history. "Projected" in the policy input (`projectedMonthlyUsd`) means the *estimated total after the change*, not a forecast. |
| **Actual** | **No** | Nothing reads a bill, a cost report, an invoice, a billing API or a tag-based cost allocation, in any account. There is no code path from a cloud's real charges into Zenith. |

So an estimate is never an invoice and the code is built not to let it be mistaken
for one: `platform.cost_estimates` stores only `kind: "estimate"` documents and
refuses anything else ("this store never records an invoice as a cost"), and every
estimate carries the line "This is an estimate from a static list-price catalog, not
an invoice or a quote". If a screen shows a figure from this engine it must say
"estimate".

## What goes into an estimate

- **Inputs:** the placed graph's **managed** nodes (referenced and external
  resources are not Zenith's bill and are not priced), a usage profile and the
  catalog. A value of the wrong type or an unknown size throws `CostInputError`
  rather than being guessed, and a missing price is an error (`MissingPriceError`),
  never a silent zero: a candidate that cannot be priced cannot be recommended.
  Unpriced managed nodes refuse the whole-graph estimate, including a graph with
  other priced nodes. The default worker cost port returns no estimate rather
  than approving a partial subtotal. Genuine zero-charge infrastructure on a
  cataloged provider and referenced/external ownership remain separate cases.
- **Usage assumptions**, all recorded in the estimate's `assumptions`: 730 billable
  hours a month; internet egress 50 GB; 5 million requests; 10 GB per object store;
  5 GB of log ingestion per compute service; 20 GB per database; 20 % of egress
  flowing between components across a region or provider boundary; 2 availability
  zones and a single NAT gateway by default; backups kept 7 days at a 5 % daily change
  rate; 90 % of object requests are reads. These are **defaults, not measurements**.
  Change them with `UsageAssumptions`.
- **Modelling rules worth knowing:** NAT is needed when a compute node has no public
  IP, and all internet egress of private workloads is assumed to pass through it;
  public IPv4 is counted for load balancers, NAT gateways and public workloads;
  egress uses the **first-tier** per-GB price for every GB; cross-region and
  cross-cloud edges are billed on the sending side; backups are
  `storageGb x (1 + 0.05 x retentionDays)`; MySQL is priced with the provider's
  PostgreSQL SKUs (an approximation, stated in the estimate).
- **Output:** per-line `basis` (the arithmetic), `priceVerification` (how that unit
  price was obtained), the `assumptions`, and `included` and `excluded` lists.
  `diffCost(before, after)` gives the line-level delta and sets `catalogChanged` when
  the two estimates used different catalog versions, because the delta then mixes
  price changes with usage changes.

### What an estimate says it includes and excludes

Exact text from the engine, for a stack of a container service, a database, an
object store and a load balancer on AWS, plus a MySQL database and a referenced node. (A test rebuilds this sample and
fails if the lists below are not what the engine says now.)

Included (each appears only when the estimate has such a line):

```
Compute, database, cache, storage and queue charges at on-demand list prices
NAT gateway hours and data processing
Public IPv4 addresses (load balancers, NAT gateways, public workloads)
Load balancer hours and capacity / processed-data charges
Internet egress
Object storage, queue and DNS request charges
Backup and snapshot storage
Log ingestion
```

Also, when present: "Cross-region and cross-cloud transfer between components",
"Provisioned IOPS", "High-availability standby capacity",
"Supported native secret storage, active versions, API operations and rotation notifications",
"Supported private registry image storage and assumed internet pulls" and
"Supported build compute, source storage and requests, logs and assumed internet egress".

Excluded:

```
Taxes (VAT/GST), currency conversion and payment fees
Discounts: savings plans, committed use, reserved instances, spot, enterprise agreements and credits
Provider free tiers and free monthly allowances are not deducted (conservative), except where the list price itself is zero
Volume-tier egress discounts: the first-tier per-GB price is applied to every GB
Data transfer between availability zones inside one region
Registry and build features outside the supported native profiles (enhanced scanning, replication, signing, external tools and services)
Monitoring metrics, alarms, traces and dashboards; compute log storage (supported build log storage is modeled)
Custom secret key management, automatic rotation execution and secret profiles outside the supported native drivers
WAF, DDoS protection, CDN and API gateway charges
Support plans and marketplace fees
This is an estimate from a static list-price catalog, not an invoice or a quote
1 referenced or external node(s) are not Zenith's bill and are not priced
MySQL is priced with the provider's PostgreSQL SKUs (approximation)
```

Managed functions, static sites, Kubernetes clusters and namespaces and
provider-native (Level 3) resources have no model and refuse the estimate.
Secret, registry and build nodes are priced only for the exact supported native
profiles below; a bare node or an unknown store, provider, configuration or meter
still refuses the whole estimate. A managed node on a provider without a
catalog (including Kubernetes, sandbox and LocalStack) also refuses. Referenced
and external nodes remain outside this estimate; their actual cost is unknown to
Zenith, rather than asserted to be free in their owner's account.

## Supported secret and Git-build profiles

Managed `zenith_vault` secrets with `purpose: environment` and a vault reference
are priced as the current native AWS Secrets Manager, GCP Secret Manager or
Azure Standard Key Vault driver. A provider reference has separate ownership;
it is not a free managed secret. No secret value is read or included in a cost.

- AWS: one secret-month plus API operations; the native AWS-managed
  `aws/secretsmanager` key adds no encryption charge and the driver configures no
  automatic rotation. Custom keys, rotation execution and private endpoints
  refuse this profile. Regional rates come from the
  [official Secrets Manager feeds](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSSecretsManager/current/index.json).
  [AWS describes the managed key and rotation charges](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html).
- GCP: enabled **and disabled** retained versions per native replica location,
  access operations and scheduled rotation notifications. The current driver
  creates one user-managed replica. The
  [official pricing page](https://cloud.google.com/secret-manager/pricing)
  supplies global list rates but publishes no effective date; retrieval is
  recorded separately. Free monthly allowances are not deducted.
- Azure: Standard vault secret operations only, using the exact regional
  Standard Operations 10K meter from the
  [official Retail Prices API](https://prices.azure.com/api/retail/prices).
  Its effective date is 2015-08-01, not the 2026-10-05 retrieval date. HSM,
  custom-key and certificate profiles are outside this model.
- OCI vault secrets may use an existing software or HSM key; this graph does
  not prove its billing type, lifetime or private-vault charge. OCI and Zenith
  managed secrets still refuse the estimate rather than returning a partial
  zero. [Oracle lists the distinct key and vault charges](https://www.oracle.com/cloud/price-list/).

Secret operation usage defaults to **10,000 calls/month per secret**, explicitly
an assumption. GCP defaults to **one retained active version** and **zero rotation
notifications** because the native driver installs no schedule. Supply
`requestsMillions`, and for GCP `activeVersions` and `rotationNotifications`, in
the cost graph to change those assumptions. An explicitly unavailable (`null`),
negative or invalid quantity refuses; omitted usage receives the stated default.
These cost-only fields are not new deployment configuration controls.

AWS Git sources expand into an on-demand Linux `BUILD_GENERAL1_MEDIUM` CodeBuild
project and private ECR repository. The estimate includes rounded minutes per
build, average source-bucket storage, GET/PUT requests, log ingestion and retained
compressed logs, image storage and assumed charged internet transfer. The native
source bucket expires bundles after 14 days; build logs retain 30 days and ECR
keeps 30 images. Retention is not a byte quantity or a billing cap.

Defaults per pipeline are four builds/month at ten minutes/build, 1 GB-month of
source bundles, one GET and PUT per build, 0.1 GB log ingestion and 0.1 GB-month
compressed logs, and 1 GB charged internet egress. Each repository assumes
1 GB-month of retained images and 1 GB charged internet pulls. These are
planning quantities, not measured use. Multipart requests, retries, retained
versions and build output size can increase the bill; supply the explicit
cost-graph quantities when known. Every required meter must exist even when a
quantity is zero. Same-region AWS image pulls may be explicitly set to zero;
unknown pull volume never silently defaults to zero.

Rates are transcribed from the regional
[CodeBuild](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/CodeBuild/current/index.json),
[ECR](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECR/current/index.json)
and [CloudWatch](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/index.json)
feeds. Source storage, request, ingestion and transfer prices retain their original
evidence dates. Native AES256 encryption and basic image scanning add no charge;
[ECR documents transfer and encryption pricing](https://aws.amazon.com/ecr/pricing/)
and [AWS documents free basic scanning](https://aws.amazon.com/about-aws/whats-new/2024/08/new-version-amazon-ecr-basic-scanning/).
Enhanced scanning, replication, signing, arbitrary build tools/services, customer
KMS, VPC builds and non-AWS builds/registries still refuse when specified.
Ambient account features are not discovered; the native-profile assumption does
not prove the actual account is configured that way. Compare the estimate with
current account configuration before relying on it. Nothing caps a bill.

## The price catalog

`src/lib/placement/catalog/2026-10.json`, loaded and validated by
`src/lib/placement/pricebook.ts`. Current version: **`2026-10-05.2`**.
The September artifact remains unchanged for historical interpretation.

- **A static snapshot of list prices.** Nothing fetches anything at run time. Prices
  are USD before taxes, discounts and free tiers. The retained September values
  keep their original evidence classes and dates; the eight refreshed entries
  and 36 added auxiliary entries have explicit 2026-10-05 retrieval notes. Values are **transcribed by hand**,
  rather than fetched at execution time.
- **Versioned.** `version` is `YYYY-MM-DD.N`. Every estimate records the version it
  used (`catalogVersion`), and so does `platform.cost_estimates`, so an old estimate
  stays interpretable after a refresh.
- **Every entry names how its number was obtained** (`verification`) and is covered
  by a `sources[]` record for the same provider and class, carrying the official
  URL, the retrieval date and the statement that the values were transcribed.
  `parseCatalog` refuses a catalog where an entry has no covering source, a source
  lacks the transcription note, a weak-evidence source does not say its numbers
  need refreshing or are assumptions, a SKU does not start with its provider, or a
  ratio is not a `*_multiplier` of at least 1.

### Evidence classes

| Class | Meaning | Counted as weak in an estimate? |
|---|---|---|
| `official_api` | Read from the provider's own public price feed or API | No (strong) |
| `official_page` | Parsed from the provider's official pricing page | No (strong) |
| `third_party_mirror` | Read from a third-party mirror of the official API | No, but **not official either**: treat with care |
| `derived` | Arithmetic on other catalog numbers (documented in the entry's `note`) | **Yes** |
| `model_knowledge` | A remembered list price, **not** read from any feed; refresh before relying on it | **Yes** |
| `internal_assumption` | Zenith managed-tier planning price; not a published rate | **Yes** |

Each estimate totals the part of its modeled subtotal that rests on the three weak classes in
`assumptions.priceEvidenceWeakUsd` (and `priceEvidenceWeakLines`), and the placement
solver warns on a candidate when more than 25 % of its estimate does.

### What the catalog holds today

Counts of entries by provider and class at version `2026-10-05.2` (a test keeps this
table equal to the file):

| Provider | Class | Entries |
|---|---|---|
| aws | official_api | 160 |
| aws | official_page | 4 |
| aws | model_knowledge | 4 |
| azure | official_api | 100 |
| azure | derived | 4 |
| azure | model_knowledge | 48 |
| gcp | official_page | 20 |
| gcp | third_party_mirror | 40 |
| gcp | derived | 36 |
| gcp | model_knowledge | 64 |
| oci | official_api | 33 |
| oci | derived | 39 |
| oci | model_knowledge | 39 |
| zenith | internal_assumption | 120 |

In plain terms: **AWS is the best-evidenced** provider (most entries read from the
AWS Price List Bulk API for four regions; the ElastiCache high-availability node
count remains remembered). GCP is the weakest of the
hyperscalers: its compute, NAT, storage and egress rates come from a **third-party
mirror** of the Billing Catalog (the official API needs a key and was not queried),
Cloud SQL and Memorystore are derived from a remembered us-central1 price scaled by
a regional ratio, and load balancing, DNS and logging are remembered. Azure NAT
gateway, managed disks and DNS are remembered because the Retail Prices filters
returned no NAT rows. **The `zenith` managed tier has no price at all**: its 120
entries are internal planning assumptions, there is no public Zenith price page, and
the source record says they must be replaced before managed-tier estimates are shown
to users. The solver excludes the managed tier unless it is asked for, pinned or
preferred.

Regions with prices: AWS `ap-south-1`, `ap-southeast-1`, `eu-west-1`, `us-east-1`;
Azure `centralindia`, `southeastasia`, `eastus`, `westeurope`; GCP `asia-south1`,
`asia-southeast1`, `europe-west1`, `us-central1`; OCI `ap-mumbai-1`,
`ap-singapore-1`, `us-ashburn-1` (OCI lists the same price in every region); the
managed tier four placeholder regions. A node in any other region throws
`MissingPriceError`.

## Refreshing the catalog

A refresh is a **deliberate, reviewed change**; nothing does it for you and no script
exists. This snapshot refreshes only eight entries:

- Four `aws.acm.public_cert_month` entries were checked against the
  [official ACM pricing page](https://aws.amazon.com/certificate-manager/pricing/)
  on 2026-10-05. The zero rate covers non-exportable certificates used with
  integrated AWS services only. Exportable, ACME and Private CA charges are outside
  that SKU; no effective-start date was published for the no-charge rate.
- Four `azure.public_ip.hour` entries were checked separately in `centralindia`,
  `southeastasia`, `eastus` and `westeurope` using the
  [public Retail Prices API](https://prices.azure.com/api/retail/prices).
  Each exact Consumption meter, `Standard IPv4 Static Public IP`, returned USD
  0.005 per hour on 2026-10-05, with effective-start date 2018-06-01. Basic, Global
  and Public IP Prefix rates are outside this SKU. The new source record retains
  the exact product/SKU/meter selection; retrieval and effective dates are distinct.

All untouched entry objects and September source records remain identical. The
latest catalog timestamp indicates this bounded refresh, not fresh verification
of every price. Azure NAT remains `model_knowledge`: the official pricing page
returned numeric placeholders and the public API filters tried returned no NAT
rows. Missing public data was not converted into a zero or a verified rate.

1. For each `sources[]` record, re-read the feed it names (the AWS Price List Bulk
   API region files, the Azure Retail Prices API filtered by region and service, the
   OCI public price list API, the Cloud Run pricing page), for the SKUs each entry's
   `note` describes.
2. Update `usd` where the feed moved. **Upgrade weak entries** where a feed exists:
   replace `model_knowledge` with `official_api` or `official_page` and say so in
   `verification` and `note`; re-derive every `derived` entry from its new inputs.
3. Add a source record limited to the touched cohort, with its `retrievedAt`, exact
   meters/units and `source` text; preserve untouched records and entry objects. It must keep
   the words "transcribed" (and, for the weak classes, "refreshed", "replaced",
   "derived" or "assumption"), or `parseCatalog` refuses the file.
4. Bump `version` (`YYYY-MM-DD.N`).
5. Run `npx vitest run tests/placement`. The catalog tests check that every entry has
   a source, that nothing is negative or duplicated, that every cost role each
   provider defines is priced in every region, and that the latency table and the
   catalog cover the same regions. They also **pin the version and a set of figures**
   read on 2026-09-30 (`tests/placement/catalog.test.ts`); a refresh that changes
   them must update those pins on purpose, in the same change.
6. Update this page: the counts table above and, if the set of exclusions changed,
   the verbatim lists. `npx vitest run tests/docs` fails until you do.
7. Review the diff like a pricing change, because it is one: every stored estimate
   keeps its old `catalogVersion`, every new one uses the new one, and
   `diffCost(...).catalogChanged` will flag comparisons across the boundary.

Keep the old dated artifact intact, add the new snapshot and change the selected
import in `pricebook.ts` in the same reviewed change. Real calendar dates are
required; a source retrieval date after the snapshot version date is refused.

## Where estimates are used

- **Placement** (`solvePlacement` and `explainPlacement` in `src/lib/placement`): every
  candidate's cost, hard filters (budget, residency, availability, denylist, missing
  price) and a deterministic score. The model extracts constraints and explains the
  result; it never optimizes. Latency in placement comes from a static table of
  approximate round-trip times written from public figures as remembered on
  2026-09-30 and **not measured**; it ranks regions, it is not an SLO
  (`src/lib/placement/latency.ts`).
- **Policy** (`costDeltaUsdMonthly`, `projectedMonthlyUsd` in the policy input): the
  rules `cost_threshold_exceeded` and `budget_exceeded` compare against the
  workspace's `costApprovalThresholdUsd` and `budgetUsdMonthly`
  ([POLICY.md](POLICY.md#workspace-parameters)). Both inputs are estimates, so
  both rules are only as accurate as the catalog and the usage assumptions. The
  broker accepts costs only in-process from the execution side (`ProposeContext.cost`),
  never from a request body, and nothing supplies them yet, so over REST these two
  rules do not fire today.
- **Store** (`platform.cost_estimates`): the estimate document, its catalog version
  and its monthly total, scoped by workspace.

## Limits, stated once

- Numbers are list prices in USD from a snapshot. A customer with discounts,
  credits, committed use, a different currency or a free tier will pay a different
  amount; the estimate does not try to guess which.
- The usage profile is an assumption. Real traffic can move the bill more than any
  price in the catalog.
- Coverage is partial by design: see the exclusions above. A missing line is not a
  zero.
- Nothing here has been compared with a real bill.


## Remaining production gaps

This bounded change does not refresh every weak price or migrate the legacy V1
screens. Forecasts and actual spend still have no ingestion path. The existing
solver remains deterministic and read-only, with its 15% optional cross-cloud
savings margin and explicit complexity/transfer/latency costs; it does not perform
an autonomous economic migration. A repeated optimization workflow with current
field ownership, approvals and durable cooldown remains separate work.
