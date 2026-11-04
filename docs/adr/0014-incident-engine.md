# ADR-0014 — Evidence-first incident investigation

Status: accepted (2026-09-30)

## Decision
A deterministic traversal of the resource graph along the request path with
bounded read-only probes per hop; hypotheses are rules over evidence with
computed confidence; remediations are capability requests with a policy
dry-run. Models may narrate; they cannot add evidence or approve fixes.
