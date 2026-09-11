# Operator access policy and compromise drill (G26)

Prepared 2026-09-07 by W11 against `ffb2753` on `zenith/hosted-r3`.

G26 is `Unverified` and **no code can close it**. It is a set of things a
person must do and record. This file is that checklist, unfilled: every box is
`[ ]`, every owner is `unknown`, and every date is `unknown`.

Two honesty rules for whoever fills it in:

- Tick a box only when the thing is **true right now**, not when it is
  planned. A ticked box is evidence in the register.
- A single-founder operation cannot separate every duty. Where separation is
  impossible today, write that down instead of pretending — an honest
  "one person holds all four roles, compensating control: X" is auditable; a
  ticked box that is aspirational is not.

Scope: the accounts and credentials that can reach hosted customers' apps,
data, source or backups. It does not cover the local development machine
except where a credential on it also opens production.

## 1. Roles and separation

Four credential roles, from `R3-05` and register row G25 (scoped tokens per role).
Each must be a **separate credential**, not the same token used four ways.

| Role | May do | Must never | Held by | Separate credential? |
| --- | --- | --- | --- | --- |
| **Control** | Operate the control service, read/write the authority, manage grants | Run submitted code; hold the backup key | `unknown` | `[ ]` |
| **Build** | Run the pinned recipe, read one submitted source, write one artifact | Read the control database, platform secrets, other tenants' sources or the publisher credential | `unknown` | `[ ]` |
| **Publisher** | Verify artifact bytes and activate a release | Build; read customer records | `unknown` | `[ ]` |
| **Recovery** | Decrypt and restore backups | Be stored on the control host, or be the same key as `ZENITH_SECRET_KEY` | `unknown` | `[ ]` |

- `[ ]` The four roles are enumerated with a named human owner each.
- `[ ]` Where one person holds several roles, that is written down with the
  compensating control.
- `[ ]` No credential grants more than its role needs (least privilege
  reviewed, not assumed).
- `[ ]` The Cloudflare token, if one is ever issued, is account-scoped and
  read-limited to what the runtime needs — the existing inspection harness
  requires only **Workers Scripts Read**.
- `[ ]` The build credential cannot reach the control origin or a cloud
  metadata endpoint (tested, not assumed).

## 2. Multi-factor authentication

- `[ ]` MFA enforced on the source-control account (GitHub).
- `[ ]` MFA enforced on the identity provider account (Supabase).
- `[ ]` MFA enforced on the hosting account, once one exists.
- `[ ]` MFA enforced on the DNS registrar.
- `[ ]` MFA enforced on the backup-storage account.
- `[ ]` MFA enforced on the email-sending account.
- `[ ]` Recovery codes for each are stored somewhere that survives losing the
  primary device, and **not** on the control host.
- `[ ]` No shared logins. If one exists, it is named here: `unknown`.

Enforced on: `unknown`. Verified by: `unknown`. Date: `unknown`.

## 3. Credential inventory

One row per credential that can reach customer data, source, backups or DNS.

