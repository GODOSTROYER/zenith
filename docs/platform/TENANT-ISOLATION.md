# Tenant isolation: two untrusted tenants, resource isolation under load

Status: PROD-MAN-04 and PROD-MAN-05. The policy generators, the gate and the acceptance
suite are built and unit tested. **No live acceptance run has happened**: the suite is
written to run on a kind cluster on the verifier's machine and has not been run. Live
managed-cluster acceptance is deferred by the user. Every number marked *provisional* is
a safety starting point, not a measured or priced commitment.

Read this with `docs/platform/MANAGED-PLATFORM.md` (the baseline) and
`deploy/zenith-managed/README.md` (what the operator installs).

## 1. What is built

| Piece | Where | State |
| --- | --- | --- |
| Per-tenant baseline: Namespace with Pod Security `restricted`, default-deny NetworkPolicy, allow-platform policy, ResourceQuota, LimitRange (now with ephemeral-storage defaults and ceilings), `zenith-tenant` ServiceAccount | `src/lib/providers/zenith/tenancy.ts`, `plans.ts` | existed; LimitRange gained ephemeral-storage |
| Metadata and private-range exclusion on the only public egress rule | `tenancy.ts` (`PRIVATE_IPV4_RANGES` includes `169.254.0.0/16`) | existed |
| Hostname egress allowlist (Cilium `toFQDNs`) with a metadata deny that beats any allow | `isolation-bundle.ts` (`renderIsolationBundle`), `isolation-profile.ts` | new |
| Sandbox RuntimeClass hook: stamped on every tenant pod, any other value refused by the gate | `render.ts` (`withPodDefaults`), `isolation.ts` rule `runtime_class`, `ZENITH_MANAGED_RUNTIME_CLASS` | new |
| Pod placement rules: no `priorityClassName`, `nodeName` or wildcard toleration | `isolation.ts` | new |
| System-priority quota (zero pods of `system-*` classes) | `isolation-bundle.ts` | new |
| Operator separation: one ServiceAccount, one namespaced Role and one by-name namespace grant per tenant; a static cross-tenant analysis; a per-tenant credential reference | `isolation-bundle.ts` (`renderIsolationBundle`, `validateOperatorAccess`, `analyzeOperatorSeparation`), `substrate.ts` (`substrateConnectionConfig`) | new |
| Operator script that prints a tenant's bundle for the bootstrap identity | `scripts/isolation/render-tenant-bundle.ts` | new |
| kind acceptance with two adversarial tenants and a noisy-neighbour load test | `tests/isolation/`, `scripts/isolation/` | new, gated, not run |
| RuntimeClass and bootstrap RBAC examples | `deploy/zenith-managed/optional/` | new, never applied |

Configuration (all optional; with none set the substrate renders exactly what it did before):
`ZENITH_MANAGED_FQDN_ENGINE`, `ZENITH_MANAGED_EGRESS_FQDNS`, `ZENITH_MANAGED_RUNTIME_CLASS`,
`ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX` (see MANAGED-PLATFORM.md, Configuration).

## 2. Threat model

Assets: another tenant's data, secrets, availability and hostnames; the node and the
cluster; the cloud account behind the nodes; the platform's own credentials.

Adversary: **a tenant who runs arbitrary code of their choosing** in their own namespace
and who controls what their manifests ask for. Mutually untrusting tenants, free-plan
signups included.

| # | Threat | In scope |
| --- | --- | --- |
| T1 | Tenant code reaches another tenant's pods or services over the network | yes |
| T2 | Tenant code reaches node services, the API server, cloud metadata or the internal network | yes |
| T3 | Tenant asks for a privileged, host-mounting, root, capability-adding or scheduler-gaming pod | yes |
| T4 | Tenant exhausts CPU, memory, disk or PIDs so a neighbour degrades | yes |
| T5 | Tenant holds Kubernetes credentials (a stolen workload or operator token) and reads another tenant's secrets or storage | yes |
| T6 | Tenant hijacks another tenant's hostname or route | yes |
| T7 | Tenant exfiltrates data to arbitrary internet hosts | partly: hostname allowlist narrows it, DNS and shared-IP channels remain (section 4) |
| T8 | Tenant escapes the container to the node kernel | **not stopped by namespaces or policy**; this is what a sandboxed runtime is for (section 5) |
| T9 | Compromise of the platform operator or bootstrap identity | out of scope for tenants, but its blast radius is stated (section 7) |
| T10 | A malicious image (supply chain) | out of scope here (digest pinning and registry rules are elsewhere) |

