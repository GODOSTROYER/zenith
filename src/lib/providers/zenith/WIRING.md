# Managed database and workload identity wiring

`createVaultDatabaseRuntime` composes the existing Neon adapter with the encrypted
secret backend. Its input is the current workspace/project/environment tuple,
substrate and full graph. Only managed Zenith Postgres addresses are authorized.
Provider create/get/delete calls are checked against that scope before provider
I/O. Workload URI reads use the same backend and scope as the sink.

```ts
const runtime = createVaultDatabaseRuntime(
  { workspaceId, projectId, environmentId, substrate, nodes: graph.nodes },
  { fetch, resolveSecret: resolvePlatformCredential },
);
const session = await openZenithSession(tenant, {
  substrate,
  createKubernetesSession,
  databases: runtime.databases,
});
const result = await applyZenithEnvironment({
  session, expect: { workspaceId, environmentId }, toolkit,
  nodes: graph.nodes,
  resolveSecret: runtime.resolveSecret,
  workloadIdentity: { cluster: clusterAddress, mechanism: "eks-irsa" },
  resolveAttribute: (address, attribute) => publishedAttributes[address]?.[attribute],
});
```

The injected platform credential resolver is distinct from the workload resolver:
operator API keys never become workload values. Neon passes the URI directly to
the encrypted sink; database convergence awaits persistence before baseline,
TLS or workload writes. A failed or conflicting write stops apply with a fixed,
value-free error. Retries preserve the existing URI; dry run makes no Neon call
or vault write. JavaScript strings cannot be securely zeroed.

`renderZenithEnvironment`, `applyZenithEnvironment` and `exportKubernetesBundle`
accept the same optional `workloadIdentity` and synchronous `resolveAttribute`
inputs. Give them the complete current graph and concrete non-secret published
attributes, after cloud apply or reference resolution. This does not create trust,
configure admission webhooks or verify effective cloud access.

The Kubernetes renderer uses its node list for lookup and rendering. The Zenith
adapter therefore passes selected nodes with their forced namespace/managed host
views and keeps all other nodes available for lookup. Unselected managed
Kubernetes/Zenith nodes have a temporary `referenced` ownership view so they do
not render. Cloud nodes retain their original fields. The source graph and
persisted ownership do not change; synthetic reference-skip notes are removed
so they cannot be mistaken for source ownership claims. The tenant isolation
gate remains in force, including its refusal of Kubernetes API tokens and RBAC.

An export's cloud annotations still require cloud-side federation/trust for its
chosen namespace and ServiceAccount. Exporting manifests does not provision that
trust; the notes state that effective access is unverified. Missing, ambiguous,
unresolved or mismatched identity evidence produces no cloud annotation.

Proof is contract-level: real encrypted file storage and Kubernetes rendering,
with fake Neon HTTP and apply adapters. No hosted cluster, live Neon/cloud
credentials or live Postgres were exercised. The default platform worker has no
Zenith session composition root; its owner must call the existing session/apply
APIs with this factory's ports when enabling managed-provider execution.

## Outside-owned-path typecheck blocker

The existing `src/lib/platform/credentials.ts:161` passes `req.purpose`
(`observe | deploy | secret.write`) to `withProviderSession`, whose parameter
accepts only `observe | deploy`. This code is identical in HEAD and was not
changed by WS-ZM-WIRE. The orchestrator should add a guard immediately before
the capability-purpose check at line 150:

```ts
if (req.purpose !== "observe" && req.purpose !== "deploy") {
  return deny("purpose_capability_mismatch", "This provider requires observe or deploy purpose.");
}
```

AWS has already been dispatched at line 139. The guard keeps the non-AWS
session contract narrow; GCP/Azure/Kubernetes secret delivery uses `deploy`
purpose with a `secret.write` grant, as documented in `src/lib/secrets/DELIVERY.md`.
It also rejects unsupported non-AWS purposes before session creation. This fix
must be made by the owner of platform credentials, rather than weakening its
type or editing outside this workstream's ownership.
