#!/usr/bin/env python3
"""Root-only direct Debian ARM64 package tests. Review before using the heavy slot.

No product source, host bind, apt transaction, metadata repair or golden fallback.
Installed systemd, default backend and AMD64 acceptance are separate obligations.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import secrets
import subprocess
import tarfile
import time
import urllib.parse
import urllib.request

BASE = Path('/Users/saivedanthava/.codex/zenith-production')
CONTRACT = BASE / 'logs/guest-package-native-runtime-helper-20261005/revision14/EXECUTION-SOURCE-CONTRACT.json'
# Filled only from the final independently reviewed native compatibility packet.
CONTRACT_SHA = '1cff638baeacbee93e1db8b499fb6c23055f5344690aad45b6e68a85dc5fa372'
INDEX = 'sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251'
ARM = 'sha256:0c8bbb8e987a035fe1d9704eb2e571b7e9a836e1caa46345290674b45b69e417'
IMAGE = 'docker.io/library/debian@' + ARM
GO_URL = 'https://go.dev/dl/go1.27.1.linux-arm64.tar.gz'
GO_SHA = '3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec'
MIB = 1024 ** 2
RESERVE = 8 * 1024 ** 3
ROOT_BYTES = 2560 * MIB
NATIVE = ['TestPackageHelperNativeNoFollowAndCustody',
          'TestPackageFrontendLockIndependentProcess',
          'TestPackageNativeSignedFirstInstallAndNonReplay',
          'TestPackageNativeDeclaredMountAndACLRefusals']
CHILDREN = ['TestPackageNativeSignedFirstInstallAndNonReplay/' + name for name in
            ['foreign_audience', 'foreign_operation', 'foreign_workspace', 'missing_resource', 'unknown_constraint']]

LINUX_MODELS = ['TestPackageNativeReadbackPreservesRegistryAndIdentity/diversion_bytes_changed_after_child', 'TestPackageNativeReadbackPreservesRegistryAndIdentity/trigger_interest_changed_after_child', 'TestPackageNativeReadbackPreservesRegistryAndIdentity/native_config_changed_after_child', 'TestPackageNativeReadbackPreservesRegistryAndIdentity/identity_bytes_changed_after_child', 'TestPackageNativeReadbackPreservesRegistryAndIdentity/pending_native_activation_introduced_after_child', 'TestPackageNativeReadbackPreservesRegistryAndIdentity/unrelated_installed_tuple_changed_after_child', 'TestPackageNativeEffectivePolicyPreservesRawReadback', 'TestPackageNativeStatusMultilineHeaders/observed_empty_multiline_first_line_preserves_continuation_bytes', 'TestPackageNativeStatusMultilineHeaders/existing_space_separated_empty_first_line_remains_compatible', 'TestPackageNativeStatusMultilineHeaders/case_insensitive_recognized_native_identity_remains_canonical', 'TestPackageNativeStatusMultilineHeaders/duplicate_empty_field_refuses', 'TestPackageNativeStatusMultilineHeaders/case_variant_duplicate_empty_field_refuses', 'TestPackageNativeStatusMultilineHeaders/empty_first_value_cannot_hide_a_later_duplicate', 'TestPackageNativeStatusMultilineHeaders/case_variant_duplicate_nonempty_field_refuses', 'TestPackageNativeStatusMultilineHeaders/whitespace_inside_field_name_refuses', 'TestPackageNativeStatusMultilineHeaders/comment_prefix_cannot_introduce_a_field', 'TestPackageNativeStatusMultilineHeaders/hyphen_prefix_cannot_introduce_a_field', 'TestPackageNativeStatusMultilineHeaders/nonempty_value_without_canonical_space_refuses', 'TestPackageNativeStatusMultilineHeaders/empty_field_name_refuses', 'TestPackageNativeStatusMultilineHeaders/orphan_continuation_refuses', 'TestPackageNativeStatusMultilineHeaders/NUL_in_native_field_refuses', 'TestPackageNativeStatusMultilineHeaders/carriage_return_in_native_field_refuses', 'TestPackageNativeStatusMultilineHeaders/overlong_native_line_refuses', 'TestPackageNativeStatusMultilineHeaders/pending_native_status_remains_inadmissible', 'TestPackageNativeStatusMultilineHeaders/missing_native_status_remains_inadmissible', 'TestPackageNativeStatusMultilineHeaders/empty_package_identity_remains_inadmissible', 'TestPackageNativeStatusMultilineHeaders/missing_native_architecture_remains_inadmissible', 'TestPackageNativeStatusMultilineHeaders/pending_triggers_remain_inadmissible', 'TestPackageNativeStatusMultilineHeaders/awaited_triggers_remain_inadmissible', 'TestPackageNativeStatusMultilineHeaders/lone_lowercase_pending_field_cannot_hide_native_trigger_work', 'TestPackageNativeStatusMultilineHeaders/lone_mixed_case_awaited_field_cannot_hide_native_trigger_work']

# This setup binary is not the offered package helper. It creates only declared
# disposable mount/ACL controls and emits hashes, never native file contents.
PROBE_GO = r'''package main
import("crypto/sha256";"encoding/binary";"encoding/hex";"encoding/json";"fmt";"os";"path/filepath";"strings";"syscall")
type Entry struct { Mode uint32 `json:"mode"`; UID uint32 `json:"uid"`; GID uint32 `json:"gid"`; Bytes int64 `json:"bytes"`; SHA string `json:"sha256"` }
func must(e error){if e!=nil{panic("owned fixture prerequisite failed")}}
func snapshot(prefix string){
 if prefix!=""&&prefix!="/guest/rootfs"{panic("invalid fixed snapshot target")}
 result:=map[string]Entry{};var total int64
 for _,root:=range []string{"/var/lib/dpkg","/etc/dpkg"}{must(filepath.Walk(prefix+root,func(p string,i os.FileInfo,e error)error{
  if e!=nil{return e};st:=i.Sys().(*syscall.Stat_t);v:=Entry{Mode:st.Mode,UID:st.Uid,GID:st.Gid}
  var raw []byte
  if i.Mode().IsRegular(){if i.Size()>16<<20{return fmt.Errorf("bound")};raw,e=os.ReadFile(p)}else if i.Mode()&os.ModeSymlink!=0{var s string;s,e=os.Readlink(p);raw=[]byte(s)}else if !i.IsDir(){return fmt.Errorf("type")}
  if e!=nil{return e};total+=int64(len(raw));if total>128<<20{return fmt.Errorf("bound")};v.Bytes=int64(len(raw));h:=sha256.Sum256(raw);v.SHA=hex.EncodeToString(h[:]);result[strings.TrimPrefix(p,prefix)]=v;return nil
 }))};must(json.NewEncoder(os.Stdout).Encode(result))
}
func absentDir(p string,mode os.FileMode){if _,e:=os.Lstat(p);!os.IsNotExist(e){panic("fixture already exists")};must(os.Mkdir(p,mode))}
func fresh(p string,raw []byte){f,e:=os.OpenFile(p,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600);must(e);_,e=f.Write(raw);must(e);must(f.Sync());must(f.Close())}
func setup(){
 var fs syscall.Statfs_t;must(syscall.Statfs("/",&fs));if uint64(fs.Type)!=0xef53{panic("persistent ext4 root required")}
 for _,p:=range []string{"/var/lib/zenithd-package-install","/var/lib/zenithd-package-install/archives","/var/lib/zenithd-package-install/staged","/var/lib/zenithd-package-install/backups","/var/lib/zenithd-package-install/intents","/etc/zenithd"}{absentDir(p,0700)}
 absentDir("/opt/zenith-packages",0755);absentDir("/run/zenithd-package-install",0755)
 fresh("/run/zenith-package-acceptance-owned",[]byte("zenith-owned-disposable-package-install-v1\n"))
 base:="/var/lib/zenithd-package-install";for _,p:=range []string{base+"/mount-controls",base+"/mount-controls/nested",base+"/mount-sources",base+"/mount-sources/directory",base+"/acl-controls"}{absentDir(p,0700)}
 fresh(base+"/mount-sources/directory/source",[]byte("owned directory mount control"));fresh(base+"/mount-sources/file",[]byte("owned file mount control"));fresh(base+"/mount-controls/file",nil)
 must(syscall.Mount(base+"/mount-sources/directory",base+"/mount-controls/nested","",syscall.MS_BIND,""));must(syscall.Mount(base+"/mount-sources/file",base+"/mount-controls/file","",syscall.MS_BIND,""))
 p:=base+"/acl-controls/source";fresh(p,[]byte("owned real access ACL control"));acl:=make([]byte,4);binary.LittleEndian.PutUint32(acl,2)
 for _,v:=range [][3]uint32{{1,6,0xffffffff},{2,4,12345},{4,0,0xffffffff},{16,4,0xffffffff},{32,0,0xffffffff}}{b:=make([]byte,8);binary.LittleEndian.PutUint16(b,uint16(v[0]));binary.LittleEndian.PutUint16(b[2:],uint16(v[1]));binary.LittleEndian.PutUint32(b[4:],v[2]);acl=append(acl,b...)}
 must(syscall.Setxattr(p,"system.posix_acl_access",acl,0));fmt.Println("owned real mount and ACL fixtures created")
}
func main(){if len(os.Args)!=2{panic("fixed command required")};switch os.Args[1]{case "snapshot-image":snapshot("");case "snapshot-copy":snapshot("/guest/rootfs");case "setup":setup();default:panic("unknown fixed command")}}
'''

SETUP = r'''set -euo pipefail
test "$(uname -m)" = aarch64
test "$(stat -f -c %T /guest)" = ext2/ext3
test "$(stat -f -c '%a %S' /guest | awk '{printf "%.0f\n", $1*$2}')" -ge 8589934592
test -z "$(ls -A /guest)"
for tool in truncate mkfs.ext4 losetup mount umount findmnt mknod cp stat sha256sum tar awk; do command -v "$tool" >/dev/null; done
test "$(losetup --version)" = 'losetup from util-linux 2.38.1'
mount --make-rprivate /guest
umask 077
truncate -s 2684354560 /guest/rootfs.ext4
test "$(stat -c '%u:%g:%a:%h:%s' /guest/rootfs.ext4)" = 0:0:600:1:2684354560
mkfs.ext4 -q -F -m 0 /guest/rootfs.ext4
mkdir -m 0700 /guest/rootfs
test ! -e /dev/loop-control || test -c /dev/loop-control
test -e /dev/loop-control || mknod -m 0600 /dev/loop-control c 10 237
'''

STAGE_PUBLIC = 'set -euo pipefail\ncase "$1" in\n /guest/go.tar.gz) maximum=201326592;;\n /guest/source.tar.gz) maximum=33554432;;\n /guest/probe.go) maximum=1048576;;\n *) exit 1;;\nesac\n[[ "$2" =~ ^[1-9][0-9]*$ ]] && test "$2" -le "$maximum"\n[[ "$3" =~ ^[a-f0-9]{64}$ ]]\ntest -f "$1" && test ! -L "$1"\ntest "$(stat -c \'%F:%h:%s\' -- "$1")" = "regular file:1:$2"\nidentity=$(stat -c \'%d:%i:%F:%h:%s\' -- "$1")\n# These are freshly copied public fixture files, never native Debian metadata.\n# CAP_CHOWN transfers donor ownership before chmod or any content read.\nchown --no-dereference 0:0 -- "$1"\ntest ! -L "$1"\ntest "$(stat -c \'%d:%i:%F:%h:%s\' -- "$1")" = "$identity"\ntest "$(stat -c \'%u:%g\' -- "$1")" = 0:0\nchmod 0600 -- "$1"\ntest ! -L "$1"\ntest "$(stat -c \'%d:%i:%F:%h:%s\' -- "$1")" = "$identity"\ntest "$(stat -c \'%u:%g:%a:%h:%s\' -- "$1")" = "0:0:600:1:$2"\nactual=$(sha256sum -- "$1")\ntest "${actual%% *}" = "$3"\n'

INSTALL_PROBE = 'set -euo pipefail\n[[ "$1" =~ ^[1-9][0-9]*$ ]] && test "$1" -le 1048576\n[[ "$2" =~ ^[a-f0-9]{64}$ ]]\nfor parent in /guest/rootfs /guest/rootfs/root; do\n test -d "$parent" && test ! -L "$parent"\n test "$(stat -c \'%F:%u:%g:%a\' -- "$parent")" = directory:0:0:755\ndone\nparent_identity=$(stat -c \'%d:%i:%F:%u:%g:%a\' -- /guest/rootfs/root)\ntest -f /guest/probe.go && test ! -L /guest/probe.go\ntest "$(stat -c \'%F:%u:%g:%a:%h:%s\' -- /guest/probe.go)" = "regular file:0:0:600:1:$1"\nsource_identity=$(stat -c \'%d:%i:%F:%u:%g:%a:%h:%s\' -- /guest/probe.go)\nactual=$(sha256sum -- /guest/probe.go)\ntest "${actual%% *}" = "$2"\ntest ! -e /guest/rootfs/root/probe.go && test ! -L /guest/rootfs/root/probe.go\ncp --no-clobber --no-dereference --preserve=mode -- /guest/probe.go /guest/rootfs/root/probe.go\ntest ! -L /guest/rootfs/root && test ! -L /guest/rootfs/root/probe.go\ntest "$(stat -c \'%d:%i:%F:%u:%g:%a\' -- /guest/rootfs/root)" = "$parent_identity"\ntest "$(stat -c \'%d:%i:%F:%u:%g:%a:%h:%s\' -- /guest/probe.go)" = "$source_identity"\ntest "$(stat -c \'%F:%u:%g:%a:%h:%s\' -- /guest/rootfs/root/probe.go)" = "regular file:0:0:600:1:$1"\nactual=$(sha256sum -- /guest/rootfs/root/probe.go)\ntest "${actual%% *}" = "$2"\n'

COPY = r'''set -euo pipefail
mount -t ext4 -o nosuid "$1" /guest/rootfs
for name in bin sbin lib lib64 usr etc; do if test -e "/$name" || test -L "/$name"; then cp -a "/$name" /guest/rootfs/; fi; done
mkdir -m 0755 /guest/rootfs/var /guest/rootfs/var/lib /guest/rootfs/var/log
cp -a /var/lib/dpkg /guest/rootfs/var/lib/
if test -f /var/log/dpkg.log; then cp -a /var/log/dpkg.log /guest/rootfs/var/log/; fi
mkdir -m 0755 /guest/rootfs/opt /guest/rootfs/run /guest/rootfs/proc /guest/rootfs/dev /guest/rootfs/root
mkdir -m 1777 /guest/rootfs/tmp
for item in 'null 1 3' 'zero 1 5' 'urandom 1 9'; do set -- $item; mknod -m 0666 /guest/rootfs/dev/"$1" c "$2" "$3"; done
mount -t proc -o nosuid,nodev,noexec proc /guest/rootfs/proc
test ! -e /guest/rootfs/usr/local/go
tar --no-same-owner -xzf /guest/go.tar.gz -C /guest/rootfs/usr/local
test "$(chroot /guest/rootfs /usr/local/go/bin/go version)" = 'go version go1.27.1 linux/arm64'
'''

BACKING = r'''set -euo pipefail
test -f /guest/rootfs.ext4 && test ! -L /guest/rootfs.ext4
test "$(stat -c '%u:%g:%a:%h:%s' /guest/rootfs.ext4)" = 0:0:600:1:2684354560
stat -c '%d:%i' /guest/rootfs.ext4
findmnt -nr -T /guest/rootfs.ext4 -o MAJ:MIN
'''

LOOP_NODE = r'''set -euo pipefail
case "$1" in /dev/loop[0-9]*) ;; *) exit 1;; esac
test ! -e "$1" && test ! -L "$1"
mknod -m0600 "$1" b 7 "${1##*loop}"
test "$(stat -c '%u:%g:%a' "$1")" = 0:0:600
test -b "$1"
'''

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worktree', type=Path, required=True)
    parser.add_argument('--label', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'zenith-package-native-[a-z0-9-]{1,30}', args.label):
        parser.error('fixed private label required')
    if not re.fullmatch(r'[0-9a-f]{64}', CONTRACT_SHA) or sha(CONTRACT.read_bytes()) != CONTRACT_SHA:
        parser.error('final reviewed native source contract is not bound')
    contract = json.loads(CONTRACT.read_text())
    if contract['nativeCases'] != NATIVE or contract['imageIndex'] != INDEX or contract['imageArm'] != ARM:
        parser.error('fixed native scope mismatch')
    if contract.get('additionalLinuxOnlyModelCases') != LINUX_MODELS:
        parser.error('fixed Linux-only model scope mismatch')
    names = contract['nativeCases']
    if len(names) != len(set(names)) or any(not re.fullmatch(r'TestPackage[A-Za-z0-9_]+', n) for n in names):
        parser.error('malformed exact native identities')
    worktree = args.worktree.resolve(strict=True)
    if worktree.parent not in [BASE / 'worktrees', BASE / 'checkouts']:
        parser.error('private source checkout required')
    os.umask(0o077)
    token = secrets.token_hex(16)
    out = BASE / 'logs' / (args.label + '-' + token)
    out.mkdir(mode=0o700)
    container, volume = args.label + '-' + token, args.label + '-' + token + '-state'
    receipt = {'status': 'failed', 'scope': 'DIRECT_NATIVE_ONLY', 'owner': token,
               'sourceContractSha256': CONTRACT_SHA, 'imageIndex': INDEX, 'imageArm': ARM,
               'goSha256': GO_SHA, 'nativeCases': names, 'stages': [], 'cleanup': [],
               'limits': {'rootBytes': ROOT_BYTES, 'tmpfsBytes': 192 * MIB,
                          'aggregateBytes': 4 * 1024 ** 3, 'hostReserveBytes': RESERVE,
                          'memoryBytes': 2 * 1024 ** 3, 'cpus': 2, 'pids': 512},
               'installedSystemdDefaultBackendAmd64FullLifecycle': 'UNVERIFIED'}
    owned_container = owned_volume = False
    loop = None
    backing = None
    attach_started = False
    exec_unsettled = False
    mutation_unsettled = None
    cleanup_mode = False
    baseline_images = set()
    image_id = None
    pull_started = False

    def save():
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def reserve():
        fs = os.statvfs(out)
        if fs.f_bavail * fs.f_frsize < RESERVE:
            raise RuntimeError('8GiB host reserve unavailable')
        logs = sum(p.stat().st_size for p in out.iterdir() if p.is_file() and p.suffix in ['.stdout', '.stderr'])
        if logs > 48 * MIB:
            raise RuntimeError('bounded private artifact budget unavailable')

    def run(command, phase, check=True, timeout=60):
        # Fixed positively owned cleanup can release storage after a reserve
        # failure. It still has the same per-file and process limits.
        if not cleanup_mode:
            reserve()
        def child_limit():
            limit = 64 * 1024 if cleanup_mode else 4 * MIB
            resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
        with (out / (phase + '.stdout')).open('xb') as stdout, (out / (phase + '.stderr')).open('xb') as stderr:
            proc = subprocess.Popen(command, stdout=stdout, stderr=stderr,
                                    env={k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT']},
                                    preexec_fn=child_limit)
            deadline = time.monotonic() + timeout
            try:
                while proc.poll() is None:
                    if time.monotonic() > deadline:
                        raise RuntimeError('bounded phase timed out')
                    if not cleanup_mode:
                        reserve()
                    time.sleep(0.5)
            except BaseException:
                proc.kill()
                proc.wait()
                raise
        receipt['stages'].append({'id': phase, 'exitCode': proc.returncode})
        save()
        if check and proc.returncode:
            raise RuntimeError('owned phase failed: ' + phase)
        return proc.returncode, (out / (phase + '.stdout')).read_bytes()

    def mutate(command, phase, timeout=60):
        nonlocal mutation_unsettled
        family = tuple(command[1:3]) if command[1] in ['volume', 'image'] else tuple(command[1:2])
        if command[0] != 'docker' or family not in [
                ('pull',), ('volume', 'create'), ('run',), ('cp',),
                ('stop',), ('rm',), ('volume', 'rm'), ('image', 'rm')]:
            raise RuntimeError('unknown fixed Docker mutation refused')
        if mutation_unsettled is not None or exec_unsettled:
            raise RuntimeError('prior Docker delivery unconfirmed; preserved')
        # CLI termination and resource presence do not settle daemon delivery.
        # Pin before launch; only the bounded successful reply clears this pin.
        # A failed create can finish late, and a failed cp can still write state.
        mutation_unsettled = phase
        receipt['unsettledDockerMutation'] = phase
        save()
        result = run(command, phase, timeout=timeout)
        if result[0] != 0:
            raise RuntimeError('Docker mutation delivery unconfirmed; preserved')
        receipt['unsettledDockerMutation'] = None
        try:
            save()
        except BaseException:
            receipt['unsettledDockerMutation'] = phase
            raise
        mutation_unsettled = None
        return result

    def inspect(kind, name):
        code, raw = run(['docker', kind, 'inspect', name, '--format', '{{json .}}'], 'inspect-' + kind + '-' + secrets.token_hex(3), False)
        if code:
            # Absence, daemon errors and lost responses are indistinguishable
            # here. None proves global loop detach or permits backing removal.
            raise RuntimeError('owned resource presence unconfirmed; preserved')
        obj = json.loads(raw)
        labels = obj.get('Labels') if kind == 'volume' else obj.get('Config', {}).get('Labels')
        if not labels or labels.get('zenith.package.owner') != token:
            raise RuntimeError('resource ownership mismatch; preserved')
        return obj

    def confirm_absent(kind, name, phase):
        field = '{{json .Names}}' if kind == 'container' else '{{json .Name}}'
        pattern = '^/' + name + '$' if kind == 'container' else '^' + name + '$'
        _, raw = run(['docker', kind, 'ls', '-q' if kind == 'volume' else '-a',
                      '--filter', 'name=' + pattern, '--format', field], phase)
        if raw.strip():
            raise RuntimeError('owned name remains after removal; preserved')

    def execute(argv, phase, check=True, timeout=60):
        nonlocal exec_unsettled
        if not inspect('container', container):
            raise RuntimeError('positively owned container absent')
        # Terminating a Docker CLI is not cancellation of its container process.
        # Unknown/nonzero delivery therefore pins every owned resource. Only a
        # successful response plus fresh empty actual ExecIDs permits release.
        exec_unsettled = True
        result = run(['docker', 'exec', container, *argv], phase, check, timeout)
        settled = inspect('container', container)
        if result[0] != 0 or not settled or settled.get('ExecIDs') not in [None, []]:
            raise RuntimeError('actual container command settlement unconfirmed; preserved')
        exec_unsettled = False
        return result

    def stage_public(local, target, expected):
        maximum = {'/guest/go.tar.gz': 192 * MIB, '/guest/source.tar.gz': 32 * MIB,
                   '/guest/probe.go': MIB}.get(target)
        if maximum is None or not re.fullmatch(r'[a-f0-9]{64}', expected):
            raise RuntimeError('fixed public staging target refused')
        st = local.lstat()
        if (not local.is_file() or local.is_symlink() or st.st_nlink != 1
            or not 0 < st.st_size <= maximum or sha(local.read_bytes()) != expected):
            raise RuntimeError('captured public staging bytes refused')
        phase = {'/guest/go.tar.gz': 'public-tool-owner', '/guest/source.tar.gz': 'public-source-owner',
                 '/guest/probe.go': 'public-probe-owner'}[target]
        execute(['bash', '-c', STAGE_PUBLIC, 'fixed-public-staging', target, str(st.st_size), expected], phase)

    def backing_identity(phase):
        _, raw = execute(['bash', '-c', BACKING], phase)
        lines = raw.decode().splitlines()
        if len(lines) != 2 or not re.fullmatch(r'[0-9]+:[0-9]+', lines[0]) or not re.fullmatch(r'[0-9]+:[0-9]+', lines[1]):
            raise RuntimeError('owned backing identity unavailable')
        return {'deviceInode': lines[0], 'majorMinor': lines[1], 'inode': int(lines[0].split(':')[1])}

    def loop_record(phase):
        if backing_identity(phase + '-backing') != backing:
            raise RuntimeError('owned backing inode changed; preserved')
        _, raw = execute(['losetup', '--json', '--list', '--output',
                          'NAME,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT,RO', loop], phase)
        parsed = json.loads(raw)
        if not isinstance(parsed, dict) or set(parsed) != {'loopdevices'}:
            raise RuntimeError('loop allocation ambiguous; preserved')
        rows = parsed['loopdevices']
        if not isinstance(rows, list) or len(rows) != 1:
            raise RuntimeError('loop allocation ambiguous; preserved')
        row = rows[0]
        fields = {'name', 'back-ino', 'back-maj:min', 'offset', 'sizelimit', 'ro'}
        if not isinstance(row, dict) or set(row) != fields:
            raise RuntimeError('loop allocation ambiguous; preserved')
        # Pinned util-linux 2.38.1 reports an unbound exact named device as
        # one row with all backing fields null, never as partial ownership.
        if row['name'] == loop and row['ro'] is False and all(
                row[field] is None for field in ['back-ino', 'back-maj:min', 'offset', 'sizelimit']):
            return None
        major_minor = row['back-maj:min']
        if not isinstance(major_minor, str) or not re.fullmatch(r' *[0-9]+:[0-9]+ *', major_minor):
            raise RuntimeError('loop device does not own exact backing inode; preserved')
        # Pinned util-linux pads this field with ASCII spaces. No other
        # whitespace, partial identity or numeric normalization is admitted.
        major_minor = major_minor.strip(' ')
        if row.get('name') != loop or row.get('back-ino') != backing['inode'] or major_minor != backing['majorMinor'] or row.get('offset') != 0 or row.get('sizelimit') != 0 or row.get('ro') is not False:
            raise RuntimeError('loop device does not own exact backing inode; preserved')
        return row

    try:
        reserve()
        source = contract['goInventory']
        files = {name: worktree / name for name in source}
        if not files or sum(p.stat().st_size for p in files.values()) > 32 * MIB:
            raise RuntimeError('bounded exact source unavailable')
        for name, p in files.items():
            if not re.fullmatch(r'go/[A-Za-z0-9_./-]+', name) or '..' in Path(name).parts or p.is_symlink() or not p.is_file() or sha(p.read_bytes()) != source[name]['sha256']:
                raise RuntimeError('exact reviewed source mismatch')
        if (worktree / 'go/go.mod').read_text().strip() != 'module github.com/GODOSTROYER/zenith/go\n\ngo 1.27':
            raise RuntimeError('unexpected module or download dependency')
        receipt['sourceFingerprintSha256'] = sha(json.dumps(source, sort_keys=True, separators=(',', ':')).encode())
        archive = out / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name, p in sorted(files.items()):
                tar.add(p, arcname=name, recursive=False)
        if archive.stat().st_size > 32 * MIB:
            raise RuntimeError('source archive bound exceeded')
        with tarfile.open(archive, 'r:gz') as tar:
            members = tar.getmembers()
            if len(members) != len(source) or {m.name for m in members} != set(source):
                raise RuntimeError('source archive identities changed')
            for member in members:
                if not member.isfile() or member.size != source[member.name]['bytes'] or sha(tar.extractfile(member).read()) != source[member.name]['sha256']:
                    raise RuntimeError('exact source archive bytes changed')
        receipt['sourceArchiveSha256'] = sha(archive.read_bytes())
        _, raw = run(['docker', 'info', '--format', '{{.Architecture}}'], 'native-daemon-architecture')
        if raw.decode().strip() not in ['aarch64', 'arm64']:
            raise RuntimeError('native ARM64 daemon unavailable')
        _, raw = run(['docker', 'image', 'ls', '-q', '--no-trunc'], 'image-baseline')
        baseline_images = set(raw.decode().split())
        _, raw = run(['docker', 'manifest', 'inspect', 'docker.io/library/debian@' + INDEX], 'pinned-index', timeout=120)
        children = [m for m in json.loads(raw)['manifests'] if m['platform'].get('os') == 'linux' and m['platform'].get('architecture') == 'arm64']
        if len(children) != 1 or children[0]['digest'] != ARM:
            raise RuntimeError('official index does not bind exact ARM child')
        _, raw = run(['docker', 'manifest', 'inspect', '--verbose', IMAGE], 'pinned-manifest', timeout=120)
        manifest = json.loads(raw)
        descriptor = manifest['Descriptor']
        body = manifest.get('OCIManifest') or manifest.get('SchemaV2Manifest')
        if descriptor['digest'] != ARM or descriptor['platform']['architecture'] != 'arm64' or sum(x['size'] for x in body['layers']) > 256 * MIB:
            raise RuntimeError('bounded pinned native image manifest unavailable')
        pull_started = True
        mutate(['docker', 'pull', '--platform', 'linux/arm64', IMAGE], 'pinned-image-pull', timeout=300)
        _, raw = run(['docker', 'image', 'inspect', IMAGE], 'pinned-image-readback')
        image = json.loads(raw)[0]
        if image['Architecture'] != 'arm64' or image['Os'] != 'linux' or image['Size'] > 512 * MIB or not any(x.endswith('@' + ARM) for x in image.get('RepoDigests', [])):
            raise RuntimeError('actual native image identity or budget refused')
        image_id = image['Id']
        for kind, name in [('container', container), ('volume', volume)]:
            code, _ = run(['docker', kind, 'inspect', name], 'absent-' + kind, False)
            if not code:
                raise RuntimeError('new owned name occupied; preserved')
        owned_volume = True
        mutate(['docker', 'volume', 'create', '--label', 'zenith.package.owner=' + token, volume], 'owned-volume-create')
        inspect('volume', volume)
        owned_container = True
        mutate(['docker', 'run', '-d', '--platform', 'linux/arm64', '--name', container,
             '--label', 'zenith.package.owner=' + token, '--network', 'none', '--read-only',
             '--memory', '2g', '--memory-swap', '2g', '--cpus', '2', '--pids-limit', '512',
             '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1', '--cap-drop', 'ALL',
             '--cap-add', 'SYS_ADMIN', '--cap-add', 'SYS_CHROOT', '--cap-add', 'MKNOD', '--cap-add', 'CHOWN',
             '--cap-add', 'SETUID', '--cap-add', 'SETGID',
             '--device-cgroup-rule', 'b 7:* rwm', '--device-cgroup-rule', 'c 10:237 rwm',
             '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=192m',
             '--mount', 'type=volume,source=' + volume + ',target=/guest', IMAGE, 'sleep', 'infinity'], 'owned-container-create')
        state = inspect('container', container)
        host = state['HostConfig']
        mounts = state.get('Mounts', [])
        if host['Privileged'] or host['Binds'] or host.get('Devices') or host['NetworkMode'] != 'none' or not host['ReadonlyRootfs'] or host['Memory'] != 2 * 1024 ** 3 or host['MemorySwap'] != 2 * 1024 ** 3 or host['NanoCpus'] != 2 * 10 ** 9 or host['PidsLimit'] != 512 or host['CapDrop'] != ['ALL'] or {c.removeprefix('CAP_') for c in host['CapAdd']} != {'SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'CHOWN', 'SETUID', 'SETGID'} or host['DeviceCgroupRules'] != ['b 7:* rwm', 'c 10:237 rwm'] or host['Tmpfs'] != {'/tmp': 'rw,nosuid,nodev,noexec,size=192m'} or host['LogConfig'] != {'Type': 'json-file', 'Config': {'max-file': '1', 'max-size': '1m'}} or len(mounts) != 1 or mounts[0]['Type'] != 'volume' or mounts[0]['Name'] != volume or mounts[0]['Destination'] != '/guest' or not mounts[0]['RW']:
            raise RuntimeError('private fixture isolation refused')
        execute(['bash', '-c', SETUP], 'capped-persistent-root', timeout=90)
        backing = backing_identity('fixed-backing-identity')
        _, raw = execute(['losetup', '--find'], 'free-loop-index')
        loop = raw.decode().strip()
        if not re.fullmatch(r'/dev/loop[0-9]{1,4}', loop):
            raise RuntimeError('owned loop allocation ambiguous')
        # A free-index lookup is not ownership. Create only a new private node,
        # then atomically bind that exact device. EBUSY refuses without retry or
        # modification of another mapping. Lost response retains this index.
        execute(['bash', '-c', LOOP_NODE, 'owned-loop-node', loop], 'owned-loop-node')
        if loop_record('unbound-loop-prerequisite') is not None:
            raise RuntimeError('free loop became occupied; preserved')
        attach_started = True
        execute(['losetup', loop, '/guest/rootfs.ext4'], 'atomic-fixed-loop-attach')
        if loop_record('exact-loop-readback') is None:
            raise RuntimeError('owned loop attachment unavailable')
        receipt['ownedLoop'] = {'device': loop, 'backingIdentity': backing, 'bytes': ROOT_BYTES}
        save()
        class Redirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, url):
                if urllib.parse.urlparse(url).scheme != 'https' or urllib.parse.urlparse(url).hostname not in ['go.dev', 'dl.google.com']:
                    raise RuntimeError('unapproved tool redirect')
                return super().redirect_request(req, fp, code, msg, headers, url)
        download = out / 'go.tar.gz'
        download_deadline = time.monotonic() + 180
        with urllib.request.build_opener(Redirect()).open(GO_URL, timeout=60) as response, download.open('xb') as target:
            total = 0
            while True:
                reserve()
                if time.monotonic() > download_deadline:
                    raise RuntimeError('pinned download deadline exceeded')
                chunk = response.read(MIB)
                if not chunk:
                    break
                total += len(chunk)
                if total > 128 * MIB:
                    raise RuntimeError('pinned Go archive bound exceeded')
                target.write(chunk)
        if sha(download.read_bytes()) != GO_SHA:
            raise RuntimeError('pinned Go checksum refused')
        mutate(['docker', 'cp', str(download), container + ':/guest/go.tar.gz'], 'copy-pinned-tool')
        stage_public(download, '/guest/go.tar.gz', GO_SHA)
        execute(['bash', '-c', COPY, 'copy-native-image', loop], 'preserve-real-debian-image', timeout=180)
        setup = out / 'probe.go'
        setup.write_text(PROBE_GO)
        mutate(['docker', 'cp', str(setup), container + ':/guest/probe.go'], 'copy-fixed-probe')
        stage_public(setup, '/guest/probe.go', sha(PROBE_GO.encode()))
        execute(['bash', '-c', INSTALL_PROBE, 'install-fixed-probe', str(len(PROBE_GO.encode())), sha(PROBE_GO.encode())], 'install-fixed-probe')
        goenv = ['/usr/bin/env', '-i', 'PATH=/usr/local/go/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/root',
                 'GOTOOLCHAIN=local', 'GOPROXY=off', 'GOSUMDB=off', 'CGO_ENABLED=0', 'GOMAXPROCS=2',
                 'GOMEMLIMIT=1400MiB', 'GOCACHE=/root/go-cache', 'GOPATH=/root/go-path']
        execute(['chroot', '/guest/rootfs', *goenv, 'go', 'build', '-p=1', '-o', '/usr/local/bin/owned-package-probe', '/root/probe.go'], 'build-fixed-probe', timeout=240)
        _, raw = execute(['/guest/rootfs/usr/local/bin/owned-package-probe', 'snapshot-image'], 'original-native-state')
        original = json.loads(raw)
        _, raw = execute(['/guest/rootfs/usr/local/bin/owned-package-probe', 'snapshot-copy'], 'copied-native-state')
        if json.loads(raw) != original:
            raise RuntimeError('real native metadata changed during bootstrap')
        receipt['originalNativeStateSha256'] = sha(json.dumps(original, sort_keys=True, separators=(',', ':')).encode())
        execute(['chroot', '/guest/rootfs', '/usr/local/bin/owned-package-probe', 'setup'], 'actual-mount-acl-fixtures')
        mutate(['docker', 'cp', str(archive), container + ':/guest/source.tar.gz'], 'copy-exact-go-source')
        stage_public(archive, '/guest/source.tar.gz', receipt['sourceArchiveSha256'])
        execute(['bash', '-c', 'mkdir -m0700 /guest/rootfs/root/source; tar --no-same-owner -xzf /guest/source.tar.gz -C /guest/rootfs/root/source; rm /guest/source.tar.gz /guest/go.tar.gz'], 'unpack-exact-go-source')
        model_pattern = '^(TestPackageNativeReadbackPreservesRegistryAndIdentity|TestPackageNativeEffectivePolicyPreservesRawReadback|TestPackageNativeStatusMultilineHeaders)$'
        model_code, model_raw = execute(['chroot', '/guest/rootfs', *goenv, 'go', '-C', '/root/source/go', 'test', '-json', '-count=1', '-p=1', './internal/machine', '-run', model_pattern], 'linux-only-model-current-attempt', False, 900)
        model_terminal = {}
        model_package_pass = False
        model_allowed = set(LINUX_MODELS + ['TestPackageNativeReadbackPreservesRegistryAndIdentity', 'TestPackageNativeStatusMultilineHeaders'])
        for line in model_raw.splitlines():
            event = json.loads(line)
            if not isinstance(event, dict) or event.get('Package') != 'github.com/GODOSTROYER/zenith/go/internal/machine' or event.get('Action') not in ['start', 'run', 'pause', 'cont', 'output', 'pass', 'fail', 'skip']:
                raise RuntimeError('malformed current Linux model report')
            if event.get('Action') in ['fail', 'skip']:
                raise RuntimeError('Linux model failure or skip is never accepted')
            if event.get('Action') == 'pass' and not event.get('Test'):
                if model_package_pass:
                    raise RuntimeError('duplicate Linux model package terminal')
                model_package_pass = True
            if event.get('Action') in ['pass', 'fail', 'skip'] and event.get('Test'):
                model_name = event['Test']
                if model_name in model_terminal or model_name not in model_allowed:
                    raise RuntimeError('duplicate or unexpected Linux model identity')
                model_terminal[model_name] = event['Action']
        if model_code or not model_package_pass or set(model_terminal) != model_allowed or any(v != 'pass' for v in model_terminal.values()):
            raise RuntimeError('required current Linux models failed, skipped or missing')
        receipt['actualLinuxModelEventsSha256'] = sha(model_raw)
        receipt['actualLinuxModelCases'] = model_terminal
        save()
        pattern = '^(' + '|'.join(names) + ')$'
        code, raw = execute(['chroot', '/guest/rootfs', *goenv, 'ZENITH_TEST_PACKAGE_INSTALL_REQUIRED=1',
                             'go', '-C', '/root/source/go', 'test', '-json', '-count=1', '-p=1',
                             './internal/machine', '-run', pattern], 'direct-native-current-attempt', False, 900)
        terminal = {}
        package_pass = False
        for line in raw.splitlines():
            event = json.loads(line)
            if not isinstance(event, dict) or event.get('Package') != 'github.com/GODOSTROYER/zenith/go/internal/machine' or event.get('Action') not in ['start', 'run', 'pause', 'cont', 'output', 'pass', 'fail', 'skip']:
                raise RuntimeError('malformed current native report')
            if event.get('Action') in ['fail', 'skip']:
                raise RuntimeError('native failure or skip is never accepted')
            if event.get('Action') == 'pass' and not event.get('Test'):
                if package_pass:
                    raise RuntimeError('duplicate package terminal')
                package_pass = True
            if event.get('Action') in ['pass', 'fail', 'skip'] and event.get('Test'):
                name = event['Test']
                if name in terminal or name not in names + CHILDREN:
                    raise RuntimeError('duplicate or unexpected native case identity')
                terminal[name] = event['Action']
        if code or not package_pass or set(terminal) != set(names + CHILDREN) or any(v != 'pass' for v in terminal.values()):
            raise RuntimeError('required current native cases failed, skipped or missing')
        receipt['actualNativeEventsSha256'] = sha(raw)
        receipt['actualNativeCases'] = terminal
        _, raw = execute(['chroot', '/guest/rootfs', '/usr/local/bin/owned-package-probe', 'snapshot-image'], 'after-native-state')
        after = json.loads(raw)
        def protected(p):
            return p.startswith('/etc/dpkg/') or p.startswith('/var/lib/dpkg/triggers/') or p in ['/etc/dpkg', '/var/lib/dpkg/triggers', '/var/lib/dpkg/diversions', '/var/lib/dpkg/diversions-old', '/var/lib/dpkg/statoverride', '/var/lib/dpkg/statoverride-old']
        if {p: v for p, v in after.items() if protected(p)} != {p: v for p, v in original.items() if protected(p)}:
            raise RuntimeError('original registry or config changed')
        receipt['afterNativeStateSha256'] = sha(json.dumps(after, sort_keys=True, separators=(',', ':')).encode())
        if any(sha(p.read_bytes()) != source[name]['sha256'] for name, p in files.items()):
            raise RuntimeError('host source changed during native attempt')
        receipt['status'] = 'direct_native_passed_pending_cleanup'
    except Exception as error:
        receipt['failure'] = str(error) if isinstance(error, RuntimeError) else 'fixed prerequisite or current-attempt parse failure'
        receipt['status'] = 'failed'
    finally:
        cleanup_mode = True
        cleanup_ok = True
        try:
            if exec_unsettled or mutation_unsettled is not None:
                raise RuntimeError('unconfirmed Docker delivery; preserve mapping and resources')
            if owned_container and inspect('container', container):
                if attach_started and loop_record('cleanup-loop-owner') is not None:
                    # Nested mounts were created only by the fixed fixture.
                    # Verify every mounted target is under the owned ext4 root
                    # and the root source is this same loop before any unmount.
                    script = 'set -euo pipefail; test "$(findmnt -nr -M /guest/rootfs -o SOURCE)" = "$1"; for p in /guest/rootfs/var/lib/zenithd-package-install/mount-controls/file /guest/rootfs/var/lib/zenithd-package-install/mount-controls/nested /guest/rootfs/proc; do if findmnt -rn --mountpoint "$p" >/dev/null; then umount "$p"; fi; done; umount /guest/rootfs'
                    # A failed COPY may precede the root mount; it is safe to
                    # detach only if the device has no mounted target.
                    _, mounted = execute(['findmnt', '-nr', '-S', loop, '-o', 'TARGET'], 'cleanup-loop-mounts', False)
                    if mounted.strip():
                        targets = set(mounted.decode().splitlines())
                        allowed = {'/guest/rootfs', '/guest/rootfs/var/lib/zenithd-package-install/mount-controls/file', '/guest/rootfs/var/lib/zenithd-package-install/mount-controls/nested'}
                        if '/guest/rootfs' not in targets or not targets <= allowed:
                            raise RuntimeError('own loop mounted at unknown target; preserved')
                        execute(['bash', '-c', script, 'owned-cleanup', loop], 'owned-unmount')
                    if loop_record('cleanup-before-detach') is None:
                        raise RuntimeError('own loop unexpectedly detached; preserved')
                    execute(['losetup', '--detach', loop], 'owned-loop-detach')
                    # Never touch a subsequently reused device. Read-only
                    # association scan must find no remaining own-file mapping.
                if attach_started:
                    if backing_identity('cleanup-own-file-identity') != backing:
                        raise RuntimeError('owned backing identity changed; preserved')
                    _, associated = execute(['losetup', '--associated', '/guest/rootfs.ext4', '--noheadings', '--output', 'NAME'], 'own-file-detached')
                    if associated.strip():
                        raise RuntimeError('owned backing remains attached; preserved')
                mutate(['docker', 'stop', '--time', '10', container], 'owned-container-stop')
                mutate(['docker', 'rm', container], 'owned-container-remove')
                confirm_absent('container', container, 'owned-container-absent')
                receipt['cleanup'].append('owned container absent after explicit own-loop detach' if attach_started else 'owned container absent; no loop attachment was attempted')
            if owned_volume and inspect('volume', volume):
                mutate(['docker', 'volume', 'rm', volume], 'owned-volume-remove')
                confirm_absent('volume', volume, 'owned-volume-absent')
                receipt['cleanup'].append('owned volume removed')
            if image_id and image_id not in baseline_images:
                _, used = run(['docker', 'ps', '-aq', '--filter', 'ancestor=' + image_id], 'owned-image-users')
                if used.strip():
                    raise RuntimeError('new image has another user; preserved')
                mutate(['docker', 'image', 'rm', IMAGE], 'owned-image-reference-remove', timeout=90)
            if pull_started and image_id is None:
                raise RuntimeError('partial pinned pull accounting unavailable; no global prune')
            _, remaining = run(['docker', 'image', 'ls', '-q', '--no-trunc'], 'baseline-images-preserved')
            if not baseline_images <= set(remaining.decode().split()):
                raise RuntimeError('baseline image inventory changed')
        except Exception:
            cleanup_ok = False
            receipt['cleanup'].append('cleanup refused or failed; positively owned remaining resources require root investigation')
        if receipt['status'] == 'direct_native_passed_pending_cleanup' and cleanup_ok:
            receipt['status'] = 'direct_native_passed'
        else:
            receipt['status'] = 'failed'
        receipt['cleanupComplete'] = cleanup_ok
        save()
    print(json.dumps({'receipt': str(out / 'receipt.json'), 'status': receipt['status']}))
    return 0 if receipt['status'] == 'direct_native_passed' else 1

if __name__ == '__main__':
    raise SystemExit(main())