## 3. Claim, mechanism, proof

"Proof" is two things and they are kept apart: the generator and gate tests (no cluster,
run in the normal suite) and the live suite (a real API server and CNI, not yet run).

| Claim | Mechanism | Unit proof (`tests/providers/zenith/`) | Live proof (`tests/isolation/tenant-isolation-acceptance.test.ts`) |
| --- | --- | --- | --- |
| Tenants cannot reach each other (T1) | default-deny both directions, ingress only from the gateway namespace | `tenancy.test.ts` | pod-IP and service-name probes both ways, same-namespace unlabelled probe, gateway control |
| No node, API server or metadata access (T2) | the public egress rule excludes private, link-local, CGNAT and configured cluster ranges; in hostname mode no address rule exists and a metadata deny beats any allow | `tenancy.test.ts`, `isolation-bundle.test.ts` | real listeners on a metadata address and on public-looking addresses; kubelet and API server probes; the public control proves the block is specific |
| Hostname-only egress (T7) | CiliumNetworkPolicy `toFQDNs`, TCP 443 only; refused when the engine cannot enforce it | `isolation-bundle.test.ts` | allowlisted, unlisted, wildcard and name-that-resolves-to-metadata cases (Cilium profile only) |
| Pod security (T3) | namespace label `pod-security.kubernetes.io/enforce: restricted`; the gate lints the same fields; placement fields refused | `isolation.test.ts`, `isolation-bundle.test.ts` | twelve adversarial pods refused by the API server, one control admitted, a system-priority pod refused by quota |
| Quota and limits (T4) | ResourceQuota (compute, ephemeral storage, object counts, no LB or NodePort), LimitRange ceilings and defaults | `tenancy.test.ts`, `isolation-bundle.test.ts` | over-ceiling containers, a pod past the CPU quota, 25 secrets past 20, LB, NodePort, PVC on a plan with none |
| Resource isolation under load (T4) | CFS quota, memory cgroup OOM kill, kubelet ephemeral-storage eviction, kubelet `podPidsLimit`, requests as CPU shares | plan constants checked | all four exhaustions at once from tenant A while tenant B's p95 latency is measured against a baseline |
| Operator separation (T5) | per-tenant operator ServiceAccount, namespaced Role, by-name namespace grant, per-tenant credential reference | `isolation-bundle.test.ts` (validator mutations, static cross-tenant analysis) | `can-i` matrix and real tokens: works in its own namespace, refused for the other tenant, cluster scope, kube-system, escalation and exec |
| Secret and storage separation (T5) | no token mounted, no role bindings for the workload identity; claims are namespaced; hostPath refused | `isolation.test.ts`, `substrate.test.ts` (object prefixes) | workload token reads nothing; a pod naming B's claim never gets it |
| Route and hostname hijack (T6) | routes rewritten under the tenant's managed suffix; gate refuses foreign hostnames and parents | `isolation-bundle.test.ts`, `render.test.ts` | operator A refused HTTPRoute create and namespace patch in B (the Gateway API CRDs are not installed on kind, so attachment itself is not exercised live) |

A namespace is a name scope. Nothing above relies on a namespace alone: each row names the
enforcing component, and the live suite includes an optional **unbounded control**
(`ZENITH_TEST_ISOLATION_CONTROL=1`) that runs the same load in a namespace with no quota or
limits and records the neighbour's latency without asserting it, so the difference is visible.

