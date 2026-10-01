# Codex job: continue a Zenith platform workstream

You are a Codex implementation agent continuing a PARTIALLY COMPLETED workstream of the
Zenith platform build (GODOSTROYER/zenith: a deterministic, agent-operable multi-cloud
infrastructure control plane; Next.js 15 + TypeScript strict + vitest). A previous agent
did part of the work, committed it, and wrote the handoff note below. An orchestrator
reviews, verifies and integrates your result.

## Read first
1. The common worker brief (rules on owned paths, fixed contracts, honesty, security
   invariants, testing, environment):
   C:\Users\user\AppData\Local\Temp\claude\Z--Projects-Spawned-ai\5e97a1aa-a341-43fb-821c-9424d9f61a81\scratchpad\WORKER-BRIEF.md
2. The handoff note at the end of this prompt — completely, before changing anything.
3. `git status`, `git log --oneline -15` and the code it names, to see the actual state.

## Overrides to the brief (these win)
- DO NOT run `git commit`, `git merge`, `git stash`, `git reset`, `git checkout -- …` or any
  command that writes to `.git` — the `.git` directory is read-only in your sandbox. Leave
  every change in the working tree; the orchestrator verifies and commits it.
- Do not run `npm install`/`npm ci` and do not edit package.json or package-lock.json.
- WSL and Docker are not available to you. Network access may be unavailable: tests that
  need it must stay gated behind their env var and be reported as not run.
- Stay inside the workstream's owned paths listed in the handoff note.

## How to work
- Continue from the current state. Do not redo finished work and do not undo the decisions
  the handoff records unless they are clearly wrong — if you change one, say why.
- Complete every item in the handoff's "Remaining" checklist, then make the verification
  commands pass: `npx tsc --noEmit` (whole repo) clean, `npx eslint <owned paths>` clean,
  the workstream's vitest suites passing. Fix failures rather than weakening tests; never
  mark something passing that you did not run.
- Honesty rules from the brief apply in full: nothing mocked is labeled real, unknown is a
  valid state, no secret values anywhere, external strings are data.

## Final message (required)
End with a concise report: (1) files changed/added, (2) every test/check command you ran
with exact pass/fail counts, (3) what remains or could not be done and why, (4) any
deviation from the handoff's decisions.

---

# Handoff note
