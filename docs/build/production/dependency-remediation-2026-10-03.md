# Next lint dependency remediation

Candidate based on published `24e941f3f673c316b5adb31572b79e51cab9ea3e`.
The candidate removes the vulnerable chain. Independent review corrected
additional matching differences after the first passing build; root fresh audit, installation, full lint, focused tests and production build
for the revised adapter now pass. Integrated compiler and exact pushed CI remain
required.
Root review, integration verification and exact published CI are required;
this document grants no exception or release
approval. The earlier remediation and failed audit receipts remain historical
evidence.

On October 3, the [official advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
still lists `braces <=3.0.3` with no patched version. The npm registry still
publishes 3.0.3 as latest, and the [upstream issue](https://github.com/micromatch/braces/issues/70)
remains open. Both current Next 15.5.27 and Next 16.3.8 retain `fast-glob`
3.3.1. Updating Next alone therefore does not remove this advisory.

The only installed parent of `fast-glob` is `@next/eslint-plugin-next`
15.5.24. The [exact tagged source](https://github.com/vercel/next.js/blob/v15.5.24/packages/eslint-plugin-next/src/utils/get-root-dirs.ts)
and its registry tarball use one API: `globSync(string, { onlyDirectories:
true })` for custom Next roots. A version-scoped npm override replaces that
child with `npm:glob@13.0.6`; it preserves the real package name, public
registry URL and SHA-512 integrity. No package version is fabricated.

`glob` 13.0.6 already exists elsewhere in this lock. Its
[official source](https://github.com/isaacs/node-glob/tree/e80cb38ae60d6cbff9e75f39032a994858994d35)
supports Node 22 and uses the patched `brace-expansion` 5.0.12 chain. The
replacement and all three new parser-subtree tarballs have SHA-512 hashes
matching registry metadata, and their published registry signatures verify
against the public npm signing key
`SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`. This is registry
integrity and signature verification; it does not assert a SLSA attestation
for this release.

The adapter in `eslint.config.mjs` changes only the module resolved by this
exact Next plugin. It runs before FlatCompat loads the existing rule sets,
expands braces through the patched parser, retains literal roots and trailing
slashes, follows directory symlinks, filters out files and excludes the
scan's base directory. Glob enumerates candidates. The existing Picomatch
4.0.7 is declared as an exact direct development dependency and retains
fast-glob's `posix: true` and `strictSlashes: false` matching options. It
classifies bracket patterns and matches negative extglobs, hidden directories
and slash spellings. A guard rejects an unexpected caller API or
replacement version, so a future plugin change requires review. The root
`glob` used by E2B keeps its original API. Next, TypeScript and local lint
rules, runtime `>=22.22.2 <23`, CI and the mandatory audit are unchanged.

The root lock entry records the direct Picomatch dependency; no existing
non-root entry changes. Sixteen unused chain entries disappear and four
entries are added for the scoped alias and its parser dependencies.
All 158 pre-existing optional entries, including native bindings for other
platforms, remain byte-identical. The complete lock contains 909 registry
entries with SHA-512 integrity and six bundled entries.

Historical first-adapter verification on Darwin arm64, Node 22.23.3 and npm
10.9.9, before the independent review corrections below:

- A fresh private `npm ci --ignore-scripts --no-fund` passes. No lifecycle
  scripts or provider credentials are used.
- The unchanged complete mandatory audit, lock-integrity check and
  `npm ls --all --json` all exit zero.
- Eighteen absolute directory-pattern comparisons against the original
  registry `fast-glob` package matched, including literal roots, globs,
  nested braces, padded ranges, extglobs, hidden directories, symlinks,
  globstars and directory-only behavior. The committed tests also cover
  relative roots and mixed root arrays.
- Four focused tooling suites pass **73 tests, zero failures, zero skips**.
  They exercised real Next root discovery, active internal-link diagnostics,
  TypeScript alias/package/core resolution, missing imports, local unused
  variable and hosted-import rules, existing package compatibility, and a
  bounded child process for deeply nested braces. The pages-rule fixture
  reflects Next 15's existing behavior; this change does not repair its
  app-directory URL normalization.
- Full repository lint exits zero. The one explicit full TypeScript run
  aborts at its 2 GiB heap limit before reporting a compiler diagnostic;
  root must perform integrated compiler verification at the established
  4 GiB limit. The failed receipt is retained.
- Next production build exits zero in 158.31 seconds, including type
  validation, page-data collection, all 20 static pages and build traces.
  It uses a 4 GiB heap, one worker and a credential-free environment. Existing
  nonfatal compilation and experimental SQLite warnings remain; this is not
  a warning-free build.

Independent review then found differences for literal brackets, negative
extglobs, hidden directories and parent-segment spelling. The revised adapter
passes all **12 actual-parent comparisons** from the review fixture under
a 128 MiB heap, including `a[[]1]`, `!(web)`, `[!w]*`, `**/!(pages)` and
`web/../*`. Five corresponding regression cases are added to the committed
suite. These bounded comparisons do not replace fresh full lint, compiler,
focused-suite, complete-audit and Next build verification on the revised
source. The earlier green results must not be relabeled as revised-source
results.

An exploratory plain `tinyglobby` alias was rejected after real directory
checks found differences in symlink, numeric-range and trailing-slash
behavior. Its audit result is not used to claim compatibility. Failed test
fixtures and an npm stale-alias lock attempt are retained privately. The
final lock was generated from the committed baseline with no installed
dependency tree, then installed freshly and validated without suppressing
peers or optional packages.

Private evidence is under `logs/dependency-fix-20261003` and
`logs/dependency-fix-20261003-upstream` in the Mac's production workspace.
macOS results do not prove Linux installation or build behavior. Root must
review the frozen candidate and rerun required integrated checks before
publishing it to the same production branch.

Root repeated revision-two verification with Node 22.23.3 and npm 10.9.9 in a
credential-free Darwin ARM64 environment: fresh installation, the unchanged
complete audit (zero known findings), lock integrity, the complete installed
tree, full repository lint and **78 tests / zero failures / zero skips** all
passed. Next production build passed in **168.49 seconds**, including type
validation, 20 static pages and build traces. All five source hashes were
unchanged during verification. The earlier explicit 2 GiB compiler failure
remains recorded; integrated compiler and remote Linux gates are still pending.
The root-owned `.next` output was removed after verification to recover about
1.49 GB. This dependency result does not imply production release approval.
