#!/usr/bin/env python3
"""Explicit preparation of one disposable GitHub-hosted Linux VM only.

The fixture helper and writer keep their existing guards. This helper can
only harden the pinned /opt directory's mode and two validated Linux POSIX
ACL attributes; it never changes ownership, contents, mounts or root ACLs.
"""
import errno
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import struct
import sys


ROOTS = (
    '/opt/zenith-file-write-tests',
    '/opt/zenith-file-write-mounts',
    '/opt/zenith-file-write-golden',
)
SUPPORTED_FILESYSTEMS = frozenset(('ext2', 'ext3', 'ext4', 'xfs', 'btrfs'))
ID = re.compile(r'[1-9][0-9]{0,8}\Z')
RUN = re.compile(r'[a-f0-9]{32}\Z')
ACL_NAMES = {'access': 'system.posix_acl_access',
             'default': 'system.posix_acl_default'}
ACL_MAX_BYTES = 4096
UNDEFINED_ID = 0xffffffff


class Refusal(Exception):
    """Only fixed reason IDs reach the current-attempt report."""


def refuse(reason):
    raise Refusal(reason)


def mount_id(fd):
    with open('/proc/self/fdinfo/' + str(fd), encoding='ascii') as stream:
        rows = [line.split(':', 1)[1].strip() for line in stream
                if line.startswith('mnt_id:')]
    if len(rows) != 1 or not rows[0].isdigit():
        refuse('mount_identity_unavailable')
    return int(rows[0])


def root_filesystem(root_mount):
    rows = []
    with open('/proc/self/mountinfo', encoding='ascii') as stream:
        for line in stream:
            cols = line.split()
            if cols[4] == '/' and int(cols[0]) == root_mount:
                rows.append(cols[cols.index('-') + 1])
    if len(rows) != 1:
        refuse('root_mount_ambiguous')
    return rows[0]


def acl_metadata(raw):
    # Linux UAPI v2: little-endian 32-bit header and 8-byte tag/perm/id entries.
    # Accept canonical owner, sorted named users, group, sorted named groups,
    # optional/required mask, other. No entry IDs or raw bytes reach logs.
    if (not isinstance(raw, bytes) or len(raw) < 28
            or len(raw) > ACL_MAX_BYTES or (len(raw) - 4) % 8
            or struct.unpack_from('<I', raw)[0] != 2):
        refuse('malformed_posix_acl')
    entries = list(struct.iter_unpack('<HHI', raw[4:]))
    state, named, prior_user, prior_group = 1, False, -1, -1
    owner = group = mask = other = None
    for tag, perm, entry_id in entries:
        if perm & ~7:
            refuse('malformed_posix_acl')
        if tag in (1, 4, 16, 32) and entry_id != UNDEFINED_ID:
            refuse('malformed_posix_acl')
        if tag == 1 and state == 1:
            owner, state = perm, 2
        elif tag == 2 and state == 2 and prior_user < entry_id < UNDEFINED_ID:
            prior_user, named = entry_id, True
        elif tag == 4 and state == 2:
            group, state = perm, 8
        elif tag == 8 and state == 8 and prior_group < entry_id < UNDEFINED_ID:
            prior_group, named = entry_id, True
        elif tag == 16 and state == 8:
            mask, state = perm, 32
        elif tag == 32 and (state == 32 or state == 8 and not named):
            other, state = perm, 0
        else:
            refuse('malformed_posix_acl')
    if state != 0:
        refuse('malformed_posix_acl')
    return {'bytes': len(raw), 'entries': len(entries),
            'sha256': hashlib.sha256(raw).hexdigest(),
            'modeBits': owner << 6 | (group if mask is None else mask) << 3 | other}


