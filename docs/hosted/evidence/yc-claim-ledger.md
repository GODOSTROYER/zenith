# YC claim ledger (G41)

Prepared 2026-09-07 by W11. **Empty. No claim is currently supported.**

> **Do not fabricate.** Every sentence that will appear in a YC application, a
> demo, a video or an investor conversation gets a row here, and a row is only
> `supported` when an artefact in this repository or a named external record
> proves it. A claim with no evidence path is `unsupported` and must not be
> said out loud.

Three statuses, and only three:

| Status | Means |
| --- | --- |
| `supported` | A named artefact proves it today. Path recorded. |
| `unsupported` | No evidence. It may be true; it may not be said. |
| `retired` | It was said before and is now known to be wrong. Kept, so the correction is visible. |

## Product claims

| # | Claim as it would be stated | Evidence path | Status | Checked on |
| --- | --- | --- | --- | --- |
| 1 | "A builder can publish a private app from real source." | `unknown` | `unsupported` | 2026-09-07 |
| 2 | "An invited colleague with no dashboard account can use it." | `unknown` | `unsupported` | 2026-09-07 |
| 3 | "Their work persists across updates and restarts." | `unknown` | `unsupported` | 2026-09-07 |
| 4 | "Revoking access denies the next request." | `unknown` | `unsupported` | 2026-09-07 |
| 5 | "We can restore on a clean host without resurrecting revoked access." | `unknown` | `unsupported` | 2026-09-07 |
| 6 | "Builds are isolated from the control plane." | `unknown` | `unsupported` — `recipe-local` runs on the control host and is labelled *not a hostile-code sandbox* | 2026-09-07 |
| 7 | "The app runs on Cloudflare Workers for Platforms." | `unknown` | `unsupported` — no account, no request ever made | 2026-09-07 |
| 8 | "Health and logs are real." | Existing health route returns `simulated: true` | `unsupported` for hosted apps; the existing simulation is honestly labelled | 2026-09-07 |
| 9 | "The application has a tested codebase and passing CI." | Latest CI run `34106170750` at `ffb2753`: verify, production build and Docker build passed; 119 files / 1,216 tests at the Revision 3 baseline | `supported` — **for the existing infrastructure product only**, not for hosted capability | 2026-09-07 |
| 10 | "Zenith cannot read customer data." | — | `unsupported`, and it cannot become supported under the current design. See [../THREAT-MODEL.md](../THREAT-MODEL.md) §7. | 2026-09-07 |

## Traction claims

| # | Claim | Evidence path | Status |
| --- | --- | --- | --- |
| 11 | "N teams have used it." | [activation-ledger.md](activation-ledger.md) — 0 rows | `unsupported` |
| 12 | "N teams came back." | [activation-ledger.md](activation-ledger.md) — 0 eligible | `unsupported` |
| 13 | "N teams are paying." | [payment-ledger.md](payment-ledger.md) — 0 collected | `unsupported` |
| 14 | "We have interviewed N teams." | [discovery-log.md](discovery-log.md) — 0 rows | `unsupported` |
| 15 | Any MRR figure | — | `unsupported`; pilot payment is not recurring revenue |

## Founder claims

Not available to this repository. An engineering audit cannot fill these in,
and guessing is disqualifying.

| # | Claim | Evidence path | Status |
| --- | --- | --- | --- |
| 16 | Founder identities and roles | `unknown` | `unsupported` |
| 17 | Relevant accomplishments | `unknown` | `unsupported` |
| 18 | Who built what | `unknown` | `unsupported` |
| 19 | Equity and ownership | `unknown` | `unsupported` |
| 20 | How the founders know each other | `unknown` | `unsupported` |
| 21 | Availability and commitment | `unknown` | `unsupported` |
| 22 | Incorporation status | `unknown` | `unsupported` |

## Submission facts

| Item | Value | Source |
| --- | --- | --- |
| Batch | Winter 2027 | YC application page, checked 2026-09-07 by the gap analysis |
| On-time deadline | **2 November 2026, 8 p.m. Pacific** | same |
| Decisions | 11 December 2026 | same |
| Batch dates | January–March, San Francisco | same |
| Internal targets | 26 and 31 October | the plan's own dates, not YC's |
| Submission receipt | `unknown` | — |
| Demo recorded | `unknown` | — |
| Founder video | `unknown` | — |

Recheck the portal's current requirements at submission time; they change.
**No user or payment count is a guaranteed admission threshold** — do not
build the application around hitting one.

## Demo requirement

The demo must show the real two-identity journey: publish → invite → sign in
as the recipient → persist → conflict or revoke → recover. An attractive
landing-page recording is not a substitute, and neither is a Gimbal animation.
Current demo status: `unknown`, because the journey does not exist yet.
