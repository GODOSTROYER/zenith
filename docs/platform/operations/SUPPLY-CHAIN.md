# Verified release supply chain

Written against branch `prod/compose`, guide input at `443bfeaf537dd5d5324d33c84fc544ede0baa632`. Working-tree assembly; native and live acceptance remain unverified.

PROD-OPS-09. What ships, how an operator verifies it offline, and what is deliberately not claimed.

## What exists

| Piece | Where | What it does |
| --- | --- | --- |
| Pinned dependencies | `scripts/ci/lockfile-integrity.mjs`, `scripts/ci/security-audit.mjs` (unchanged) | Every non-bundled registry entry has its own sha512; six bundled entries inherit documented custody from their hashed enclosing package, without fabricated child hashes; the complete audit blocks release. The release workflow runs both on the tagged commit. |
| SBOM | `scripts/supply-chain/sbom.mjs` | CycloneDX 1.5 JSON: npm lockfile (purl, sha512, scope, dependency graph), Go build info (`go version -m`), Dockerfile inputs (base images, pinned OpenTofu) and the built image digests. |
| Provenance | `scripts/supply-chain/release.mjs provenance` | in-toto Statement v1 with a SLSA provenance v1 predicate: subjects are every release file by sha256; resolved dependencies are the git commit and the lockfile digest. |
| Signed release | `release.mjs manifest` / `sign`, `.github/workflows/release.yml` | One verification manifest naming every artifact, the SBOM and the provenance by sha256, signed with the offline `signing:release` Ed25519 key. Same key format and signing scheme as the runner updater, so one key and one pinned public key serves both. |
| Updater manifests | `go/cmd/zenith-release sign` (MACH-04, unchanged) | The workflow signs the runner and zenithd update manifests with the same key when `ZENITH_UPDATE_BASE_URL` is set. Agents already verify these (`docs/platform/RUNNER-UPDATES.md`). |
| Offline verifier | `scripts/supply-chain/zenith-verify-release.mjs` (`npm run verify:release`) | Verifies signature, digests, SBOM, image archives and provenance with no network. |
| Vulnerability triage | `scripts/ci/vulnerability-triage.mjs`, `scripts/ci/vulnerability-triage.json` | Records linked to SBOM components by purl, with expiry; mirrors every security exception; renders CycloneDX VEX. Never affects the dependency gate. |
| Audit export | `src/lib/audit-export`, `POST /api/platform/v1/audit/exports`, `scripts/supply-chain/zenith-verify-audit-export.mjs` | Hash-chained, signed export of an audit-log range with a ledger (`platform.audit_exports`, migration 47) and an offline verifier. |

## Releasing

Push a version tag (`v1.2.3`, `v1.2.3-rc.1`) whose commit is on the default branch. Nothing else triggers
`.github/workflows/release.yml`. One-time operator setup (this workflow cannot create any of it):

1. Generate the release key offline: in `go/`, `go run ./cmd/zenith-release keygen --kid release-2026-10 --private-out seed.txt`.
   It prints the public entry. Keep `seed.txt` offline except for the CI secret below.
2. Create a protected GitHub environment named `release` with required reviewers.
3. In that environment: secret `ZENITH_RELEASE_SIGNING_SEED` (the seed), variables `ZENITH_RELEASE_KEY_ID` and
   `ZENITH_RELEASE_PUBLIC_KEYS` (a JSON array of pinned `{"kid","publicKey"}` entries), optionally
   `ZENITH_UPDATE_BASE_URL` (an https prefix under which you host `<version>/<os>-<arch>/<component>`).

Without the secret the run still builds and uploads an artifact named `release-UNSIGNED-<tag>`, labelled unsigned, and
publishes nothing. With it, the run builds, generates the SBOM, signs, then verifies its own output offline against the
pinned public keys before publishing; a failed verification publishes nothing.

The control plane never holds this key: `signing:release` is verify-only there (`docs/platform/operations/KEY-CUSTODY.md`).
The seed is present on the CI runner only inside the signing steps and is deleted after them.

## Verifying a release (offline)

```
node scripts/supply-chain/zenith-verify-release.mjs ./bundle --keys pinned-keys.json --lock package-lock.json [--strict]
```

`pinned-keys.json` is the public key entry (or array) you recorded when the key was generated, not a file from the bundle.
The bundle is the `zenith-<tag>-bundle.tar` release asset, extracted. The verifier checks that:

