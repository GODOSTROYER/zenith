# Acceptance record — template

Prepared 2026-09-07 by W11. **This is a blank form. It records nothing.**

> **Do not fabricate.** An acceptance record is what moves a requirement's
> status in `requirements.json`. Filling one in from an expectation rather
> than an observation corrupts the register. If a run failed, record the
> failure — a failed record is evidence; a missing one is a gap.

One record per requirement per run. Copy the block below into a new file named
`<requirement-id>-<YYYYMMDD>.md` in this directory. Do not overwrite an
earlier record: keep both, so a regression is visible.

Collect these **during** implementation. Reconstructing evidence at the end of
a sprint produces a story, not a record.

---

## Record

| Field | Value |
| --- | --- |
| Requirement id | `unknown` — e.g. `ATT-DATA-02`, and/or the gap row `G18` |
| Acceptance gate | `unknown` — which of the twelve gates in `PLAN-R3.md` §3, if any |
| Date and time (with timezone) | `unknown` |
| Source SHA | `unknown` |
| Build SHA / artifact digest | `unknown` |
| Branch | `unknown` |
| Environment | `unknown` — OS, Node version, `ZENITH_DATA` path, hosted mode on/off |
| Provider versions and identifiers | `unknown` — runtime, build runner, backup target, Supabase project, exact SDK versions |
| Configuration that matters | `unknown` — the `ZENITH_*` values in effect, secrets by presence only, never by value |
| Tester | `unknown` — a human name or an agent id |
| Identities used | `unknown` — owner / editor / viewer / uninvited / revoked, and which are real accounts |
| Fixture or input | `unknown` — exact fixture path or the input bytes' digest |
| Expected result | `unknown` |
| Actual result | `unknown` |
| Pass / fail | `unknown` |
| Artifact path | `unknown` — log, screenshot, JSON output; sanitized |
| Repeatability | `unknown` — the exact command another person can run |
| Limitations | `unknown` — what this run does **not** establish |

## Limitations section — always non-empty

Every record must name what it does not prove. A record whose limitations
section is empty is incomplete, not strong. Common ones, to be kept or
replaced honestly:

- Mocks and doubles establish contract behaviour, not live provider behaviour.
- A local run does not certify CI, the container, or another Node line.
- A process kill is not power loss. A restart is not a crash.
- A passing test proves the case it encodes, not the property it is named
  after.
- Screenshots show a screen; they do not show authorization or durable
  acknowledgement.
- One host is not two tenants.
- Simulated providers stay simulated no matter how real the output looks.

## Rules

- No test may be weakened, skipped or deleted to produce a pass.
- A failed run and its resolution are both retained, in their original form.
- Sanitize artifacts: no credentials, no customer data, no token values.
- Independent review of a record is not the same as independent verification
  of the behaviour.
- Only the integrator changes a `requirements.json` status, and only against a
  completed record.
