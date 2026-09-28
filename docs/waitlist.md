# Waitlist operations

Public intake and account access are separate switches. Both default to off:
collecting waitlist entries does not restrict product access, and enabling the
access gate does not open public intake.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `ZENITH_WAITLIST_ENABLED` | Set to `1` to accept public waitlist submissions. | `0` |
| `ZENITH_WAITLIST_GATE_ENABLED` | Set to `1` to require admission for new accounts. | `0` |
| `ZENITH_WAITLIST_ADMIN_IDS` | Comma-separated immutable Supabase user UUIDs allowed to review and admit entries. | Empty |
| `ZENITH_WAITLIST_EXISTING_USERS_BEFORE` | ISO timestamp defining the existing-account cutoff; required when the gate is enabled. | Unset |
| `ZENITH_WAITLIST_RATE_LIMIT_SECRET` | Private salt of at least 32 characters for client rate-limit keys; required when public intake is enabled. | Unset |
| `ZENITH_WAITLIST_TRUSTED_IP_HEADER` | Optional trusted client-IP header: `x-forwarded-for`, `x-real-ip`, or `x-vercel-forwarded-for`. | Unset |
| `ZENITH_STORE` | Waitlist storage backend: `file` or `postgres`. | `file` |

The operator allowlist is independent of workspace roles. Being a workspace
owner or admin does not grant waitlist administration. Use Supabase user UUIDs,
not email addresses, in `ZENITH_WAITLIST_ADMIN_IDS`.

At activation, set the cutoff to the current UTC timestamp and keep it fixed.
Do not copy an old example date or recompute it on each deployment: a past
cutoff can incorrectly exclude people who have already created accounts.
Accounts created before it retain access regardless of workspace membership.
Accounts created at or after the cutoff need admission, except allowlisted
operators. Accepting a workspace invitation never bypasses the gate. Admission
is checked against the account's verified, canonical email from Supabase, not
a browser-supplied email or stale session claims. The gate requires
`NEXT_PUBLIC_SUPABASE_URL` and server-only
`SUPABASE_SERVICE_ROLE_KEY` so it can call Supabase Auth `getUserById`.

Configure a trusted IP header only behind a trusted proxy that overwrites it.
An untrusted client must not be able to choose its rate-limit identity. Without
a configured header, or when its IP is missing or invalid, submissions share
one conservative **unknown-client bucket of 10 requests per hour**. With no
trusted header this limit is shared across everyone, so configure a trusted,
proxy-overwritten header before opening intake to a wider audience. The global
1,000-requests-per-hour limit also applies. Keep the rate-limit secret private
and consistent across instances.

## Storage and rollout

The waitlist follows `ZENITH_STORE`, independently of `ZENITH_HOSTED_STORE`.
File mode stores entries and counters in a dedicated
`<ZENITH_DATA>/waitlist.sqlite` database. Use a durable data directory for a
single local instance, or Postgres for shared deployment state. Apply
[`supabase/migrations/0009_waitlist.sql`](../supabase/migrations/0009_waitlist.sql)
and then [`supabase/migrations/0010_waitlist_profile.sql`](../supabase/migrations/0010_waitlist_profile.sql)
before using the original intake backend. The administration console also requires
[`0012_waitlist_admin.sql`](../supabase/migrations/0012_waitlist_admin.sql), applied after
0011. The backend uses service-role RPCs. These migrations
are additive and preserve existing entries, positions and admissions. The application
does not apply this migration automatically. **Serverless deployments require
`ZENITH_STORE=postgres`; the runtime refuses file storage on serverless hosts.**

The dedicated SQLite database is independent of the product JSON store and
hosted subsystem backups. Include it explicitly in backup procedures. Use
SQLite's online backup facility, or stop the application cleanly before copying
the database. SQLite uses WAL mode: the `waitlist.sqlite-wal` file may contain
committed data, so copying only the main database while the application is
running can lose queue entries, admissions or retry records.

