# Installing zenithd on a Linux VM

zenithd is a single static binary (amd64 or arm64) plus a systemd unit. It only
makes outbound HTTPS connections to your Zenith control plane. No inbound port,
no SSH, no cloud credentials. Read `docs/platform/ZENITHD.md` first for what it
can and cannot do.

Everything below runs as root on the VM.

## 1. Get and verify the binary

Build it (`go/build.sh`, see `docs/platform/ZENITHD.md`) or download a release
build, then verify it against the `SHA256SUMS` file published with it:

```sh
cd /tmp/zenith-release
sha256sum --check --ignore-missing SHA256SUMS      # must print "zenithd: OK"
install -m 0755 linux-amd64/zenithd /usr/local/bin/zenithd   # or linux-arm64
zenithd version
```

## 2. Create the service account and the unit

```sh
install -m 0644 zenithd.sysusers.conf /usr/lib/sysusers.d/zenithd.conf
systemd-sysusers                      # creates user "zenithd", member of systemd-journal
install -m 0644 zenithd.service /etc/systemd/system/zenithd.service
```

## 3. Configure it

```sh
install -d -m 0750 -o root -g zenithd /etc/zenithd
install -m 0640 -o root -g zenithd config.example.yaml /etc/zenithd/config.yaml
$EDITOR /etc/zenithd/config.yaml      # control plane URL, name, what to open
zenithd --config /etc/zenithd/config.yaml check
```

`check` validates the file and prints exactly which operations this machine will
accept. The defaults are read-only: inspect, processes, service status, metrics,
journal logs and network checks.

### Opt in to more, deliberately

| You want | Do |
|---|---|
| restart specific services | list them in `services.restartAllow`, **and** install the polkit rule below |
| read specific files | list prefixes in `files.readAllow`; make sure the `zenithd` user can read them (for `/var/log`: `usermod -aG adm zenithd`) |
| Docker list / inspect / logs | set `containers.enabled: true` and add the user to the `docker` group (**root-equivalent**, read `docs/platform/ZENITHD.md`) |
| `machine.exec` / `container.exec` | set `exec.enabled: true` (and narrow with `exec.allowArgv0`) |

Restart permission, without running the agent as root:

```sh
install -m 0644 50-zenithd-restart.rules.example /etc/polkit-1/rules.d/50-zenithd-restart.rules
$EDITOR /etc/polkit-1/rules.d/50-zenithd-restart.rules     # same unit list as restartAllow
```

## 4. Register and start

In Zenith, create a **machine** registration token (single use, valid for at most
an hour). Put it in a file only the service user can read, register, and delete it:

```sh
install -d -m 0700 -o zenithd -g zenithd /var/lib/zenithd
install -m 0600 -o zenithd -g zenithd /dev/null /run/zenithd-register.token
$EDITOR /run/zenithd-register.token   # paste the token
sudo -u zenithd zenithd --config /etc/zenithd/config.yaml register --token-file /run/zenithd-register.token
shred -u /run/zenithd-register.token
systemctl enable --now zenithd
journalctl -u zenithd -f
```

Registration generates an Ed25519 key on this machine
(`/var/lib/zenithd/identity.json`, mode 0600) and sends Zenith only the public
half. The token is consumed by the registration and is not stored anywhere.

You can also pass the token through the environment for the registration only:
`ZENITH_REGISTRATION_TOKEN=... sudo -E -u zenithd zenithd register`.

## 5. Operate it

| Task | How |
|---|---|
| see what it did | `/var/lib/zenithd/audit.jsonl` (root-readable; one JSON line per request, never file contents) |
| upgrade | replace `/usr/local/bin/zenithd`, `systemctl restart zenithd` (identity and replay cache persist) |
| revoke | revoke the machine in Zenith; the agent exits with code 3 and systemd leaves it stopped |
| uninstall | `systemctl disable --now zenithd`, remove the unit, `/etc/zenithd`, `/var/lib/zenithd`, the user |

A revoked or upgrade-required agent exits with code 3 or 4 and is **not**
restarted by systemd (`RestartPreventExitStatus=3 4`). After revocation, register
again with `--force` and a new token.
