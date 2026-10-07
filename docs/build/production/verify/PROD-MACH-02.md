# PROD-MACH-02 Kubernetes guest credentials: verification notes

Built only. Executed here: `tsc --noEmit` and `eslint` on every changed file. No vitest, kind, Postgres or cluster run.
Platform migration version used: 35.

## 1. Audit (what existed)

- Guest (machine) sessions: `src/lib/machines/sessions.ts` asks the platform broker for a Kubernetes session; `src/lib/platform/credentials.ts` resolved the tenant's vault reference and used it as-is (a token or kubeconfig the tenant supplied, bound to the stored server/CA by `vault-target.ts`). Scope was whatever the tenant's own identity could do; Zenith neither minted nor limited it, and revocation only stopped Zenith from reading the vault value (the cluster identity lived on).
- Verified earlier slice (tests/machines/kubernetes-kind.test.ts, default-kubernetes-session.test.ts): the tenant-supplied-token path, broker/vault/machine-session wiring, SQL revocation recheck. Left untouched.
- No per-binding ServiceAccount/Role, no TokenRequest in product code (only in the kind fixture), no cluster-side revocation.

## 2. What was built

Default resolution is the new connection mode `scoped_guest` (`KubernetesConnectionConfig.mode`). `connection.createKubernetes` now DEFAULTS to it (`scopedGuest` defaults true, optional `guestAudiences`); saving legacy `kubeconfig_ref` needs an explicit admin `scopedGuest: false`, and the plan shows a warning. The CLI create handoff and the connection view (`guestCredentials` identity line, rotate panel callout) state the default. The vault credential of such a connection is a namespaced MINTER, never a guest credential.

Flow per machine dispatch (`sessions.ts` -> broker `withSession` with new `CredentialRequest.kubernetesGuest {namespace, profile}`):
1. Namespace comes from the machine target id, must be in the connection allowlist and not `kube-system|kube-public|kube-node-lease`; profile is `read` (container.list/inspect/logs) or `exec` (everything exec based).
2. `assertMinterNotOverprivileged`: SelfSubjectAccessReview as the minter must be DENIED for `*/*`, cluster roles/bindings create, kube-system secrets, kube-system pods/exec, kube-system serviceaccounts/token.
3. Binding row (`platform.k8s_guest_bindings`, one per workspace+connection+namespace+profile) ensured in SQL; refused if the connection is revoked or the binding is revoking/revoked. On first use the minter must also hold the create/get/update/delete rights it needs.
4. ServiceAccount `zg-<hash16>-<profile>` + Role (exact verbs, no wildcards, no secrets: read = pods get/list + pods/log get; exec adds pods/exec create,get) + RoleBinding in that single namespace, labelled with an opaque tenant+connection hash. Foreign objects with the same name are refused (`object_conflict`); out-of-band Role widening is reverted on the next mint.
5. TokenRequest (600 s minimum, 3600 s ceiling, audiences from `guestAudiences` or the API-server default). Token claims are checked (subject, ServiceAccount uid, non-empty audience, expiry bound) before use.
6. `recordIssuance` updates the row only while `status='active'` AND the connection is not revoked, in one SQL statement; otherwise the token is discarded.
7. The session handed to the machine driver carries only the guest token, the connection's own server/CA, `namespaces=[that namespace]`, expiry = min(token, grant, 15 min). The minter never leaves the broker block.

Refusals (all `CredentialDeniedError reason=guest_credential_refused`, fixed messages, audit event `credential.denied`): over-privileged/insufficient/rejected minter, missing namespace, foreign object conflict, bad token, revoked binding, cluster error, scope outside allowlist, any non-guest use of a scoped_guest connection (deploy/observe provider paths, the test credential adapter). There is no fallback to the minter, a kubeconfig, a runner identity or cluster-admin.

