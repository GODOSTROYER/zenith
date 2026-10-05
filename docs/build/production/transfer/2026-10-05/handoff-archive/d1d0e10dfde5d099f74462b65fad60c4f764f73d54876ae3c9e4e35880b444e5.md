# Codex handoff notes

One file per workstream: <WS-ID>.md (e.g. WS-CAP.md). Written by the Sonnet worker
at checkpoint time. Required sections:

1. Workstream, branch, worktree path, last commit SHA (all work committed; WIP commits prefixed `wip:`)
2. Objective (the original task, condensed but complete: scope, owned paths, contracts, required tests, definition of done)
3. Done (files/modules, what works, which tests pass with exact commands and counts)
4. Remaining (precise checklist, in order)
5. Known failures (tsc errors, failing tests, with file:line)
6. Decisions and assumptions already made (so the next agent does not undo them)
7. Verification commands