- the manifest is signed by a pinned key and has not expired;
- every listed artifact exists with the signed sha256 and size, and nothing unlisted ships (`--strict`: failure);
- the SBOM is bound by the signed manifest, is valid CycloneDX 1.5, names the same version and commit, lists every shipped image at
  its digest, and with `--lock` contains exactly the lockfile's npm packages;
- each OCI image archive's blobs hash to their names and the image manifest digest read from the archive is the signed digest;
- the provenance is bound by the signed manifest, attests every artifact at its signed digest, and names the same commit and repository.

Exit 0 verified, 1 not verified (every failed check listed), 2 usage error.

### What a verified release does not mean

- Provenance is workflow-asserted. It is bound by the release signature but is not a Sigstore or GitHub attestation, the build
  is not on an isolated hosted builder, and no SLSA level is claimed.
- Images are not pushed to a registry. They ship as OCI archives (`docker load`, `skopeo copy oci-archive:...`). Digests are verified
  from the archive; there is no registry signature.
- Base images are not all digest-pinned in source. `docker/runner.Dockerfile` and `docker/zenithd.Dockerfile` use tag-only
  `golang`, `alpine` and `distroless` bases. The SBOM marks them `zenith:pinned=tag-only`; the verifier warns, and fails with `--strict`.
- OS packages inside base images are not inventoried. Every container component says `zenith:os-packages=not-inventoried`.
- An SBOM is not a vulnerability statement. It lists inputs. Vulnerability state is the audit gate plus the triage records.
- The first signed release has not been produced; no key exists yet, and the workflow has not been run.

## Vulnerability triage

`scripts/ci/vulnerability-triage.json` holds records `{ id, advisoryId, component: { purl }, state, justification?, detail, owner,
createdAt, reviewDueAt, expiresAt, exceptionId? }`. States: `in_triage`, `exploitable`, `not_affected` (needs a CycloneDX VEX
justification), `false_positive`, `resolved`, `risk_accepted`.

- Every record expires (at most 90 days; `in_triage` and `exploitable` at most 14) and has a review date; an expired or overdue record fails the check.
- The component's purl must be in the release SBOM.
- `risk_accepted` must name an existing entry in `scripts/ci/security-exceptions.json` for the same advisory and may not outlive it;
  every security exception must in turn be mirrored by a `risk_accepted` record.
- The dependency gate is untouched. A triage record never clears a finding; only a reviewed, signed, expiring security exception can,
  under that policy's rules (an external trust authority, two signatures). `gateEffect` is always `none`.
- `node scripts/ci/vulnerability-triage.mjs --sbom sbom.cdx.json --audit npm-audit.json --vex-out vex.cdx.json [--strict]` lists audit
  findings without a triage record and writes the CycloneDX file with a `vulnerabilities` section.

The committed registry is empty: no triage has been performed and none is claimed.

## Tamper-evident audit export

`POST /api/platform/v1/audit/exports` (workspace admin, browser session only) with body `{ "from"?, "to"? }` returns
`{ exportId, record, document }`. `GET` lists the workspace's export ledger (admin).

The document is a hash chain over the range's events (ordered by timestamp, then id) plus a compact EdDSA JWS whose payload carries
the genesis, head, event count, range, export id and the link to the workspace's previous export. It is signed with the control
signing key (`signing:jobs`). No signing key configured means the export is refused, never produced unsigned. A range of more than
10,000 events is refused, not truncated. Events are the already-redacted audit rows.

Offline verification:

```
node scripts/supply-chain/zenith-verify-audit-export.mjs export.json --keys control-public-keys.json [--ledger ledger.json] [--workspace ID] [--previous-head HEX]
```

`control-public-keys.json` is the public JWK (or a JWKS) of the control signing key, pinned by you (retired keys stay verifiable via
`ZENITH_CONTROL_EXTRA_PUBLIC_JWKS`). The verifier detects an edited, removed, inserted or re-ordered event, a truncated tail, a swapped or
forged header, an event outside the signed range, and (with the ledger) an export that was never recorded, a different head, or a
dropped predecessor. The ledger refuses to fork and is append-only by trigger.

Limits: the chain starts at export time. It proves an exported range was not changed after export and that exports of a workspace form
one chain; it does not prove the live `audit_events` table was complete before export, because rows are not hash-chained when
written. Deleting the whole ledger together with every export file removes the evidence.
