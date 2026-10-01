# Cost estimates

What Zenith's cost engine produces, what it does not, where its numbers come from
and how to refresh them. Design: [ADR-0013](../../adr/0013-placement-and-cost.md).
Code: `src/lib/placement/`.

Written against branch `ws/docs` at commit `fd2ce9f` (2026-09-30).

**Status.** The price catalog, the cost engine and the placement solver are built as
pure libraries and tested. **They are not wired into anything a user sees.** The
product's cost card (`src/app/(product)/p/[slug]/observe/cost-card.tsx`), the
onboarding preview and the deploy panel all still use the original static table in
`src/lib/cost/pricing.ts`, a static table of service sizes, five resource kinds and
routes that has no NAT, public IPv4, load balancer or egress. No route or workflow calls the new engine yet; the place that will keep
its output is `platform.cost_estimates`.

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
object store and a load balancer on AWS, plus a function, a MySQL database, a node on
a provider with no catalog and a referenced node. (A test rebuilds this sample and
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
"Provisioned IOPS" and "High-availability standby capacity".

Excluded:

```
Taxes (VAT/GST), currency conversion and payment fees
Discounts: savings plans, committed use, reserved instances, spot, enterprise agreements and credits
Provider free tiers and free monthly allowances are not deducted (conservative), except where the list price itself is zero
Volume-tier egress discounts: the first-tier per-GB price is applied to every GB
Data transfer between availability zones inside one region
Container registry storage and image pulls, and CI/CD build minutes
Monitoring metrics, alarms, traces and dashboards (only log ingestion is modeled)
Secret manager and key management charges
WAF, DDoS protection, CDN and API gateway charges
Support plans and marketplace fees
This is an estimate from a static list-price catalog, not an invoice or a quote
1 function node(s): serverless functions not priced by catalog 2026-09-30.1
Resources on provider "kubernetes" have no price catalog and are not priced
1 referenced or external node(s) are not Zenith's bill and are not priced
MySQL is priced with the provider's PostgreSQL SKUs (approximation)
```

The kinds the catalog does not price are named per estimate: functions, static sites,
container registries, secrets, Kubernetes clusters and namespaces, build pipelines
and provider-native (Level 3) resources. A provider with no catalog (Kubernetes,
and the sandbox and LocalStack providers) is listed as unpriced, not as free.

## The price catalog

`src/lib/placement/catalog/2026-09.json`, loaded and validated by
`src/lib/placement/pricebook.ts`. Current version: **`2026-09-30.1`**.

- **A static snapshot of list prices.** Nothing fetches anything at run time. Prices
  are USD before taxes, discounts and free tiers. Values were read from the named
  feed on 2026-09-30 and **transcribed by hand**; the catalog says so in every
  source record.
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

Each estimate totals the part of its bill that rests on the three weak classes in
`assumptions.priceEvidenceWeakUsd` (and `priceEvidenceWeakLines`), and the placement
solver warns on a candidate when more than 25 % of its estimate does.

### What the catalog holds today

Counts of entries by provider and class at version `2026-09-30.1` (a test keeps this
table equal to the file):

| Provider | Class | Entries |
|---|---|---|
| aws | official_api | 140 |
| aws | model_knowledge | 8 |
| azure | official_api | 96 |
| azure | derived | 4 |
| azure | model_knowledge | 48 |
| gcp | official_page | 8 |
| gcp | third_party_mirror | 40 |
| gcp | derived | 36 |
| gcp | model_knowledge | 64 |
| oci | official_api | 33 |
| oci | derived | 39 |
| oci | model_knowledge | 39 |
| zenith | internal_assumption | 120 |

In plain terms: **AWS is the best-evidenced** provider (most entries read from the
AWS Price List Bulk API for four regions; the ACM certificate price and the
ElastiCache high-availability node count are remembered). GCP is the weakest of the
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
exists.

1. For each `sources[]` record, re-read the feed it names (the AWS Price List Bulk
   API region files, the Azure Retail Prices API filtered by region and service, the
   OCI public price list API, the Cloud Run pricing page), for the SKUs each entry's
   `note` describes.
2. Update `usd` where the feed moved. **Upgrade weak entries** where a feed exists:
   replace `model_knowledge` with `official_api` or `official_page` and say so in
   `verification` and `note`; re-derive every `derived` entry from its new inputs.
3. Update each touched source record's `retrievedAt` and `source` text. It must keep
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

If a file name change is wanted (the loader imports `catalog/2026-09.json`
directly), change the import in `pricebook.ts` in the same commit.

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
  both rules are only as accurate as the catalog and the usage assumptions.
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