def acl_state(fd):
    try:
        names = os.listxattr(fd)
    except OSError:
        refuse('acl_observation_unavailable')
    try:
        invalid = (not isinstance(names, list) or len(names) > 64
                   or any(not isinstance(n, str) or not n or '\x00' in n
                          or len(n.encode('utf-8')) > 255 for n in names)
                   or len(set(names)) != len(names))
    except UnicodeError:
        refuse('unsupported_xattr_metadata')
    if invalid:
        refuse('unsupported_xattr_metadata')
    if any('acl' in n.lower() and n not in ACL_NAMES.values() for n in names):
        refuse('unsupported_acl_attribute')
    observed = {}
    for kind, name in ACL_NAMES.items():
        try:
            raw = os.getxattr(fd, name)
        except OSError as error:
            if error.errno != errno.ENODATA:
                refuse('acl_observation_unavailable')
            if name in names:
                refuse('acl_identity_changed')
            observed[kind] = None
        else:
            if name not in names:
                refuse('acl_identity_changed')
            observed[kind] = acl_metadata(raw)
    # Preserve every unrelated attribute name without printing its name/value.
    other = sorted(n for n in names if n not in ACL_NAMES.values())
    other_digest = hashlib.sha256(json.dumps(other, separators=(',', ':')).encode()).hexdigest()
    return observed, other_digest


def identity(fd):
    item = os.fstat(fd)
    acl, other = acl_state(fd)
    if (acl['access'] is not None
            and acl['access']['modeBits'] != (stat.S_IMODE(item.st_mode) & 0o777)):
        refuse('acl_mode_mismatch')
    return {
        'device': item.st_dev, 'inode': item.st_ino, 'mount': mount_id(fd),
        'uid': item.st_uid, 'gid': item.st_gid,
        'mode': stat.S_IMODE(item.st_mode),
        'directory': stat.S_ISDIR(item.st_mode),
        'noAcl': all(value is None for value in acl.values()),
        'acl': acl, 'otherXattrNamesSha256': other,
    }


class SystemHost:
    def __init__(self):
        self.root_fd = None
        self.opt_fd = None

    def __enter__(self):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        self.root_fd = os.open('/', flags)
        try:
            self.opt_fd = os.open('opt', flags, dir_fd=self.root_fd)
        except Exception:
            os.close(self.root_fd)
            self.root_fd = None
            raise
        return self

    def __exit__(self, *_):
        if self.opt_fd is not None:
            os.close(self.opt_fd)
        if self.root_fd is not None:
            os.close(self.root_fd)

    def observe(self):
        root, opt = identity(self.root_fd), identity(self.opt_fd)
        # Reopen both exact names without following links. A pinned original
        # fd alone cannot prove that /opt still names that same directory.
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        current_root = os.open('/', flags)
        try:
            current_opt = os.open('opt', flags, dir_fd=current_root)
            try:
                if root != identity(current_root) or opt != identity(current_opt):
                    refuse('ancestor_identity_changed')
            finally:
                os.close(current_opt)
        finally:
            os.close(current_root)
        with open('/proc/self/status', encoding='ascii') as stream:
            caps = [line.split(':', 1)[1].strip() for line in stream
                    if line.startswith('CapEff:')]
        if len(caps) != 1 or not re.fullmatch(r'[a-fA-F0-9]{1,16}', caps[0]):
            refuse('capability_observation_unavailable')
        return {
            'root': root, 'opt': opt,
            'rootFilesystem': root_filesystem(root['mount']),
            'sysAdmin': bool(int(caps[0], 16) & (1 << 21)),
            'toolsPresent': all(shutil.which(tool) is not None
                                for tool in ('mount', 'umount', 'flock')),
            'fixtureRootsAbsent': not any(os.path.lexists(p) for p in ROOTS),
        }

    def harden_opt(self):
        # Operates on the exact no-follow descriptor, never a recursive path.
        os.fchmod(self.opt_fd, 0o755)

    def remove_opt_acl(self, kind):
        if kind not in ACL_NAMES:
            refuse('unsupported_acl_attribute')
        # Only these two fixed attributes on the pinned no-follow descriptor.
        # ENODATA after a present observation is a race, not successful removal.
        try:
            os.removexattr(self.opt_fd, ACL_NAMES[kind])
        except OSError:
            refuse('opt_acl_removal_failed')


