# Data lifecycle, regions and commitments (G27, G36)

Prepared 2026-09-07 by W11 against `ffb2753` on `zenith/hosted-r3`.

This is the document a customer would be shown before putting real data into a
hosted Zenith app. **It is not ready to be shown to anyone.** Most values are
`unknown` because the decisions behind them have not been made, and the two
capabilities it describes — export/import (G27) and published commitments
(G36) — are `Partial` and `Unverified` respectively in the gap register.

Filling a value in here is a commitment. Do not infer one. If a row says
`unknown`, the honest answer to a customer asking that question today is
"we have not decided, and I will tell you when we have."

## 1. What data exists

| Class | Contents | Where it lives | Who can read it |
| --- | --- | --- | --- |
| Identity | Email address, Supabase user id, verified-email state | Supabase Auth project | Supabase; Zenith operators via the dashboard and the service-role key |
| Platform state | Workspaces, members, projects, manifests, revisions, deploys, audit trail, alert channels | `<ZENITH_DATA>/state.json` + `revisions/` on the control volume | Anyone who can read the volume; workspace members through the product |
| Hosted control state | Apps, grants, invites (token **hashes**), invite delivery payloads (encrypted), app sessions, exchanges, jobs, outbox, artifacts index, releases, quotas, usage, revocations, events | `<ZENITH_DATA>/control.sqlite` | Anyone who can read the volume; owners through the product |
| Customer app records | The tracker records a recipient actually types — the equipment requests | `<ZENITH_DATA>/apps/<appId>/app.sqlite` (local runtime) or per-app D1 (Cloudflare runtime) | The app's granted users through the broker; anyone who can read the volume |
| Artifacts | Built frontend bundles, content-addressed | `<ZENITH_DATA>/artifacts/sha256/<digest>/` | Anyone who can read the volume; granted users through the gateway |
| Secrets | Workspace secret values, AES-256-GCM under `ZENITH_SECRET_KEY` | `<ZENITH_DATA>/secrets.json` | The running process; anyone holding the key and the file |
| Backups | Encrypted copies of control and app databases + the revocation ledger | Off-host target — `unknown` | Anyone holding `ZENITH_BACKUP_KEY` and the target |
| Analytics events | Event name, timestamp, workspace, app, **pseudonymous subject hash**, release, outcome, logical id, assisted flag, actor class | `control.sqlite` | Operators |
| Logs | Application and deploy logs | Control volume; host provider's log pipeline — `unknown` | Operators; the host provider |

Two rules the event table must keep (`R3-13`): **no customer record contents
and no secrets in analytics**, and subjects appear only as an HMAC under
`ZENITH_EVENTS_SALT`, never as an id or an email.

## 2. Providers, regions and exposure

| Provider | Role | Region | Data it can see | Status |
| --- | --- | --- | --- | --- |
| Supabase | Authentication (existing project) | `ap-south-1` (Mumbai) — recorded in this project's own operating notes. **Not re-verified from the Supabase dashboard in this session.** Confirm before publishing it to a customer. | Email addresses, user ids, sign-in metadata | In use |
| Control host | Runs the single control process and holds the volume | `unknown` | **Everything in §1 except backups**, in plaintext at run time | Not selected |
| Off-host backup target | Encrypted backups + revocation ledger | `unknown` | Ciphertext only, provided `ZENITH_BACKUP_KEY` is not stored with it | Not selected |
| Cloudflare (Workers for Platforms, D1) | Optional edge runtime | `unknown` | Customer app records and served artifacts, if selected | Not configured; no account |
| E2B | Optional isolated build runner | `unknown` | Submitted source during a build | Not configured; terms unresolved |
| Email provider | Invitation delivery | `unknown` | Recipient email addresses, invitation tokens in transit | Not selected |
| DNS registrar / certificate issuer | Domains and TLS | n/a | Hostnames | Not selected |
| Anthropic | Optional Navigator LLM (`ANTHROPIC_API_KEY`) | `unknown` | Whatever a Navigator prompt contains. **Not on the hosted path**; a recipient's task must never depend on it. | Optional, existing |

**Subprocessor list — template.** A published list needs a row per provider
with an accountable owner and a date. None of these has been reviewed or
agreed.

| Subprocessor | Purpose | Data categories | Region | Contract / DPA | Reviewed on | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| Supabase | Authentication | Identity | `ap-south-1` (unconfirmed) | `unknown` | `unknown` | `unknown` |
| `unknown` (host) | Compute + storage | All | `unknown` | `unknown` | `unknown` | `unknown` |
| `unknown` (backup) | Encrypted backups | Ciphertext | `unknown` | `unknown` | `unknown` | `unknown` |
| `unknown` (email) | Invitation delivery | Email address | `unknown` | `unknown` | `unknown` | `unknown` |
| *(add a row per provider actually used — an unused provider must not appear)* | | | | | | |

## 3. Retention

Every number below is a **proposal**, not an agreed policy, and none is
implemented as an expiry job.

