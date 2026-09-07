# Cloudflare edge sources — unverified live

These are the two Workers the `cloudflare` runtime would deploy. **Neither has
ever run on Cloudflare.** No account, namespace or API token exists on this
machine, so nothing in this directory is evidence of anything: it is a written
path with unit tests over its logic, and the seven feasibility gates in
[`docs/hosted/DECISIONS.md`](../docs/hosted/DECISIONS.md#cloudflare-feasibility-gates)
stay open until it is exercised against real resources with two real identities.

They are deliberately **not part of the Next build**. Nothing under `src/`
imports them, and they import nothing from `src/`. `workers/types.d.ts` declares
the four Cloudflare shapes they use so the repository's `tsc --noEmit` still
covers them without adding a dependency.

| File | What it is |
| --- | --- |
| `gateway-worker.ts` | The dispatch worker. Asks the control service's `/api/hosted/policy/admit` about every request and obeys the answer. Denials never invoke a script. |
| `broker-worker.ts` | The fixed broker over D1: the trusted half, uploaded per app, holding the app's only `DB` binding. |
| `types.d.ts` | Ambient declarations for `D1Database`, `Fetcher`, `DispatchNamespace` and `ExecutionContext`. |

## What the gateway worker does

1. Reads the Host header, the path, the `__Host-zenith_app` cookie and `Origin`.
2. `POST`s them to `POLICY_URL` with `authorization: Bearer <POLICY_SECRET>`.
3. On `deny`, answers with the status and code the policy chose. **No dispatch
   script is fetched**, which is the edge's version of the local gateway's
   invocation sentinel.
4. On `serve`, strips `cookie`, `authorization` and every inbound `x-zenith-*`
   header, sets the identity the policy decided, and invokes
   `env.DISPATCH.get(<script>)` — the release script for app paths, the app's
   broker script for `/_zenith/data/v1/*`.
5. Applies the same response guard the control service applies, to the
   dispatched response and to its own.

### The route rule this deployment needs

The worker answers `503 policy_unavailable` for `/_zenith/auth/*`,
`/_zenith/session` and `/_zenith/health`, and says so in the refusal. Those are
control-service pages — the sign-in page, the exchange callback, sign-out, the
session document and the health probe — and this worker will not invent them.
A deployment must route them on the app hostname to the Zenith control service
**ahead of** the dispatch worker. Until that route exists, an app on the
Cloudflare runtime can serve files and data to an already-admitted recipient
but cannot start a session. That is a gap, not a subtlety, and it is listed as
one in this workstream's report.

## What the broker worker does

The same contract as the local broker: list, read, create with write-id replay,
update with a version compare-and-swap and a 409 carrying the current record.
Its SQL is **copied character for character** from
[`src/lib/hosted/data/sql.ts`](../src/lib/hosted/data/sql.ts), and
`tests/hosted/runtime/workers.test.ts` fails if the two ever diverge.

One statement is not shared: `D1_DELETE_WRITE`. D1's HTTP API has no
interactive transaction — a batch is one transaction, but a conditional
`INSERT` that matches no row is not a failure and commits alongside its
neighbours. So when the storage quota refuses a row, the create path issues a
compensating batch that removes the write-ledger row and subtracts the logical
bytes. That compensation is correct on paper and **unproven**: "zero affected
rows do not throw automatically" is exactly the D1 behaviour the decision
record says must be tested against actual D1 before any of this is trusted.

The broker trusts the `x-zenith-subject` / `-email` / `-role` headers, because
only the dispatch worker can invoke it inside the namespace and that worker
deletes any the client sent. **That trust is itself an open gate**: it holds only
if a script in the namespace cannot be invoked directly, which is one of the
"private assets" and "binding isolation" gates.

## Building and deploying (not done here)

Both files are TypeScript. Bundle each to a single ES module before upload —
the platform uploads the *bundle*, never TypeScript — and point
`ZENITH_CF_BROKER_MODULE` at the broker's bundle so `CloudflareRuntime.ensureApp`
can upload it. Without that variable the runtime refuses to create an app
rather than deploying a placeholder.

The release script is not built from these sources: it is the five-line
`RELEASE_WORKER_MODULE` constant in
[`src/lib/hosted/runtime/cloudflare.ts`](../src/lib/hosted/runtime/cloudflare.ts),
which does nothing but hand the request to its `ASSETS` binding. That is the
whole capability an app's own code gets.

## Tests

```powershell
npx vitest run tests/hosted/runtime/workers.test.ts
```

They drive both `fetch` handlers with fake `env` objects: a fake
`DispatchNamespace` that records whether it was asked for a script, and a fake
`D1Database` that records statements and returns canned rows. Passing tests
show the logic is consistent with the control service's. They show nothing
about Cloudflare.