## 4. Hostname egress, honestly

A Kubernetes NetworkPolicy matches IP addresses, not names. A hostname allowlist exists only
where the CNI implements one.

| Engine | Hostname policy | Zenith |
| --- | --- | --- |
| Cilium | `CiliumNetworkPolicy` `toFQDNs` (`matchName`, `matchPattern`), `egressDeny` | **rendered** (`ZENITH_MANAGED_FQDN_ENGINE=cilium`) |
| GKE Dataplane V2 (Cilium based) | its own `FQDNNetworkPolicy` kind | not rendered; use the Cilium kinds only if your cluster exposes them |
| Calico open source, AWS VPC CNI network policy, Azure NPM, kube-router, Weave | none | **refused**: a hostname request is an `unsupported` error, never widened to an address range |
| Calico Enterprise / Cloud | domain-based egress in its own API group | not rendered; not refused silently: choose `none` and use address rules |

Residual risks that remain in hostname mode and are not hidden:

- **DNS is open to the cluster resolver for every name.** A tenant can encode data in query
  names (DNS tunnelling). Cilium's DNS proxy sees it; Zenith renders no DNS name filter.
- **The allowlist matches the addresses a name resolved to, not the name a connection
  asked for.** Anything else hosted on a shared IP (a CDN) that the allowlisted name also
  uses is reachable. TLS SNI and HTTP Host are not inspected.
- **A name that resolves into a private or metadata range** is blocked only because of the
  rendered `egressDeny` over `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::/32` and
  `100.100.100.200/32`. Other private ranges are not in the deny (denying them would
  also deny cluster DNS on some Cilium versions); the live suite checks the metadata
  case with a name that really resolves there. Set `ZENITH_MANAGED_INTERNAL_CIDRS` and
  review Cilium's behaviour for your version before relying on more.
- Cilium learns resolved addresses for a TTL; a direct connection to an address a
  neighbour pod recently resolved can succeed.
- IPv6 and UDP (QUIC) are not opened: only TCP 443.

Cloud metadata is blocked in three independent places, and an operator should use all of
them: the NetworkPolicy range exclusion and the Cilium deny rendered here; the node's own
metadata hardening (IMDSv2 with hop limit 1, GKE metadata concealment or Workload Identity,
Azure IMDS restrictions: verify the current setting for your cloud at install time); and no
workload credential mounted in a pod.

## 5. Sandboxed runtime, evaluated against the threat model

The baseline stops T1 to T7 on the assumption that the container boundary holds. T8 (kernel
escape) is a different failure: every tenant on a node shares one Linux kernel, so a kernel
or runc vulnerability gives a tenant that node and every other tenant on it. Pod Security,
seccomp `RuntimeDefault` and dropped capabilities shrink the reachable syscall surface; they
do not remove it.

