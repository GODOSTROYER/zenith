# Reviewed, expiring security exceptions

The mandatory complete locked dependency audit remains enabled at every severity. The committed `scripts/ci/security-exceptions.json` registry is empty. GHSA-vfj7-8cjw-p6xm and its five inherited findings remain blocking. No risk exception, reviewer approval, operator approval, trust authority or clearance is activated by this change.

## Approval authority

Repository JSON identities, `decision: approved`, review links and a merge do not authenticate an approval. A nonempty registry requires two Ed25519 signatures over the exact complete request, verified against distinct role-bound public keys from `/etc/zenith/security-exception-authority.json`. The production audit has no environment variable, CLI flag, candidate repository key, fallback authority or automatic key generation that supplies approval.

The external authority must be a regular nonsymlink file outside the checkout, owned by UID 0, at most 64 KiB and not writable by group or other users. Every physical parent directory must also be owned by UID 0 and not writable by group or other users. The verifier opens the file with `O_NOFOLLOW`. Missing, unsafe or malformed authority blocks every active record. An empty registry needs no authority and preserves clean-audit behavior.

The authority has exactly `schemaVersion: 1`, `repository: GODOSTROYER/zenith`, `reviewerKeys` and `operatorKeys`. Each nonempty role array contains at most 20 entries with exactly `id`, `actor` and a PEM SPKI Ed25519 `publicKeyPem`. Key IDs and public-key fingerprints must be unique across both roles. Each signature's role/key ID and actor must match the trusted entry; the reviewer and operator must be different actors. Removing an anchor revokes its records on the next evaluation.

Authenticated provisioning of these anchors, verified human-to-key bindings, private signer custody, revocation and a protected CI workflow executing the reviewed verifier are required before any real acceptance. The current unprotected branch provides no proved governance for those steps. They are outside this source change and are not configured here. A signature proves control of an externally trusted key only to the extent that this authority and verifier execution are trustworthy. Unit fixtures supply ephemeral synthetic public anchors to `evaluateSecurityExceptions`, which does not establish caller-key authority. The production runner calls `applySecurityExceptions`, whose interface cannot inject anchors or select a trust-store path. Test private keys exist only as in-memory KeyObjects.

## Exact review contract

An active registry record has exactly these fields:

- `id`, `status: approved`, canonical `advisoryId`, `owner`.
- `advisoryScope`: the normalized current findings for that advisory, sorted by package. Every finding binds severity, affected range, directness, complete node list, effects, remediation (`fixAvailable`) and the complete `via` chain. Direct advisory objects bind source ID, package/dependency, title, canonical URL, severity, range, CWE and CVSS content. Missing, malformed or conflicting advisory scope refuses validation. `securityFindingScope(finding)` constructs each normalized snapshot; the verifier compares it with the current audit on every evaluation.
- `lockSha256` for the complete raw committed lock bytes and `sourceSha256` from the reviewed source inventory.
- `affectedNodes`, each with exactly `package`, physical locked `node`, `version` and full `integrity`.
- `issuedAt`, `reviewDueAt`, `expiresAt`.
- `review`: `reviewer`, `decision: approved`, `reviewedAt`, `reference`, `keyId`, `signature`.
- `approval`: `operator`, `decision: approved`, `approvedAt`, `reference`, `keyId`, `signature`.
- `reachability` and `mitigations`, each with a concrete `summary` and nonempty `sources` containing repository `file` and exact file `sha256`.
- `primarySources`, including the exact canonical advisory URL.

Both signatures authorize all those fields, including both identities, key IDs, references and times. `securityExceptionApprovalPayload(record, role)` returns canonical UTF-8 JSON with sorted object keys, retained array order, repository `GODOSTROYER/zenith` and distinct `zenith.security-exception.reviewer.v1` / `zenith.security-exception.operator.v1` purpose domains. Only the two signature values themselves are removed before signing. Ed25519 signatures use standard Base64. Substituting the advisory, lock, source, node, integrity, version, evidence, owner, expiry or another request invalidates the signatures. Review references must identify this repository's pull request or its review/comment; a URL is contextual evidence, never authentication.

All timestamps use strict UTC `YYYY-MM-DDTHH:mm:ss.SSSZ` with a real calendar date. Issuance precedes review, review precedes operator approval, approval cannot be in the future, and the current clock must precede both review due and expiry. Lifetimes cannot exceed seven days from issuance; review due cannot exceed 24 hours from review. Expiry and review due are strict boundaries. Future, expired, overdue, duplicate, missing, unknown-field, stale or malformed records block the gate. Renewal requires a fresh exact request and both approvals.

The production entry point accepts no clock override. After authority, source, evidence, graph and signature validation it reads the clock again immediately before returning a clearance decision. Reaching either deadline during IO blocks the record, including exact equality. Only the explicit verification core permits synthetic clocks for unit fixtures; no CLI or environment value supplies a production clock.

The source inventory hashes sorted `file`/SHA-256 pairs for `src`, `workers`, `scripts`, `docker`, `deploy`, `go`, `policy`, `supabase`, `public`, `here-now-gimbal`, `.github`, root `Dockerfile`/`.dockerignore`, and root JSON/JS/TS/YAML/TOML/shell configuration files. The registry is excluded to avoid self reference; installed `node_modules` trees are excluded from source inventory and require independent artifact review. Inventory symlinks are refused, including matching root configurations before regular-file filtering. Evidence paths reject symlinks in every component, must stay within the checkout and cannot reference `.git`, `node_modules`, environment files or the registry, whether lexically or after resolution. Each referenced file is independently hashed. Code, deployment, tooling, configuration, lock or evidence changes invalidate their bound record.

