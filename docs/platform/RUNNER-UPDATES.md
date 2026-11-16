# Runner and zenithd updates: signed channel, staged activation, rollback

`zenith-runner` and `zenithd` can update themselves from a **signed release
channel**. The channel is off by default. Nothing about it is controlled by the
Zenith control plane: the release keys, the manifest URL and the health policy
are local configuration on the host.

## Trust model

| Question | Answer |
|---|---|
| Who signs a release? | A release key you hold **offline**. `zenith-release sign` runs on the release machine, never on an agent host. |
| What does the agent trust? | Only the release **public** keys pinned in its own config (`update.publicKeys`). Never keys from the manifest, the download host or the control plane. |
| What if the download host is compromised? | The manifest signature or the artifact SHA-256 and size fail, and nothing is installed. |
| What if the control plane is compromised? | It cannot change which binary runs, the channel, the keys or the health policy. |
| Replay of an old manifest? | Refused: every manifest has a `seq` the agent persists, and `expiresAt` (at most 90 days). |
| Downgrade? | Refused unless the signed manifest says `allowDowngrade` (a deliberate, signed rollback release). |

## Release manifest

```json
{ "manifest": "<base64url of the signed JSON>",
  "signatures": [{ "kid": "release-2026-1", "sig": "<base64url Ed25519>" }] }
```

The signature covers `zenith.release/v1\n` followed by the exact manifest bytes.
The manifest holds `channel`, `component` (`zenithd` or `zenith-runner`),
`version` (semantic), `seq`, `issuedAt`, `expiresAt`, optional `allowDowngrade`,
and per platform the artifact `url` (https; plain http only for loopback), `sha256`
and `size`.

```sh
zenith-release keygen --kid release-2026-1 --private-out release.key   # prints the PUBLIC entry for update.publicKeys
go/build.sh 1.4.0                                                        # builds dist/, tools/zenith-release
ZENITH_RELEASE_KEY_FILE=release.key ZENITH_RELEASE_KID=release-2026-1 \
ZENITH_RELEASE_BASE_URL=https://downloads.example.com ZENITH_RELEASE_SEQ=12 go/build.sh 1.4.0
# writes dist/manifests/stable-zenithd.json and stable-zenith-runner.json
```

Publish the binaries under `<base-url>/<component>/<version>/<os>-<arch>/<component>`
and the manifest wherever `update.manifestUrl` points. `--seq` must exceed every
earlier release of that channel and component.

## Agent configuration

```yaml
update:
  enabled: true
  channel: stable
  manifestUrl: https://downloads.example.com/zenithd/stable-zenithd.json
  publicKeys:
    - kid: release-2026-1
      publicKey: <base64url Ed25519 public key>
  checkIntervalSec: 3600     # 60..86400
  healthWindowSec: 300       # 30..3600
```

## What happens on an update

1. The agent fetches the manifest and verifies the signature against the pinned
   keys, the channel and component, `expiresAt`, `seq` and the version rule.
2. It downloads the artifact for its platform and checks size and SHA-256
   against the **signed** manifest, into `<stateDir>/update/releases/` (0700).
3. It runs the staged binary with `version` and requires it to report the signed
   version (a binary that cannot execute here is refused before activation).
4. It records the new release as active and **pending health**
   (`<stateDir>/update/state.json`, atomic), finishes in-flight jobs, and exits
   with code 75. `Restart=on-failure` restarts it.
5. The packaged binary (`/usr/local/bin/zenithd`) is also the **launcher**: on start
   it re-hashes the active release against its recorded digest and execs it. A
   digest mismatch, missing file or group-writable file is a rollback, never "run it anyway".
6. The new release is **healthy** once it completed an authenticated heartbeat
   and an authenticated poll and stayed up `minStableSec`. It then commits
   (pending cleared, old releases pruned, the previous slot kept for manual rollback).

## Automatic rollback

A pending release is rolled back to the previous binary (or the packaged one) when:

- it does not become healthy within `healthWindowSec` (the process rolls back and exits 76), or
- it restarts `maxBoots` times without committing, or its deadline passed by the next start (the launcher rolls back before running it), or
- its file no longer matches the verified digest, or it cannot be executed.

A rolled-back version is remembered and is not applied again; a fixed release is
a new version with a higher `seq`. Rollback is a state change plus an exec of the
previous slot, so it works even when the new release cannot start at all.

## Operating it

```sh
zenithd update status      # state: current | pending_health | rolled_back | check_failed, plus history
zenithd update check       # one-shot check and stage (needs update.enabled)
zenithd update rollback    # revert by hand, then restart the service
```

The control plane shows each agent's release state (reported in the heartbeat):
a release that is checking its health, or that was rolled back, is called out in
`Platform > Runners` and in the `delivery.release` field of the list API.

## Limits

- The launcher execs a binary under the state directory, so that directory must
  not be mounted `noexec`. The systemd units keep `ProtectSystem=strict` with the
  state directory read-write.
- A staged release is verified against its **recorded** digest on every start.
  A local attacker who can already rewrite `state.json` as the service user can
  point it at their own binary; the state directory is 0700 and owned by the
  service user, which is the same trust boundary as the identity key.
- Health is judged against the control plane. If the control plane is down for
  the whole health window, a good release is rolled back; it is not re-applied
  (its version is marked failed) until a newer signed release appears.
- Windows hosts are not a delivery target; the update package builds there for
  development only.
