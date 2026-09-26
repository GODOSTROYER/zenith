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

Set the cutoff to a fixed ISO timestamp, for example `2026-09-26T00:00:00.000Z`.
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
before using the Postgres backend, which uses service-role RPCs. The application
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

## Joining and checking access

`POST /api/waitlist` accepts an anonymous JSON submission:

```json
{
  "email": "person@example.com",
  "occupation": "Software engineer",
  "useCase": "Deploy and operate an application with my team."
}
```

Both this endpoint and `POST /api/admin/waitlist/admit` require JSON requests.
When a browser sends an `Origin` header, it must match the request's origin;
cross-site browser mutations are rejected.

All three fields are required and trimmed. `email` must be a valid address of
at most 254 characters and is normalized to lowercase; `occupation` accepts
1–120 characters and `useCase` accepts 1–2,000. Unknown fields are rejected.
The JSON body is limited to 8 KiB. Persistent rate limits allow 10 requests per
client per hour and 1,000 globally per hour. Successful new and duplicate
submissions return HTTP 202 with `{"accepted":true}`, so the endpoint does not reveal
whether an email is already queued or admitted. Duplicate submissions preserve
the original answers, queue position and admission status.

Authenticated users denied access can visit `/waitlist` to see their status,
join using their current account email and provide their occupation and use
case. After an operator admits them, they can recheck access on that page.
Public intake must be enabled for new submissions.

No waitlist confirmation emails, admission emails or other notifications are
sent. Operators must arrange any communication separately.

## Reviewing and admitting entries

Sign in as an allowlisted operator and open `/admin/waitlist`. The page lists
entries and provides batch admission controls. The same operations are
available through authenticated API requests. The page saves a pending
admission's `requestId` and `count` in `sessionStorage`, scoped to the operator,
so a reload in the same tab restores the same batch for retry. A confirmed
result clears that pending record. If browser storage is unavailable, the page
warns the operator to keep it open until the batch is confirmed.

`GET /api/admin/waitlist?status=queued&limit=100` lists entries in queue position
order. The optional `status` filter is `queued` or `admitted`. `limit` defaults
to 100 and cannot exceed 200. The response contains `entries`, `total`,
`queued`, `admitted` and `nextCursor`. Use `nextCursor` as the next request's
`after` value when another page is available; it is an immutable positive
numeric queue position.

`POST /api/admin/waitlist/admit` admits the oldest queued entries in a batch:

```json
{
  "count": 100,
  "requestId": "f3c0a9b5-1e47-4ab6-9c2d-04bb60d72e58"
}
```

`count` must be an integer from 1 through 1,000. Generate a fresh UUID
`requestId` for each new batch. If a request times out or its result is unclear,
retry the same payload with the same `requestId`: replay returns the same batch
and does not admit another batch.