An unchanged GHSA ID does not preserve authorization when reported severity, range, advisory content, affected findings or remediation changes. The current normalized snapshot must match the signed record; editing that record requires both fresh signatures. Every returned finding retains its current normalized `scope`, including findings covered by synthetic reviewed exceptions. The complete audit uses `--audit-level=low`: status zero with any low-or-higher finding, or status one without such findings, is an inconsistent report and fails before exception evaluation. Informational findings below that exit threshold still remain subject to the mandatory all-severity gate.

Scope ranges use a bounded supported npm SemVer grammar: numeric or wildcard partials, comparator sets, OR clauses, plain hyphen endpoints, and complete versions with strict prerelease/build identifiers. Numeric core and prerelease identifiers reject leading zeroes; build identifiers may contain them. Empty identifiers and comparator-prefixed hyphen endpoints are refused. Remediation versions require complete strict versions, with the same identifier rules. Malformed scope fails before exceptions and cannot clear even with fresh synthetic signatures. The validator imports no undeclared parser dependency; unsupported syntax fails closed.

The lock graph must be version 2 or 3 with supported physical `node_modules` paths and no links. Root dependency declarations must agree exactly with `package.json`. Physical Node resolution follows nested and hoisted installed nodes; production traversal includes dependencies, installed optional dependencies, peers and bundled dependencies. Missing required edges or unsupported graphs refuse acceptance. An affected node must be reachable from a development root and absent from the production closure, with `dev: true` as an additional constraint. That flag alone never grants permission. The record must enumerate every locked copy of every inherited package for the canonical advisory, with exact versions and SHA-512 integrities; incomplete or ambiguous mixed copies fail closed.

Graph eligibility establishes locked dependency reachability. Reviewers must independently assess application imports, untrusted tooling inputs and shipped images: a development dependency can still exist physically in a full-install image. A summary string does not establish shipping absence or mitigations. Bind real source and artifact review evidence before a human signs; the pending braces proposal has unresolved shipped-image evidence.

Every canonical advisory on a finding needs its own eligible record. A new advisory, package, version, integrity or node remains blocking. One record can cover the five inherited findings of the same canonical advisory without authorizing another advisory. All known findings remain in output; accepted findings are visibly marked `REVIEWED EXCEPTION` with IDs, review due and expiry. Acceptance never reports zero vulnerabilities. Invalid audit JSON, incomplete counts, registry/network failure, missing lock or an unsuccessful audit exit retain the mandatory failure path before exception evaluation.

## Pending braces proposal: not approved, not applied

The exact `290540c88f54e878e716c1f0b20466dd55b71a06` CI run [37087774593](https://github.com/GODOSTROYER/zenith/actions/runs/37087774593) finished with 13 successful jobs and one failed mandatory dependency audit. The private triage snapshot identifies one high advisory, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), inherited by these five locked development packages:

| Physical locked node | Version |
| --- | --- |
| `node_modules/eslint-config-next` | 15.5.24 |
| `node_modules/@next/eslint-plugin-next` | 15.5.24 |
| `node_modules/fast-glob` | 3.3.1 |
| `node_modules/micromatch` | 4.0.8 |
| `node_modules/braces` | 3.0.3 |

The locked bytes have SHA-256 `b6c8d26a1c57a70d031ad8b72d1a391d554e53121a8b58e590763902c674816d`. The 2026-10-03 private triage snapshot found no released patched braces version or safe tested upstream upgrade removing this chain; the [upstream change](https://github.com/micromatch/braces/pull/72) was still unreleased. These are dated observations, not a guarantee of current upstream status. Refresh the advisory, registry and upstream evidence before a real review.

The private proposal remains `NOT_APPROVED` / `NOT_APPLIED`, owned by `PROD-WS-RUNTIME-SECURITY`. Its proposed issuance is `2026-10-03T02:05:39.311Z`, review due is `2026-10-04T02:05:39.311Z`, and expiry is `2026-10-10T02:05:39.311Z`. No reviewer, operator, key, approval reference or signature is filled in or invented. These deadlines cannot be extended silently; if review due passes before approval, prepare a fresh bounded proposal for real review.

The concrete reviewer/operator disposition still requires:

1. Authenticate the two human role-to-key bindings and external trust-store provisioning through a trusted process; establish a protected verifier workflow outside candidate-controlled code and configuration.
2. Refresh primary advisory/upstream evidence, the complete audit, exact five-node versions/integrities and whole-lock hash. Confirm there are no additional physical copies or production graph paths.
3. Review source-bound lint/plugin entry points and the absence of customer-controlled glob inputs. Confirm actual runtime image inventories, including the full-install migration image, and decide whether tooling exposure and mitigations are acceptable. Current source inspection does not prove shipped-image absence.
4. Pin the concrete reachability/mitigation evidence, exact reviewed source digest and deadlines. Have the authenticated reviewer and operator sign the same complete purpose-bound request independently.
5. Review the concrete signed registry diff before applying it. Re-run the complete mandatory audit and security gates; preserve all accepted findings and expiration dates in release evidence. Until those steps are complete, the registry stays empty and release remains blocked.

No dependencies or lock bytes are changed by this mechanism, and no live, shipped-artifact, authenticated governance or production acceptance is claimed.
