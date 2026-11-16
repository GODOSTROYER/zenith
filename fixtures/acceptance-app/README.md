# Acceptance app

A dependency-free Node HTTP fixture for Demos A–J. No package installation is
needed. `node server.mjs` starts it; it serves on `0.0.0.0:8080` by default.

| Route | Observation | Limits |
|---|---|---|
| `/health` | Process is serving; 200 with `status: ok` | Does not touch the database or prove dependency health |
| `/db` | A TCP handshake to the host/port in `DATABASE_URL`; 200 if reachable, otherwise 503 | No SQL, authentication, database TLS, or query health check |
| `/` | App description | No infrastructure verification |

`/db` reports `timeout`, `refused`, `dns`, `unreachable`, or `error` according
to the socket outcome, and `not_configured`/`invalid_url` for configuration
problems. A non-routable address can fail immediately on a restricted network;
an immediate error is never described as a timeout. `/health` stays healthy
during a database outage so Demo B must diagnose the dependency failure.

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | 8080 | HTTP listen port |
| `HOST` | 0.0.0.0 | Listen address |
| `DATABASE_URL` | unset | PostgreSQL URL; credentials are discarded after parsing host/port |
| `DB_CONNECT_TIMEOUT_MS` | 2000 | TCP timeout; positive milliseconds |
| `DB_CHECK_INTERVAL_MS` | 15000 | Background database checks; 0 disables |
| `APP_VERSION` | dev | Version label returned by `/health` |

The database URL/password is never returned or logged. Logs are JSON lines:
`listening`, `db_check`, and `db_connect_failed` with reason and timings.
Use a disposable URL with fake credentials for local network checks. For real
deployment, Zenith's secret/binding flow supplies a vault reference; do not
put a password in a manifest or evidence file.

```powershell
node fixtures/acceptance-app/server.mjs
docker build -t zenith-acceptance-app:local fixtures/acceptance-app
docker run --rm -p 18089:8080 --env-file <private-env-file> zenith-acceptance-app:local
curl.exe http://localhost:18089/health
curl.exe http://localhost:18089/db
docker image rm zenith-acceptance-app:local
```

The Dockerfile runs as the image's non-root `node` user and includes a
`/health` healthcheck. The previous agent reported a successful Docker build,
uid 1000, `/health` 200 and `/db` timeout on 2026-09-30; Docker is unavailable
to this continuation and those results have not been refreshed. Node-process
HTTP tests can run without Docker.

Base image: `node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`.
The prior agent obtained this digest from `docker pull node:22-alpine` on
2026-09-30 (reported Node v22.23.3). To refresh, an operator with Docker and
registry access pulls that tag, inspects its RepoDigests, reviews the change,
updates only the Dockerfile digest, then rebuilds and verifies routes and the
non-root user. The digest is pinned; the tag alone is insufficient.

Demo A analyses these files into a web service, Docker build, health route,
Postgres resource and a `DATABASE_URL` vault reference. Its repository source
is `.` in the inferred manifest: the integrated source-upload/build path must
resolve this to this fixture, not the whole Zenith repository. Demo B removes
the run-tagged database security group's port 5432 ingress out of band; `/db`
then fails while `/health` remains 200. Demo C requires an approved repair.

Keep the `postgres://` header example and Dockerfile healthcheck: the merged
repository analyser uses both to infer the datastore and health path. The
TypeScript declaration file is for tests only and is not a dependency.
