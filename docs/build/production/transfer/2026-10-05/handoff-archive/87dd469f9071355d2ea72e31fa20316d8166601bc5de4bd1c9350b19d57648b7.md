# Cost catalog, bounded source correction, 2026-10-05

This packet corrects unknown managed cost admission in the existing default
execution and placement paths. It also adds a dated October snapshot for eight
explicitly checked rate entries. It does not close PROD-COST-01/02/03.

## Source behavior

A managed graph node without a provider catalog or a modeled kind now throws
`MissingPriceError`. That rejects the entire graph, including a graph with priced
nodes; no partial subtotal is returned as the monthly estimate. The unchanged
`defaultCostPort` converts this to no estimate, and the unchanged solver rejects
the candidate with a price reason. The current worker behavior with an absent cost
remains unchanged; this packet does not add a budget enforcement or billing cap.

Known zero-charge infrastructure and referenced/external ownership have separate
controls. Referenced resources are outside Zenith's modeled total; this does not
claim their owner's actual bill is zero. Existing network auxiliary lines for NAT,
IPv4, load balancing, transfer, requests, provisioned IOPS, backups and logs remain.

The selected artifact is `2026-10.json`, version `2026-10-05.1`. The entire old
`2026-09.json` is preserved. All old source records and all untargeted entry objects
are unchanged. The eight entries are four Azure Standard IPv4 rates and four AWS
non-exportable integrated ACM certificate rates. New source records and entry
notes limit the evidence to that cohort; the latest snapshot date does not claim
every old price was rechecked. Impossible calendar dates and retrieval after the
snapshot version date refuse catalog parsing without reading the wall clock.

## Primary price research

The [official ACM page](https://aws.amazon.com/certificate-manager/pricing/) was
read on 2026-10-05. The zero certificate rate covers non-exportable public
certificates used with integrated services only; exportable, ACME and Private CA
are excluded. No effective-start date was given for that rate.

The [official Azure Retail Prices API](https://prices.azure.com/api/retail/prices)
was read separately for centralindia, southeastasia, eastus and westeurope. Each
exact Consumption meter was Standard IPv4 Static Public IP, USD 0.005 per hour,
effective 2018-06-01, retrieved 2026-10-05. Exact unauthenticated responses and hashes
are in the private source receipt. This is not a cloud account or billing read.
The Azure NAT page produced numeric placeholders and tested API filters returned
no NAT rows, so its remembered rates remain honestly weak.

## Ownership and validation

Eleven authorized paths are inventoried, with ten changed. The old catalog is an
owned unchanged control. Production changes are confined to the graph cost engine,
catalog parser/selection and new artifact. Cost, catalog, solver, default port and
operator-document fixtures retain their old literal titles; new parameter-expanded
contracts are pinned in `CASE-CONTRACT.json`. The old unpriced subtotal example
now proves strict refusal. The documentation sample contains only priced managed
nodes and separately checks unpriced refusal.

All project imports, tests, compiler, lint and services are UNRUN by the author.
Root must independently review and run the affected cost/catalog/solver/default
execution and operator-document suites. The public pricing research is the only
network activity; no cloud credential, account operation, purchase, installation,
service, Docker/database startup, real staging or commit was performed.

## Remaining release work

Full weak-rate refresh, pricing every managed kind, migration of the legacy V1
product screens, observed usage forecasts and actual-spend ingestion remain open.
Prices are estimates, not quotes, invoices or billing caps. The existing solver
is deterministic and read-only; its 15% cross-cloud margin and explicit transfer,
latency and complexity costs are unchanged. An autonomous economic optimizer with
current field ownership, approval and durable cooldown is outside this packet.
No ledger requirement is closed from this source inspection.
