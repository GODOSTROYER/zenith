# Mixed reference app

A small order service for PROD-MIX acceptance: GCP web, an AWS enricher, and Azure PostgreSQL. Every acknowledged order is independently checked by `scripts/acceptance/mixed/readback.ts` with its own database credential file. Contract tests and LocalStack do not prove the three live clouds participated.

| Variant | Manifest | Enricher and authentication |
| --- | --- | --- |
| Experimental Lambda | `zenith.app.json` | `functions[]`, versioned S3 ZIP with source/package SHA-256; SDK SigV4 invocation of an exact published Lambda version ARN |
| Labelled container | `zenith.app.container.json` | AWS container stand-in, `enricher/server.mjs`; protected HTTP with mutual TLS in live acceptance |

`zenith.app.json` is an **unbound template**. Its placeholders intentionally fail manifest validation. Do not replace them with invented digests. Package the exact checked-out `enricher/handler.mjs` and `spec.json`, upload the ZIP to a versioned S3 object, and bind the actual immutable metadata and the driver's `qualified_arn` output for the reviewed deployed function. The binding script verifies the ZIP digest, entry set and exact source bytes before producing a runnable manifest. Invocation independently checks Lambda's actual `CodeSha256` and `ExecutedVersion`. Mutable S3 references, `$LATEST`, aliases and changed code refuse before acknowledgement.

```bash
# Offline; needs zip and unzip. Use a fresh output directory.
node scripts/acceptance/mixed/package-lambda.mjs .data/mixed-lambda-run
# binding.json: bucket, key, version, functionArn (numeric version), sha256, sourceDigest
node scripts/acceptance/mixed/bind-lambda.mjs .data/mixed-lambda-run .data/mixed-lambda-run/binding.json .data/mixed-lambda-run/zenith.app.json
```

For the reviewed cloud deployment, the artifact-only function plan can be applied first. Bind its actual published ARN into the web manifest and review that web plan next. The binder also refuses an ARN in a different region. An already published Lambda version can be used by the standalone traffic harness without applying another function. No caller credential is created by manifest expansion: supply a temporary IAM principal restricted to `lambda:GetFunction` and `lambda:InvokeFunction` on that exact published function ARN. Deterministic credential provisioning and approval remain outside customer code; neither the model nor the manifest supplies secrets.

The web adapter uses `ENRICHER_MODE=lambda`, `ENRICHER_LAMBDA_ARN`, `ENRICHER_LAMBDA_SHA256` and `ENRICHER_LAMBDA_CREDENTIAL_FILE`. The private JSON credential file contains `accessKeyId`, `secretAccessKey`, `sessionToken`, `expiresAt` (ISO time). Live credentials must be temporary and unexpired. No ambient AWS credential chain, anonymous URL, public function URL or container fallback is used in Lambda mode. `ENRICHER_LAMBDA_ENDPOINT` is accepted only with `ZENITH_MIXED_LOCALSTACK=1` and a loopback endpoint. LocalStack fake credentials are created at runtime by the gated helper; they are never committed.

`STORE=memory` is explicitly local evidence. Live web reads Azure PostgreSQL credentials from `DATABASE_URL_FILE`; production cannot silently fall back to memory. `ENRICHER_TIMEOUT_MS` bounds both the digest read and invocation (default 3000).

The unchanged container traffic/recovery harness is a separate labelled variant. Its web configuration uses `ENRICHER_MODE=container` (the legacy default), `ENRICHER_URL`, and mutual TLS files `ENRICHER_CA_FILE`, `ENRICHER_CERT_FILE`, `ENRICHER_KEY_FILE`. It proves no Lambda execution.

```bash
# Container variant, local memory test only, from fixtures/mixed-app:
node --input-type=module -e "import('./enricher/server.mjs').then(m => m.createEnricherServer().listen(8081))"
STORE=memory ENRICHER_MODE=container ENRICHER_URL=http://127.0.0.1:8081 node web/server.mjs
```

Exact Mac LocalStack, PostgreSQL, kind and deferred live commands are in [W5-GAPS verification](../../docs/build/production/verify/W5-GAPS.md). No live cloud was called by this job.