Before enabling intake, configure storage and the rate-limit secret. Before
enabling the gate, configure Supabase's server credentials, the operator UUID
allowlist and the existing-account cutoff. Enable either switch independently
as needed. Disabling intake stops new submissions; it does not disable the
access gate.

To roll back, first set both `ZENITH_WAITLIST_ENABLED=0` and
`ZENITH_WAITLIST_GATE_ENABLED=0`, then deploy the previous application build.
Retain the additive Postgres tables or dedicated SQLite database to preserve
the queue, admission history and idempotent replay records. Older builds ignore
the new tables; no destructive rollback SQL or data deletion is needed.

## Google identity and product admission

Keep the Supabase **Before User Created** hook enabled at
`pg-functions://postgres/public/zenith_before_user_created` and apply migration
`0013_google_waitlist_identity.sql` after 0012. Google may now establish an Auth
identity and session before admission so the application receives the verified
email. The callback checks admission before creating any workspace or accepting
invitations. Unadmitted identities go directly to /waitlist, where the session
email and name prefill the form. Email is read-only; it is never copied from URL
parameters. The visitor still explicitly submits their waitlist request.

An Auth identity is not a product account with access. Keep
`ZENITH_WAITLIST_GATE_ENABLED=1` and preserve the fixed existing-user cutoff.
The canonical Auth creation time, verified email, operator IDs and admitted
waitlist entries remain the only access decisions. Product pages, API routes,
server actions and agent paths enforce admission. Browser database roles have
no product table or waitlist RPC access. A waiting Google session cannot provision
a workspace, accept an invitation, read tenant data or enter /admin.

The hook trusts only Auth-owned `user.app_metadata.provider = google` with a
nonempty canonical email. It never trusts user_metadata provider claims. Other
new accounts still require an admitted email; password, phone, anonymous and
other-provider creation cannot bypass this rule. Refusals retain the stable
`ZENITH_WAITLIST_REQUIRED` marker and safe redirect behavior. Existing users
and their sessions are unchanged. Approved Google users can continue to Zenith
and set a password in Account.

The migration preserves SECURITY INVOKER, the admitted-only RLS policy, and
Auth-only execution privileges. Supabase must read the same Postgres queue as
the app. Keep global `disable_signup` false so Google can establish identity;
the hook and application gate perform their distinct checks. Privileged Auth
administration remains trusted and never substitutes for product admission.

Deploy the UI and verify the production access gate before applying 0013. Test
Google identity -> waitlist prefill, blocked product/API requests, unchanged
existing access, and admission -> continuation. Never run the destructive
queue contract suite against production. To restore the prior strict signup
policy, reapply 0011 transactionally; retain the application gate and all queue
and identity records. No deletion or cutoff changes are required.

