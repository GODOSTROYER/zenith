# K8S-CONNECTION-JOIN: one Kubernetes connection, two separated roles

Branch `prod/k8s-conn-w4b` from `ad78c593`. Built only. Executed here: `npx tsc --noEmit -p .` (clean) and `npx eslint` on every changed file (clean). No vitest, kind, Postgres or cluster run.
Platform migration: NONE needed. The connection `config` is JSON and `assertNoSecretKeys` allows `...Ref` names; version 46 stays unused.

## 1. Problem and decision

MACH-02 made `scoped_guest` the default mode, and its vault credential is a namespaced MINTER. LIFE-07 deploy/observe goes through the same broker and was refused for `scoped_guest` (`guest_credential_refused`), so one cluster needed two connections (one `scoped_guest` for guests, one legacy `kubeconfig_ref` for deploy/observe).

Decision: a `scoped_guest` connection carries an optional SECOND credential part, the deployer:

- `credentialRef` (unchanged): the minter. Used only for guest sessions, guest-binding lifecycle and minter verification.
- `deployerCredentialRef` + `deployerScope` (`namespaced` default, or `cluster`): used only by the deploy/observe broker path (the same `withSession` that the DUR guard chain reaches: authority/intent, semantics re-check, custody, effect record, then provider call). The broker picks the vault reference by request purpose.
- Absent deployer part = guest-only connection; deploy/observe refused with the new denial reason `deployer_credential_refused`.

Legacy `kubeconfig_ref` behaviour is exactly as MACH-02 left it (deploy/observe yes, guest refused, convert via rotate).

## 2. What was built

New: `src/lib/providers/kubernetes/deployer.ts` (policy: scope type, fixed-message `DeployerCredentialError`, `verifyDeployerCredential` over the existing SelfSubjectAccessReview port).

Edited:
- `src/lib/credentials/types.ts`: `deployerCredentialRef`, `deployerScope` on `KubernetesConnectionConfig`; `DenialReason` `deployer_credential_refused`.
- `src/lib/platform/credentials.ts`: `kubernetesVaultSession(..., part)`; deploy/observe path for scoped_guest uses the deployer reference only (target binding via `assertVaultKubeconfigTarget` applies to the deployer too); no deployer part, missing vault value, equal refs or any failure = `deployer_credential_refused`, never the minter; guest path unchanged and never reads the deployer; `verifyConnection` verifies each part with its own credential (`verify_minter`, then `verify_deployer`), the connection verifies only if all parts do; `assertSeparateCredentials` refuses a deployer whose resolved value equals the minter's.
- `src/lib/connections/schemas.ts`: rotate patch `deployerCredentialRef`, `deployerScope`, `removeDeployer`, and for conversion `retainLegacyAsDeployer` (the legacy broad credential keeps serving deploy/observe as the deployer; it can never be the minter). Deployer equal to minter refused.
- `src/lib/connections/service.ts`: connection view `deployerCredentials`; `revokeConnection` reports `deployer: { revoked: true }` and a customer step for the deployer's vault secret.
- `src/lib/actions/defs/connection-kubernetes.ts`: `connection.createKubernetes` accepts `deployerCredentialRef` and `deployerScope` (scoped guest only, different from the minter), plan text, verify preview ignores them in the saved-target check.
- `src/app/(product)/platform/connections/connection-admin.tsx`: rotate panel fields (deployer reference and scope), retain-legacy-as-deployer checkbox on conversion, explanatory callout.

Verification demands (`deployer.ts`): every allowlisted namespace must allow get serviceaccounts, list pods, get and patch deployments (apps). A `namespaced` deployer must also be DENIED `*/*`, create clusterroles and clusterrolebindings, get kube-system secrets, exec in kube-system, serviceaccounts/token in kube-system. A `cluster` deployer skips the denial probes. System namespaces and an empty allowlist are `scope_refused`.

## 3. Acceptance mapping

| Requirement | Implementation | Tests |
| --- | --- | --- |
| one connection serves both roles | deployer part on scoped_guest; LIFE-07 deploy/observe accepted when the deployer part exists and the connection is verified (verification demands the deployer verify) | contract "observe and deploy get the DEPLOYER credential"; kind test 1 |
| separated privileges, no fallback either way | purpose-selected vault reference; guest never reads deployer; deployer path never reads minter; guest failure never falls to deployer; no deployer = refusal | contract: "a guest session ... never reads or uses the deployer", "no deployer part", "deployer vault value missing", "a guest failure never falls back", target-binding case; kind test 1 SelfSubjectAccessReviews both ways |
| namespaced vs cluster per declared scope | `deployerScope`, over-privilege probes only for `namespaced` | contract "declared namespaced but holding cluster-wide power", kind test 2 |
| LIFE-01 create | `connection.createKubernetes` inputs and plan | rotation-patch contract tests cover shared validation (action itself unchanged in flow) |
| LIFE-01 verify both | `verifyConnection` loop over parts, per-part detail | contract "verification covers both parts" (6 cases) |
| LIFE-01 rotate | patch schema, candidate verified as BOTH parts before promotion | contract "rotation patch rules" (4 cases incl. verify-then-promote switching deploy) |
| LIFE-01 revoke both atomically | one SQL status flip (and guest bindings to `revoking`) already in one transaction; broker status gate and admission re-read refuse the deployer too; cluster objects of Zenith's exist only for the guest part | contract "revocation ends both parts together"; kind test 3 |
| legacy kubeconfig_ref unchanged | untouched branches; legacy rotate rejects deployer fields unless converting | contract legacy cases |

