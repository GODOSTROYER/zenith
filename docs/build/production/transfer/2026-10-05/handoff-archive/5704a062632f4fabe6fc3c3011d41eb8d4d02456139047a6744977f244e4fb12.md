# WS-REF — make the execution path resolve cross-node references the way the drivers publish them

Workstream: WS-REF (new; written by the orchestrator; nothing done yet)
Branch: ws/ref — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-ref
Base: platform/integration @ c32a1c7 (tsc clean; AWS provider registry merged)

## The bug (found in orchestrator review; blocks any real deploy)
`CompileContext.ref(address, attribute)` (contract: src/lib/drivers/types.ts) is implemented
for real execution in `src/lib/execution/compile.ts:89-95`: it compiles the target node and
returns `${<primary tofu address>.<attribute>}`, and `ATTRIBUTE = /^[A-Za-z0-9_.[\]-]+$/`
(line 41) rejects anything else.
But the drivers were written against a different convention:
- AWS (src/lib/providers/aws/drivers/**): every referenceable attribute is published by the
  target's driver as a tofu LOCAL named `refLocalName(address, attribute)` =
  `ref_<tfLabel(address)>__<attribute lowercased, non-[a-z0-9_] → _>`
  (src/lib/providers/aws/drivers/shared/refs.ts, published via FragmentBuilder.expose).
  Attributes like `security_group_id`, `target_group_arn:<target>[:<port>]`,
  `private_route_table:<zone>` exist ONLY as those locals; `target_group_arn:web` even fails
  the ATTRIBUTE regex today. The AWS e2e compile test (tests/providers/aws/drivers/e2e-compile.test.ts)
  passes only because its own test context (tests/providers/aws/drivers/_integration.ts:45) returns
  `${local.<refLocalName>}` — the real execution path was never exercised.
- OCI (src/lib/providers/oci/**): expects `${<ociPrimaryAddress(node)>}.<attr>` for ctx.ref and
  reads other values through its own published locals (`auxRef`). See the OCI test context
  tests/providers/oci/compile.test.ts:664.
- GCP: uses ctx.ref in 2 places — find out which form it expects (its tests' context).
- Azure: publishes per-node locals (`exports.ts`) and references them directly; its test
  context throws if ctx.ref is called — confirm the one `ctx.ref(` occurrence in
  src/lib/providers/azure is not a live call.
- Kubernetes / zenith: compile:false, no ctx.ref.

## Objective
One documented resolution rule in the execution compile path that every provider's drivers
satisfy, proven by compiling real expanded graphs THROUGH THE EXECUTION PATH.

Owned paths: src/lib/execution/compile.ts ; NEW src/lib/drivers/refs.ts (provider-neutral
`refLocalName`/label helpers, if you move them — the AWS shared module must then re-export the
SAME function, byte-identical output, no driver changes needed) ; src/lib/drivers/types.ts
(doc comment of CompileContext.ref only) ; docs/platform/DRIVER-CONVENTIONS.md (the reference
section) ; NEW test files under tests/execution/ (e.g. tests/execution/compile-refs*.test.ts) —
do NOT edit existing tests/execution files or src/lib/execution/{capability,ports}.ts (another
Codex job, WS-MACH-ALIGN, is editing them now). Do not edit any driver; if a driver violates the
rule, report it with file:line instead.

## What to build
1. Resolution rule in compile.ts `ref(target, attribute)`:
   a. compile the target (as today; cycles stay an error);
   b. if the target's fragment declares the local `refLocalName(target, attribute)` in
      `fragment.locals` → return `${local.<that name>}`;
   c. else, if `attribute` is a plain attribute path (identifier segments, optional index) →
      `${<primary address>.<attribute>}` (today's behaviour, used by OCI and by AWS id/arn);
   d. else refuse with StepFailedError naming the node, the target and the attribute, never
      echoing more than a bounded, sanitized string.
   Validate `attribute` with a strict pattern for (b) that allows `:` and the characters the
   AWS REF constants use, and the existing pattern for (c). The returned string is always a
   single interpolation of a local or a resource traversal — never manifest text.
2. Update the CompileContext.ref doc comment and DRIVER-CONVENTIONS to state the rule.
3. Tests (new files only):
   - unit: rule (b) wins over (c) when both exist; (c) for a plain attribute; (d) refusal;
     cycle error kept; output never contains anything but `${local.x}` / `${a.b.c}`.
   - AWS through the REAL execution path: take the production AND staging graphs that
     tests/providers/aws/drivers/_integration.ts builds (reuse its fixture/expansion helpers by
     import), register the AWS drivers, compile + assemble through the execution compile path
     (the function compile.ts exports for activities), and assert: no StepFailedError, every
     `${local.…}` referenced anywhere is declared exactly once, every `${type.label.attr}`
     traversal names a declared resource/data address, no duplicate addresses, deterministic
     configDigest across two runs. Then a gated real `tofu init -backend=false` + `tofu validate`
     on that workspace behind ZENITH_TEST_TOFU_NETWORK=1 (the existing gated tests show how;
     the orchestrator will run it outside your sandbox if your sandbox cannot execute tofu —
     say so, do not claim it ran).
   - Same through the execution path for the OCI fixture graph used by tests/providers/oci
     (compile with the OCI compile context wrapper it requires) and for GCP if GCP uses ctx.ref.

## Decisions already made (keep them)
- Drivers are not edited in this job. Execution adapts to the published conventions.
- Unknown/ambiguous reference → refuse (fail closed), never guess.
- No new dependencies.

## Verification commands
- npx tsc --noEmit
- npx eslint src/lib/execution/compile.ts src/lib/drivers tests/execution
- npx vitest run tests/execution tests/providers/aws tests/providers/oci tests/providers/gcp tests/providers/azure
- ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/execution/compile-refs (or your file names)
