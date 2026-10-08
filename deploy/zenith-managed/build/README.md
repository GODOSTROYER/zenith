# Owned isolated source builder (J6)

This is the build controller and image toolchain for LIFE-09/10 and MAN-01.
Default composition is an **assembly join**, listed in the three verification
documents. The previous kaniko port remains selected until that join happens.
The new Kubernetes port refuses before launch until its provider profile,
source hand-off and provenance schema are joined. The owned managed builder needs no new migration. Native Kubernetes source custody also needs an assigned additive migration to widen the approved_source_snapshots provider CHECK; that is outside this job.

The entrypoint runs as UID 1000 in an outer pod user namespace. Only UID/GID
mapping helpers may become root inside that namespace. SETUID/SETGID and
allowPrivilegeEscalation are deliberate, bounded prerequisites for RootlessKit;
there is no privileged pod, SYS_ADMIN capability on the outer container,
host mount, host network, insecure entitlement, Unconfined profile or disabled
BuildKit process sandbox. Localhost seccomp/AppArmor profiles and the runtime
class are operator-installed, reviewed prerequisites. A stock kind runtime is
not assumed to support them. Missing profiles, unsupported user namespaces,
PSA rejection or failed probes refuse the build. Do not relax admission or
enable --oci-worker-no-process-sandbox to get a passing run.

Build pods have no service-account token, DNS access or direct egress. A separate
proxy accepts only exact host/IP/port destinations. It dials the configured IP
without tenant-controlled DNS. Use dedicated registry/package mirrors; CONNECT
cannot police application traffic inside TLS or separate virtual hosts sharing
an allowed IP. The proxy is bounded to 128 MiB. Deployment credentials and
control-plane signing keys are never passed to either image.

The entrypoint removes only the fixed Kubernetes API discovery variables that kubelet injects even with service links disabled. The existing strict environment guard then rejects every remaining Kubernetes or cloud credential variable; discovery addresses never reach the daemon or executor.

A trusted, immutable-image probe executes before any tenant source and again
checks its outer prerequisites immediately before execution. It tests mapped
user IDs, token/environment absence, root/source write denial, metadata and
direct egress denial, proxy denial, positive registry reachability through the proxy and direct registry denial, cgroup limits and a real scratch BuildKit
RUN with full PID/mount isolation. The build is pinned to that probe's node.
The controller checks **all** NetworkPolicies in both namespaces, exact proxy
configuration/readiness, runtime, source bytes, pod image IDs and launch
ownership before and after execution. Drift, unreadable objects, extra pods,
injected mounts/credentials and unknown outcomes refuse release.

BuildKit attaches SLSA v1 provenance. The controller reads the published OCI
index, image manifest, attestation manifest and statement by digest and verifies
their bytes and links. The existing LIFE-09 signer then binds reviewed source,
archive/recipe, builder identity and resulting digest using its existing key.
Existing release admission verifies that signature; built images already require
attested provenance in createPlatformReleaseSafety.

The source hand-off remains capped at 700 KiB. The small C fixture avoids
embedding a multi-megabyte Go HTTP binary in that archive. Source Secrets are
retained because the source name is shared by simultaneous operations in one
environment; no unsafe per-build deletion is attempted. The operator must prune
unreferenced immutable source Secrets after durable build records and Jobs have
expired. Quotas fail closed when full.

Only contract and native Windows pure tests ran in this worktree. No Docker,
kind, browser, PostgreSQL, Temporal or live cloud acceptance is claimed.

