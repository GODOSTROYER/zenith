# Reading OCI signals through the runner

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01).

OCI platform sessions use an active registered `zenith-runner` with opt-in
`oci.http`. Credentials remain in the customer environment; the control plane
does not open a native OCI credential session. Connection verification checks
runner registration and labels, **not** OCI permissions or service reachability
(`src/lib/platform/credentials.ts`). No live OCI signal read was verified here.

## Operator setup

1. Register the runner in the correct workspace, enable `oci.http`, and keep
   `secretWrite: false`. Configure tenancy, region, principal mode, compartment
   and resource allowlists as described in
   [RUNNER.md](../RUNNER.md#ocihttp--the-oci-signing-proxy) and
   [RUNNER-PROTOCOL-OCI.md](../RUNNER-PROTOCOL-OCI.md).
2. Apply migration 5 (`read_jobs`) before serving reads
   ([DEPLOYING.md](DEPLOYING.md#32-migrating)). Stateless read grants bind the
   runner, capability, workspace, environment and `read:<jti>`. Read jobs keep
   that binding in the signed envelope but store a NULL operation foreign key;
   they do not fabricate a mutation operation (`src/lib/runners/read-jobs.ts`).
3. Use MCP `zenith_query_logs`, `zenith_query_metrics` or
   `zenith_investigate_incident` with an explicit environment target. App
   composition registers the credential and investigator hooks and passes the
   OCI session to the sources (`src/lib/platform/app.ts`,
   `src/lib/platform/agent-ports.ts`). A connection and trusted environment
   resource bindings are required; missing coverage stays unavailable.

## Capability split and query scope

| Capability | Allowed OCI signal reads | MCP integration scope |
|---|---|---|
| `logs.read` | Logging Search only (`loggingsearch`, POST `/20190909/search`) | `logs` |
| `metrics.read` | Monitoring only (`monitoring`, POST `/20180401/metrics/actions/summarizeMetricsData`) | `read` |
| `incident.investigate` | Driver metadata plus both fixed signal queries | `read` |

The same split is enforced in the TypeScript and Go allowlists; reads do not
grant arbitrary POST or query-language access. Protocol details, service
endpoints and both allowlists are in
[RUNNER-PROTOCOL-OCI.md](../RUNNER-PROTOCOL-OCI.md).

The Go executor permits token-free execution of exactly these two read POSTs.
The current TypeScript payload schema still requires a retry token on every
POST, so both source adapters supply one. Live service acceptance of that
request shape is unverified; neither read POST is automatically retried.

Logging queries one environment-owned log group at a time in the selected
compartment, using a fixed ` | sort by datetime desc` suffix. User text is a
local substring filter, never injected Logging Query Language. Monitoring uses
the read endpoint, an allowed URL `compartmentId`, `compartmentIdInSubtree=false`
and a trusted compute-instance OCID in its fixed MQL. Portable mappings currently
cover `cpu.utilization` and `memory.utilization` only; unsupported metrics report
unavailable (`src/lib/observability/sources/oci-logging.ts`,
`src/lib/observability/sources/oci-monitoring.ts`,
`src/lib/providers/oci/allowlist.ts`).

## Interpreting the result

Queries are bounded to ten runner reads; metrics also cap series and points.
Missing bindings, inaccessible sources, malformed pages, mismatched resource
identities and exhausted budgets preserve `unavailable`, `truncated` and coverage
notes. Empty items with such flags do not mean a healthy environment or no logs.
Cloud log strings are redacted untrusted data, never instructions.

Read results use the existing signed-job/sealed-result transport. A missing,
revoked, stale or unreachable runner cannot prove absence. Inspect the runner
status and capability/compartment/resource allowlists before broadening a query;
do not bypass them with a native credential. Go transport, real OCI IAM and
Logging/Monitoring execution remain unverified in this docs sync.