Revocation (LIFE-01): `repos.connections.revoke` and `revokeAudited` now flip open bindings to `revoking` in the same transaction as the connection revoke, so nothing can mint from that commit on. `revokeConnection` (`src/lib/connections/service.ts`) then calls `revokeKubernetesGuestBindings` which deletes RoleBinding, Role, ServiceAccount (only objects carrying the tenant hash label) with the minter and marks rows `revoked`. Deleting the ServiceAccount invalidates already-issued tokens at the API server. Cluster failure leaves rows `revoking` (still unmintable), reports `guestBindings.pending` and a customer step, and a repeat revoke retries (idempotent).

MACH-05 custody: tokens exist only in worker memory inside the broker callback; the binding table has no credential column (only stable snake_case error codes); errors are fixed strings (no provider text); runner-mode connections are still refused by the broker; revoked connections never reach a mint (SQL gate) and never fall through to another connection; model-visible machine results go through the existing sanitizer, and guest tokens never enter them.

Files (new): `src/lib/providers/kubernetes/guest.ts`, `guest-store.ts`, `src/lib/controlplane/db/migrations/0035_k8s_guest_bindings.ts`, `src/lib/controlplane/db/repos/k8s-guest-bindings.ts`, tests listed below.
Files (edited): `src/lib/credentials/types.ts` (mode, `guestAudiences`, `kubernetesGuest`, `guest_credential_refused`), `src/lib/platform/credentials.ts`, `src/lib/machines/sessions.ts`, `src/lib/providers/kubernetes/vault-target.ts` (accepts scoped_guest minter kubeconfigs, same binding rules), `src/lib/controlplane/db/repos/connections.ts` + `repos/index.ts` + `migrations/index.ts`, `src/lib/connections/service.ts` + `schemas.ts` (rotate minter ref), `src/lib/actions/defs/connection-kubernetes.ts` (create/verify accept scoped_guest).

Verified behaviour touched: `vault-target.ts` guard now also admits `scoped_guest`; `Repos.connections.revoke` is now a transaction (same result). kubeconfig_ref behaviour and its tests are unchanged.

## 3. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| tenant-scoped | per workspace+connection hashed names/labels, single-namespace token, SQL tenancy on every store call, allowlist and system-namespace refusal | `tests/providers/kubernetes/guest.test.ts` (names, namespaces), `tests/controlplane/k8s-guest-bindings.test.ts` (tenancy), `tests/machines/scoped-guest-session.test.ts`, kind "foreign namespace", "read-only token" |
| least privilege | exact Role rules, no secrets/wildcards, minter over-privilege refusal, Role drift revert | `guest.test.ts` (roles, minter scope), kind: SelfSubjectAccessReviews as the guest token, drift test |
| short-lived, audience-bound tokens | TokenRequest 600..3600 s, claims verified | `guest.test.ts` (claims, audiences, clamp), kind token claims |
| revocable | same-commit binding revoke, cluster deletion, in-flight token death, new dispatch refused | `k8s-guest-bindings.test.ts` (revoke/revokeAudited), `scoped-guest-session.test.ts` revocation, kind revocation (expects HTTP 401 for the held token) |
| never falls back to higher privilege | every failure is `guest_credential_refused`; test adapter, deploy/observe and legacy paths refused for scoped_guest | `scoped-guest-session.test.ts` (no fallback cases), kind "cannot create the RoleBinding" |
| LIFE-01 wiring | revokeConnection, repo revoke, rotate minter ref, create/verify actions | `scoped-guest-session.test.ts`, `k8s-guest-bindings.test.ts` |

## 4. Verification commands (other machine)

```
npx vitest run tests/providers/kubernetes/guest.test.ts tests/controlplane/k8s-guest-bindings.test.ts tests/machines/scoped-guest-session.test.ts
npx vitest run tests/machines tests/platform/credentials-verification.test.ts tests/providers/kubernetes tests/connections tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts
# Postgres lane for the store: ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/controlplane/k8s-guest-bindings.test.ts
# kind (disposable cluster, same gate as the existing guest kind test):
ZENITH_TEST_KIND=1 KUBECONFIG=<abs private> ZENITH_TEST_KIND_GUEST_CLUSTER=zenith-<n> ZENITH_TEST_KIND_RELEASE_IMAGE=<repo@sha256:..> npx vitest run tests/machines/kubernetes-guest-scoped-kind.test.ts
```
Expected: all pass; the kind file is skipped without `ZENITH_TEST_KIND=1`. `scoped-guest-session.test.ts` models ONLY the Kubernetes API (vi.mock of `createGuestClusterPort`); `guest.test.ts` models cluster and store; neither is cluster evidence.

