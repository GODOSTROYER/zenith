# Activation and return ledger (G38)

Prepared 2026-09-07 by W11. **Empty. Zero teams have activated.**

> **Do not fabricate.** No activation may be recorded that did not happen, and
> nothing the founder or a test account did counts. A sign-up, a rendered
> page, an invitation record, a founder-run demo and a simulated deployment
> are **none of them** activation.

## Definition

A team is activated when **all** of these are true:

1. The app is a real private app on its own host, published from real source.
2. An **invited non-builder** — not a workspace member, not the founder, not a
   test account — signed in on the app host.
3. That person completed a **meaningful persisted action**: a record that is
   still there after a reload and after a control-service restart.
4. The data was not disposable test data.

Any one of those missing means not activated. The chain is conjunctive.

## Ledger

| # | Team | App | Recipient actor class | Invite sent | Invite delivered | Accepted | First meaningful action | Persisted after restart | Assisted? | Founder minutes | Counts as activation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| — | *(no rows — nothing has been observed)* | | | | | | | | | | |

Totals: activations `0`. Eligible cohort `0`. As of `unknown`.

## Return cohort (days 7–13)

Only **matured** cohorts count: a team activated on day D can only be
evaluated after day D+13. Page views are not returns; a meaningful non-builder
action is.

| Team | Activation date | Cohort matures | Meaningful action in days 7–13 | Counts as return |
| --- | --- | --- | --- | --- |
| — | *(none)* | | | |

Returns `0` of an eligible cohort of `0`. A ratio over a zero denominator is
not 0 % and not 100 % — it is undefined, and must be reported as `n/a (0
eligible)`.

## Instrumentation

| Item | State |
| --- | --- |
| Event table | Contract only (`HOSTED_EVENTS` in `src/lib/hosted/contracts/types.ts`); implementation is W8's |
| Event names | **Provisional.** The exact eleven names on p. 36 could not be read; the current set must be reconciled when the PDF reaches an editing session (`R3-13`) |
| Subject identity in events | HMAC under `ZENITH_EVENTS_SALT` only — never an id or an email |
| Founder/test exclusion | `ZENITH_FOUNDER_SUBJECTS`; the list itself is `unknown` and must be filled before any aggregate is quoted |
| Deduplication | By logical operation id; retries must not inflate counts |
| Failed attempts | Retained, not discarded |
| Customer record contents in analytics | Forbidden |

## Supporting measures

| Measure | Rule | Value |
| --- | --- | --- |
| Publish success | successes / **accepted supported attempts**; a >= 90 % target for the first 20 is a target, not a claim | `unknown` (0 attempts) |
| Recipient conversion | sent invite → acceptance → useful action; **sent** is the denominator unless delivery is actually verified; bounces retained | `unknown` |
| Time to useful action | link-open to committed action; report median **with count and range**; email delay reported separately | `unknown` |
| Founder assistance | minutes and actual interventions; concierge help disclosed and expected to trend down before anything is called self-service | `unknown` |

## Milestone reality

At least three teams must activate by 28 September for the 11 October
days-7–13 checkpoint to mean anything. Current count: `0`. As of 2026-09-07,
that is day one of the sprint — not a missed milestone, and not progress
either.
