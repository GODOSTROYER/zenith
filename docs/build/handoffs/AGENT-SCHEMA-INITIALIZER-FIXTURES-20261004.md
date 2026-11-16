# Agent schema initializer fixture correction, 2026-10-04

The disposable agent initializer completed root-owned cold PostgreSQL setup,
reapplication, canonical verification, incompatible-role refusal and ledger-tamper
refusal on the coherent source tree `df9aedc92fe9bdd173a571e543391a02bdba754f`.
Its separate model run failed five existing initializer cases. The unchanged
production initializer and its canonical migrations are outside this correction.

The SQL protocol fixture matched the role subqueries inside the membership query
before matching its outer `pg_auth_members` query. That returned modeled role rows
as memberships and prevented valid models from reaching migration or verification.
The fixture now checks the outer membership query first. Existing refusal,
rollback, verifier, ledger and close assertions are retained.

The actual Node/tsx linkage refusal produced the exact fixed diagnostic followed
by the SQLite experimental import warning. A test-only child preload now suppresses
only the exact SQLite warning text with the `ExperimentalWarning` type. Every other
warning is forwarded to Node's original emitter. The original CLI case retains
exact status, signal, empty stdout and fixed stderr equality, including the secret
canary refusal assertion. The executable and CI invocation are unchanged.

Two additive child-process controls use the real executable and refused hosted
target. They emit a different experimental warning or the same SQLite text with
an ordinary warning type. Each requires the exact warning block once, allowing
only its child PID to vary, and requires every remaining stderr byte to equal the
unchanged diagnostic. Neither control opens a database or invokes migration IO.

The original 42 expanded case identities are unchanged; the two added controls
bring this modeled and module-linkage suite to 44. These fixtures do not establish
native PostgreSQL authority, hosted identity, provider permissions or worker
acceptance. Platform907, PostgreSQL80 and the 22 packaged check identities are
unchanged. Root's failed model report and all prior initializer receipts remain
retained.

Author execution remains unrun: no project imports, tests, compiler, lint,
database, Docker, services, install or commits. Independent source review and the
root-owned affected model rerun remain required. The separate Kubernetes onboarding
finding remains open: tenant-scoped secret storage does not currently bind a stored
credential to the requested API server and CA, so positive verification has not
been added.