| Credential | Provider | Scope | Where stored | Rotation interval | Last rotated | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `ZENITH_SECRET_KEY` | self | Workspace secret store | `unknown` | `unknown` | `unknown` | `unknown` |
| `ZENITH_BACKUP_KEY` | self | Backup decryption | `unknown` — must be off the control host | `unknown` | `unknown` | `unknown` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Full project access | `unknown` | `unknown` | `unknown` | `unknown` |
| `ZENITH_CF_API_TOKEN` | Cloudflare | `unknown` | not issued | `unknown` | n/a | `unknown` |
| `E2B_API_KEY` | E2B | `unknown` | not issued | `unknown` | n/a | `unknown` |
| `ZENITH_SMTP_URL` | email provider | Send | `unknown` | `unknown` | `unknown` | `unknown` |
| `ZENITH_POLICY_SHARED_SECRET` | self | Gateway↔policy | `unknown` | `unknown` | `unknown` | `unknown` |
| `ZENITH_EVENTS_SALT` | self | Subject pseudonymisation | `unknown` | `unknown` — **rotating it breaks cohort continuity**; decide before the first pilot | `unknown` | `unknown` |
| Host / DNS / registrar logins | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` |

- `[ ]` Every credential above has a real row, not a placeholder.
- `[ ]` No credential appears in a repository, a screenshot, a chat message, a
  CI log or an evidence file.
- `[ ]` `ZENITH_BACKUP_KEY` is provably different from `ZENITH_SECRET_KEY`.
- `[ ]` Losing any single credential has a written recovery path.
- `[ ]` **Known limitation, unchanged:** the existing secret store has no
  rotation tooling and no re-wrap command — values written under an old
  `ZENITH_SECRET_KEY` cannot be read back. A rotation plan must account for
  that, not assume it away.

## 4. Access review

- `[ ]` A list exists of every human who can reach production customer data.
- `[ ]` Review cadence agreed: `unknown`.
- `[ ]` Last review: `unknown`. Reviewer: `unknown`.
- `[ ]` Departure procedure written (revoke, rotate, confirm): `unknown`.
- `[ ]` Contractors and agents, if any, are on the list.
- `[ ]` Automated agents operating on this repository are listed with their
  permissions.

## 5. Support access to customer data

- `[ ]` It is written down that an operator **can** read customer app records
  in plaintext, and the customer has been told.
- `[ ]` The conditions under which an operator may do so are defined.
- `[ ]` Customer consent requirement decided: `unknown`.
- `[ ]` Every support access is logged with who, when, which app, why.
- `[ ]` Logs are **off-host**. A local append-only file is not tamper-resistant
  and must never be described as such (`ATT-TRUST-02`, `not started`).
- `[ ]` The customer is told after the fact: `unknown`.
- `[ ]` Support access is reviewed at the cadence in §4.

Nothing in this section is implemented. The hosted event table records product
events, not operator reads.

## 6. Audit evidence

- `[ ]` Grant changes, revocations, releases and restores are recorded in the
  authority.
- `[ ]` The revocation ledger reaches the off-host target on every revocation,
  and a failure to append is surfaced rather than swallowed.
- `[ ]` Audit records survive a host loss.
- `[ ]` It is stated, in customer-facing text, that on-host audit files are
  not tamper-proof.

## 7. Credential-compromise drill

Run this before a real customer, not after an incident. Record the result as
an acceptance record
([template](evidence/acceptance-record-template.md)).

**Scenario A — a provider token leaks (Cloudflare, E2B, SMTP, S3).**

- `[ ]` Detect: how would you know? Written answer: `unknown`.
- `[ ]` Revoke the token at the provider.
- `[ ]` Issue a replacement with the same narrow scope.
- `[ ]` Confirm the service reports the capability as *blocked* while the
  token is absent, rather than degrading into a simulation.
- `[ ]` Check provider logs for use between leak and revocation.
- `[ ]` Record what the attacker could have reached with that scope.
- Time taken: `unknown`.

**Scenario B — the control host is compromised.**

- `[ ]` Assume every value on the volume is disclosed: `state.json`,
  `secrets.json`, `control.sqlite`, per-app databases, artifacts.
- `[ ]` Confirm `ZENITH_BACKUP_KEY` was **not** on that host, so the backups
  are still confidential.
- `[ ]` Rotate `ZENITH_SECRET_KEY` — and confront the no-re-wrap limitation in
  §3 before, not during, the incident.
- `[ ]` Terminate every app session and platform session.
- `[ ]` Rebuild on a clean host from a backup taken **before** the compromise
  window, using [RUNBOOK-DEPLOY.md](RUNBOOK-DEPLOY.md) §6.
- `[ ]` Reconcile revocations; leave unconfirmed grants `needs_reapproval`.
- `[ ]` Notify affected customers. Trigger and wording: `unknown`.
- Time taken: `unknown`.

**Scenario C — the recovery key is lost.**

- `[ ]` Confirm what is unrecoverable: **every backup**. There is no fallback.
- `[ ]` Confirm the custody arrangement that would have prevented it.
- `[ ]` Write down the second custody location and who can reach it:
  `unknown`.

**Scenario D — an operator account is taken over.**

- `[ ]` Reset the account, invalidate sessions, check MFA enrolment.
- `[ ]` Review every action that account took in the window.
- `[ ]` Confirm the audit trail for that review exists off-host — today it
  does not.
- Time taken: `unknown`.

## 8. Status

| Item | State |
| --- | --- |
| Roles separated | Not done |
| MFA enforced everywhere | Not verified |
| Credential inventory complete | Not done |
| Access review performed | Never |
| Support access logged | Not implemented |
| Off-host tamper-resistant audit | Not implemented |
| Drill run | Never |

G26 remains `Unverified`. Reaching `locally verified` needs a filled-in
inventory, an enforced-MFA confirmation and at least Scenario A and Scenario C
run with recorded times. Reaching anything stronger needs the independent
assessment in G35, which agent review does not satisfy.
