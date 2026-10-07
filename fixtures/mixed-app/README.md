# Mixed reference app

A deliberately small order service for the live mixed-cloud acceptance (PROD-MIX-06). It exists to serve real traffic across
three clouds and to be checked by something that does not trust it.

| Part | Where it runs in the live harness | What it does |
| --- | --- | --- |
| `web/server.mjs` | GCP compute | `POST /orders`, `GET /orders/:clientKey`, `GET /orders?prefix=`, `GET /health`. A 201 or 200 is an acknowledgement that the row is in PostgreSQL. |
| `enricher/handler.mjs`, `enricher/server.mjs` | AWS (a container service; the handler is Lambda-shaped) | Price and checksum of an order. Stateless, no secrets. |
| PostgreSQL (`db/schema.sql`) | Azure Database for PostgreSQL | One `orders` table; `client_key` is unique, so a resend is idempotent. |

`spec.json` is the shared contract (catalog prices, checksum rule, which provider hosts which tier). `zenith.app.json` is the
manifest: manifest v2, `nodePlacement` pins web to GCP `us-central1`, the enricher to AWS `us-east-1` and the database to Azure
`eastus`; the web tier and enricher meet over protected endpoints (mutual TLS plus an allowlist) declared on the mixed plan, not in
the manifest.

Credentials are never values: the web tier reads its database URL from the file named by `DATABASE_URL_FILE`; the mutual-TLS client
material for the enricher comes from `ENRICHER_CA_FILE`, `ENRICHER_CERT_FILE` and `ENRICHER_KEY_FILE`. The in-memory store is only
used when `STORE=memory` is set explicitly (local tests); a deployment can never fall back to it silently.

Checking it: `scripts/acceptance/mixed/traffic.ts` generates deterministic orders keyed `<runId>-<n>` and records only what the app
said; `scripts/acceptance/mixed/readback.ts` reads PostgreSQL directly with its own read-only credential file and decides whether every
acknowledged write is really there, correct and stored once. Locally the same code runs against these servers on loopback
(`tests/acceptance/mixed-traffic.test.ts`); live runs are gated by `ZENITH_LIVE_MIXED=1` and an approved scope manifest.

```
node --input-type=module -e "import('./enricher/server.mjs').then(m => m.createEnricherServer().listen(8081))"
STORE=memory ENRICHER_URL=http://127.0.0.1:8081 node web/server.mjs     # local only
```
