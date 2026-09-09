# hosted/gateway — the app host's front door

Every request to `<slug>.<ZENITH_APP_DOMAIN>` is rewritten here by
`src/lib/hosted/edge.ts` with its Host header intact, and lands in
`src/app/hosted-gateway/[host]/[[...path]]`. The order below is the contract
(docs/hosted/CONTRACTS-R3.md, "App host surface") and it is the order for a
reason: each step is cheaper and less trusting than the one after it, and the
two steps that touch anything an app produced come last.

```
1 host  2 app  3 state  4 quota  5 authority  6 reserved
7 session  8 release  9 artifact | broker  10 guard
```

Import from `index.ts`, not from a file inside.

| File | Owns | Must not |
| --- | --- | --- |
| `index.ts` | The barrel | Expose a step in a way that lets a caller run it out of order |
| `handle.ts` | The pipeline, in contract order, and every refusal decision in it | Let a dependency double decide anything — `deps.ts` supplies data, `handle.ts` decides |
| `admission.ts` | Steps 1–8, runtime-agnostic and free of `Response` objects, so the same decisions serve both the local runtime and `/api/hosted/policy/admit` for an edge worker with no access to the authority | Return "maybe" — every step throws a `HostedError`. Answer anything the authority cannot answer with a pass; that is a 503 |
| `reserved.ts` | `/_zenith/*`: sign-in page, exchange callback, sign-out, session, health. Checked at step 6, before the artifact lookup at step 9, so an app that ships `_zenith/session` never serves it | Put anything but the sign-in page and the callback outside admission — those two are how a session begins |
| `broker.ts` | `/_zenith/data/v1/requests[...]` — the fixed broker's HTTP surface. Three defences before the per-app store is touched: exact same-origin for mutations, role, then a bounded body read | Run anything an app published. This is what makes "the editable code path holds no data capability" (gate 4) true rather than aspirational |
| `artifacts.ts` | Step 9: serving one file of the active release's artifact, with `HEAD`, byte ranges and ETag — the three ways a careless gateway leaks content to someone it already refused | Run before admission, or serve without incrementing the invocation sentinel |
| `guard.ts` | The single exit: a fixed CSP, `nosniff`, `no-referrer`, `DENY` framing, same-origin opener, a restrictive permissions policy, and an unconditional strip of `set-cookie` / `location` / `link` / `access-control-*` unless the gateway itself set it (marked via `x-zenith-owned`). `private, no-store` except for hashed assets | Make the strip conditional. It is mostly theoretical today and stops being theoretical after one refactor |
| `errors.ts` | Refusals: one JSON envelope for programs, one small page for people, the guard on both, `no-store` always | Read app state or app code — `respondWithError` is reachable from the first line of the pipeline, before the host is known. Let a shared cache be able to replay a refusal |
| `telemetry.ts` | The invocation sentinel: process-wide counters incremented before any artifact byte is read or any `TrackerDataStore` method is called, so a denial test can assert both are zero (G14) | Be read by an admission decision. These exist for tests and a health probe |
| `deps.ts` | The one seam onto the four sibling workstreams — access (W5), quota and events (W8), artifacts (W2), data (W3). Defaults are the real functions | Be called from anything in `src/`; `setGatewayDepsForTests` is the only way anything else gets in. Replace a *decision* rather than data |