## 4. Verification commands (other machine)

```
npx vitest run tests/machines/k8s-connection-join.test.ts tests/machines/scoped-guest-session.test.ts tests/machines/default-kubernetes-session.test.ts tests/platform/credentials-verification.test.ts tests/platform/kubernetes-vault-target.test.ts tests/connections tests/bridge/connection-kubernetes.test.ts tests/controlplane/kubernetes-connection-link.test.ts
# kind (disposable cluster, same gate as the MACH-02 kind test):
ZENITH_TEST_KIND=1 KUBECONFIG=<abs private> ZENITH_TEST_KIND_GUEST_CLUSTER=zenith-<n> npx vitest run tests/machines/kubernetes-connection-join-kind.test.ts
```
Expected: pass; the kind file is skipped (not passed) without `ZENITH_TEST_KIND=1`. `k8s-connection-join.test.ts` models ONLY the Kubernetes API, keyed by which credential presented the SelfSubjectAccessReview; it is not cluster evidence.

## 5. Known gaps, behaviour changes, shared-file updates

- Verified behaviour changed: `tests/machines/scoped-guest-session.test.ts` "broker refuses a scoped_guest connection on every non-guest path" now expects `deployer_credential_refused` (was `guest_credential_refused`) for observe without a deployer part; a bad guest scope stays `guest_credential_refused` (case kept in the same test).
- Verification detail for a scoped_guest connection with a deployer is two sentences prefixed by part (`Guest minter:` on failure); a guest-only connection keeps the MACH-02 wording.
- The "no fallback" guarantee is by construction (reference chosen by purpose, `DeployerCredentialError` on any gap), not by inspecting the cluster. Same-identity detection compares the resolved vault values (and refs); two different tokens of one ServiceAccount are not detected as the same identity. The minter's own over-privilege probes still prevent it from being a deployer in practice.
- The deployer is customer-held: Zenith cannot revoke it cluster-side (no objects to delete); revoke stops Zenith using it and tells the customer to delete the secret and identity. Tokens already issued to in-flight deploy sessions expire within the session lifetime (at most 15 minutes).
- Deployer verification checks a small verb set (get serviceaccounts, list pods, get/patch deployments) per namespace; it is not an exhaustive proof of the rights LIFE-07 actually uses (StatefulSets, CronJobs, PVCs, NetworkPolicies, Jobs). A deployer lacking those verbs verifies and then fails at apply with the provider's own error.
- A connection created before this change has no deployer part; add it with `connection.rotate` `{ deployerCredentialRef, deployerScope? }` (admin, human, audited, both parts verified before promote), or convert a legacy connection with `{ convertToScopedGuest, credentialRef: <new minter>, retainLegacyAsDeployer: "namespaced"|"cluster" }`.
- Not wired: CLI create handoff text still describes only the minter (the `connection.createKubernetes` action accepts the new inputs, so MCP/CLI callers reach it).
- Shared files for the assembler: gate manifest (add `tests/machines/k8s-connection-join.test.ts` to the machine/guest cohort and `tests/machines/kubernetes-connection-join-kind.test.ts` to the kind cohort), ledger/PROGRESS, LIMITATIONS. No migration, no tenancy or SQL-scoping change, no new store functions.

### LIMITATIONS replacement text (assembler)

Replace the sentence "a `scoped_guest` connection serves machine sessions only, so one cluster needs one connection of each kind to be both deployed to and operated on" in the operator behaviour-changes bullet with: "a `scoped_guest` connection serves guests through its namespaced minter and serves deploy and observe only when it also carries a separate deployer credential (`deployerCredentialRef`, declared `namespaced` or `cluster`, verified with the minter and revoked together with it); without a deployer part deploy and observe are refused, and neither credential ever stands in for the other." Append to the MACH-02 entry: "The deployer is customer-held (Zenith cannot delete it cluster-side), its verification probes a small verb set and the namespaced declaration is trusted via SelfSubjectAccessReview probes, not an exhaustive RBAC audit."

## 6. Suggested ledger implementationStatus

`implementation_complete_verification_pending`: single scoped_guest connection with separate minter and deployer parts (purpose-selected credentials, no cross fallback, both parts verified/rotated/revoked, LIFE-07 deploy/observe accepted via the deployer); contract and kind-gated tests written, none executed.
