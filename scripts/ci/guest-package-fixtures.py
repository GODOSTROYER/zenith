#!/usr/bin/env python3
"""Canonical direct native package phase; raw output is consumed privately by the existing Go validator.

The caller stays unprivileged. Only a fresh pinned, native Debian guest receives
fixed setup privileges. Unknown daemon delivery preserves resources and fails;
a successful CLI reply, drained group and durable completion are all necessary.
This phase does not start the installed helper unit or ordinary daemon.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import resource
import signal
import subprocess
import sys
import tarfile
import time

INDEX = 'sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251'
NATIVE = (
    'TestPackageHelperNativeNoFollowAndCustody',
    'TestPackageFrontendLockIndependentProcess',
    'TestPackageNativeSignedFirstInstallAndNonReplay',
    'TestPackageNativeDeclaredMountAndACLRefusals',
)
PATTERN = '^(' + '|'.join(NATIVE) + ')$'
MIB = 1024 ** 2
RESERVE = 8 * 1024 ** 3
ROOT_BYTES = 2560 * MIB
CAPS = ('SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'CHOWN', 'SETUID', 'SETGID')
ENV = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME')}
ENV.update(GIT_OPTIONAL_LOCKS='0', LC_ALL='C', GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off')

PROBE_GO = 'package main\nimport("crypto/sha256";"encoding/binary";"encoding/hex";"encoding/json";"fmt";"os";"path/filepath";"strings";"syscall")\ntype Entry struct { Mode uint32 `json:"mode"`; UID uint32 `json:"uid"`; GID uint32 `json:"gid"`; Bytes int64 `json:"bytes"`; SHA string `json:"sha256"` }\nfunc must(e error){if e!=nil{panic("owned fixture prerequisite failed")}}\nfunc snapshot(prefix string){\n if prefix!=""&&prefix!="/guest/rootfs"{panic("invalid fixed snapshot target")}\n result:=map[string]Entry{};var total int64\n for _,root:=range []string{"/var/lib/dpkg","/etc/dpkg"}{must(filepath.Walk(prefix+root,func(p string,i os.FileInfo,e error)error{\n  if e!=nil{return e};st:=i.Sys().(*syscall.Stat_t);v:=Entry{Mode:st.Mode,UID:st.Uid,GID:st.Gid}\n  var raw []byte\n  if i.Mode().IsRegular(){if i.Size()>16<<20{return fmt.Errorf("bound")};raw,e=os.ReadFile(p)}else if i.Mode()&os.ModeSymlink!=0{var s string;s,e=os.Readlink(p);raw=[]byte(s)}else if !i.IsDir(){return fmt.Errorf("type")}\n  if e!=nil{return e};total+=int64(len(raw));if total>128<<20{return fmt.Errorf("bound")};v.Bytes=int64(len(raw));h:=sha256.Sum256(raw);v.SHA=hex.EncodeToString(h[:]);result[strings.TrimPrefix(p,prefix)]=v;return nil\n }))};must(json.NewEncoder(os.Stdout).Encode(result))\n}\nfunc absentDir(p string,mode os.FileMode){if _,e:=os.Lstat(p);!os.IsNotExist(e){panic("fixture already exists")};must(os.Mkdir(p,mode))}\nfunc fresh(p string,raw []byte){f,e:=os.OpenFile(p,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600);must(e);_,e=f.Write(raw);must(e);must(f.Sync());must(f.Close())}\nfunc setup(){\n var fs syscall.Statfs_t;must(syscall.Statfs("/",&fs));if uint64(fs.Type)!=0xef53{panic("persistent ext4 root required")}\n for _,p:=range []string{"/var/lib/zenithd-package-install","/var/lib/zenithd-package-install/archives","/var/lib/zenithd-package-install/staged","/var/lib/zenithd-package-install/backups","/var/lib/zenithd-package-install/intents","/etc/zenithd"}{absentDir(p,0700)}\n absentDir("/opt/zenith-packages",0755);absentDir("/run/zenithd-package-install",0755)\n fresh("/run/zenith-package-acceptance-owned",[]byte("zenith-owned-disposable-package-install-v1\\n"))\n base:="/var/lib/zenithd-package-install";for _,p:=range []string{base+"/mount-controls",base+"/mount-controls/nested",base+"/mount-sources",base+"/mount-sources/directory",base+"/acl-controls"}{absentDir(p,0700)}\n fresh(base+"/mount-sources/directory/source",[]byte("owned directory mount control"));fresh(base+"/mount-sources/file",[]byte("owned file mount control"));fresh(base+"/mount-controls/file",nil)\n must(syscall.Mount(base+"/mount-sources/directory",base+"/mount-controls/nested","",syscall.MS_BIND,""));must(syscall.Mount(base+"/mount-sources/file",base+"/mount-controls/file","",syscall.MS_BIND,""))\n p:=base+"/acl-controls/source";fresh(p,[]byte("owned real access ACL control"));acl:=make([]byte,4);binary.LittleEndian.PutUint32(acl,2)\n for _,v:=range [][3]uint32{{1,6,0xffffffff},{2,4,12345},{4,0,0xffffffff},{16,4,0xffffffff},{32,0,0xffffffff}}{b:=make([]byte,8);binary.LittleEndian.PutUint16(b,uint16(v[0]));binary.LittleEndian.PutUint16(b[2:],uint16(v[1]));binary.LittleEndian.PutUint32(b[4:],v[2]);acl=append(acl,b...)}\n must(syscall.Setxattr(p,"system.posix_acl_access",acl,0));fmt.Println("owned real mount and ACL fixtures created")\n}\nfunc main(){if len(os.Args)!=2{panic("fixed command required")};switch os.Args[1]{case "snapshot-image":snapshot("");case "snapshot-copy":snapshot("/guest/rootfs");case "setup":setup();default:panic("unknown fixed command")}}\n'

BACKING = 'set -euo pipefail\ntest -f /guest/rootfs.ext4 && test ! -L /guest/rootfs.ext4\ntest "$(stat -c \'%u:%g:%a:%h:%s\' /guest/rootfs.ext4)" = 0:0:600:1:2684354560\nstat -c \'%d:%i\' /guest/rootfs.ext4\nfindmnt -nr -T /guest/rootfs.ext4 -o MAJ:MIN\n'

LOOP_NODE = 'set -euo pipefail\ncase "$1" in /dev/loop[0-9]*) ;; *) exit 1;; esac\ntest ! -e "$1" && test ! -L "$1"\nmknod -m0600 "$1" b 7 "${1##*loop}"\ntest "$(stat -c \'%u:%g:%a\' "$1")" = 0:0:600\ntest -b "$1"\n'

SETUP = 'set -euo pipefail\ntest "$(dpkg-query -W -f=\'${Version}\' dpkg)" = 1.21.23\ntest "$(stat -f -c %T /guest)" = ext2/ext3\ntest "$(stat -f -c \'%a %S\' /guest | awk \'{printf "%.0f\\n", $1*$2}\')" -ge 8589934592\ntest -z "$(ls -A /guest)"\nfor tool in truncate mkfs.ext4 losetup mount umount findmnt mknod cp stat tar awk; do command -v "$tool" >/dev/null; done\ntest "$(losetup --version)" = \'losetup from util-linux 2.38.1\'\nmount --make-rprivate /guest\numask 077\ntruncate -s 2684354560 /guest/rootfs.ext4\ntest "$(stat -c \'%u:%g:%a:%h:%s\' /guest/rootfs.ext4)" = 0:0:600:1:2684354560\nmkfs.ext4 -q -F -m 0 /guest/rootfs.ext4\nmkdir -m 0700 /guest/rootfs\ntest ! -e /dev/loop-control || test -c /dev/loop-control\ntest -e /dev/loop-control || mknod -m 0600 /dev/loop-control c 10 237\n'

STAGE_PUBLIC = 'set -euo pipefail\ncase "$1" in\n /guest/go.tar.gz) maximum=201326592;;\n /guest/source.tar.gz) maximum=33554432;;\n /guest/probe.go) maximum=1048576;;\n *) exit 1;;\nesac\n[[ "$2" =~ ^[1-9][0-9]*$ ]] && test "$2" -le "$maximum"\n[[ "$3" =~ ^[a-f0-9]{64}$ ]]\ntest -f "$1" && test ! -L "$1"\ntest "$(stat -c \'%F:%h:%s\' -- "$1")" = "regular file:1:$2"\nidentity=$(stat -c \'%d:%i:%F:%h:%s\' -- "$1")\n# These are freshly copied public fixture files, never native Debian metadata.\n# CAP_CHOWN transfers donor ownership before chmod or any content read.\nchown --no-dereference 0:0 -- "$1"\ntest ! -L "$1"\ntest "$(stat -c \'%d:%i:%F:%h:%s\' -- "$1")" = "$identity"\ntest "$(stat -c \'%u:%g\' -- "$1")" = 0:0\nchmod 0600 -- "$1"\ntest ! -L "$1"\ntest "$(stat -c \'%d:%i:%F:%h:%s\' -- "$1")" = "$identity"\ntest "$(stat -c \'%u:%g:%a:%h:%s\' -- "$1")" = "0:0:600:1:$2"\nactual=$(sha256sum -- "$1")\ntest "${actual%% *}" = "$3"\n'

INSTALL_PROBE = 'set -euo pipefail\n[[ "$1" =~ ^[1-9][0-9]*$ ]] && test "$1" -le 1048576\n[[ "$2" =~ ^[a-f0-9]{64}$ ]]\nfor parent in /guest/rootfs /guest/rootfs/root; do\n test -d "$parent" && test ! -L "$parent"\n test "$(stat -c \'%F:%u:%g:%a\' -- "$parent")" = directory:0:0:755\ndone\nparent_identity=$(stat -c \'%d:%i:%F:%u:%g:%a\' -- /guest/rootfs/root)\ntest -f /guest/probe.go && test ! -L /guest/probe.go\ntest "$(stat -c \'%F:%u:%g:%a:%h:%s\' -- /guest/probe.go)" = "regular file:0:0:600:1:$1"\nsource_identity=$(stat -c \'%d:%i:%F:%u:%g:%a:%h:%s\' -- /guest/probe.go)\nactual=$(sha256sum -- /guest/probe.go)\ntest "${actual%% *}" = "$2"\ntest ! -e /guest/rootfs/root/probe.go && test ! -L /guest/rootfs/root/probe.go\ncp --no-clobber --no-dereference --preserve=mode -- /guest/probe.go /guest/rootfs/root/probe.go\ntest ! -L /guest/rootfs/root && test ! -L /guest/rootfs/root/probe.go\ntest "$(stat -c \'%d:%i:%F:%u:%g:%a\' -- /guest/rootfs/root)" = "$parent_identity"\ntest "$(stat -c \'%d:%i:%F:%u:%g:%a:%h:%s\' -- /guest/probe.go)" = "$source_identity"\ntest "$(stat -c \'%F:%u:%g:%a:%h:%s\' -- /guest/rootfs/root/probe.go)" = "regular file:0:0:600:1:$1"\nactual=$(sha256sum -- /guest/rootfs/root/probe.go)\ntest "${actual%% *}" = "$2"\n'

COPY = 'set -euo pipefail\nmount -t ext4 -o nosuid "$1" /guest/rootfs\nfor name in bin sbin lib lib64 usr etc; do if test -e "/$name" || test -L "/$name"; then cp -a "/$name" /guest/rootfs/; fi; done\nmkdir -m 0755 /guest/rootfs/var /guest/rootfs/var/lib /guest/rootfs/var/log\ncp -a /var/lib/dpkg /guest/rootfs/var/lib/\nif test -f /var/log/dpkg.log; then cp -a /var/log/dpkg.log /guest/rootfs/var/log/; fi\nmkdir -m 0755 /guest/rootfs/opt /guest/rootfs/run /guest/rootfs/proc /guest/rootfs/dev /guest/rootfs/root\nmkdir -m 1777 /guest/rootfs/tmp\nfor item in \'null 1 3\' \'zero 1 5\' \'urandom 1 9\'; do set -- $item; mknod -m 0666 /guest/rootfs/dev/"$1" c "$2" "$3"; done\nmount -t proc -o nosuid,nodev,noexec proc /guest/rootfs/proc\ntest ! -e /guest/rootfs/usr/local/go\ntar --no-same-owner -xzf /guest/go.tar.gz -C /guest/rootfs/usr/local\n'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def private_file(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as target:
            target.write(raw)
            target.flush()
            os.fsync(fd)
        if path.read_bytes() != raw:
            raise RuntimeError('private completion readback refused')
    finally:
        os.close(fd)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def file_inventory(root):
    listing = subprocess.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'go'],
                             cwd=root, env=ENV, capture_output=True, check=True).stdout
    names = sorted(set(x.decode('utf-8') for x in listing.split(b'\0') if x))
    result = {}
    total = 0
    for name in names:
        p = root / name
        st = p.lstat()
        if not re.fullmatch(r'go/[A-Za-z0-9_./-]+', name) or '..' in Path(name).parts or not p.is_file() or p.is_symlink() or st.st_nlink != 1:
            raise RuntimeError('source snapshot refused')
        raw = p.read_bytes()
        total += len(raw)
        if total > 32 * MIB:
            raise RuntimeError('source snapshot bound')
        result[name] = {'sha256': digest(raw), 'bytes': len(raw), 'mode': st.st_mode & 0o777}
    if not result or (root / 'go/go.mod').read_text().strip() != 'module github.com/GODOSTROYER/zenith/go\n\ngo 1.27':
        raise RuntimeError('offline native module prerequisite refused')
    return result


def tool_archive(goroot, target):
    # Use the actual already-pinned CI toolchain, not another network/bootstrap.
    # Special files and all symlinks are refused in this immutable tool snapshot.
    total = 0
    with tarfile.open(target, 'x:gz') as tar:
        for p in sorted(goroot.rglob('*')):
            if p.is_symlink() or (not p.is_file() and not p.is_dir()):
                raise RuntimeError('tool snapshot type refused')
            if p.is_file():
                total += p.stat().st_size
                if total > 512 * MIB:
                    raise RuntimeError('tool snapshot bound')
                tar.add(p, arcname='go/' + p.relative_to(goroot).as_posix(), recursive=False)
    if target.stat().st_size > 192 * MIB:
        raise RuntimeError('tool archive bound')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--attempt', required=True)
    parser.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    os.umask(0o077)
    if sys.platform != 'linux' or os.getuid() == 0 or not re.fullmatch(r'[a-f0-9]{32}', args.attempt):
        raise RuntimeError('unprivileged native caller prerequisite refused')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if arch != args.arch:
        raise RuntimeError('host architecture refused')
    attempt = root / '.data-ci-guest' / ('attempt-' + args.attempt)
    for p in (attempt.parent, attempt):
        st = p.lstat()
        if p.is_symlink() or not p.is_dir() or st.st_uid != os.getuid() or st.st_mode & 0o7777 != 0o700:
            raise RuntimeError('current private attempt refused')
    out = attempt / 'package-private'
    out.mkdir(mode=0o700)
    docker_config = out / 'docker-config'
    docker_config.mkdir(mode=0o700)
    private_file(docker_config / 'config.json', b'{"auths":{}}\n')
    nonce = os.urandom(16).hex()
    container, volume = 'zenith-ci-package-' + nonce, 'zenith-ci-package-' + nonce + '-state'
    labels = {'zenith.package.owner': nonce, 'zenith.package.attempt': args.attempt}
    scope = {'schemaVersion': 1, 'attempt': args.attempt, 'imageIndex': INDEX, 'arch': arch,
             'status': 'failed', 'delivery': None, 'cleanupComplete': False, 'stages': [],
             'env': {'ZENITH_TEST_PACKAGE_INSTALL_REQUIRED': '1'}, 'nativeCases': list(NATIVE),
             'emulated': False, 'apparmorFixtureOverride': False}
    context = None
    socket_host = None
    pending = None
    counter = 0
    cleanup = False
    own_container = own_volume = False
    container_id = volume_identity = image_id = image_ref = backing = loop = None
    attached = False
    baseline_images = baseline_containers = baseline_volumes = None
    raw_events = None
    apparmor = False

    def save(phase):
        private_file(out / (phase + '.record'), (json.dumps(scope, sort_keys=True) + '\n').encode())

    def reserve():
        v = os.statvfs(out)
        if v.f_bavail * v.f_frsize < RESERVE or sum(p.stat().st_size for p in out.iterdir() if p.is_file()) > 384 * MIB:
            raise RuntimeError('bounded storage reserve refused')

    def run(command, timeout=60, limit=4 * MIB):
        nonlocal counter
        counter += 1
        phase = '%03d' % counter
        if not cleanup:
            reserve()
        def bounds():
            resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
        stdout, stderr = out / (phase + '.stdout'), out / (phase + '.stderr')
        with stdout.open('xb') as so, stderr.open('xb') as se:
            proc = subprocess.Popen(command, stdout=so, stderr=se, env=ENV,
                                    start_new_session=True, preexec_fn=bounds)
            deadline = time.monotonic() + timeout
            try:
                while proc.poll() is None:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('owned CLI timeout')
                    if not cleanup:
                        reserve()
                    time.sleep(0.25)
            except BaseException:
                # Signal only this invocation's still-live owned group leader.
                # This does not cancel Docker daemon delivery; pending stays set.
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                raise
        try:
            os.killpg(proc.pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise RuntimeError('owned CLI descendants unconfirmed')
        scope['stages'].append({'id': phase, 'exitCode': proc.returncode})
        save(phase + '-observed')
        if proc.returncode != 0:
            raise RuntimeError('owned command failed')
        return stdout.read_bytes()

    def docker(*argv, timeout=60, limit=4 * MIB):
        if (docker_config / 'config.json').read_bytes() != b'{"auths":{}}\n':
            raise RuntimeError('private unauthenticated registry config changed')
        return run(['docker', '--config', str(docker_config), '--host', socket_host, *argv], timeout, limit)

    def safe_context():
        nonlocal socket_host
        raw = run(['docker', 'context', 'inspect', context])
        rows = json.loads(raw)
        if len(rows) != 1 or rows[0].get('Name') != context:
            raise RuntimeError('local context refused')
        endpoint = rows[0].get('Endpoints', {}).get('docker', {})
        host = endpoint.get('Host', '')
        if not re.fullmatch(r'unix:///[^\s?\x00-\x1f]+', host) or endpoint.get('SkipTLSVerify') not in (None, False):
            raise RuntimeError('local socket refused')
        if socket_host is not None and socket_host != host:
            raise RuntimeError('original local socket changed')
        socket_host = host
        return digest(json.dumps(rows, sort_keys=True).encode())

    def absent(kind, name):
        field = '{{json .Names}}' if kind == 'container' else '{{json .Name}}'
        argv = ['ps', '-a', '--format', field] if kind == 'container' else ['volume', 'ls', '--format', field]
        names = [json.loads(x) for x in docker(*argv).splitlines()]
        if any(not isinstance(x, str) for x in names) or len(names) != len(set(names)) or name in names:
            raise RuntimeError('owned absence unconfirmed')

    def inspect_container(allow_stopped=False):
        rows = json.loads(docker('container', 'inspect', container))
        if len(rows) != 1:
            raise RuntimeError('owned container refused')
        v = rows[0]
        h, c, state = v['HostConfig'], v['Config'], v['State']
        m = v.get('Mounts', [])
        if (v.get('Name') != '/' + container or c.get('Labels') != labels or v.get('Image') != image_id
            or (container_id is not None and v.get('Id') != container_id) or c.get('Image') != image_ref
            or c.get('User') != '0:0' or c.get('Cmd') != ['sleep', 'infinity']
            or h.get('Privileged') or h.get('Binds') or h.get('Devices') or h.get('NetworkMode') != 'none'
            or not h.get('ReadonlyRootfs') or h.get('Memory') != 2 * 1024 ** 3 or h.get('MemorySwap') != 2 * 1024 ** 3
            or h.get('NanoCpus') != 2 * 10 ** 9 or h.get('PidsLimit') != 512 or h.get('CapDrop') != ['ALL']
            or {x.removeprefix('CAP_') for x in h.get('CapAdd', [])} != set(CAPS)
            or h.get('DeviceCgroupRules') != ['b 7:* rwm', 'c 10:237 rwm']
            or h.get('Tmpfs') != {'/tmp': 'rw,nosuid,nodev,noexec,size=192m'}
            or h.get('SecurityOpt') not in ([['apparmor=unconfined']] if apparmor else [None, []])
            or h.get('LogConfig') != {'Type': 'json-file', 'Config': {'max-file': '1', 'max-size': '1m'}}
            or len(m) != 1 or m[0].get('Type') != 'volume' or m[0].get('Name') != volume
            or m[0].get('Destination') != '/guest' or not m[0].get('RW')
            or state.get('Paused') or state.get('Restarting') or (not allow_stopped and not state.get('Running'))):
            raise RuntimeError('fixed guest isolation refused')
        return v

    def inspect_volume():
        rows = json.loads(docker('volume', 'inspect', volume))
        if len(rows) != 1:
            raise RuntimeError('owned volume refused')
        v = rows[0]
        if v.get('Name') != volume or v.get('Labels') != labels or v.get('Driver') != 'local' or v.get('Scope') != 'local' or v.get('Options'):
            raise RuntimeError('fixed volume ownership refused')
        identity = digest(json.dumps(v, sort_keys=True).encode())
        if volume_identity is not None and identity != volume_identity:
            raise RuntimeError('owned volume changed')
        return identity

    def mutate(argv, exec_command=False, timeout=60, limit=4 * MIB):
        nonlocal pending
        family = tuple(argv[:2]) if argv[0] in ('volume', 'image') else tuple(argv[:1])
        if family not in (('pull',), ('volume', 'create'), ('run',), ('cp',), ('exec',),
                          ('stop',), ('rm',), ('volume', 'rm'), ('image', 'rm')) or pending is not None:
            raise RuntimeError('unknown or prior daemon delivery refused')
        if safe_context() != context_identity:
            raise RuntimeError('local context changed')
        if exec_command:
            inspect_container()
        # Pin before launch. Nonzero, timeout, signal, parse or completion-write
        # failures preserve the pin; read/presence probes never clear it.
        pending = '%03d' % (counter + 1)
        scope['delivery'] = pending
        save(pending + '-intent')
        raw = docker(*argv, timeout=timeout, limit=limit)
        if exec_command and inspect_container().get('ExecIDs') not in (None, []):
            raise RuntimeError('guest execution settlement unconfirmed')
        if safe_context() != context_identity:
            raise RuntimeError('local context changed')
        scope['delivery'] = None
        try:
            save(pending + '-complete')
        except BaseException:
            scope['delivery'] = pending
            raise
        # In-memory pin clears only after successful completion is persisted.
        pending = None
        return raw

    def execute(argv, timeout=60, limit=4 * MIB):
        return mutate(['exec', container, *argv], True, timeout, limit)

    def stage_public(local, target, expected):
        maximum = {'/guest/go.tar.gz': 192 * MIB, '/guest/source.tar.gz': 32 * MIB,
                   '/guest/probe.go': MIB}.get(target)
        if maximum is None or not re.fullmatch(r'[a-f0-9]{64}', expected):
            raise RuntimeError('fixed public staging target refused')
        st = local.lstat()
        if (not local.is_file() or local.is_symlink() or st.st_nlink != 1
            or not 0 < st.st_size <= maximum or digest(local.read_bytes()) != expected):
            raise RuntimeError('captured public staging bytes refused')
        execute(['bash', '-c', STAGE_PUBLIC, 'fixed-public-staging', target, str(st.st_size), expected])

    def backing_identity():
        lines = execute(['bash', '-c', BACKING]).decode().splitlines()
        if len(lines) != 2 or not all(re.fullmatch(r'[0-9]+:[0-9]+', x) for x in lines):
            raise RuntimeError('backing identity refused')
        return {'inode': int(lines[0].split(':')[1]), 'deviceInode': lines[0], 'majorMinor': lines[1]}

    def loop_record():
        if backing_identity() != backing:
            raise RuntimeError('backing identity changed')
        reply = json.loads(execute(['losetup', '--json', '--list', '--output', 'NAME,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT,RO', loop]))
        if not isinstance(reply, dict) or set(reply) != {'loopdevices'}:
            raise RuntimeError('loop reply shape refused')
        rows = reply['loopdevices']
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise RuntimeError('loop mapping ambiguous')
        v = rows[0]
        if set(v) != {'name', 'back-ino', 'back-maj:min', 'offset', 'sizelimit', 'ro'} or v['name'] != loop or v['ro'] is not False:
            raise RuntimeError('loop ownership refused')
        # Genuine util-linux2.38.1 reports this exact singleton for a free
        # device. Empty/partial/unknown replies never establish ownership.
        if all(v[name] is None for name in ('back-ino', 'back-maj:min', 'offset', 'sizelimit')):
            return None
        # The pinned util-linux reply pads this scalar with ASCII spaces.
        # Admit only its exact numeric grammar before comparing the captured
        # canonical backing device; other whitespace never grants ownership.
        device = v['back-maj:min']
        if not isinstance(device, str) or not re.fullmatch(r' *[0-9]+:[0-9]+ *', device):
            raise RuntimeError('loop ownership refused')
        if (type(v['back-ino']) is not int or v['back-ino'] != backing['inode']
            or device.strip(' ') != backing['majorMinor'] or type(v['offset']) is not int or v['offset'] != 0
            or type(v['sizelimit']) is not int or v['sizelimit'] != 0):
            raise RuntimeError('loop ownership refused')
        return v

    try:
        reserve()
        source = file_inventory(root)
        archive = out / 'source.tar.gz'
        with tarfile.open(archive, 'x:gz') as tar:
            for name, expected in source.items():
                p = root / name
                tar.add(p, arcname=name, recursive=False)
        # No caller archive or additional files can enter the guest.
        with tarfile.open(archive, 'r:gz') as tar:
            members = tar.getmembers()
            if len(members) != len(source) or {m.name for m in members} != set(source):
                raise RuntimeError('source archive identity refused')
            for m in members:
                if not m.isfile() or m.size != source[m.name]['bytes'] or digest(tar.extractfile(m).read()) != source[m.name]['sha256']:
                    raise RuntimeError('source archive bytes refused')
        archive_sha = digest(archive.read_bytes())
        version = json.loads(run(['go', 'env', '-json', 'GOVERSION', 'GOOS', 'GOARCH', 'GOROOT']))
        if version['GOVERSION'] != 'go1.27.1' or version['GOOS'] != 'linux' or version['GOARCH'] != arch:
            raise RuntimeError('native pinned Go prerequisite refused')
        goroot = Path(version['GOROOT']).resolve(strict=True)
        tool = out / 'go.tar.gz'
        tool_archive(goroot, tool)
        private_file(out / 'probe.go', PROBE_GO.encode())
        scope['goSourceSha256'] = digest(json.dumps(source, sort_keys=True, separators=(',', ':')).encode())
        scope['toolArchiveSha256'] = digest(tool.read_bytes())
        context = run(['docker', 'context', 'show']).decode().strip()
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', context):
            raise RuntimeError('bounded local context refused')
        context_identity = safe_context()
        info = json.loads(docker('info', '--format', '{{json .}}'))
        daemon_arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(info.get('Architecture'))
        if info.get('OSType') != 'linux' or daemon_arch != arch:
            raise RuntimeError('native daemon refused')
        apparmor = 'name=apparmor' in info.get('SecurityOptions', [])
        scope['apparmorFixtureOverride'] = apparmor
        baseline_images = set(docker('image', 'ls', '-q', '--no-trunc').decode().split())
        baseline_containers = set(docker('ps', '-aq', '--no-trunc').decode().split())
        baseline_volumes = set(docker('volume', 'ls', '-q').decode().split())
        index = json.loads(docker('manifest', 'inspect', 'docker.io/library/debian@' + INDEX, timeout=120))
        children = [m for m in index['manifests'] if m.get('platform', {}).get('os') == 'linux' and m['platform'].get('architecture') == arch]
        if len(children) != 1 or not re.fullmatch(r'sha256:[a-f0-9]{64}', children[0].get('digest', '')):
            raise RuntimeError('pinned native image refused')
        child = children[0]['digest']
        image_ref = 'docker.io/library/debian@' + child
        manifest = json.loads(docker('manifest', 'inspect', '--verbose', image_ref, timeout=120))
        descriptor = manifest['Descriptor']
        body = manifest.get('OCIManifest') or manifest.get('SchemaV2Manifest')
        if descriptor.get('digest') != child or descriptor.get('platform', {}).get('architecture') != arch or sum(x['size'] for x in body['layers']) > 256 * MIB:
            raise RuntimeError('pinned image budget refused')
        mutate(['pull', '--platform', 'linux/' + arch, image_ref], timeout=300)
        rows = json.loads(docker('image', 'inspect', image_ref))
        if len(rows) != 1:
            raise RuntimeError('pinned image absent')
        image = rows[0]
        if image.get('Architecture') != arch or image.get('Os') != 'linux' or image.get('Size', 2**63) > 512 * MIB or not any(x.endswith('@' + child) for x in image.get('RepoDigests', [])):
            raise RuntimeError('loaded native image refused')
        image_id = image['Id']
        scope['imageDigest'] = child
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
            raise RuntimeError('loaded image identity refused')
        absent('container', container)
        absent('volume', volume)
        own_volume = True
        label_args = [a for k, v in labels.items() for a in ('--label', k + '=' + v)]
        mutate(['volume', 'create', *label_args, volume])
        volume_identity = inspect_volume()
        own_container = True
        cap_args = [a for cap in CAPS for a in ('--cap-add', cap)]
        security_args = ['--security-opt', 'apparmor=unconfined'] if apparmor else []
        mutate(['run', '-d', '--platform', 'linux/' + arch, '--user', '0:0', '--name', container,
                *label_args, '--network', 'none', '--read-only', '--memory', '2g', '--memory-swap', '2g',
                '--cpus', '2', '--pids-limit', '512', '--log-driver', 'json-file', '--log-opt', 'max-size=1m',
                '--log-opt', 'max-file=1', '--cap-drop', 'ALL', *cap_args, *security_args,
                '--device-cgroup-rule', 'b 7:* rwm', '--device-cgroup-rule', 'c 10:237 rwm',
                '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=192m',
                '--mount', 'type=volume,source=' + volume + ',target=/guest', image_ref, 'sleep', 'infinity'])
        container_id = inspect_container()['Id']
        execute(['bash', '-c', SETUP], timeout=90)
        backing = backing_identity()
        loop = execute(['losetup', '--find']).decode().strip()
        if not re.fullmatch(r'/dev/loop[0-9]{1,4}', loop):
            raise RuntimeError('loop candidate refused')
        execute(['bash', '-c', LOOP_NODE, 'owned-loop-node', loop])
        if loop_record() is not None:
            raise RuntimeError('loop candidate occupied')
        attached = True
        execute(['losetup', loop, '/guest/rootfs.ext4'])
        if loop_record() is None:
            raise RuntimeError('loop attachment refused')
        mutate(['cp', str(tool), container + ':/guest/go.tar.gz'])
        stage_public(tool, '/guest/go.tar.gz', scope['toolArchiveSha256'])
        execute(['bash', '-c', COPY, 'copy-native-image', loop], timeout=180)
        if execute(['chroot', '/guest/rootfs', '/usr/local/go/bin/go', 'version']).decode().strip() != 'go version go1.27.1 linux/' + arch:
            raise RuntimeError('copied toolchain refused')
        if execute(['chroot', '/guest/rootfs', 'dpkg', '--print-architecture']).decode().strip() != arch:
            raise RuntimeError('actual dpkg architecture refused')
        mutate(['cp', str(out / 'probe.go'), container + ':/guest/probe.go'])
        stage_public(out / 'probe.go', '/guest/probe.go', digest(PROBE_GO.encode()))
        execute(['bash', '-c', INSTALL_PROBE, 'install-fixed-probe', str(len(PROBE_GO.encode())), digest(PROBE_GO.encode())])
        goenv = ['/usr/bin/env', '-i', 'PATH=/usr/local/go/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/root',
                 'GOTOOLCHAIN=local', 'GOPROXY=off', 'GOSUMDB=off', 'CGO_ENABLED=0', 'GOMAXPROCS=2',
                 'GOMEMLIMIT=1400MiB', 'GOCACHE=/root/go-cache', 'GOPATH=/root/go-path']
        execute(['chroot', '/guest/rootfs', *goenv, 'go', 'build', '-p=1', '-o', '/usr/local/bin/owned-package-probe', '/root/probe.go'], timeout=240)
        original = json.loads(execute(['/guest/rootfs/usr/local/bin/owned-package-probe', 'snapshot-image']))
        if json.loads(execute(['/guest/rootfs/usr/local/bin/owned-package-probe', 'snapshot-copy'])) != original:
            raise RuntimeError('native metadata changed during copy')
        scope['nativeStateSha256'] = digest(json.dumps(original, sort_keys=True, separators=(',', ':')).encode())
        execute(['chroot', '/guest/rootfs', '/usr/local/bin/owned-package-probe', 'setup'])
        mutate(['cp', str(archive), container + ':/guest/source.tar.gz'])
        stage_public(archive, '/guest/source.tar.gz', archive_sha)
        execute(['bash', '-c', 'mkdir -m0700 /guest/rootfs/root/source; tar --no-same-owner -xzf /guest/source.tar.gz -C /guest/rootfs/root/source; rm /guest/source.tar.gz /guest/go.tar.gz'])
        raw_events = execute(['chroot', '/guest/rootfs', *goenv, 'ZENITH_TEST_PACKAGE_INSTALL_REQUIRED=1',
                              'go', '-C', '/root/source/go', 'test', '-json', '-count=1', '-p=1',
                              './internal/machine', '-run', PATTERN], timeout=900, limit=32 * MIB)
        after = json.loads(execute(['chroot', '/guest/rootfs', '/usr/local/bin/owned-package-probe', 'snapshot-image']))
        def protected(p):
            return p.startswith('/etc/dpkg/') or p.startswith('/var/lib/dpkg/triggers/') or p in ('/etc/dpkg', '/var/lib/dpkg/triggers', '/var/lib/dpkg/diversions', '/var/lib/dpkg/diversions-old', '/var/lib/dpkg/statoverride', '/var/lib/dpkg/statoverride-old')
        if {p: v for p, v in original.items() if protected(p)} != {p: v for p, v in after.items() if protected(p)}:
            raise RuntimeError('native config or registry changed')
        scope['afterNativeStateSha256'] = digest(json.dumps(after, sort_keys=True, separators=(',', ':')).encode())
        if file_inventory(root) != source:
            raise RuntimeError('source changed during native attempt')
        scope['status'] = 'native_pending_owned_cleanup'
    finally:
        cleanup = True
        # A lost command response can settle late. Presence and stopped-state
        # observations do not release this pin or authorize deletion/detach.
        if pending is not None:
            raise RuntimeError('daemon delivery unconfirmed; preserve owned resources')
        if own_container:
            inspect_container()
            inspect_volume()
            if attached:
                if loop_record() is None:
                    raise RuntimeError('loop unexpectedly absent; preserve backing')
                targets = execute(['findmnt', '-nr', '-S', loop, '-o', 'TARGET']).decode().splitlines()
                allowed = {'/guest/rootfs', '/guest/rootfs/var/lib/zenithd-package-install/mount-controls/file', '/guest/rootfs/var/lib/zenithd-package-install/mount-controls/nested'}
                if targets:
                    if '/guest/rootfs' not in targets or not set(targets) <= allowed:
                        raise RuntimeError('foreign loop mount; preserve backing')
                    script = 'set -euo pipefail; test "$(findmnt -nr -M /guest/rootfs -o SOURCE)" = "$1"; for p in /guest/rootfs/var/lib/zenithd-package-install/mount-controls/file /guest/rootfs/var/lib/zenithd-package-install/mount-controls/nested /guest/rootfs/proc; do if findmnt -rn --mountpoint "$p" >/dev/null; then umount "$p"; fi; done; umount /guest/rootfs'
                    execute(['bash', '-c', script, 'owned-cleanup', loop])
                if loop_record() is None:
                    raise RuntimeError('loop ownership lost before detach')
                execute(['losetup', '--detach', loop])
                if backing_identity() != backing or execute(['losetup', '--associated', '/guest/rootfs.ext4', '--noheadings', '--output', 'NAME']).strip():
                    raise RuntimeError('owned backing association unresolved')
            mutate(['stop', '--time', '10', container])
            inspect_container(allow_stopped=True)
            mutate(['rm', container])
            absent('container', container)
        if own_volume:
            inspect_volume()
            mutate(['volume', 'rm', volume])
            absent('volume', volume)
        if image_id is not None and image_id not in baseline_images:
            if docker('ps', '-aq', '--filter', 'ancestor=' + image_id).strip():
                raise RuntimeError('new image has unrelated user')
            mutate(['image', 'rm', image_ref], timeout=90)
        if baseline_images is not None:
            remaining_images = set(docker('image', 'ls', '-q', '--no-trunc').decode().split())
            if image_id is not None and image_id not in baseline_images and image_id in remaining_images:
                raise RuntimeError('new image cleanup unconfirmed')
            if not baseline_images <= remaining_images or not baseline_containers <= set(docker('ps', '-aq', '--no-trunc').decode().split()) or not baseline_volumes <= set(docker('volume', 'ls', '-q').decode().split()):
                raise RuntimeError('unrelated baseline changed')
        if safe_context() != context_identity:
            raise RuntimeError('local context changed')
        if scope['status'] != 'native_pending_owned_cleanup' or raw_events is None:
            raise RuntimeError('native attempt did not complete')
        scope['status'] = 'native_and_owned_cleanup_completed'
        scope['cleanupComplete'] = True
        save('terminal')
    # Only actual fresh Go events after owned cleanup enter the existing validator.
    sys.stdout.buffer.write(raw_events)
    sys.stdout.buffer.flush()
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # No raw exceptions, command arguments, native rows or stderr are public.
        sys.stderr.write('native package phase refused; private current-attempt diagnostics retained\n')
        raise SystemExit(1)
