#!/usr/bin/env python3
"""Explicit preparation of one disposable GitHub-hosted Linux VM only.

The fixture helper and writer keep their existing guards. This helper can
only remove write permission from the pinned /opt directory itself; it never
changes its ownership, contents, mount, ACLs or the root filesystem flags.
"""
import errno
import json
import os
import platform
import re
import shutil
import stat
import sys


ROOTS = (
    '/opt/zenith-file-write-tests',
    '/opt/zenith-file-write-mounts',
    '/opt/zenith-file-write-golden',
)
SUPPORTED_FILESYSTEMS = frozenset(('ext2', 'ext3', 'ext4', 'xfs', 'btrfs'))
ID = re.compile(r'[1-9][0-9]{0,8}\Z')
RUN = re.compile(r'[a-f0-9]{32}\Z')


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


def no_acl(fd):
    for name in ('system.posix_acl_access', 'system.posix_acl_default'):
        try:
            os.getxattr(fd, name)
        except OSError as error:
            if error.errno == errno.ENODATA:
                continue
            refuse('acl_observation_unavailable')
        return False
    return True


def identity(fd):
    item = os.fstat(fd)
    return {
        'device': item.st_dev, 'inode': item.st_ino, 'mount': mount_id(fd),
        'uid': item.st_uid, 'gid': item.st_gid,
        'mode': stat.S_IMODE(item.st_mode),
        'directory': stat.S_ISDIR(item.st_mode), 'noAcl': no_acl(fd),
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


def validate(observed):
    root, opt = observed['root'], observed['opt']
    if not root['directory'] or root['uid'] != 0 or root['mode'] & 0o7022:
        refuse('unsafe_root_ancestor')
    if not root['noAcl'] or not opt['noAcl']:
        refuse('ancestor_acl_present')
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
    if before['opt']['mode'] == 0o777:
        host.harden_opt()
        report['hardenedOpt'] = True
    after = host.observe()
    report['after'] = after
    expected = {**before, 'opt': {**before['opt'], 'mode': 0o755}}
    if after != expected:
        refuse('ancestor_identity_changed')
    validate(after)
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
        'verdict': 'refused', 'hardenedOpt': False,
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
