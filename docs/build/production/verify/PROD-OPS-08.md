# PROD-OPS-08: Independent adversarial security acceptance

Branch `prod/ops-08-w5`, base c02c097e. Build only: nothing here was executed. `tsc --noEmit` and `eslint` on the
changed files are clean; the vitest files below must be run on the verifying machine.

## 1. Summary

New suite under `tests/adversarial/`, one file per threat class, plus the threat model
`docs/platform/ADVERSARIAL-ACCEPTANCE.md`. Eight narrow fixes for vulnerabilities the suite's cases exposed by reading
the code (the tests assert the fixed behaviour, so each fix is also its regression test).

Files added:

- `tests/adversarial/cross-tenant.test.ts`
- `tests/adversarial/role-escalation.test.ts`
- `tests/adversarial/approvals-forgery.test.ts`
- `tests/adversarial/ssrf-rebinding.test.ts`
- `tests/adversarial/prompt-injection.test.ts`
- `tests/adversarial/malicious-archives.test.ts`
- `tests/adversarial/token-forgery.test.ts`
- `tests/adversarial/build-exfiltration.test.ts`
- `tests/adversarial/integration-compromise.test.ts`
- `docs/platform/ADVERSARIAL-ACCEPTANCE.md`

Source changed (all narrow): `src/lib/portability/net.ts`, `src/lib/alerts/webhook-policy.ts`,
`src/lib/alerts/deliver.ts`, `src/lib/execution/prober.ts`, `src/lib/hosted/source/validate.ts`,
`src/lib/hosted/backup/bundle.ts`, `src/lib/portability/artifact.ts`, `src/lib/execution/build-isolation.ts`.

No migration, no new table, no new dependency, no workflow or gate-manifest change made. No shared-file edits.

## 2. Findings

| # | Where | Severity | Finding | Fix |
| --- | --- | --- | --- | --- |
| F1 | `src/lib/portability/net.ts:47` `classifyAddress` | High | The connection guard for tenant-supplied hosts (MySQL, Postgres, S3 endpoint, DNS engines) classified NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 `2002::/16`, IPv4-compatible `::a.b.c.d`, IPv4-translated, Teredo/`2001::/23`, `2001:db8::/32`, `100::/64`, `3fff::/20` and `fec0::/10` literals as public, so `64:ff9b::a9fe:a9fe` (metadata) and `64:ff9b::7f00:1` (loopback) passed. Under the private-range opt-in, AWS IMDSv6 `fd00:ec2::254` and Alibaba metadata `100.100.100.200` were allowed. IPv4 documentation, protocol-assignment and 6to4-relay ranges were public; benchmarking space was public. | These ranges now classify as `never` (benchmarking `198.18/15` as `private`); both metadata addresses are `never`. The webhook and probe guards already refused them; the three guards now agree and are tested against one independent oracle. |
| F2 | `src/lib/alerts/webhook-policy.ts:~425-445` `blockedCategory` | Low | `fec0::/10`, `2001::/23`, `100::/64`, `3fff::/20` and IPv4-translated `::ffff:0:a.b.c.d` were not blocked for alert webhook targets. | Added as non-relaxable categories. |
| F3 | `src/lib/execution/prober.ts:78` `BLOCKED` | Low | IPv4-translated `::ffff:0:0:0/96` was a public address for probes. | Added to the block list. |
| F4 | `src/lib/hosted/source/validate.ts:~279-293` `validateSource` | Medium | Tenant source tarballs accepted names colliding under case-folding or Unicode normalisation (`src/A.ts` and `src/a.ts`, NFC and NFD) and a path that is both file and directory. On a case-insensitive filesystem the second write wins, so disk differs from the pinned digest; the file-under-file case surfaced as an unclassified raw filesystem error during materialisation. | Both are refused with `unsupported_source` and the offending paths. |
| F5 | `src/lib/hosted/backup/bundle.ts:49,136-141` `unpackBundle`, `NAME_RE` | Low | A restore container with a duplicated file name and a matching count passed validation (one file written twice, another missing); a manifest without a file table threw a raw `TypeError`; names with `.` segments aliased other names. | Duplicate names and a missing file table are refused with the container's error; `.` and `..` segments are refused. |
| F6 | `src/lib/portability/artifact.ts:14` `ARTIFACT_NAME` | Low | `a/./b` aliases `a/b`: two distinct manifest names for one location. | `.` segments refused like `..`. |
| F7 | `src/lib/execution/build-isolation.ts:112` `profileFor` | Low | `__proto__` and `constructor` resolved to inherited objects, failing later with a `TypeError` instead of the typed refusal. Fail-closed but off-contract. | Own-property lookup only. |
| F8 | `src/lib/alerts/deliver.ts:~222` `slackBody` | Low | Alert titles, details and close reasons went into Slack mrkdwn unescaped, so attacker-influenced text could page a channel (`<!channel>`), mention users or render a link. | `slackEscape` (`&`, `<`, `>`) applied to every interpolated field. |

