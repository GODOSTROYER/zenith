# Independent security review (G35)

Prepared 2026-09-07 by W11. **No independent review has been commissioned,
scoped, performed or paid for.**

> **Do not fabricate.** A reviewer's name, a scope, a finding or a closure
> date may only be entered if the review happened. In particular:
> **independent agent review of a repository patch is not this review.** It is
> useful engineering evidence and nothing more.

## Status

| Item | Value |
| --- | --- |
| Reviewer | `unknown` |
| Independent of the builders? | `unknown` |
| Engagement scope agreed | `unknown` |
| Commissioned on | `unknown` |
| Performed on | `unknown` |
| Report location | `unknown` |
| Cost | `unknown` |
| Approved by | `unknown` |

## Scope that would need to be covered

Derived from the page-47 families in [../THREAT-MODEL.md](../THREAT-MODEL.md).
A review that skips one of these does not close G35 for that family.

| # | Area | In scope | Result |
| --- | --- | --- | --- |
| 1 | App grant, session and revocation boundary | `unknown` | `unknown` |
| 2 | Cross-domain exchange and host-only sessions | `unknown` | `unknown` |
| 3 | Gateway admission on pages, assets, API, HEAD, Range and direct origins | `unknown` | `unknown` |
| 4 | Broker isolation and binding policy | `unknown` | `unknown` |
| 5 | Source intake and build isolation | `unknown` | `unknown` |
| 6 | Artifact integrity and release activation | `unknown` | `unknown` |
| 7 | Quotas, suspension and abuse | `unknown` | `unknown` |
| 8 | Backup, restore and revocation reconciliation | `unknown` | `unknown` |
| 9 | Secret scopes and operator access | `unknown` | `unknown` |
| 10 | Data lifecycle, export and deletion | `unknown` | `unknown` |

## ASVS

| Item | Value |
| --- | --- |
| Applicable verification level | `unknown` — choose deliberately; a level is a scope decision, not a badge |
| Version | `unknown` |
| Requirements in scope | `unknown` |
| Requirements verified | `unknown` |
| Requirements not applicable, with reasons | `unknown` |

## Findings

| # | Finding | Severity | Blocking? | Fix | Fixed in | Retested on | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | *(none — no review has been performed)* | | | | | | |

Blocking findings closed: `0 of 0`. That ratio means "no review", not "clean".

## Rules

- Every **blocking** finding must be closed before a broader rollout, and the
  fix must be retested by the reviewer, not asserted by the builder.
- Evidence must be reproducible: a finding without steps is not a finding.
- Design risks described in the plan's addendum are **not** confirmed exploits
  in the current application, and must not be reported as such.
- A provider's certifications do not transfer to Zenith.
- Regulated or sensitive workloads need a separate assessment; do not accept
  one on the strength of a pilot review.

G35 remains `Unverified`.
