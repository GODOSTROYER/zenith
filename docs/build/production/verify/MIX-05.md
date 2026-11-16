# MIX-05 local target verification

Implementation complete for the J15 local harness; verification pending. No engine or live cloud was run on this PC. No schema/migration change.

Built: `scripts/release/local-kubernetes.ts`, `local-environment.ts`, `local-mixed.ts`, `local-pebble.ts`, `local-targets.ts`, `local-target-runner.ts`; `deploy/acceptance/local-targets/**`; fixture TLS file support and Pebble challenge server.

Acceptance mapping: existing connectivity contracts cover CIDR overlap and approval-bound endpoint declarations. Local mixed target checks ClusterIP-only PostgreSQL, certificate authentication denial, mTLS denial without a peer certificate, successful authenticated traffic and independent direct readback. ACME target performs CoreDNS HTTP-01 and validates an issued certificate's hostname/key and HTTPS trust chain. Tests: `tests/release/local-targets.test.ts`, `tests/acceptance/local-targets.engine.test.ts`, `tests/execution/mixed/connectivity.test.ts`, `tests/acceptance/mixed-connectivity-probe.test.ts`.

Exact Mac setup, env vars, run and cleanup commands: [mixed and Pebble profiles](../../../../deploy/acceptance/local-targets/README.md). Run the mixed Lambda block (2 passed/2 intentionally skipped engine cases), then the ACME block (1 passed/3 intentionally skipped). Expected direct target receipts: all four mixed connectivity/traffic checks and all three ACME checks passed, evidenceLabel local_rehearsal. Missing prerequisites fail or skip explicitly, never pass.

Limits: no actual cross-cloud network, VPN, peering, public DNS or cloud identity. NetworkPolicy is emitted; kindnet alone does not enforce it. J11 must supply the policy-capable CNI for packet-isolation proof. Zenith's connectivity declaration resources still need provisioning in the owning compiler job; this local fixture setup does not fill that production gap. Existing live probes and protected-endpoint approval contracts remain unchanged and gated.

Suggested ledger status: implementation_complete_verification_pending. Assembly joins: J11 CNI/image digests; J1/J2 full approval/default journey. No test expectation, gate or assertion was weakened.
