# Privacy, subprocessors and support commitments (G36)

Prepared 2026-09-07 by W11. **Nothing is published, agreed or committed.**

> **Do not fabricate.** Do not write a policy statement here that has not been
> reviewed and published, and do not name a region, retention period or
> subprocessor that has not been decided. A published commitment binds; an
> invented one is a lie a customer can act on.

The substance lives in [../DATA-LIFECYCLE.md](../DATA-LIFECYCLE.md). This file
is the *status* record: what exists, who owns it, when it was published.

## Documents

| Document | Exists | Published at | Owner | Reviewed by | Date |
| --- | --- | --- | --- | --- | --- |
| Privacy policy covering hosted apps | No | `unknown` | `unknown` | `unknown` | `unknown` |
| Subprocessor list | No | `unknown` | `unknown` | `unknown` | `unknown` |
| Data processing agreement | No | `unknown` | `unknown` | `unknown` | `unknown` |
| Terms of service for the pilot | No | `unknown` | `unknown` | `unknown` | `unknown` |
| Retention and deletion policy | No — proposals only | `unknown` | `unknown` | `unknown` | `unknown` |
| Incident response commitment | No | `unknown` | `unknown` | `unknown` | `unknown` |
| Support access disclosure | No | `unknown` | `unknown` | `unknown` | `unknown` |
| Security overview for customers | No | `unknown` | `unknown` | `unknown` | `unknown` |

Legal review of any of the above: `unknown`. None has been obtained, and
nothing in this repository can substitute for it.

## Regions

| Data | Region | Confirmed |
| --- | --- | --- |
| Identity (Supabase Auth) | `ap-south-1` (Mumbai), per this project's operating notes | **No** — not re-verified from the Supabase dashboard in this session |
| Control host: platform state, hosted control state, customer app records, artifacts, secrets | `unknown` | No host selected |
| Backups | `unknown` | No target selected |
| Edge runtime, if used | `unknown` | Not configured |
| Build runner, if used | `unknown` | Not configured |
| Email in transit | `unknown` | No provider selected |

## Commitments a customer will ask for

| Question | Answer today |
| --- | --- |
| Where is my data? | `unknown` for everything except identity, which is unconfirmed |
| Who else can see it? | Zenith operators and the host provider, in plaintext. Disclosed, not designed away. |
| Is it encrypted? | At rest under the backup key for backups; the live database is on the host filesystem. **At-rest encryption is not end-to-end encryption.** |
| Can you read it? | **Yes.** See [../THREAT-MODEL.md](../THREAT-MODEL.md) §7. |
| Can I delete it? | Deletion is not implemented; backups retain deleted data for a retention window that is `unknown` |
| Can I export it? | An export bundle is designed; the round trip has never been tested |
| What happens in an incident? | `unknown` — no named owner, no coverage hours, no notification trigger |
| Who do I call? | `unknown` |
| Are you certified? | No, and a provider's certifications do not transfer to Zenith |

## Rules

- Publish nothing that has not been reviewed.
- State hours of coverage honestly: a single founder is not 24/7, and saying
  so builds more trust than implying otherwise.
- Never claim immediate erasure while backups retain the data.
- Never claim Zenith cannot read customer data under the current design.
- Regulated or sensitive workloads are out of scope and must be declined
  rather than accommodated informally.

G36 remains `Unverified` until the documents above exist, are reviewed, are
published, and this table carries dates.
