# Installing zenith-runner on a Linux host

1. Download `zenith-runner` for your architecture and verify it against the
   published `SHA256SUMS` (or build it: `go/build.sh VERSION`), then
   `install -m 0755 zenith-runner /usr/local/bin/zenith-runner`.
2. Create the service account:
   `useradd --system --home-dir /var/lib/zenith-runner --shell /usr/sbin/nologin zenith-runner`.
3. Write `/etc/zenith-runner/config.yaml` (see `docs/platform/RUNNER.md`) and
   install `zenith-runner.service` from this directory into `/etc/systemd/system/`.
4. Create a registration token in Zenith (kind runner, valid up to one hour),
   register once as the service user, then start the unit:

   ```sh
   sudo -u zenith-runner zenith-runner --config /etc/zenith-runner/config.yaml \
        register --token-file /root/zrt.token
   systemctl enable --now zenith-runner
   ```

   The token is consumed by registration and stored nowhere. The state directory
   (`/var/lib/zenith-runner`) must be writable by the service user.
5. Operate it:

| Task | How |
|---|---|
| see its state | Zenith shows online, degraded, offline, recovering and revoked; locally `zenith-runner update status` shows the release state |
| revoke | revoke the runner in Zenith; it exits with code 3, records the revocation in `/var/lib/zenith-runner/revoked.json`, and systemd leaves it stopped |
| recover after revoke | register again with `--force` and a new token (this clears the local revocation) |
| upgrade by hand | replace `/usr/local/bin/zenith-runner`, then `systemctl restart zenith-runner` |
| upgrade through the signed channel | enable the `update` block (see `docs/platform/RUNNER-UPDATES.md`) |
| undelivered results | spooled in `/var/lib/zenith-runner/spool`, delivered after reconnect; refused ones sit in `spool/quarantine` |