Observed, not fixed (not narrow, or a documented decision): see "Residual risk and non-goals" in
`docs/platform/ADVERSARIAL-ACCEPTANCE.md`. The ones most worth a follow-up requirement are the hosted launch `state`
not being browser-bound, the platform REST bearer path lacking the MCP origin/authority-kind check, and the
hosted source tar reader's missing terminator and trailing-data checks.

The tests assert the expected-safe behaviour for fixed items. They do not use expected-failure markers.

## 3. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Tenant | route and repository inventories, reflective sweep, edge access classification | `cross-tenant.test.ts` |
| Role, escalation | catalog-generated sweep, admin-only operation matrix | `role-escalation.test.ts` |
| Stale approval, forgery, replay, semantics | broker matrices, grant verifier forgery, digest component mutation | `approvals-forgery.test.ts` |
| SSRF, rebinding | corpus times wrappers over three guards, URL obfuscation, pinned literals, outbound inventory | `ssrf-rebinding.test.ts` |
| Prompt injection | corpus over agent, analysis, broker free text | `prompt-injection.test.ts` |
| Archive | six readers, generated hostile constructions | `malicious-archives.test.ts` |
| Build, exfiltration | child environment, isolation admission, recipe container argv | `build-exfiltration.test.ts` |
| Forgery, audience confusion | mutation operators over every token kind | `token-forgery.test.ts` |
| Integration compromise | webhook, GitHub download, plugin manifest, alert text | `integration-compromise.test.ts` |
| Threat model doc | `docs/platform/ADVERSARIAL-ACCEPTANCE.md` | n/a |

## 4. Verification commands (other machine)

Node 22. PGlite is used everywhere; no external service is needed. POSIX host needed for the webhook block only (it is
skipped with a reason on Windows).

```
npx vitest run tests/adversarial
npx vitest run tests/portability tests/alerts tests/execution/prober.test.ts tests/hosted/source tests/hosted/backup tests/platform/source-bundle.test.ts tests/execution/build-isolation.test.ts
npx vitest run tests/capabilities tests/security tests/controlplane/tenancy.test.ts
```

Expected: all pass. The first command is the new suite. The second and third are the regression neighbourhood of the
eight fixes: if a pre-existing test pinned the old behaviour (for example an address in `198.18/15` or `2001:db8::/32`
treated as connectable by a portability test, or a hosted source fixture with case-colliding names) it needs the fixture
corrected, not the fix reverted.

Things most likely to need a first-run adjustment, because they were written without being executed:

1. `cross-tenant.test.ts` repository sweep depends on `Function.prototype.toString` parameter names surviving the
   transform; it asserts at least 15 functions were exercised and says so if not.
2. `approvals-forgery.test.ts` relies on the harness world key format `${workspaceId}|${userId}` for demotions.
3. `prompt-injection.test.ts` asserts proposal-quality properties only for payloads under 20 kB and excludes the NUL
   category (a NUL makes a file binary and the repository unanalysable).
4. `malicious-archives.test.ts` `unpackBundle` duplicate-name forgery builds raw container bytes from the documented
   layout (`ZBK1`, version byte, u32 manifest length, entries of u16 name length, u64 content length, name, content).
5. `integration-compromise.test.ts` plugin mutation test excludes the single `signature.value` suffix mutation (lenient
   base64 decoding); it expects more than 30 generated mutants.

## 5. Known gaps and shared-file updates for the orchestrator

- No gate-manifest, workflow or ledger edit was made. To run in CI add `tests/adversarial` to the unit lane in
  `scripts/ci/gate-manifest.mjs` (the assembler owns it). The suite is PGlite-only and takes a few minutes: the
  capability sweeps run 700 proposals per store.
- No new table; nothing to add to `src/lib/sensitivedata/inventory.ts` or the tenancy classifications.
- Live acceptance, real DNS rebinding and real GitHub behaviour are not exercised and not claimed.
- The webhook block cannot run on Windows (secret custody checks need POSIX).
- Verified behaviours changed: none intentionally. Behaviour tightened only where the fixes above refuse previously
  accepted hostile input.

## 6. Suggested ledger implementationStatus

`implementation_complete_verification_pending`: nine-file adversarial suite with generated cases, threat model, eight
narrow fixes recorded; unrun pending verifier execution; eight observed residual items recorded as follow-ups.