## 5. Known gaps and shared-file updates

- Kind test fixture-only question (not a product claim):  the minter Role pins `bind`/`escalate` on `roles` to the two guest role names (RBAC privilege-escalation prevention). If the API server returns 403 on Role/RoleBinding create, widen those two rules to unpinned `bind`/`escalate` in the fixture only; the product code needs no change.
- `pods/exec` lists `get` and `create` because the WebSocket upgrade is authorized as `get` on older API servers.
- Legacy `kubeconfig_ref` connections keep serving deploy/observe, but guest (machine) sessions are now REFUSED in `sessions.ts` (`MachineOperationError denied`, message starts `guest_credential_refused` with migration guidance) and the vault value is never read. Conversion: `connection.rotate` patch `{ convertToScopedGuest: true, credentialRef: <new minter ref> }` (admin, human-only, audited like every rotate); the candidate is verified as a minter (over-privilege and sufficiency probes) and only then promoted. `connection-rotations.stage` allows exactly this one mode change. Verified-behaviour change: tests/machines/default-kubernetes-session.test.ts and tests/machines/kubernetes-kind.test.ts exercise guest sessions with `kubeconfig_ref` fixtures through the real provider and will now see the refusal; both are now re-baselined: positive cases use scoped_guest fixtures (default-kubernetes-session.test.ts models only the Kubernetes API; kubernetes-kind.test.ts creates a per-connection namespaced minter on the real cluster), each keeps a legacy-refusal case, and the empty/reduced namespace cases now assert refusal before any mint instead of an empty-scope session. The 401 case now asserts the real API rejecting the minter leads to a denied dispatch. tests/bridge/connection-kubernetes.test.ts and tests/controlplane/kubernetes-connection-link.test.ts inputs now pass `scopedGuest: false` to keep covering the legacy create path.
- A scoped_guest connection serves machine (guest) sessions only. Deploy/observe providers (Kubernetes drivers, observability source) calling the broker with it are explicitly refused.
- In-flight tokens: SQL stops new issuance atomically; already issued tokens die when the ServiceAccount is deleted (kind test waits up to 20 s for API-server propagation) or at expiry (<= the session lifetime). A cluster outage during revoke leaves rows `revoking` until the revoke is repeated; no scheduled retry was added.
- The minter is trusted to be namespaced by SelfSubjectAccessReview probes (six denied checks, create/get/update/delete required per namespace); it is not an exhaustive RBAC audit.
- Migration 35 leaves a 30-34 gap until the assembler fills the other versions; `tests/controlplane/migrations.test.ts` contiguity will fail until then.
- Shared files for the orchestrator: migrations inventory (`k8s_guest_bindings`, version 35, RLS enabled, service_role select/insert/update), `tests/controlplane/tenancy.test.ts` and controlplane-sql-scoping (workspace-keyed table, all `repos.k8sGuestBindings.*` take workspace_id; `markConnectionRevoking` and `ensure` also read `platform.provider_connections` by workspace_id), `supabase/migrations` emit, gate manifest (add the three vitest files to the machine/guest cohort and the kind file to the kind cohort), LIMITATIONS (items above), PROGRESS, ledger.
- Store functions: `ensure`, `get`, `listOpen`, `listForConnection`, `markActive`, `recordIssuance`, `recordError`, `markConnectionRevoking`, `markRevoked`, `markRevoking`.

## 6. Suggested ledger implementationStatus

`implementation_complete_verification_pending`: default scoped_guest path (per-binding ServiceAccount/Role/RoleBinding, TokenRequest, same-commit revocation + cluster cleanup) built and wired to broker, machine sessions and connection admin; modeled and kind tests written, none executed.