| Option | Boundary | Against T8 | Costs and constraints | Fit |
| --- | --- | --- | --- | --- |
| runc, `restricted` PSS, seccomp `RuntimeDefault` (today's baseline) | shared kernel, namespaces + cgroups + seccomp | weakest: one kernel bug is one escape | none | acceptable for one trusted party, **not** for mutually untrusting arbitrary code |
| runc + user namespaces (`hostUsers: false`) | shared kernel, container root is unprivileged on the host | reduces the impact of an escape that needs real root; does not stop it | needs a recent Kubernetes and runtime and a supporting filesystem; not rendered here | a worthwhile addition; not a substitute |
| gVisor (`runsc`) | user-space kernel intercepts syscalls; the host kernel sees a small, fixed surface | strong against kernel-bug escapes in the syscall surface; the sentry itself is code to trust | syscall and feature gaps (some `/proc`, raw sockets, unusual ioctls), overhead on syscall- and network-heavy work, no nested virtualization needed | good first choice for HTTP services and workers that are compatible; test your workload mix |
| Kata Containers (QEMU, Cloud Hypervisor or Firecracker back end) | one lightweight VM per pod, own guest kernel | strongest of the practical options: an escape needs a hypervisor bug | needs hardware virtualization on the node (bare metal or nested virtualization), higher memory overhead, slower start, some feature limits (host volumes, some device passthrough) | the choice when workloads need full Linux compatibility with a hard boundary and the node pool can offer virtualization |
| Dedicated node pool per tenant or per plan | tenant does not share a kernel with others | removes T8 *between tenants* by removing the sharing | cost scales with tenants; scheduling and quota per pool | the cleanest answer for paid tiers; combines with any of the above |

Recommendation (provisional, a decision for whoever operates the platform, **not approved
here**): for the free and shared tiers, mandate a sandboxed RuntimeClass (gVisor where the
workload mix is compatible, Kata or a Firecracker-backed Kata where it is not and the cloud
offers virtualization); keep runc-only for trusted single-owner clusters and dedicated node
pools. Which clouds offer which runtime on managed Kubernetes changes; confirm it for the
target cloud when choosing, and record the result next to the substrate configuration.

What Zenith provides today is the **hook and the enforcement**, not the runtime:

- `ZENITH_MANAGED_RUNTIME_CLASS=<name>`: every tenant pod is rendered with
  `runtimeClassName: <name>`; a tenant pod naming any other class, or any class when none is
  mandated, is an `isolation_violation`. The operator installs the RuntimeClass and the
  runtime on the nodes (examples in `deploy/zenith-managed/optional/`).
- The live suite runs a pod under the class when `ZENITH_TEST_ISOLATION_RUNTIME_CLASS` is
  set and records what the pod sees; kind has no sandbox runtime, so on kind that check is
  recorded as skipped and never as passed.
- Not proven: that a given runtime defeats a given escape. That is the runtime's own
  security record, not something Zenith tests.

## 6. Resource isolation, and what is not bounded

| Resource | Bound | Mechanism | Not bounded |
| --- | --- | --- | --- |
| CPU | per container (LimitRange ceiling, default limit) and per namespace (quota) | CFS quota; requests give a CPU-share guarantee to a neighbour | CPU cache, memory bandwidth and SMT sharing between tenants on one node |
| Memory | same | memory cgroup, OOM kill of the offender | page cache and kernel memory attributable to a pod are only partly charged to it |
| Ephemeral disk | container ceiling and default limit, namespace quota | kubelet eviction of the pod that exceeds its limit (periodic, so a burst can briefly overshoot) | disk **IOPS and bandwidth**; inode exhaustion on the node filesystem |
| PIDs | per pod | kubelet `podPidsLimit` (set it: `kubeletConfiguration`, shown in `deploy/zenith-managed/optional/kubelet-pids.yaml`) | a node without the setting has none; the live suite fails on purpose |
| Pod and object counts | quota: pods, services, secrets, configmaps, PVCs, zero LB and NodePort | API-server admission | API request rate (use API Priority and Fairness per workload identity) |
| Scheduling priority | a tenant cannot set `priorityClassName`; zero pods of `system-*` classes by quota | gate + quota | a tenant's pods still compete for node capacity with equal priority |
| Network | none for bandwidth | | per-pod bandwidth, conntrack table, ephemeral ports |
| Shared services | none | | CoreDNS query load from one tenant can slow every tenant's lookups |

Where a noisy neighbour matters commercially, the answer is dedicated node pools and
per-pool quotas, not tuning namespaces.

The load test (`describe "noisy neighbour"`): tenant A (free plan) runs a CPU burner, a
memory allocator, a disk writer and a fork bomb together; tenant B runs a small HTTP server
and its latency is measured through the gateway namespace before and during the load.
Pass conditions: B drops no request, B's p95 is at most
`max(baseline p95 x FACTOR, baseline p95 + ABS_MS)` with `FACTOR` 5 and `ABS_MS` 250 (both
**provisional**, overridable), B's pod never restarts, no node goes NotReady; each hog is
bounded by its own mechanism (CPU held to its limit, memory hog OOM killed, disk hog
evicted, fork bomb held to the per-pod PID ceiling). kind runs everything on one machine,
so a pass shows the controls hold at that scale; it is not a capacity statement.

## 7. Operator separation

Two identities, never one:

- **Bootstrap** (`deploy/zenith-managed/optional/41-tenant-bootstrap-rbac.yaml`, placeholder):
  creates namespaces and RBAC for a new tenant. RBAC cannot scope namespace creation, and
  creating Roles needs `escalate`/`bind`, so this is the most powerful credential and it must
  be held only by platform automation, never reachable from tenant code, rotated, audited. It
  holds **no** access to Secret values.
- **Per-tenant operator** (rendered by `renderIsolationBundle`): ServiceAccount
  `zenith-system/zenith-op-<tenant namespace>`, a Role in that namespace only (the same
  resources as the platform-wide ClusterRole, minus anything RBAC or exec related), and a
  ClusterRole limited by `resourceNames` to `get`/`patch` of that one namespace. The Zenith
  session for a tenant resolves the credential reference
  `<ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX>/<tenant namespace>`, so a session for
  tenant A cannot hold tenant B's authority even if the application's own namespace
  allowlist were bypassed.

Tokens for the per-tenant ServiceAccount are minted by the platform with the TokenRequest
API (short-lived) and stored under the prefix; minting and rotation is **not built** here
(join below). Until `ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX` is set, sessions still use the
platform-wide operator credential and the bundle's notes say so on every render.

What this does not change: the platform operator and bootstrap credentials are still
cluster-powerful. Compromise of platform automation is compromise of every tenant; the
separation protects tenants from each other and from a compromised *session*, not from a
compromised *platform*.

## 8. Joins (other requirements build the pieces these attach to)

| Join | Needed from | State |
| --- | --- | --- |
| Apply the isolation bundle on environment create | MAN-01 (substrate) apply path with the bootstrap identity: `renderZenithEnvironment(...).isolation` carries the validated objects in apply order (`bundleObjects`); the Kubernetes provider's apply set deliberately does not contain Cilium or RBAC kinds | **not wired**: use `scripts/isolation/render-tenant-bundle.ts` or the acceptance suite until then |
| Mint and rotate per-tenant operator tokens into the vault prefix | MAN-01/MACH-02 credential brokering | not built |
| A manifest field that carries a tenant's allowed hostnames | MAN-02/03 serving: `ZenithRenderInput.egressFqdns` accepts them today; nothing in the manifest or UI sets it | not wired |
| Mandatory sandbox for a plan tier | commercial decision (not approved); the substrate flag is per cluster | decision open |
| Dedicated node pools per tier | MAN-01 placement | not built |
| Object storage with prefix-scoped credentials | MAN-0x object store; refused today (`object-store.ts`), prefixes derive and are tested for non-overlap | not built |

## 9. Operator checklist before a second tenant

1. A CNI that enforces NetworkPolicy; run the live suite on a cluster like yours.
2. Pod Security Admission enabled (namespaces carry `enforce: restricted`).
3. Kubelet `podPidsLimit` set; eviction thresholds set so node-level disk pressure evicts the
   offender, not a neighbour.
4. Cloud metadata hardened at the node (section 4), independent of NetworkPolicy.
5. A sandbox RuntimeClass chosen (section 5) or a written reason to run runc only.
6. Per-tenant operator credentials in use (`ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX`), the
   bootstrap identity held by automation only.
7. A hostname engine if tenants must be restricted by name; otherwise accept "public addresses
   on 443" and say so to tenants.
8. Quotas reviewed per plan (the numbers are provisional).

## 10. How to run the proof

```
scripts/isolation/tenant-isolation-acceptance.sh kind-calico    # all but hostname egress
scripts/isolation/tenant-isolation-acceptance.sh kind-cilium    # adds hostname egress (set the Cilium pins first)
```

See `docs/build/production/verify/PROD-MAN-04-05.md` for expected results and what may fail
first.
