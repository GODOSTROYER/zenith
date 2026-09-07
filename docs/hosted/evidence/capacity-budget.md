# Capacity, budget and measured economics (G40)

Prepared 2026-09-07 by W11. **Empty. No owner, no approved budget, no measured
cost.**

> **Do not fabricate.** Do not enter an estimate in a column headed *measured*.
> Planning arithmetic and a bill are different things, and the difference is
> the whole point of this file.

G40 is a **Decision** row. It is unresolved because nobody has been named,
no hours have been committed and no envelope has been approved.

## People and hours

| Role | Named person | Hours per week available | Confirmed on |
| --- | --- | ---: | --- |
| B1 — runtime / reliability | `unknown` | `unknown` | `unknown` |
| B2 — product / access | `unknown` | `unknown` | `unknown` |
| F — founder / operator | `unknown` | `unknown` | `unknown` |
| Independent reviewer | `unknown` | `unknown` | `unknown` |

The plan's P1–P10 timeboxes sum to **192 hours**, plus a 48-hour buffer =
240. Those are the plan's numbers, not a fresh estimate and not a remaining-
hour calculation. Existing preparation should not be mechanically subtracted
from them. The plan itself calls for re-estimation after day three; that
re-estimate is `unknown`.

If actual capacity is **one builder**, the plan's own 120-hour / 24-hour-buffer
fallback is the starting point — fixed reviewed backend, editable supported
frontend, manual intake, 2–3 teams. Preserving a two-builder target by
quietly dropping access, isolation or recovery requirements is not an option.

| Item | Value |
| --- | --- |
| Actual capacity | `unknown` |
| Scope chosen (full / fallback) | `unknown` |
| Re-estimate after day three | `unknown` |

## Budget

| Item | Value |
| --- | --- |
| Approved envelope | `unknown`. The plan's **$300 is an unconfirmed planning envelope** — not permission to spend and not a cap. |
| Approved by | `unknown` |
| Approved on | `unknown` |
| `ZENITH_SPEND_ENVELOPE_USD` | Unset (alerts measure against `0`) |
| Alert thresholds | 50 / 75 / 90 % — implementation is W8's |
| Behaviour at 90 % | New builds pause; running apps keep serving |
| Hard cap possible? | **No.** Provider invoices lag; application quotas cannot promise a bill ceiling. |

## Cost lines

| Line | Fixed or marginal | Provider | Plan | Estimated | Measured | Source |
| --- | --- | --- | --- | ---: | ---: | --- |
| Control host | Fixed | `unknown` | `unknown` | `unknown` | `unknown` | — |
| Domain(s) | Fixed | `unknown` | `unknown` | `unknown` | `unknown` | — |
| TLS certificate | Fixed | `unknown` | `unknown` | `unknown` | `unknown` | — |
| Identity (Supabase) | Fixed | Supabase | `unknown` | `unknown` | `unknown` | — |
| Edge runtime | Fixed + marginal | Cloudflare WfP | `unknown` | Base listed at **$25/month** on the official pricing page when checked 2026-09-07 — **unverified as a bill**; usage, D1, storage and egress are separate and unpriced | `unknown` | gap analysis §11 |
| Build runner | Marginal | E2B | `unknown` | **Unverified.** Do not use the plan's price example as a quote; do not assume a paid plan is required. Recheck the selected plan against the real workload. | `unknown` | gap analysis §11 |
| Object storage / backups | Fixed + marginal | `unknown` | `unknown` | `unknown` | `unknown` | — |
| Email | Marginal | `unknown` | `unknown` | `unknown` | `unknown` | — |
| Founder support time | Marginal | — | — | `unknown` | `unknown` | — |

**Nothing in the "Measured" column can be filled until a real workload runs on
a real account.** Until then the honest total is `unknown`, not a sum of
estimates.

## Unit economics

| Measure | Value |
| --- | --- |
| Cost per active team per month | `unknown` |
| Support minutes per team per month | `unknown` |
| Requests / CPU / storage / builds / emails per team | `unknown` |
| Break-even teams at the current experimental price | Arithmetic only: five teams at $25 = $125/month against a fully spent $300 → −$175 before salaries |

## Rules

- Separate fixed from marginal costs, and make support time visible — it is
  the cost most likely to be omitted and the one most likely to dominate.
- An estimate never moves into the measured column.
- Purchasing anything, including a $5 domain, needs explicit approval
  (`ATT-HANDOFF-02`, `blocked`).
