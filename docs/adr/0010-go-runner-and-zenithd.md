# ADR-0010 — Go for zenith-runner and zenithd; signed outbound protocol

Status: accepted (2026-09-30)

## Decision
Both agents are Go (static binaries, stdlib-heavy, small attack surface),
one module at `go/`. Outbound HTTPS only; server identity verified; client
authentication by per-request Ed25519 signatures (RFC 9421-style) with
optional client-cert mTLS where the control plane can terminate it (a
Vercel-hosted control plane cannot; this is documented, not hidden). Jobs
are compact JWS signed by the control plane, bound to runner id, capability
grant, expiry and nonce. The runner's AWS path is a SigV4 signing proxy with
an action allowlist, so TypeScript drivers are reused unchanged and
credentials never leave the customer network. Protocol:
`docs/platform/RUNNER-PROTOCOL.md`.
