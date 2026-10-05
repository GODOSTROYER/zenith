#!/usr/bin/env python3
"""Explicit, disposable hosted-Linux fixture; never a deployment/startup hook.

The ordinary test account gets the existing manage-units/restart permission for
one inert unit. No caller chooses a unit, command, policy, account or path.
Unknown effects stay pinned in the root-owned receipt. The original four-root
helper still owns filesystem setup/cleanup and is not modified here.
"""
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys

UNIT = "zenith-mach01-configure-fixture.service"
UNIT_PATH = "/run/systemd/system/" + UNIT
RULE_PATH = "/etc/polkit-1/rules.d/49-zenith-mach01-configure-fixture.rules"
ROOT = "/opt/zenith-file-write-mounts"
TESTS = "/opt/zenith-file-write-tests"
RECEIPT = ROOT + "/.mach01-systemd-receipt.json"
LEASE = ROOT + "/.mach01-systemd-lease"
CANONICAL_LEASE = ROOT + "/.gate-lease"
MARKERS = [TESTS + "/.mach01-systemd-ops-active", TESTS + "/.mach01-systemd-executor-active"]
SYSTEMCTL = "/usr/bin/systemctl"
PROPERTIES = "LoadState,ActiveState,SubState,FragmentPath,InvocationID,MainPID,Job,User,Group,NoNewPrivileges,CapabilityBoundingSet,AmbientCapabilities"
SELF = Path(__file__).resolve()
CANONICAL = SELF.parent / "guest-file-write-fixtures.sh"
OPENED = []
CURRENT = None
# Diagnostic values are fixed source stages, never exception text or native data.
FAILURE_PHASE = "arguments"
FAILURE_PHASES = ('arguments', 'host-identity', 'account-identity', 'protected-parents', 'canonical-fixture-check', 'setup-lease', 'setup-object-absence', 'setup-unit-absence', 'setup-polkit-active', 'setup-canonical-custody', 'setup-preparing-receipt', 'setup-owned-files', 'setup-daemon-reload', 'setup-unit-poststate', 'setup-ready-receipt', 'existing-receipt', 'existing-custody', 'cleanup-leases', 'cleanup-current-custody', 'cleanup-preparing-receipt', 'cleanup-revoke-rule', 'cleanup-stop-unit', 'cleanup-inactive-unit', 'cleanup-remove-unit', 'cleanup-daemon-reload', 'cleanup-unit-absence', 'cleanup-remove-lease', 'cleanup-final-receipt')


def refuse():
    raise RuntimeError("fixture-refused")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def no_acl(fd):
    for name in ["system.posix_acl_access", "system.posix_acl_default"]:
        try:
            os.getxattr(fd, name)
        except OSError as error:
            if error.errno == errno.ENODATA:  # Unsupported observations refuse.
                continue
            raise
        refuse()


def metadata(fd):
    st = os.fstat(fd)
    return {"device": st.st_dev, "inode": st.st_ino, "uid": st.st_uid,
            "gid": st.st_gid, "mode": stat.S_IMODE(st.st_mode), "links": st.st_nlink,
            "size": st.st_size}


def protected_directory(path):
    # Walk the actual root descriptor; never accept a symlinked ancestor.
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for part in [None, *Path(path).parts[1:]]:
            if part is not None:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd)
                fd = child
            st = os.fstat(fd)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o7022:
                refuse()
            no_acl(fd)
        return metadata(fd)
    finally:
        os.close(fd)


def observed_file(path, mode, maximum=65536):
    protected_directory(str(Path(path).parent))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != mode or st.st_size > maximum:
            refuse()
        no_acl(fd)
        data = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        named = os.lstat(path)
        if len(data) != st.st_size or metadata(fd) != {"device": st.st_dev, "inode": st.st_ino, "uid": st.st_uid, "gid": st.st_gid, "mode": stat.S_IMODE(st.st_mode), "links": st.st_nlink, "size": st.st_size} or (named.st_dev, named.st_ino) != (after.st_dev, after.st_ino):
            refuse()
        return {**metadata(fd), "sha256": digest(data)}, data
    finally:
        os.close(fd)