| Data | Retained while | Proposed retention after | Implemented |
| --- | --- | --- | --- |
| Customer app records | The app exists | Deleted with the app | No |
| App grants and sessions | Grant is active | Sessions expire after 12 h (`APP_SESSION_TTL_MS`); revoked grants keep a tombstone for the revocation ledger | Contract only |
| Invites | 48 h (`INVITE_TTL_MS`) | Hash retained for replay refusal; **encrypted delivery payload deleted on acceptance or expiry** | Contract only |
| Write ids / idempotency | 30 days (`R3-08`) | Deleted | Contract only |
| Artifacts | Referenced by the active release, a rollback target, a backup or retention | Cleanup preserves anything still referenced | Contract only |
| Analytics events | `unknown` | `unknown` | No |
| Application and deploy logs | `unknown` | `unknown` | No |
| Backups | Retention window `unknown` — **proposed 30 days** | Expired and unrecoverable | No |
| Revocation ledger | Must outlive the longest backup retention, or reconciliation cannot work | `unknown` | No |
| Exports the customer downloaded | Not held by Zenith | n/a | n/a |

## 4. Deletion

| Question | Answer |
| --- | --- |
| Who may delete an app | The app owner, plus a workspace role check on the control side. Not implemented. |
| What deletion removes | The app record, its grants and sessions, its per-app database and its unreferenced artifacts. |
| What deletion does **not** remove | **Backups already taken.** Deleted data stays in encrypted backups until their retention window expires. This must be disclosed as a window, not described as immediate erasure. |
| Analytics | Events are pseudonymous and are **not** deleted with the app by default; that choice is `unknown` and must be decided before a real customer. |
| Audit and revocation ledger | Kept: a revocation that disappears would let a restore resurrect access. |
| Timeline | `unknown`. |
| Confirmation to the customer | `unknown`. There is no deletion receipt. |
| Authorisation | An in-place destructive restore or deletion over live data requires explicit operator approval (`ATT-OPS-09`, `blocked`). |

## 5. Export and import (G27)

| Item | State |
| --- | --- |
| Bundle contents | Source, artifacts, schema, records and an access manifest (register rows G21 and G27; owned by W8) |
| Format | JSON bundle from `GET /api/hosted/apps/:appId/export`; contract in `CONTRACTS-R3.md` |
| Import | `scripts/hosted/restore.ts` / import into a clean data directory |
| Proven | **No.** The round-trip test is planned, not run. |
| Exit to another provider | A Worker/D1 exit package is unproven. **CSV alone is not portability** — a spreadsheet of records without schema, access and code is not the app. |
| Existing product export | The manifest/Terraform export bundle already exists and is unaffected; do not present it as a hosted-app export. |

## 6. Incident response — template

Nothing here is agreed. These are the fields a commitment needs, with the
values a customer would actually ask for.

| Field | Value |
| --- | --- |
| Accountable person | `unknown` |
| Backup contact | `unknown` |
| Contact channel for customers | `unknown` |
| Hours of coverage | `unknown` — a single founder is not 24/7, and saying so is better than implying otherwise |
| Detection | `unknown`. Existing alert rules cover the infrastructure product, not hosted apps. |
| Severity definitions | `unknown` |
| Time to acknowledge | `unknown` |
| Time to first customer update | `unknown` |
| Notification trigger for a data incident | `unknown` |
| Statutory notification obligations | `unknown` — depends on the region decision in §2 and has not been assessed |
| Post-incident record | `unknown` |

## 7. Support access — template

| Field | Value |
| --- | --- |
| Can an operator read customer app records? | **Yes.** A privileged operator has legitimate plaintext access; at-rest encryption does not prevent it. This must be disclosed, not implied away. |
| Under what conditions | `unknown` |
| Is customer consent required | `unknown` |
| Is access logged | `unknown` — off-host tamper-resistant audit is `not started` (`ATT-TRUST-02`). A local append-only file is **not** tamper-proof. |
| Is the customer told afterwards | `unknown` |
| Review cadence | `unknown` |

See [OPERATOR-ACCESS.md](OPERATOR-ACCESS.md) for the checklist that would make
these answerable.

## 8. Privacy commitments — status

| Commitment a customer would expect | State |
| --- | --- |
| Published privacy policy covering hosted apps | Does not exist |
| Published subprocessor list | Does not exist (template in §2) |
| Stated regions | Control host `unknown`; Supabase unconfirmed |
| Deletion and retention policy | Proposals only (§3, §4) |
| Export guarantee | Untested (§5) |
| Data processing agreement | Does not exist |
| Independent security assessment | Not performed (G35) |
| Statement that Zenith cannot read customer data | **Cannot be made.** See §7 and [THREAT-MODEL.md](THREAT-MODEL.md) §7. A customer who requires it needs a different key-ownership design. |

G36 stays `Unverified` until an accountable owner fills this file in with dates
and the policies are actually published. A template is not a commitment.
