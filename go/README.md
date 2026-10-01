# Zenith agents (Go)

`zenith-runner` and `zenithd`: Zenith's two outbound-only agents. One module,
standard library only, static binaries. Operator docs:
[`docs/platform/RUNNER.md`](../docs/platform/RUNNER.md),
[`docs/platform/ZENITHD.md`](../docs/platform/ZENITHD.md); wire protocol:
[`docs/platform/RUNNER-PROTOCOL.md`](../docs/platform/RUNNER-PROTOCOL.md).

```
cmd/zenith-runner, cmd/zenithd      entry points (flags: --config, run | register | check | version)
internal/protocol                   compact JWS (EdDSA, pinned keys), envelopes, grants, request signing,
                                    replay cache; testdata/ holds the golden vectors shared with TypeScript
internal/agent                      shared core: config, identity, registration, signed client, long-poll /
                                    heartbeat / result loop, revocation, graceful shutdown; fakecp/ is a fake
                                    control plane for tests
internal/awsauth                    AWS SigV4 signer (verified against the official AWS test suite) and the
                                    local credential chain (env, web identity, container, IMDSv2)
internal/runner, runner/kinds       runner executor and job kinds: tofu.run, aws.http, k8s.http, probe.*
internal/machine, machine/ops       zenithd executor, audit log, and the semantic operations
internal/netguard                   metadata / link-local denial, resolve-then-dial
internal/redact                     credential-shape redaction
internal/miniyaml                   the small YAML subset the config files use
internal/proc                       process-group handling
```

## Build, test

```sh
./build.sh 1.0.0            # dist/linux-{amd64,arm64}/{zenith-runner,zenithd} + SHA256SUMS
./build.sh test             # go vet ./... && go test ./...
go test -race ./...
```

Go 1.27, `CGO_ENABLED=0`, `-trimpath`; version injected with
`-ldflags "-X github.com/GODOSTROYER/zenith/go/internal/version.Version=…"`.

Optional gated tests (skipped unless the variable is set):

| Variable | Runs |
|---|---|
| `ZENITH_TEST_TOFU=/path/to/tofu` | plan / show / apply against a real OpenTofu 1.12.5 (`terraform_data`, no network) |
| `ZENITH_TEST_SYSTEMD=1` | real `systemctl show` and `journalctl` on a systemd host |

Regenerate the shared golden vectors only when the wire format intentionally
changes: `ZENITH_UPDATE_VECTORS=1 go test ./internal/protocol`.