def write_new(path, data, mode):
    protected_directory(str(Path(path).parent))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        offset = 0
        while offset < len(data):
            n = os.write(fd, data[offset:])
            if n <= 0:
                refuse()
            offset += n
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_parent(path)


def sync_parent(path):
    fd = os.open(str(Path(path).parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def store():
    if CURRENT is None:
        refuse()
    temporary = RECEIPT + ".new"
    write_new(temporary, (json.dumps(CURRENT, sort_keys=True) + "\n").encode(), 0o444)
    os.replace(temporary, RECEIPT)
    sync_parent(RECEIPT)


def group_absent(pid):
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return True
    return False


def command(args, effect=None):
    # Persist before delivery. Timeout/interruption/nonzero/lost readback leaves
    # pending set; no later presence/status observation clears it.
    if effect is not None:
        CURRENT["pending"] = effect
        store()
    child = None
    settled = False
    try:
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, start_new_session=True,
                                 env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C"})
        output, _ = child.communicate(timeout=20)
        settled = child.returncode == 0 and group_absent(child.pid)
        if not settled or len(output) > 8192:
            refuse()
        if effect is not None:
            CURRENT["pending"] = None
            store()
        return output.decode("utf-8", errors="strict")
    finally:
        if child is not None and not settled:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.communicate(timeout=2)
            if not group_absent(child.pid):
                refuse()


def show(unit):
    raw = command([SYSTEMCTL, "show", "--all", "--no-pager", "--property=" + PROPERTIES, "--", unit])
    rows = raw.splitlines()
    result = {}
    for row in rows:
        key, separator, value = row.partition("=")
        if not separator or key in result or key not in PROPERTIES.split(","):
            refuse()
        result[key] = value
    if set(result) != set(PROPERTIES.split(",")):
        refuse()
    return result


def unit_owned(uid, gid):
    item = show(UNIT)
    if item["LoadState"] != "loaded" or item["FragmentPath"] != UNIT_PATH or item["User"] != str(uid) or item["Group"] != str(gid) or item["NoNewPrivileges"] != "yes" or item["CapabilityBoundingSet"] or item["AmbientCapabilities"] or item["MainPID"] != "0" or item["Job"] != "0":
        refuse()
    if item["ActiveState"] not in ["inactive", "active"] or item["SubState"] not in ["dead", "exited"]:
        refuse()
    return item


def lock(path):
    observed_file(path, 0o444)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    OPENED.append(fd)


def validate(receipt, uid, gid, run):
    if set(receipt) != {"schemaVersion", "runId", "uid", "gid", "username", "state", "pending", "objects", "helperSha256", "canonicalReceiptSha256"} or receipt["schemaVersion"] != 1 or receipt["runId"] != run or receipt["uid"] != uid or receipt["gid"] != gid or receipt["helperSha256"] != digest(SELF.read_bytes()) or receipt["state"] != "ready" or receipt["pending"] is not None:
        refuse()
    canonical, _ = observed_file(ROOT + "/.gate-receipt.json", 0o444)
    if canonical["sha256"] != receipt["canonicalReceiptSha256"] or pwd.getpwuid(uid).pw_name != receipt["username"]:
        refuse()
    if set(receipt["objects"]) != {UNIT_PATH, RULE_PATH, LEASE}:
        refuse()
    for path, item in receipt["objects"].items():
        # Standard polkit rule directories can be non-traversable to the test
        # account. Do not widen their ACL/mode/group. The unprivileged check
        # reads our immutable root-owned custody receipt; root setup/cleanup
        # independently opens the actual rule, and native allow/deny calls test
        # the effective permission. This grants no production authority.
        if path == RULE_PATH and os.geteuid() != 0:
            if set(item) != {"device", "inode", "uid", "gid", "mode", "links", "size", "sha256"} or item["uid"] != 0 or item["mode"] != 0o644 or item["links"] != 1 or not 1 <= item["size"] <= 65536 or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
                refuse()
            continue
        actual, _ = observed_file(path, 0o444 if path == LEASE else 0o644)
        if actual != item:
            refuse()
    if any(os.path.lexists(p) for p in MARKERS):
        refuse()
    return unit_owned(uid, gid)


def interrupt(_number, _frame):
    raise RuntimeError("fixture-interrupted")


def main():
    global CURRENT, FAILURE_PHASE
    if len(sys.argv) != 5 or sys.argv[1] not in ["setup", "check", "cleanup"] or not re.fullmatch(r"[1-9][0-9]{0,8}", sys.argv[2]) or not re.fullmatch(r"[1-9][0-9]{0,8}", sys.argv[3]) or not re.fullmatch(r"[a-f0-9]{32}", sys.argv[4]):
        refuse()
    action, uid, gid, run = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    FAILURE_PHASE = "host-identity"
    if sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or os.environ.get("RUNNER_OS") != "Linux" or Path("/proc/1/comm").read_text().strip() != "systemd" or (action != "check" and os.geteuid() != 0) or os.geteuid() not in [0, uid] or (os.geteuid() == uid and os.getegid() != gid):
        refuse()
    FAILURE_PHASE = "account-identity"
    account = pwd.getpwuid(uid)
    if account.pw_uid != uid or account.pw_gid != gid or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", account.pw_name):
        refuse()
    FAILURE_PHASE = "protected-parents"
    parents = [str(Path(UNIT_PATH).parent), ROOT]
    if os.geteuid() == 0:
        parents.append(str(Path(RULE_PATH).parent))
    for path in parents:
        protected_directory(path)
    FAILURE_PHASE = "canonical-fixture-check"
    command(["/usr/bin/bash", str(CANONICAL), "postcheck", str(uid), str(gid), run])
    if action == "setup":
        FAILURE_PHASE = "setup-lease"
        lock(CANONICAL_LEASE)
        FAILURE_PHASE = "setup-object-absence"
        if any(os.path.lexists(p) for p in [UNIT_PATH, RULE_PATH, RECEIPT, RECEIPT + ".new", LEASE, *MARKERS]):
            refuse()
        FAILURE_PHASE = "setup-unit-absence"
        absent = show(UNIT)
        if absent["LoadState"] != "not-found" or absent["FragmentPath"]:
            refuse()
        FAILURE_PHASE = "setup-polkit-active"
        if show("polkit.service")["ActiveState"] != "active":
            refuse()
        FAILURE_PHASE = "setup-canonical-custody"
        canonical, _ = observed_file(ROOT + "/.gate-receipt.json", 0o444)
        CURRENT = {"schemaVersion": 1, "runId": run, "uid": uid, "gid": gid, "username": account.pw_name, "state": "preparing", "pending": None, "objects": {}, "helperSha256": digest(SELF.read_bytes()), "canonicalReceiptSha256": canonical["sha256"]}
        FAILURE_PHASE = "setup-preparing-receipt"
        store()
        unit = ("[Unit]\nDescription=Owned inert Zenith MACH01 acceptance fixture\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/true\nUser=" + str(uid) + "\nGroup=" + str(gid) + "\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nAmbientCapabilities=\nProtectSystem=strict\nPrivateTmp=yes\n").encode()
        rule = ("// Owned disposable MACH01 fixture; restart only.\npolkit.addRule(function(action, subject) {\n  if (subject.user === " + json.dumps(account.pw_name) + " && action.id === 'org.freedesktop.systemd1.manage-units' && action.lookup('verb') === 'restart' && action.lookup('unit') === '" + UNIT + "') { return polkit.Result.YES; }\n  return polkit.Result.NOT_HANDLED;\n});\n").encode()
        FAILURE_PHASE = "setup-owned-files"
        for path, data, mode in [(UNIT_PATH, unit, 0o644), (RULE_PATH, rule, 0o644), (LEASE, b"owned MACH01 systemd fixture lease\n", 0o444)]:
            CURRENT["pending"] = "create-owned-file"
            store()
            write_new(path, data, mode)
            CURRENT["objects"][path], _ = observed_file(path, mode)
            CURRENT["pending"] = None
            store()
        FAILURE_PHASE = "setup-daemon-reload"
        command([SYSTEMCTL, "daemon-reload"], "daemon-reload")
        FAILURE_PHASE = "setup-unit-poststate"
        item = unit_owned(uid, gid)
        if item["ActiveState"] != "inactive":
            refuse()
        FAILURE_PHASE = "setup-ready-receipt"
        CURRENT["state"] = "ready"
        store()
    else:
        FAILURE_PHASE = "existing-receipt"
        _, raw = observed_file(RECEIPT, 0o444)
        CURRENT = json.loads(raw)
        FAILURE_PHASE = "existing-custody"
        validate(CURRENT, uid, gid, run)
        if action == "cleanup":
            FAILURE_PHASE = "cleanup-leases"
            lock(CANONICAL_LEASE)
            lock(LEASE)
            FAILURE_PHASE = "cleanup-current-custody"
            validate(CURRENT, uid, gid, run)
            FAILURE_PHASE = "cleanup-preparing-receipt"
            CURRENT["state"] = "cleaning"
            store()
            # Revoke exactly our grant before stopping/removing our inert unit.
            FAILURE_PHASE = "cleanup-revoke-rule"
            for path in [RULE_PATH]:
                actual, _ = observed_file(path, 0o644)
                if actual != CURRENT["objects"][path]:
                    refuse()
                os.unlink(path)
                sync_parent(path)
            FAILURE_PHASE = "cleanup-stop-unit"
            command([SYSTEMCTL, "stop", "--no-pager", "--", UNIT], "stop-owned-unit")
            FAILURE_PHASE = "cleanup-inactive-unit"
            item = unit_owned(uid, gid)
            if item["ActiveState"] != "inactive":
                refuse()
            FAILURE_PHASE = "cleanup-remove-unit"
            actual, _ = observed_file(UNIT_PATH, 0o644)
            if actual != CURRENT["objects"][UNIT_PATH]:
                refuse()
            os.unlink(UNIT_PATH)
            sync_parent(UNIT_PATH)
            FAILURE_PHASE = "cleanup-daemon-reload"
            command([SYSTEMCTL, "daemon-reload"], "daemon-reload")
            FAILURE_PHASE = "cleanup-unit-absence"
            missing = show(UNIT)
            if missing["LoadState"] != "not-found" or missing["FragmentPath"] or missing["MainPID"] != "0" or missing["Job"] != "0" or os.path.lexists(UNIT_PATH) or os.path.lexists(RULE_PATH):
                refuse()
            FAILURE_PHASE = "cleanup-remove-lease"
            actual, _ = observed_file(LEASE, 0o444)
            if actual != CURRENT["objects"][LEASE]:
                refuse()
            os.unlink(LEASE)
            sync_parent(LEASE)
            if os.path.lexists(LEASE):
                refuse()
            FAILURE_PHASE = "cleanup-final-receipt"
            CURRENT["state"] = "cleaned"
            store()
    print(json.dumps({"fixture": "mach01-systemd", "action": action, "status": "ready" if action != "cleanup" else "cleaned"}))


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    try:
        main()
    except Exception:
        print('{"fixture":"mach01-systemd","status":"refused"}', file=sys.stderr)
        print(json.dumps({"fixture": "mach01-systemd", "failurePhase": FAILURE_PHASE if FAILURE_PHASE in FAILURE_PHASES else "unavailable"}), file=sys.stderr)
        sys.exit(1)
    finally:
        for opened in OPENED:
            os.close(opened)
