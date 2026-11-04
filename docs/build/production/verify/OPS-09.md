# OPS-09: J11 base-image digest successor

The ledger's broader supply-chain acceptance (SBOM/provenance/signatures/updater/audit export/triage) belongs to Wave 5.
J11 supplies the owned base-image pin seam only. `scripts/deploy/pin-digests.mjs` inventories external Dockerfile bases,
expands global ARG defaults, preserves platform/stage flags, and resolves real crane or buildx manifest digests before
rewriting. The recipe Dockerfile reuses the existing checked-in Node 22.23.3 digest. No digest was invented.

`tests/security/deploy-pins.test.ts` tests invalid/zero/multiline digests, late-resolution failure without writes, distinct
release-image binding, and real-archive-byte hashing with explicitly offline command models. `image-pins.test.ts` retains
every existing assertion and adds recognition of declared listener/scrape endpoints and Compose security options; those
strings still fail when placed in image fields. This corrects three false image classifications, with no image exception
added and no old expectation changed.

## Exact Mac commands and remaining TODO list

```bash
node scripts/deploy/pin-digests.mjs --todo
crane digest golang:1.27-alpine
crane digest alpine:3.22
crane digest gcr.io/distroless/static-debian12:nonroot
crane digest prom/prometheus:v3.2.1
crane digest grafana/grafana:11.6.0
crane digest otel/opentelemetry-collector-contrib:0.123.0
# Exact alternative for each reference printed above (substitute the printed reference):
docker buildx imagetools inspect golang:1.27-alpine --format '{{json .Manifest}}'
docker buildx imagetools inspect alpine:3.22 --format '{{json .Manifest}}'
docker buildx imagetools inspect gcr.io/distroless/static-debian12:nonroot --format '{{json .Manifest}}'
docker buildx imagetools inspect prom/prometheus:v3.2.1 --format '{{json .Manifest}}'
docker buildx imagetools inspect grafana/grafana:11.6.0 --format '{{json .Manifest}}'
docker buildx imagetools inspect otel/opentelemetry-collector-contrib:0.123.0 --format '{{json .Manifest}}'
ZENITH_RESOLVE_DEPLOY_PINS=1 node scripts/deploy/pin-digests.mjs --resolve --scope bases --resolver buildx
npx vitest run tests/security/image-pins.test.ts tests/security/deploy-pins.test.ts --no-file-parallelism --maxWorkers=1
# Build natively/serially on ARM64 after pinning, never under emulation labelled native:
docker build --platform linux/arm64 -f docker/runner.Dockerfile -t zenith-j11-runner:local .
docker build --platform linux/arm64 -f docker/zenithd.Dockerfile -t zenith-j11-zenithd:local .
```

Expected: resolver writes runner (Go/Alpine/distroless), zenithd (Go/distroless) and the three observability inputs with
nonzero registry-provided digests; tests pass. Native build/probes remain separate evidence from static references.
The Go `1.27` source default is preserved rather than guessed/upgraded; if unavailable, return actual registry/toolchain
compatibility evidence to the orchestrator. Any downloaded chart/image/tool still needs its actual vulnerability triage
and release signature/provenance gates. Pinning proves immutability, not trust, certification or freedom from vulnerabilities.

Remaining full `--check` failures until the other verifier steps: three Zenith release image placeholders (`OPS-03.md`)
and Cilium version/archive digest (`MAN-04.md`). Node bases already pinned in the main/worker/migration/sample Dockerfiles
are preserved. Dockerfile frontend directives are outside the assigned base-image seam and still need assembler supply-
chain review. Do not mark broader OPS-09 verified from this slice. No package/lockfile, Go source, published migrations,
workflow, signing key or release-policy changes. Docker/registry work **not run here (needs Mac/network)**.
