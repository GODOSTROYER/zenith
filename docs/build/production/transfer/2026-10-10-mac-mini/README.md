# Transfer inventory, 10 October 2026

Start with [the Mac mini handoff](../../HANDOFF-MAC-MINI-2026-10-10.md). Run `python3 docs/build/production/transfer/2026-10-10-mac-mini/verify.py` from the repository before using these files. The manifest records exact SHA-256 and sizes for 20 source/evidence files and historical base preimages. Integrity is not approval or runtime acceptance. This bundle has no dependency directories, images, credentials or full runtime logs.

| Packet | Status | Contents and safe use |
|---|---|---|
| `candidates/hosted/` | Independently source reviewed, runtime pending | Sole hosted-acceptance source file plus tracked patch, based on `28ea0b75`. Check preimage, apply only in an isolated worktree, independently review any reconciliation and execute the actual local protocol journey. |
| `candidates/sys1/` | NOT_READY, interrupted, unreviewed | Four source files plus tracked patch for two tracked files. Patch alone omits two new Python files. Review and complete the implementation before any runtime use; do not copy into root wholesale. |
| `runtime-templates/supervisor142/` | Historical frozen runner and source contract | Original host-bound runner, runtime, ownership guard, projected dependency lock, contract and freeze. Actual historical result is in `evidence/summary.json`; the earlier FREEZE's `executionPerformed: false` records pre-execution creation, not the later receipt. |
| `runtime-templates/runner-pid1-r2/` | Source reviewed, preflight passed, actual execution pending | Original runner, ownership guard, source contract and freeze. They deliberately bind old paths, tool hashes, Docker endpoint and source. Rebind with independent review; never relax a failing source guard. |
| `evidence/` | Sanitized, historical source-bound summaries | Every job of three exact-source CI runs and scoped local results. These are not evidence for the publication containing this bundle or later candidate bytes. |

All candidates were compared byte-for-byte with their preserved worktrees on 10 October. No candidate was integrated, tested or approved by packaging it. Original source files preserve old absolute paths for provenance. Do not use them as new-host configuration. No old private `.env` files or secret runtime materials are included. Raw evidence not in GitHub is explicitly unavailable; retrieve a specific sanitized missing receipt from the old host only if required, or execute a fresh source-bound attempt.

For a clean matching preimage, `git apply --check <packet>/tracked.patch` checks application without modifying files. A successful check does not authorize executing the SYS1 draft. If tracked paths changed, compare the old base, packet and current source, then make a narrow reviewed successor. Preserve all newer builder changes. Never reset to the packet base.

Transferred executable source files use a `.txt` suffix so repository compilers, linters and test discovery do not execute archived candidates. Restore original filename only inside an explicitly owned successor worktree/packet after review. Patches retain original target paths. Archived JSON contracts retain historical filenames and hashes and are not runnable current bindings.
