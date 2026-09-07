# Hosted evidence templates

Prepared 2026-09-07 by W11 against `ffb2753` on `zenith/hosted-r3`.

These are the records the gap register's non-code rows need. They are
**empty**: every value is `unknown`, every count is zero because nothing has
been observed, and no row describes a real person, team, conversation,
invoice, review or deployment.

**Do not fabricate a value in any file in this directory.** An invented lead,
an assumed activation, a plausible-looking invoice number or an
extrapolated cost is worse than an empty table — an empty table is honest and
a fabricated one poisons every decision downstream, including a YC
application. If something is unknown, it stays `unknown`. If a count is zero
because nothing happened, it is `0` and the file says why.

| File | Register row | What it records |
| --- | --- | --- |
| [discovery-log.md](discovery-log.md) | G37 | One row per team spoken to: workflow, pain, colleagues, switching cost, decision-maker |
| [activation-ledger.md](activation-ledger.md) | G38 | Real external activations and matured return cohorts, founder/test actors excluded |
| [payment-ledger.md](payment-ledger.md) | G39 | Accepted, invoiced and collected as three separate states |
| [capacity-budget.md](capacity-budget.md) | G40 | Named owners, hours, provider plan fit, attributable costs, support time |
| [yc-claim-ledger.md](yc-claim-ledger.md) | G41 | Every claim → the evidence path that supports it → its status |
| [release-governance.md](release-governance.md) | G45 | Branch protection, deploy approval, reproducible release evidence |
| [security-review.md](security-review.md) | G35 | Scope, reviewer, findings and blocking-issue closure for an independent assessment |
| [privacy-commitments.md](privacy-commitments.md) | G36 | Published policies, regions, subprocessors, deletion, incident ownership |
| [acceptance-record-template.md](acceptance-record-template.md) | G32 and every acceptance run | One record per gate run: source SHA, environment, tester, expected, actual, artifact, limitations |

Related non-template documents: [../PROVIDERS.md](../PROVIDERS.md) names the
missing provider inputs, [../RUNBOOK-DEPLOY.md](../RUNBOOK-DEPLOY.md) the
missing deployment, [../OPERATOR-ACCESS.md](../OPERATOR-ACCESS.md) the
unfilled operator checklist and
[../DATA-LIFECYCLE.md](../DATA-LIFECYCLE.md) the undecided data commitments.
