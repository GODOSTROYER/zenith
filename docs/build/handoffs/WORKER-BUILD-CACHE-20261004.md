# Worker build cache source correction

The fresh worker image build stage now runs `npm ci --ignore-scripts && npm cache clean --force` in one Dockerfile instruction. This removes only npm's download cache inside that disposable stage before its layer is recorded. The installed dependency tree and locked package inputs remain unchanged. Cleaning in a later instruction would retain the earlier layer's cache bytes.

This change addresses an independently observed source opportunity to reduce transient build storage. It does not establish how much storage will be recovered or identify the cause of a particular package failure. The actual package retries, including their recorded storage-floor failures, remain separate evidence.

The production and acceptance stages, lifecycle script policy, pinned base and OpenTofu inputs, non-root entrypoint, fresh `--no-cache` build path, owned builder release and baseline-preserving cleanup are unchanged. The committed native wrapper's 12 GiB disk prerequisite and 8 GiB running floor are unchanged. Root's separate local 18 GiB launch guard is also outside this packet and must remain intact. No host cache, shared Docker image, unrelated builder, volume or data is removed by this packet.

The additive case in `tests/ci/packaged-workers.test.ts` is a source-contract model. It checks that the locked install and cache cleanup share one build-stage instruction, that package inputs precede the install, and that the existing launch floor and exact fresh build command remain present. All prior model cases and the 22 native package check identities remain unchanged. This source model does not execute npm, build an image, measure storage or establish genuine package behavior.

The packet owns only `docker/worker.Dockerfile`, `tests/ci/packaged-workers.test.ts` and this handoff. It is based on clean commit `8ee702d8fc4e7e01e01dd6a1da36eb65c96d04da`, tree `7883eba29bd5d91906fa46414d0368f7f2fe6b14`, in a separate worktree. The freeze includes preimages, postimages, an incremental patch and unchanged outside-path inventory. No compiler, tests, lint, project import, npm install, Docker command, service, database, cloud call or commit was executed by the author.

Independent source review must precede root integration. Root owns the targeted model test, compiler and lint checks, then genuine architecture-specific fresh package execution with all existing checks and measured storage samples. No requirement is marked complete by this packet.

Suggested root source/model checks after integration:

```sh
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/vitest/vitest.mjs run tests/ci/packaged-workers.test.ts --maxWorkers=1
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/typescript/bin/tsc --noEmit
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/eslint/bin/eslint.js tests/ci/packaged-workers.test.ts
```

The actual package command and disposable ownership contract remain the existing canonical native wrapper. Separate supported host provisioning and measured storage headroom remain necessary. This packet does not relax native admission, delete retained storage, or prove accepted provider mutation and recovery.
