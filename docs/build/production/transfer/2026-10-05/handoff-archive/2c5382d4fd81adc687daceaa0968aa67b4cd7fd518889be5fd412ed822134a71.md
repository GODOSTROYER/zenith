# WS-K8S-IDENTITY — Kubernetes identity grants become RBAC and cloud workload identity

Workstream: WS-K8S-IDENTITY (new; orchestrator brief) — Branch ws/k8s-identity — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-k8s-identity
Base: platform/integration

## Situation
The Kubernetes provider's `identity` driver renders only a ServiceAccount; the node's `grants`
(target + verbs, from expansion) are not translated into anything (WS-K8S report). Workloads on a
cluster therefore get no least-privilege access to in-cluster objects or to cloud services.

## Objective
- In-cluster grants (targets that are Kubernetes objects, e.g. a Secret or ConfigMap the workload
  reads): namespaced Role + RoleBinding with exact resourceNames and verbs; never cluster-scoped;
  never wildcard resources/verbs.
- Cloud grants (targets that are cloud resources while the workload runs on a managed cluster):
  annotate the ServiceAccount for the cluster's workload identity mechanism — EKS IRSA
  (`eks.amazonaws.com/role-arn`) / Pod Identity, GKE Workload Identity (`iam.gke.io/gcp-service-account`),
  AKS Workload Identity (`azure.workload.identity/client-id` + pod label) — referencing the identity the
  cloud provider's identity driver created (by published attribute, never by guessing names). If the
  cloud side does not exist in the graph, render nothing for that grant and emit a note.
- Server-side apply ownership rules stay (field manager `zenith`, refuse foreign objects).

## Owned paths
src/lib/providers/kubernetes/** ; tests/providers/kubernetes/** .

## Tests
RBAC exactness (no wildcards, namespaced, resourceNames), each cloud mechanism's annotations from a
fixture graph, missing cloud identity → note not guess, apply against the fake API server, prune of
stale Roles/Bindings owned by Zenith only.

## Verification
- npx tsc --noEmit ; npx eslint src/lib/providers/kubernetes tests/providers/kubernetes
- npx vitest run --maxWorkers=2 tests/providers/kubernetes tests/providers/zenith
