#!/usr/bin/env bash
# Explicit disposable-host operator action only. No production startup hook.
set -euo pipefail
umask 077
if [[ $# != 4 || ! "$1" =~ ^(setup|check|cleanup)$ || ! "$2" =~ ^[1-9][0-9]{0,8}$ || ! "$3" =~ ^[1-9][0-9]{0,8}$ || ! "$4" =~ ^[a-f0-9]{32}$ ]]; then
  echo 'fixture helper: invalid invocation' >&2
  exit 2
fi
# Python handles no-follow ownership/identity receipts. All raw exceptions are
# suppressed; the four fixed namespaces and four mount destinations are closed.
python3 - "$@" <<'PY'
import errno, fcntl, json, os, platform, stat, struct, subprocess, sys

ACTION, UID, GID, RUN = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
TESTS = '/opt/zenith-file-write-tests'
MOUNTS = '/opt/zenith-file-write-mounts'
GOLDEN = '/opt/zenith-file-write-golden'
UPLOAD_GOLDEN = '/opt/zenith-file-upload-golden'
ROOTS = [TESTS, MOUNTS, GOLDEN, UPLOAD_GOLDEN]
RECEIPT = MOUNTS + '/.gate-receipt.json'
LEASE = MOUNTS + '/.gate-lease'
MOUNT_PAIRS = [
    (MOUNTS + '/sources/anchor', MOUNTS + '/anchor'),
    (MOUNTS + '/sources/backup', MOUNTS + '/backup-anchor'),
    (MOUNTS + '/sources/nested', MOUNTS + '/nested'),
    (MOUNTS + '/sources/file.txt', MOUNTS + '/file-anchor/target.txt'),
]
FDS = []

def refuse():
    raise RuntimeError('fixture-refused')

def mounts():
    rows = []
    with open('/proc/self/mountinfo', encoding='ascii') as stream:
        for line in stream:
            cols = line.split()
            # Exact owned names contain no escapes. Decoding prevents hidden
            # nested mount paths from bypassing the cleanup namespace check.
            target = cols[4]
            for escaped, plain in [('\\040', ' '), ('\\011', '\t'), ('\\012', '\n'), ('\\134', '\\')]:
                target = target.replace(escaped, plain)
            rows.append({'id': int(cols[0]), 'parent': int(cols[1]), 'target': target, 'fs': cols[cols.index('-') + 1]})
    return rows

def mount_id(fd):
    with open('/proc/self/fdinfo/' + str(fd), encoding='ascii') as stream:
        values = [int(line.split(':', 1)[1]) for line in stream if line.startswith('mnt_id:')]
    if len(values) != 1:
        refuse()
    return values[0]

def identity(p):
    st = os.lstat(p)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_DIRECTORY if stat.S_ISDIR(st.st_mode) else 0))
    try:
        opened = os.fstat(fd)
        if (st.st_ino, st.st_dev) != (opened.st_ino, opened.st_dev):
            refuse()
        return {'device': st.st_dev, 'inode': st.st_ino, 'mount': mount_id(fd), 'uid': st.st_uid, 'gid': st.st_gid, 'mode': stat.S_IMODE(st.st_mode), 'directory': stat.S_ISDIR(st.st_mode)}
    finally:
        os.close(fd)

def no_acl(p):
    for name in ['system.posix_acl_access', 'system.posix_acl_default']:
        try:
            os.getxattr(p, name, follow_symlinks=False)
            refuse()
        except OSError as error:
            if error.errno != errno.ENODATA:
                raise

def ancestors():
    root_id = None
    for p in ['/', '/opt']:
        st = os.lstat(p)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o7022:
            refuse()
        no_acl(p)
        item = identity(p)
        if root_id is None:
            root_id = item['mount']
        elif item['mount'] != root_id:
            refuse()
    rows = mounts()
    root_rows = [row for row in rows if row['target'] == '/' and row['id'] == root_id]
    if len(root_rows) != 1 or root_rows[0]['fs'] not in ['ext2', 'ext3', 'ext4', 'xfs', 'btrfs']:
        refuse()
    return root_id

def file(p, data, uid=0, gid=0, mode=0o444):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            if written <= 0:
                refuse()
            offset += written
        os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)

def directory(p, uid=0, gid=0, mode=0o755):
    os.mkdir(p, mode)
    os.chown(p, uid, gid, follow_symlinks=False)
    os.chmod(p, mode, follow_symlinks=False)
    no_acl(p)

