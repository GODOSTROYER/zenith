# Builder-facing blockers, 12 October 2026

Fresh source verification is pending after integration of the reviewed diagnostic and fixture shutdown fixes. CFB core and CI are green; full scenario acceptance is still open.

- J4: earlier default machine-schedules attempt failed after initial natural jobs; exact API/billing boundary cause remains unproven. The old stack is fully removed. Use a new database/epoch/namespace and the fixed-code private diagnostic on the fresh run; do not reuse mutated state.
- J1/J2: continuation, real Chrome dual-user TOTP/MFA, second-person approval, axe at1280/375, and native kind acceptance remain pending behind fresh J4 and witness receipts.
- MACH-03/MACH-04 and later recovery/driver scenarios need actual owned authenticated fixtures; focused mocks or CI do not replace these journeys.
- PKG-04: current Docker VM is7.75GiB versus12GiB prerequisite. Protected builder restart remains unapproved; preserve the gate.
- COST-03: actual gap-free168-hour trusted meter window cannot be manufactured or compressed.
- LIFE-10 managed PostgreSQL password readback and MACH-02 token-lifetime acceptance need builder implementation/evidence. Historical MinIO marker provenance is unresolved.
- Live cloud, spend, real DNS, private GitHub App/source, business/security exceptions and production signoff remain outside authorization.

Owned cleanup completed with19 resources removed/zero remaining; two forced stops are recorded. AirPlay remains temporarily off for remaining port5000 tests; restore the original on setting after those tests. No CA trust has been added. Keep release flags false and ledger10/66/2. Retain original failures and their exact source bindings.