def validate(observed):
    root, opt = observed['root'], observed['opt']
    if not root['directory'] or root['uid'] != 0 or root['mode'] & 0o7022:
        refuse('unsafe_root_ancestor')
    if not root['noAcl']:
        refuse('ancestor_acl_present')
    if opt['noAcl'] != all(value is None for value in opt['acl'].values()):
        refuse('acl_identity_changed')
    if not opt['directory'] or opt['uid'] != 0:
        refuse('unsafe_opt_ownership')
    if opt['mode'] not in (0o755, 0o777):
        refuse('unexpected_opt_mode')
    if root['device'] != opt['device'] or root['mount'] != opt['mount']:
        refuse('opt_not_on_root_mount')
    if observed['rootFilesystem'] not in SUPPORTED_FILESYSTEMS:
        refuse('unsupported_root_filesystem')
    if not observed['sysAdmin']:
        refuse('bind_mount_authority_unavailable')
    if not observed['toolsPresent']:
        refuse('required_mount_tool_unavailable')
    if not observed['fixtureRootsAbsent']:
        refuse('fixture_namespace_preexists')


def prepare(host, report):
    before = host.observe()
    report['before'] = before
    validate(before)
    # Independently observe again before the only allowed physical mutation.
    if host.observe() != before:
        refuse('ancestor_identity_changed')
    expected = before
    for kind in ACL_NAMES:
        if expected['opt']['acl'][kind] is None:
            continue
        # Reobserve descriptor/name/attributes immediately before EACH removal.
        if host.observe() != expected:
            refuse('ancestor_identity_changed')
        host.remove_opt_acl(kind)
        report['removedOptAcls'].append(kind)
        next_acl = {**expected['opt']['acl'], kind: None}
        expected = {**expected, 'opt': {**expected['opt'], 'acl': next_acl,
                    'noAcl': all(value is None for value in next_acl.values())}}
        report['after'] = host.observe()
        if report['after'] != expected:
            refuse('ancestor_identity_changed')
    if before['opt']['mode'] == 0o777 or report['removedOptAcls']:
        if host.observe() != expected:
            refuse('ancestor_identity_changed')
        try:
            host.harden_opt()
        except OSError:
            refuse('opt_mode_hardening_failed')
        report['hardenedOpt'] = True
    after = host.observe()
    report['after'] = after
    expected = {**expected, 'opt': {**expected['opt'], 'mode': 0o755}}
    if after != expected:
        refuse('ancestor_identity_changed')
    validate(after)
    if not after['opt']['noAcl']:
        refuse('ancestor_acl_present')
    if host.observe() != after:
        refuse('ancestor_identity_changed')


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if (len(args) != 4 or args[0] != '--github-hosted-disposable'
            or not ID.fullmatch(args[1]) or not ID.fullmatch(args[2])
            or not RUN.fullmatch(args[3])):
        print('native guest host: invalid invocation', file=sys.stderr)
        return 2
    report = {
        'schemaVersion': 1, 'kind': 'native-guest-host-prerequisites',
        'fixtureRunId': args[3], 'testUid': int(args[1]), 'testGid': int(args[2]),
        'verdict': 'refused', 'hardenedOpt': False, 'removedOptAcls': [],
    }
    try:
        if (platform.system() != 'Linux' or os.geteuid() != 0
                or os.environ.get('GITHUB_ACTIONS') != 'true'
                or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted'
                or os.environ.get('RUNNER_OS') != 'Linux'):
            refuse('disposable_host_authorization_absent')
        with SystemHost() as host:
            prepare(host, report)
        report['verdict'] = 'ready'
        report['reason'] = 'prerequisites_observed'
    except Refusal as error:
        report['reason'] = str(error)
    except Exception:
        report['reason'] = 'system_observation_failed'
    # Only this invocation's closed metadata is emitted. There is no report
    # import/path, retained pass, raw environment inventory or exception text.
    print(json.dumps(report, sort_keys=True, separators=(',', ':')))
    return 0 if report['verdict'] == 'ready' else 1


if __name__ == '__main__':
    sys.exit(main())
