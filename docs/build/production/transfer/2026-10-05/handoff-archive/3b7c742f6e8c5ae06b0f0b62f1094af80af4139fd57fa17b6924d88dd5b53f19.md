# WS-TOFU-SEC — fix SEC-F5: the workspace assembler's expression guard can be bypassed

Workstream: WS-TOFU-SEC (new; written by the orchestrator; nothing done yet)
Branch: ws/tofu-sec — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-tofu-sec
Base: platform/integration @ 1f46549 (tsc clean)

## The finding (SEC-F5, HIGH) — proven against real OpenTofu 1.12.5
`src/lib/tofu/workspace.ts:139-172` guards every string that goes into the OpenTofu JSON
config with two regexes:
  FORBIDDEN_CALL = /\b(file|filebase64|…|templatefile|pathexpand|abspath)\s*\(/
  FORBIDDEN_REF  = /\b(path\.(module|root|cwd)|terraform\.workspace)\b/
HCL allows comments and whitespace between a function name and its "(" and around ".", so
all of these pass the guard AND real tofu evaluates them (it reads the file; the runner's
process env holds brokered cloud credentials, so `${file/**/("/proc/self/environ")}` in a
fragment would exfiltrate them into the plan):
  ${file/**/("versions.tf.json")}          ${file /* c */ ("x")}
  ${file # c\n("x")}                        ${file // c\n("x")}
  ${try(file/**/("x"), "x")}                %{ if true }${file/**/("x")}%{ endif }
  (same for templatefile("x", {}) and fileexists("x"))
  ${path . cwd}   ${path/**/.cwd}   ${path . module}   ${path\n.cwd}   (leak runner paths)
The security workstream's proof lives in another branch (tests/security/tofu-workspace-injection.test.ts
in ws/sec, not merged; do not edit tests/security). Port its vectors into your own tests.

## Objective
Replace the regex guard with a guard that cannot be argued out of a comment, an escape, a
nesting or a namespace, and fails closed.

Owned paths: src/lib/tofu/** , tests/tofu/** . Nothing else. (Other Codex jobs are editing
src/lib/providers/aws/drivers/**, src/lib/platform/**, src/lib/machines/**, tests/security/** right now.)

## What to build
1. `src/lib/tofu/hcl-template.ts` (or similar): a real scanner for HCL template strings as
   OpenTofu's JSON syntax interprets them (every string value AND every object key in an
   expression position is a template). It must handle, at minimum:
   - literal text; the escapes `$${` and `%%{` (literal, NOT interpolation) — get the
     left-to-right semantics right for runs like `$$${…}`;
   - `${ … }` interpolations and `%{ … }` directives (if/else/endif/for/endfor), with `~`
     strip markers;
   - inside expressions: `#` and `//` line comments, `/* */` block comments, quoted string
     literals (which are themselves templates — recurse into nested `${…}`), heredocs
     (`<<EOT` / `<<-EOT`, also templates — recurse), numbers, identifiers, operators,
     brackets, object/tuple constructors, `for` expressions, splats, conditional `?:`;
   - namespaced calls `core::fn(`, `provider::p::fn(`.
   Output: the set of function calls and root variable references (the first identifier of
   a traversal: `local`, `var`, `data`, `path`, `terraform`, `self`, `count`, `each`, resource
   types, …) found anywhere, after comments are removed. Anything it cannot tokenize with
   certainty (unterminated interpolation/string/comment/heredoc, unknown character) → refuse.
2. The guard (replace FORBIDDEN_CALL/FORBIDDEN_REF in workspace.ts):
   - An ALLOWLIST of functions, not a denylist. Seed it with the pure functions the drivers
     actually emit today — find them by compiling every driver fixture the existing test
     suites use (tests/providers/**, tests/execution/**, tests/tofu/**) and collecting calls
     — plus a small, conservative set of pure string/collection/encoding/numeric/cidr
     functions. NEVER allow: any file*/template*/path*/abspath/fileset function, any
     namespaced call (`core::` or `provider::`), `nonsensitive` (this also closes SEC-F4),
     `timestamp`/`plantimestamp`/`uuid`/`bcrypt` (non-deterministic). Unknown function → refuse.
   - Refuse root references `path` and `terraform` (any attribute), however written.
     Bare-identifier object KEYS (`{ path = "x" }`) are literal keys, not references — do not
     refuse those; but fail closed on anything ambiguous.
   - Strings with no interpolation/directive after escapes are accepted unchanged.
   - Error messages name the location and the function/reference, never echo the full string.
3. Apply the guard everywhere a string reaches tofu: fragments (keys and values), provider
   `tags`/default_tags, `providerConfig` values — and ALSO re-run it over the final
   serialized workspace files in `assertWorkspaceIntact` (src/lib/tofu/workspace.ts:446),
   which the runner calls in `TofuRunner.open` before writing files to disk, so a workspace
   that did not come from `assembleWorkspace` (or was altered after) is refused too.
   Keep `assertWorkspaceIntact` cheap enough for the 8 MiB file bound.

## Tests (tests/tofu/)
- Unit: every SEC vector above refused (all 3 functions × 6 comment styles, the 4 path
  forms), plus `core::file(…)`, `provider::x::y(…)`, a call inside a nested quoted string
  inside an interpolation, inside a heredoc inside an interpolation, inside a `for`
  expression, behind a `~` strip marker, `nonsensitive(...)` incl. comment forms,
  unterminated constructs. Escapes accepted as literal (`$${file("x")}`, `%%{ if }`).
  A driver-shaped string corpus accepted.
- DIFFERENTIAL TEST against real tofu (tofu 1.12.5 is on PATH; gate on its presence, like
  the existing hasTofu helpers): for a corpus of tricky strings built around the harmless
  `upper("zz")`, plan ONE workspace with many `terraform_data` inputs/outputs (batch them —
  one plan, not one per string) and assert: whenever tofu's planned value contains "ZZ", the
  scanner reported an `upper` call for that string; whenever the scanner says "pure
  literal", tofu returned the string unchanged. This proves the scanner agrees with tofu.
- Real-tofu exploit test: for every SEC vector, either the assembler refuses it, or (if you
  construct the workspace without the assembler) `assertWorkspaceIntact`/`TofuRunner.open`
  refuses it before tofu runs. Use `versions.tf.json` + marker `required_version` as SEC did.
- No regression: run every existing suite that assembles workspaces — `npx vitest run
  tests/tofu tests/providers tests/execution tests/platform tests/security` (tests/security
  on this base has SEC's earlier suites only) — and the gated real-schema suites with
  ZENITH_TEST_TOFU_NETWORK=1 for tests/providers (aws network/compute, gcp, azure, oci).
  If a driver's legitimate output is refused, extend the allowlist only with a pure
  function, and list it in your report; never weaken the guard for it.

## Decisions already made (keep them)
- Fail closed: unknown function, unparseable template, or unknown root reference → refuse
  with `TofuWorkspaceError("forbidden_construct", …)`.
- Do not touch drivers, tests/security, or anything outside the owned paths.
- No new dependencies (write the scanner; do not add an HCL parser package).

## Verification commands
- npx tsc --noEmit
- npx eslint src/lib/tofu tests/tofu
- npx vitest run tests/tofu tests/providers tests/execution tests/platform tests/security
- ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/tofu tests/providers