def store(receipt):
    temporary = RECEIPT + '.new'
    file(temporary, (json.dumps(receipt, sort_keys=True) + '\n').encode())
    os.replace(temporary, RECEIPT)
    fd = os.open(MOUNTS, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def run(command):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode != 0:
        refuse()

def setup(root_mount):
    if os.geteuid() != 0 or UID == 0 or GID == 0:
        refuse()
    if any(os.path.lexists(p) for p in ROOTS) or any(row['target'] == p or row['target'].startswith(p + '/') for row in mounts() for p in ROOTS):
        refuse()
    # Root first owns all namespaces; nonwritable /opt prevents replacement.
    for p in ROOTS:
        directory(p, mode=0o755)
    receipt = {'schemaVersion': 1, 'runId': RUN, 'uid': UID, 'gid': GID, 'rootMount': root_mount, 'state': 'preparing', 'roots': {p: identity(p) for p in ROOTS}, 'nodes': {}, 'mounts': []}
    store(receipt)
    # Private root-marked lease is readable for flock, never caller replaceable.
    file(LEASE, b'zenith disposable fixture lease\n')
    fcntl.flock(os.open(LEASE, os.O_RDONLY | os.O_NOFOLLOW), fcntl.LOCK_EX | fcntl.LOCK_NB)
    for p in [TESTS, GOLDEN, UPLOAD_GOLDEN]:
        os.chown(p, UID, GID, follow_symlinks=False)
        os.chmod(p, 0o700, follow_symlinks=False)
    receipt['roots'] = {p: identity(p) for p in ROOTS}
    store(receipt)
    # Every mount source remains beneath the root-owned fixture namespace.
    directory(MOUNTS + '/sources', mode=0o755)
    for p in ['sources/anchor', 'sources/backup', 'sources/nested', 'sources/nested/parent', 'anchor', 'backup-anchor', 'nested', 'file-anchor']:
        directory(MOUNTS + '/' + p, UID, GID, 0o700)
    file(MOUNTS + '/sources/file.txt', b'inert regular file mount fixture\n', UID, GID, 0o600)
    file(MOUNTS + '/file-anchor/target.txt', b'inert mount destination\n', UID, GID, 0o600)
    # ACL support must actually work. Extended ACL is removed before tests.
    probe = TESTS + '/.acl-probe'
    file(probe, b'inert ACL capability probe\n', UID, GID, 0o600)
    acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', tag, perm, who) for tag, perm, who in [(1, 6, 0xffffffff), (2, 4, UID + 1), (4, 0, 0xffffffff), (16, 4, 0xffffffff), (32, 0, 0xffffffff)])
    os.setxattr(probe, 'system.posix_acl_access', acl, follow_symlinks=False)
    if os.getxattr(probe, 'system.posix_acl_access', follow_symlinks=False) != acl:
        refuse()
    os.removexattr(probe, 'system.posix_acl_access', follow_symlinks=False)
    os.unlink(probe)
    default_probe = TESTS + '/.acl-directory'
    directory(default_probe, UID, GID, 0o700)
    os.setxattr(default_probe, 'system.posix_acl_default', acl, follow_symlinks=False)
    if os.getxattr(default_probe, 'system.posix_acl_default', follow_symlinks=False) != acl:
        refuse()
    os.removexattr(default_probe, 'system.posix_acl_default', follow_symlinks=False)
    os.rmdir(default_probe)
    for source, target in MOUNT_PAIRS:
        run(['mount', '--bind', source, target])
        # No root flags weakening, recursive bind, remount, or caller-selected mount.
        observed = identity(target)
        if observed['mount'] == root_mount or (observed['device'], observed['inode']) != (identity(source)['device'], identity(source)['inode']):
            refuse()
        receipt['mounts'].append({'source': source, 'target': target, 'identity': observed})
        store(receipt)
    for p in [MOUNTS + '/sources', LEASE] + [source for source, _ in MOUNT_PAIRS] + [target for _, target in MOUNT_PAIRS] + [MOUNTS + '/file-anchor', MOUNTS + '/nested/parent']:
        receipt['nodes'][p] = identity(p)
    receipt['state'] = 'ready'
    store(receipt)

def load(root_mount):
    st = os.lstat(RECEIPT)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o444 or st.st_size > 65536:
        refuse()
    fd = os.open(RECEIPT, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        receipt = json.loads(os.read(fd, 65537))
    finally:
        os.close(fd)
    if receipt.get('schemaVersion') != 1 or receipt.get('runId') != RUN or receipt.get('uid') != UID or receipt.get('gid') != GID or receipt.get('rootMount') != root_mount or receipt.get('state') not in ['preparing', 'ready'] or set(receipt.get('roots', {})) != set(ROOTS):
        refuse()
    for p, expected in receipt['roots'].items():
        actual = identity(p)
        # Ownership transition during failed preparation may remain incomplete;
        # never relax ready-state identities or the root inode/mount pin.
        if actual != expected:
            refuse()
        no_acl(p)
    allowed_pairs = set(MOUNT_PAIRS)
    if len(receipt['mounts']) > 4 or len({item['target'] for item in receipt['mounts']}) != len(receipt['mounts']):
        refuse()
    for item in receipt['mounts']:
        if (item['source'], item['target']) not in allowed_pairs or identity(item['target']) != item['identity']:
            refuse()
    expected_mounts = {(item['target'], item['identity']['mount']) for item in receipt['mounts']}
    actual_mounts = {(row['target'], row['id']) for row in mounts() if any(row['target'] == p or row['target'].startswith(p + '/') for p in ROOTS)}
    if expected_mounts != actual_mounts:
        refuse()
    for p, expected in receipt['nodes'].items():
        allowed = {MOUNTS + '/sources', LEASE, MOUNTS + '/file-anchor', MOUNTS + '/nested/parent'} | {x for pair in MOUNT_PAIRS for x in pair}
        if p not in allowed or identity(p) != expected:
            refuse()
        no_acl(p)
    return receipt

def check(receipt):
    if receipt['state'] != 'ready' or len(receipt['mounts']) != 4 or os.geteuid() not in [0, UID] or (os.geteuid() == UID and os.getegid() != GID):
        refuse()
    if any(identity(p)['uid'] != UID or identity(p)['gid'] != GID or identity(p)['mode'] != 0o700 for p in [TESTS, GOLDEN, UPLOAD_GOLDEN]):
        refuse()
    if identity(MOUNTS)['uid'] != 0 or identity(MOUNTS)['mode'] != 0o755:
        refuse()
    if os.listdir(GOLDEN) or os.listdir(UPLOAD_GOLDEN) or os.path.lexists(MOUNTS + '/anchor/settings.txt') or os.listdir(MOUNTS + '/backup-anchor'):
        refuse()

def users_drained():
    active = TESTS + '/.gate-active'
    if os.path.lexists(active):
        st = os.lstat(active)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != UID or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > 1024:
            refuse()
        with open(active, encoding='ascii') as stream:
            marker = json.load(stream)
        if marker.get('runId') != RUN or type(marker.get('pid')) is not int or marker['pid'] <= 1:
            refuse()
        try:
            os.kill(marker['pid'], 0)
            refuse()
        except ProcessLookupError:
            pass
    # No lazy unmount. Check live cwd/root/fds and mapped files, including
    # descendants whose wrapper was killed. Permission failures fail closed.
    for proc in os.listdir('/proc'):
        if not proc.isdigit() or int(proc) == os.getpid():
            continue
        base = '/proc/' + proc
        try:
            candidates = [base + '/cwd', base + '/root'] + [base + '/fd/' + name for name in os.listdir(base + '/fd')]
            for candidate in candidates:
                try:
                    value = os.readlink(candidate)
                except FileNotFoundError:
                    continue
                if any(value == p or value.startswith(p + '/') for p in ROOTS):
                    refuse()
            with open(base + '/maps', encoding='utf8') as stream:
                if any(any(p in line for p in ROOTS) for line in stream):
                    refuse()
        except FileNotFoundError:
            continue

def delete_tree(fd, device, root_mount):
    # Descriptor-relative traversal never follows a changed child pathname.
    # Refuse same-device bind mounts as well as cross-device filesystem changes.
    st = os.fstat(fd)
    if st.st_dev != device or mount_id(fd) != root_mount:
        refuse()
    for name in os.listdir(fd):
        child_st = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if child_st.st_dev != device:
            refuse()
        if stat.S_ISDIR(child_st.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (child_st.st_dev, child_st.st_ino):
                    refuse()
                delete_tree(child, device, root_mount)
                if os.stat(name, dir_fd=fd, follow_symlinks=False).st_ino != opened.st_ino:
                    refuse()
                os.rmdir(name, dir_fd=fd)
            finally:
                os.close(child)
        elif stat.S_ISREG(child_st.st_mode) or stat.S_ISLNK(child_st.st_mode) or stat.S_ISFIFO(child_st.st_mode):
            os.unlink(name, dir_fd=fd)
        else:
            refuse()

def cleanup(receipt):
    if os.geteuid() != 0:
        refuse()
    lease = os.open(LEASE, os.O_RDONLY | os.O_NOFOLLOW)
    FDS.append(lease)
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    users_drained()
    for item in reversed(receipt['mounts']):
        if identity(item['target']) != item['identity']:
            refuse()
        run(['umount', '--', item['target']])
    if any(row['target'] == p or row['target'].startswith(p + '/') for row in mounts() for p in ROOTS):
        refuse()
    # Root-owned namespace names are pinned again before recursive removal.
    for p in ROOTS:
        current = identity(p)
        expected = receipt['roots'][p]
        if current != expected:
            refuse()
    for p in [UPLOAD_GOLDEN, GOLDEN, TESTS, MOUNTS]:
        fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) != (receipt['roots'][p]['device'], receipt['roots'][p]['inode']):
                refuse()
            delete_tree(fd, st.st_dev, receipt['rootMount'])
            if identity(p) != receipt['roots'][p]:
                refuse()
            os.rmdir(p)
        finally:
            os.close(fd)

try:
    if platform.system() != 'Linux' or (ACTION in ['setup', 'cleanup'] and os.geteuid() != 0):
        refuse()
    root_mount = ancestors()
    if ACTION == 'setup':
        setup(root_mount)
        check(load(root_mount))
    elif ACTION == 'check':
        check(load(root_mount))
    else:
        cleanup(load(root_mount))
    print('fixture helper: ' + ACTION + ' complete')
except Exception:
    # A partial setup intentionally remains for exact-receipt recovery. Never
    # delete unrelated/preexisting roots or conceal a cleanup refusal.
    print('fixture helper: refused; inspect private owned fixture state', file=sys.stderr)
    sys.exit(1)
finally:
    for fd in FDS:
        os.close(fd)
PY
