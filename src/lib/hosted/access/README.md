# hosted/access — who may open an app

Grants, invitations, exchange codes and app sessions. The rule this directory
exists to hold is PLAN-R3 R3-02: `app_grants` is the *only* authority on
access. No workspace membership, no `app_metadata` claim and no cached copy
adds, restores or upgrades it. That is what makes a revoke stick.

`index.ts` is the barrel every other workstream imports. It may gain exports;
it may never change one.

| File | Owns | Must not |
| --- | --- | --- |
| `index.ts` | The public surface: grants, invites, sessions, identity, and `registerAccessOutboxHandlers()` for boot | Re-export `http.ts` — the gateway and the job runner import this barrel and have no business pulling the request layer in behind it |
| `grants.ts` | Granting, listing, changing role and revoking. An app never loses its last owner, and the owner count is read inside the same transaction as the write. A revoke is one transaction: state change, session termination, ledger append, outbox row and event | Check the owner count outside the transaction, or leave a revoked grant whose sessions are still serving pages |
| `invites.ts` | Hashed, single-use, 48-hour invitations. The token is returned to the owner once and never stored in clear. Acceptance is bound to the *verified* address the invitation names | Show a link again ("resend" mints a new token and kills the old one); distinguish "unconfirmed email" from "different email" in the refusal; send inside the transaction |
| `sessions.ts` | The 60-second exchange code, the opaque app session behind it, and the `__Host-zenith_app` cookie. Neither value is stored — only SHA-256 of each. `resolveAppSession` re-reads session and grant every time | Let a platform cookie reach an app host; allow a code presented against the wrong app or state to be replayed (a mismatch consumes and stays consumed). `TODO(ceiling):` — nothing sweeps expired exchange and session rows; they are denied on read |
| `identity.ts` | The authoritative check: a live `auth.getUser()` round trip, required before anything that grants, revokes, invites, accepts or opens an app (R3-10, G13) | Return an identity it did not get from the provider. **Unavailable is never a pass**: no provider, a network error, a 5xx or a rate limit all answer `policy_unavailable` (503); only a positive "not signed in" answers 401. `TODO(ceiling):` — one round trip per grant-sensitive request, deliberately uncached |
| `seal.ts` | AES-256-GCM over the invitation token, under `ORRERY_SECRET_KEY`, for as long as one delivery row is outstanding. The invitation id is the AAD | Import `@/lib/secrets` — that store is a JSON file of workspace secrets and has no business being reachable from app access |
| `mail.ts` | Putting an invitation in front of a person, through a non-literal `nodemailer` specifier so neither `tsc` nor the bundler resolves it at build time | Claim a mailbox received anything. "Sent" means the SMTP server accepted the message, and nothing more |
| `internal.ts` | The shared primitives: secure random values, email normalisation, `subjectHash()`, and the one denial sentence | Let a stranger, a revoked grant and an under-privileged viewer get different messages — anything that told them apart would answer "does this person have a grant on this app?" for whoever asked. Never write a subject into an event |
| `http.ts` | The `/api` layer: `hostedRoute` over `route()`, the body reader, `signedInUser()` (a verified JWT — enough to read an access list) and `verifiedIdentity(req)` (the live check — required to change anything) | Be imported from `index.ts`, or be treated as interchangeable with `signedInUser`. It imports `@/lib/server/context`, which is one of the repository's three open import cycles — see docs/MODULE-MAP.md |