References: [Supabase hook contract](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook),
[hook permissions](https://supabase.com/docs/guides/auth/auth-hooks#security-model).

## Joining and checking access

`POST /api/waitlist` accepts an anonymous JSON submission:

```json
{
  "email": "person@example.com",
  "name": "Alex",
  "occupation": "Software engineer",
  "features": ["Deployments", "Custom workflow"]
}
```

Both this endpoint and `POST /api/admin/waitlist/admit` require JSON requests.
When a browser sends an `Origin` header, it must match the request's origin;
cross-site browser mutations are rejected.

Only `email` is required: it must be valid, at most 254 characters, and is
trimmed and normalized to lowercase. Optional `name` and `occupation` (profession)
accept up to 120 characters each. Optional `features` is an array of up to 12
nonempty strings, each up to 120 characters; preset and custom selections are
accepted, trimmed and deduplicated. The optional legacy `useCase` field accepts
up to 2,000 characters. Omitted profile strings become empty strings and omitted
features become an empty array. Unknown fields are rejected.
The JSON body is limited to 8 KiB. Persistent rate limits allow 10 requests per
client per hour and 1,000 globally per hour. Successful new and duplicate
submissions return HTTP 202 with `{"accepted":true}`, so the endpoint does not reveal
whether an email is already queued or admitted. Duplicate submissions preserve
the original answers, queue position and admission status.

Authenticated users denied access can visit `/waitlist` to see their status,
join using their current account email and optionally share their name,
profession and feature interests. After an operator admits them, they can recheck access on that page.
Public intake must be enabled for new submissions.

No waitlist confirmation emails, admission emails or other notifications are
sent. Operators must arrange any communication separately.

## Reviewing and admitting entries

Sign in as an allowlisted operator and open `/admin`. The former
`/admin/waitlist` address redirects there after the same owner check. The console
provides overview counts, a searchable queue with full profile review, and
approval history. Customer workspace roles never grant platform access.

Choose an individual request, selected people, the next 50, a custom next batch
of 1�1,000, or everyone currently waiting. Every console approval first creates
an actor-bound, persistent preview of exact queued IDs. Approve-all captures the
queue at preview time; later arrivals are excluded. Review the count and sample
of people before confirming. The preview expires after 24 hours. Selected
previews accept 1�1,000 unique entry IDs. An overlapping approval admits only
people still queued, so the final count can be smaller than the preview.

The browser retains the preview and a unique request ID for a pending approval,
scoped to the operator, so a reload can retry the same action. A retry after an
uncertain response must reuse both values. The database returns the saved result
without admitting a second batch, including after the preview expires. A consumed
preview cannot be reused with a new request ID. Approval and audit insertion are
one transaction.

Approval grants access; it does **not** send an email. Admitted new users can
sign in with Google using their approved email, then set a password in Account.
Existing account sign-in remains available. Operators arrange notifications
separately.

### Administration API

Every endpoint verifies the configured platform operator on the server. Mutation
requests enforce same-origin browser access and JSON input. API service-role
credentials remain server-only.

- `GET /api/admin/waitlist?status=queued&limit=100&q=engineer` searches names,
  email, profession, interests and notes. `status` is optional (`queued` or
  `admitted`); `limit` is 1�200 and defaults to 100. `q` is at most 254 characters.
  Results include global counts, the matching count and `nextCursor`. Send that
  immutable queue position as `after` for the next page.
- `POST /api/admin/waitlist/preview` accepts `{"mode":"selected","entryIds":[...]}`,
  `{"mode":"next","count":50}`, or `{"mode":"all"}`. It returns a saved preview ID,
  exact count, creation/expiry times, and the first 100 captured profiles. The
  confirmation uses the entire captured set, not just the displayed sample.
- `POST /api/admin/waitlist/admit` accepts `{"previewId":"UUID","requestId":"UUID"}`.
  Returns a bounded `{count, requestId}` acknowledgment; full profiles stay in
  the saved audit instead of overflowing serverless response limits.
  Generate one request ID per action and preserve it for retries. Expired unused
  previews return `preview_expired`; create and review a fresh preview.
- `GET /api/admin/waitlist/history?limit=50` returns recent saved approval batches
  (maximum 100), including actor, time, mode, requested/admitted counts. Exact IDs remain in the durable batch record.
- `GET /api/admin/waitlist/history/{requestId}?offset=0&limit=100` pages through
  the saved profiles from that approval (`limit` is at most 100), allowing a
  readable review even if the current queue changes. Use `nextOffset` for more.

The legacy `POST /api/admin/waitlist/admit` payload `{"count":100,"requestId":"UUID"}`
remains supported for existing clients, with its original atomic FIFO and retry
semantics. The console uses reviewed previews. History includes both forms.

Apply `0012_waitlist_admin.sql` before deploying these API changes. It preserves
existing entries and audit records, adds preview storage, and revokes browser
access to the new table and RPCs. SQLite upgrades its independent waitlist file
additively on opening. Keep both backends' audit and preview records in backups.
