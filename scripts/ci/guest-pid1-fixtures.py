#!/usr/bin/env python3
"""Mandatory fresh native SYS1 phase. Outputs are private until owned cleanup succeeds."""
import argparse,errno,hashlib,json,os,pathlib,re,resource,secrets,shutil,signal,stat,subprocess,sys,time
import importlib.util
_guard_spec=importlib.util.spec_from_file_location('guest_pid1_guard',pathlib.Path(__file__).with_name('guest-pid1-owned-guard.py'))
_guard_module=importlib.util.module_from_spec(_guard_spec);_guard_spec.loader.exec_module(_guard_module)
OwnedGuard=_guard_module.OwnedGuard
P=pathlib.Path(__file__).resolve().parent
FLOOR=12_000_000_000
OUTPUT_SCAN_ATTEMPTS=3
ENDPOINT='unix:///var/run/docker.sock'
CASE='TestSystemdSignedUpdateAndRollback'
PACKAGE='github.com/GODOSTROYER/zenith/go/internal/runner/update'
BASE_IMAGES={'amd64':'ubuntu:24.04@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b','arm64':'ubuntu:24.04@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7'}
BUILD_IMAGE='moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea'
DIAGNOSTIC_STAGES={'prepare','bind','disk-admission','docker-admission','fixture-build','buildkit-builder','pid1-container','guest-baseline','guest-prerequisite','actual-systemd-case','guest-postcondition','cleanup','complete','unknown'}
DIAGNOSTIC_FAILURES={'assertion','filesystem','subprocess','timeout','interrupt','json','other'}
DIAGNOSTIC_CLEANUP={'not-started','in-progress','completed','failed'}
DIAGNOSTIC_STAGE='prepare'
DIAGNOSTIC_DIRECTORY=None
DIAGNOSTIC_ROOT=None
DIAGNOSTIC_RUNTIME_DIRECTORY=None
DIAGNOSTIC_FAILURE=None
DIAGNOSTIC_FAILURE_STAGE=None
DIAGNOSTIC_OPERATION='prepare'
DIAGNOSTIC_FAILURE_OPERATION=None
DIAGNOSTIC_CLEANUP_STATE='not-started'
DIAGNOSTIC_CLEANUP_FAILURE_CLASS=None
DIAGNOSTIC_CLEANUP_OPERATION=None
DIAGNOSTIC_CHILD_EXIT_CODE=None
DIAGNOSTIC_APT_BUILD_OOM_OBSERVED=None
DIAGNOSTIC_APT_BUILD_FAILURE_CLASS=None
DIAGNOSTIC_HOST_FAILURE_OPERATION=None
DIAGNOSTIC_HOST_FAILURE_ERRNO=None
DIAGNOSTIC_PID1_BASELINE=None
DIAGNOSTIC_HOST_FAILURE_OPERATIONS={'pre-run-guard','phase-stream-open','child-spawn','child-register','child-poll','run-guard-check','output-cap-scan','child-drain','phase-stream-close','phase-receipt-save','phase-stdout-read','apt-stderr-read','apt-receipt-save','apt-classifier-read','unknown'}
APT_BUILD_STDERR_TAIL_BYTES=65_536

def base_image_for_arch(arch):
 assert arch in BASE_IMAGES
 return BASE_IMAGES[arch]
APT_BUILD_DIAGNOSTIC_TAIL_BYTES=16_384
APT_BUILD_DIAGNOSTIC_OUTPUT_BYTES=15_000
APT_BUILD_DIAGNOSTIC_READ_BYTES=8_192
# Labels describe recognized private-output markers, not asserted build causes.
APT_BUILD_FAILURE_CLASSES={'apt-network-marker','apt-package-marker','apt-signature-marker','base-image-pull-marker','oom-marker','multiple-signatures','unknown'}
APT_BUILD_FAILURE_SIGNATURES=(
 ('oom-marker',rb'out of memory|oomkilled'),
 ('apt-network-marker',rb'temporary failure resolving|could not resolve|connection timed out|could not connect|network is unreachable'),
 ('apt-package-marker',rb'unable to locate package|no installation candidate'),
 ('apt-signature-marker',rb'no_pubkey|expkeysig|not signed by|signatures? (?:couldn.t|could not) be verified'),
 ('base-image-pull-marker',rb'failed to resolve source metadata|pull access denied|manifest unknown|no matching manifest')
)
DIAGNOSTIC_OPERATIONS={
 'prepare','bind','disk-admission','docker-admission','resolve-build-tools','build-original-fixtures',
 'validate-build-output','binary-build-metadata','prepare-build-context','create-context','verify-context','create-builder',
 'verify-builder','build-apt-image','load-apt-image','release-builder','create-pid1','verify-pid1','guest-baseline',
 'guest-baseline-pid1','guest-baseline-architecture','guest-baseline-cgroup','guest-baseline-no-owned-paths',
 'guest-baseline-container-identity','guest-baseline-running-idle','guest-baseline-exec-settlement',
 'guest-baseline-container-id','guest-baseline-container-created','guest-baseline-container-name','guest-baseline-container-image',
 'guest-baseline-container-config','guest-baseline-container-host-config','guest-baseline-container-host-config-oom-kill-disable',
 'guest-baseline-container-mounts','guest-baseline-container-mount-order',
 'guest-prerequisite','actual-systemd-case','guest-postcondition','cleanup-reconcile','cleanup-stop-pid1',
 'cleanup-remove-pid1','cleanup-release-builder','cleanup-remove-image','cleanup-remove-context',
 'cleanup-verify-baseline','cleanup-close-guard','cleanup-unknown','unknown'
}
GUEST_BASELINE_PHASES=('guest-baseline-pid1','guest-baseline-architecture','guest-baseline-cgroup','guest-baseline-no-owned-paths')
RUN_OPERATIONS={
 'resolved-build-tools':'resolve-build-tools','build-original-fixtures':'build-original-fixtures',
 'binary-build-info-zenithd-1.0.0':'binary-build-metadata','binary-build-info-zenithd-1.1.0':'binary-build-metadata',
 'binary-build-info-update-systemd.test':'binary-build-metadata','create-owned-context':'create-context',
 'context-identity':'verify-context','create-owned-builder':'create-builder','builder-captured':'verify-builder',
 'builder-captured-descriptor':'verify-builder','builder-captured-container':'verify-builder','builder-captured-volume':'verify-builder',
 'builder-captured-buildkit-image':'verify-builder','builder-before-release-descriptor':'verify-builder',
 'builder-before-release-container':'verify-builder','builder-before-release-volume':'verify-builder',
 'builder-before-release-buildkit-image':'verify-builder',
 'apt-image-build':'build-apt-image','loaded-image':'load-apt-image','release-builder':'release-builder',
 'create-disposable-pid1':'create-pid1','container-created':'verify-pid1',
 'guest-baseline-pid1':'guest-baseline-pid1','guest-baseline-architecture':'guest-baseline-architecture',
 'guest-baseline-cgroup':'guest-baseline-cgroup','guest-baseline-no-owned-paths':'guest-baseline-no-owned-paths',
 'installed-apt-package-versions':'guest-prerequisite',
 'actual-one-systemd-scenario':'actual-systemd-case','independent-guest-fixture-absence':'guest-postcondition'
}
for _phase in GUEST_BASELINE_PHASES:
 RUN_OPERATIONS[_phase+'-before']=RUN_OPERATIONS[_phase+'-after']='guest-baseline-container-identity'
GUEST_BASELINE_CONTAINER_PHASES={_phase+'-'+suffix for _phase in GUEST_BASELINE_PHASES for suffix in ('before','after')}
RUN_STAGES={
 'native-info':'docker-admission','baseline-containers':'docker-admission','baseline-images':'docker-admission','baseline-volumes':'docker-admission',
 'test-absent':'docker-admission','builder-absent-before':'docker-admission','cache-absent-before':'docker-admission','baseline-contexts':'docker-admission','baseline-builders':'docker-admission','image-absent':'docker-admission',
 'resolved-build-tools':'fixture-build','build-original-fixtures':'fixture-build','binary-build-info-zenithd-1.0.0':'fixture-build','binary-build-info-zenithd-1.1.0':'fixture-build','binary-build-info-update-systemd.test':'fixture-build',
 'create-owned-context':'buildkit-builder','context-identity':'buildkit-builder','create-owned-builder':'buildkit-builder','builder-captured':'buildkit-builder',
 'apt-image-build':'buildkit-builder','loaded-image':'buildkit-builder','release-builder':'buildkit-builder',
 'create-disposable-pid1':'pid1-container','container-created':'pid1-container',
 'guest-baseline-pid1':'guest-baseline','guest-baseline-architecture':'guest-baseline',
 'guest-baseline-cgroup':'guest-baseline','guest-baseline-no-owned-paths':'guest-baseline',
 'installed-apt-package-versions':'guest-prerequisite','actual-one-systemd-scenario':'actual-systemd-case',
 'independent-guest-fixture-absence':'guest-postcondition'
}
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def _output_tree_size_once(root):
 flags=os.O_RDONLY|getattr(os,'O_DIRECTORY',0)|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0)
 pending=[os.open(os.fspath(root),flags)];total=0
 try:
  while pending:
   directory=pending.pop()
   try:
    with os.scandir(directory) as entries:
     for entry in entries:
      # One fd-relative lstat per entry: classification and size share this no-follow result.
      metadata=os.lstat(entry.name,dir_fd=directory)
      if stat.S_ISDIR(metadata.st_mode):pending.append(os.open(entry.name,flags,dir_fd=directory))
      elif stat.S_ISREG(metadata.st_mode):total+=metadata.st_size
   finally:os.close(directory)
  return total
 except BaseException:
  for descriptor in pending:
   try:os.close(descriptor)
   except OSError:pass
  raise
def output_tree_size(root):
 missing=None
 for _attempt in range(OUTPUT_SCAN_ATTEMPTS):
  try:return _output_tree_size_once(root)
  except OSError as error:
   if error.errno!=errno.ENOENT:raise
   missing=error
 raise FileNotFoundError(errno.ENOENT,'output-cap-scan-race') from missing
def write(p,v):
 t=p.with_suffix('.new');t.write_text(json.dumps(v,indent=2)+'\n');t.chmod(0o600);os.replace(t,p)
def set_diagnostic_stage(stage):
 global DIAGNOSTIC_STAGE
 DIAGNOSTIC_STAGE=stage if stage in DIAGNOSTIC_STAGES else 'unknown'
def set_diagnostic_operation(operation):
 global DIAGNOSTIC_OPERATION
 DIAGNOSTIC_OPERATION=operation if operation in DIAGNOSTIC_OPERATIONS else 'unknown'
def operation_for_phase(phase):
 return RUN_OPERATIONS.get(phase,RUN_STAGES.get(phase,'unknown'))
CONTAINER_IDENTITY_FIELDS=(
 ('Id','guest-baseline-container-id'),('Created','guest-baseline-container-created'),
 ('Name','guest-baseline-container-name'),('Image','guest-baseline-container-image'),
 ('Config','guest-baseline-container-config'),('HostConfig','guest-baseline-container-host-config'),
 ('Mounts','guest-baseline-container-mounts')
)
def container_identity_equal(field,expected,observed):
 if field=='Mounts':
  if type(expected) is not list or type(observed) is not list:return False
  expected_rows=sorted(json.dumps(row,sort_keys=True,separators=(',',':')) for row in expected)
  observed_rows=sorted(json.dumps(row,sort_keys=True,separators=(',',':')) for row in observed)
  return expected_rows==observed_rows
 return expected==observed
def container_identity_failure_operation(field,expected,observed):
 if field=='HostConfig' and isinstance(expected,dict) and isinstance(observed,dict):
  if 'OomKillDisable' in expected and 'OomKillDisable' in observed:
   expected_oom=expected['OomKillDisable'];observed_oom=observed['OomKillDisable']
   expected_rest={k:v for k,v in expected.items() if k!='OomKillDisable'}
   observed_rest={k:v for k,v in observed.items() if k!='OomKillDisable'}
   false_none=(expected_oom is None and type(observed_oom) is bool and observed_oom is False) or (observed_oom is None and type(expected_oom) is bool and expected_oom is False)
   if expected_rest==observed_rest and false_none:return 'guest-baseline-container-host-config-oom-kill-disable'
 return dict(CONTAINER_IDENTITY_FIELDS)[field]
def set_cleanup_operation(operation):
 global DIAGNOSTIC_CLEANUP_OPERATION
 DIAGNOSTIC_CLEANUP_OPERATION=operation if operation in DIAGNOSTIC_OPERATIONS else 'cleanup-unknown'
def classify_failure(error):
 if isinstance(error,AssertionError):return 'assertion'
 if isinstance(error,(subprocess.TimeoutExpired,TimeoutError)):return 'timeout'
 if isinstance(error,(InterruptedError,KeyboardInterrupt)):return 'interrupt'
 if isinstance(error,OSError):return 'filesystem'
 if isinstance(error,subprocess.SubprocessError):return 'subprocess'
 if isinstance(error,json.JSONDecodeError):return 'json'
 return 'other'
def classify_apt_build_failure(stderr_path):
 path=pathlib.Path(stderr_path)
 with path.open('rb') as stderr:
  stderr.seek(0,os.SEEK_END);size=stderr.tell();stderr.seek(max(0,size-APT_BUILD_STDERR_TAIL_BYTES));sample=stderr.read(APT_BUILD_STDERR_TAIL_BYTES)
 matches={failure_class for failure_class,signature in APT_BUILD_FAILURE_SIGNATURES if re.search(signature,sample,re.I)}
 if not matches:return 'unknown'
 if len(matches)>1:return 'multiple-signatures'
 return matches.pop()
def apt_build_diagnostic(out,root,attempt_directory):
 """Return a bounded redacted tail from this attempt's closed apt build streams."""
 out=pathlib.Path(out);attempt_directory=pathlib.Path(attempt_directory)
 if not out.is_absolute() or attempt_directory!=root/'.data-ci-guest'/attempt_directory.name or out!=attempt_directory/'pid1-private'/'runtime' or not re.fullmatch('attempt-[a-f0-9]{32}',attempt_directory.name):return None
 for directory in (root/'.data-ci-guest',attempt_directory,attempt_directory/'pid1-private',out):
  try:st=directory.lstat()
  except OSError:return None
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:return None
 source=out/'apt-image-build.stderr.private';channel='stderr'
 flags=os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)
 try:fd=os.open(source,flags)
 except OSError:return None
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_nlink!=1 or stat.S_IMODE(before.st_mode)!=0o600 or before.st_size>32*1024*1024:return None
  size=before.st_size;full=hashlib.sha256();offset=0
  while offset<size:
   chunk=os.read(fd,min(APT_BUILD_DIAGNOSTIC_READ_BYTES,size-offset))
   if not chunk:return None
   full.update(chunk);offset+=len(chunk)
  after=os.fstat(fd)
  if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):return None
  tail_offset=max(0,size-APT_BUILD_DIAGNOSTIC_TAIL_BYTES);os.lseek(fd,tail_offset,os.SEEK_SET);tail=os.read(fd,APT_BUILD_DIAGNOSTIC_TAIL_BYTES)
  if len(tail)!=size-tail_offset:return None
 except OSError:return None
 finally:os.close(fd)
 if not tail:
  channel='stdout';source=out/'apt-image-build.stdout.private'
  try:fd=os.open(source,flags)
  except OSError:return None
  try:
   before=os.fstat(fd)
   if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_nlink!=1 or stat.S_IMODE(before.st_mode)!=0o600 or before.st_size>32*1024*1024:return None
   size=before.st_size;full=hashlib.sha256();offset=0
   while offset<size:
    chunk=os.read(fd,min(APT_BUILD_DIAGNOSTIC_READ_BYTES,size-offset))
    if not chunk:return None
    full.update(chunk);offset+=len(chunk)
   after=os.fstat(fd)
   if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):return None
   tail_offset=max(0,size-APT_BUILD_DIAGNOSTIC_TAIL_BYTES);os.lseek(fd,tail_offset,os.SEEK_SET);tail=os.read(fd,APT_BUILD_DIAGNOSTIC_TAIL_BYTES)
   if len(tail)!=size-tail_offset:return None
  except OSError:return None
  finally:os.close(fd)
 if not tail:return None
 raw_hash=full.hexdigest();input_truncated=tail_offset>0
 text=tail.decode('utf-8','replace')
 text=re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\|$)|[@-_])','',text)
 text=''.join(c if c in '\n\t' or 32<=ord(c)<127 or ord(c)>=160 else ' ' for c in text)
 if input_truncated:text=text.split('\n',1)[1] if '\n' in text else ''
 text=re.sub(r'(?i)(https?://)[^/@\s]+@',r'\1[redacted]@',text)
 text=re.sub(r'(?i)(https?://[^\s?#]+)\?[^\s#]*',r'\1?[redacted]',text)
 text=re.sub(r'(?im)^(\s*(?:authorization|proxy-authorization)\s*[:=]\s*)[^\r\n]*',r'\1[redacted]',text)
 text=re.sub(r'(?im)\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|token|password|passwd|secret))([\s]*[:=][\s]*)[^\r\n]*',r'\1\2[redacted]',text)
 text=re.sub(r'(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*',r'\1 [redacted]',text)
 for prefix in sorted({str(pathlib.Path(root)),str(pathlib.Path(out)),str(pathlib.Path.home())},key=len,reverse=True):
  if prefix and prefix!='/':text=text.replace(prefix,'[local-path]')
 text=re.sub(r'(?<![\w])/(?:Users|private|tmp|var/folders)/[^\s\"\'<>]+','[local-path]',text)
 encoded=text.encode('utf-8');payload=encoded[:APT_BUILD_DIAGNOSTIC_OUTPUT_BYTES].decode('utf-8','ignore')
 return {'channel':channel,'rawBytes':size,'rawSha256':raw_hash,'tailOffset':tail_offset,'inputTruncated':input_truncated,
  'redactedOutputTruncated':len(encoded)>APT_BUILD_DIAGNOSTIC_OUTPUT_BYTES,'redactedPayloadSha256':hashlib.sha256(payload.encode()).hexdigest(),'payload':payload}
def host_call(operation,callback):
 global DIAGNOSTIC_HOST_FAILURE_OPERATION,DIAGNOSTIC_HOST_FAILURE_ERRNO
 try:return callback()
 except OSError as error:
  if DIAGNOSTIC_FAILURE is None and DIAGNOSTIC_HOST_FAILURE_OPERATION is None and not isinstance(error,(TimeoutError,InterruptedError)):
   DIAGNOSTIC_HOST_FAILURE_OPERATION=operation if operation in DIAGNOSTIC_HOST_FAILURE_OPERATIONS else 'unknown'
   number=error.errno
   DIAGNOSTIC_HOST_FAILURE_ERRNO=number if type(number) is int and 1<=number<=4095 else None
  raise
def initialize_diagnostic(root,attempt):
 global DIAGNOSTIC_DIRECTORY,DIAGNOSTIC_ROOT
 if not re.fullmatch('[a-f0-9]{32}',attempt) or root.resolve()!=root:raise RuntimeError('diagnostic_scope')
 base=root/'.data-ci-guest';directory=base/('attempt-'+attempt)
 for path in (base,directory):
  st=path.lstat()
  assert stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700
 DIAGNOSTIC_DIRECTORY=directory;DIAGNOSTIC_ROOT=root
PID1_COMM_DIAGNOSTIC_MAX_BYTES=4096
PID1_CONTAINER_STATUSES={'created','restarting','running','removing','paused','exited','dead'}
def pid1_comm_diagnostic(out,stream_phase='guest-baseline-pid1'):
 """Read the comm emitted by the failed baseline exec from its private stream."""
 if not re.fullmatch(r'guest-baseline-pid1(?:-retry-[0-9]{3})?',stream_phase):return None
 source=pathlib.Path(out)/(stream_phase+'.stdout.private')
 flags=os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)
 try:fd=os.open(source,flags)
 except OSError:return None
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_nlink!=1 or stat.S_IMODE(before.st_mode)!=0o600 or before.st_size>PID1_COMM_DIAGNOSTIC_MAX_BYTES:return None
  data=bytearray()
  while len(data)<before.st_size:
   chunk=os.read(fd,min(1024,before.st_size-len(data)))
   if not chunk:return None
   data.extend(chunk)
  after=os.fstat(fd)
  if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):return None
 finally:os.close(fd)
 line=bytes(data).split(b'\n',1)[0]
 if bytes(data)!=line+b'\n':return None
 try:value=line.decode('ascii')
 except UnicodeDecodeError:return None
 return value if re.fullmatch(r'[A-Za-z0-9_-]{1,15}',value) else None
def pid1_container_state_diagnostic(container):
 state=container.get('State') if isinstance(container,dict) else None
 if not isinstance(state,dict):return None
 running=state.get('Running');paused=state.get('Paused');restarting=state.get('Restarting');oom_killed=state.get('OOMKilled')
 status=state.get('Status');exit_code=state.get('ExitCode')
 if any(type(value) is not bool for value in (running,paused,restarting,oom_killed)):return None
 if status not in PID1_CONTAINER_STATUSES:return None
 if exit_code is not None and (type(exit_code) is not int or not 0<=exit_code<=255):return None
 return {'running':running,'paused':paused,'restarting':restarting,'oomKilled':oom_killed,'status':status,'exitCode':exit_code}
def pid1_inspection_stream_phase(phase,edge,retry):
 assert phase=='guest-baseline-pid1' and edge in ('before','after') and type(retry) is int and retry>=0
 suffix='' if retry==0 else '-retry-%03d'%retry
 return phase+'-'+edge+suffix

def wait_for_systemd_pid1(attempt,deadline,clock,sleep,interval=0.25):
 """Retry only the exact not-ready comm under one caller-owned deadline."""
 first_not_ready=None
 retry=0
 command=['/bin/sh','-ec','comm="$(cat /proc/1/comm)" || exit 125; printf "%s\\n" "$comm"; test "$comm" = systemd']
 while True:
  remaining=deadline-clock()
  if remaining<=0:
   if first_not_ready is not None:raise subprocess.CalledProcessError(1,'owned-child')
   raise TimeoutError()
  code,output=attempt(command,remaining,retry)
  if code==0 and output==b'systemd\n':return retry+1
  if code==0:raise AssertionError('pid1-readiness-output')
  if code!=1 or output!=b'init\n':raise subprocess.CalledProcessError(code,'owned-child')
  if first_not_ready is None:first_not_ready=True
  retry+=1
  remaining=deadline-clock()
  if remaining<=0:raise subprocess.CalledProcessError(1,'owned-child')
  sleep(min(interval,remaining))
def write_diagnostic():
 if DIAGNOSTIC_DIRECTORY is None:return
 failure_stage=DIAGNOSTIC_FAILURE_STAGE or (DIAGNOSTIC_STAGE if DIAGNOSTIC_FAILURE is not None else 'complete')
 apt_detail=None
 if DIAGNOSTIC_FAILURE=='subprocess' and DIAGNOSTIC_FAILURE_OPERATION=='build-apt-image' and DIAGNOSTIC_CHILD_EXIT_CODE is not None:
  try:apt_detail=apt_build_diagnostic(DIAGNOSTIC_RUNTIME_DIRECTORY,DIAGNOSTIC_ROOT,DIAGNOSTIC_DIRECTORY)
  except Exception:apt_detail=None
 pid1_detail=DIAGNOSTIC_PID1_BASELINE if failure_stage=='guest-baseline' and DIAGNOSTIC_FAILURE_OPERATION=='guest-baseline-pid1' and DIAGNOSTIC_FAILURE=='subprocess' else None
 row={'schemaVersion':7,'failureStage':failure_stage,'failureClass':DIAGNOSTIC_FAILURE,'failureOperation':DIAGNOSTIC_FAILURE_OPERATION,'cleanupState':DIAGNOSTIC_CLEANUP_STATE,'cleanupFailureClass':DIAGNOSTIC_CLEANUP_FAILURE_CLASS,'cleanupOperation':DIAGNOSTIC_CLEANUP_OPERATION,'childExitCode':DIAGNOSTIC_CHILD_EXIT_CODE,'aptBuildOOMObserved':DIAGNOSTIC_APT_BUILD_OOM_OBSERVED,'aptBuildFailureClass':DIAGNOSTIC_APT_BUILD_FAILURE_CLASS,'hostFailureOperation':DIAGNOSTIC_HOST_FAILURE_OPERATION,'hostFailureErrno':DIAGNOSTIC_HOST_FAILURE_ERRNO,'aptBuildDiagnostic':apt_detail,'pid1BaselineDiagnostic':pid1_detail}
 assert pid1_detail is None or failure_stage=='guest-baseline' and DIAGNOSTIC_FAILURE_OPERATION=='guest-baseline-pid1' and DIAGNOSTIC_FAILURE=='subprocess'
 if pid1_detail is not None:
  assert set(pid1_detail)=={'comm','containerState'} and (pid1_detail['comm'] is None or re.fullmatch(r'[A-Za-z0-9_-]{1,15}',pid1_detail['comm']))
  state=pid1_detail['containerState']
  assert state is None or set(state)=={'running','paused','restarting','oomKilled','status','exitCode'} and all(type(state[k]) is bool for k in ('running','paused','restarting','oomKilled')) and state['status'] in PID1_CONTAINER_STATUSES and (state['exitCode'] is None or type(state['exitCode']) is int and 0<=state['exitCode']<=255)
 assert row['failureStage'] in DIAGNOSTIC_STAGES and (row['failureClass'] is None or row['failureClass'] in DIAGNOSTIC_FAILURES) and row['cleanupState'] in DIAGNOSTIC_CLEANUP
 assert (row['failureClass'] is None) == (row['failureStage']=='complete' and row['failureOperation'] is None and row['cleanupState']=='completed')
 assert row['failureClass'] is None or row['failureOperation'] in DIAGNOSTIC_OPERATIONS
 assert (row['cleanupFailureClass'] is None) == (row['cleanupOperation'] is None)
 assert row['cleanupFailureClass'] is None or row['cleanupFailureClass'] in DIAGNOSTIC_FAILURES and row['cleanupOperation'] in DIAGNOSTIC_OPERATIONS and row['cleanupState']=='failed'
 assert row['childExitCode'] is None or type(row['childExitCode']) is int and -255<=row['childExitCode']<=255 and row['childExitCode']!=0
 assert row['childExitCode'] is None or row['failureClass']=='subprocess'
 assert row['aptBuildOOMObserved'] is None or type(row['aptBuildOOMObserved']) is bool
 assert row['aptBuildFailureClass'] is None or row['aptBuildFailureClass'] in APT_BUILD_FAILURE_CLASSES and row['failureClass']=='subprocess' and row['failureOperation']=='build-apt-image' and row['childExitCode'] is not None
 assert (row['aptBuildFailureClass'] is not None)==(row['failureClass']=='subprocess' and row['failureOperation']=='build-apt-image' and row['childExitCode'] is not None)
 assert row['hostFailureOperation'] is None or row['hostFailureOperation'] in DIAGNOSTIC_HOST_FAILURE_OPERATIONS and row['failureClass']=='filesystem'
 assert row['hostFailureErrno'] is None or type(row['hostFailureErrno']) is int and 1<=row['hostFailureErrno']<=4095 and row['failureClass']=='filesystem' and row['hostFailureOperation'] is not None
 assert row['hostFailureOperation'] is not None or row['hostFailureErrno'] is None
 target=DIAGNOSTIC_DIRECTORY/'pid1-diagnostic.private.json';tmp=DIAGNOSTIC_DIRECTORY/('.pid1-diagnostic-'+secrets.token_hex(8)+'.tmp')
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
 try:
  with os.fdopen(fd,'wb',closefd=False) as out:out.write((json.dumps(row,separators=(',',':'),ensure_ascii=False)+'\n').encode('utf-8'));out.flush();os.fsync(fd)
 finally:os.close(fd)
 os.replace(tmp,target)
 dfd=os.open(DIAGNOSTIC_DIRECTORY,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
 try:os.fsync(dfd)
 finally:os.close(dfd)
def bind(f):
 root=pathlib.Path(f['root']);assert root.resolve()==root
 assert subprocess.check_output([f['tools']['git']['path'],'rev-parse','HEAD'],cwd=root,text=True).strip()==f['sourceCommit']
 assert not subprocess.check_output([f['tools']['git']['path'],'diff','--name-only','HEAD'],cwd=root).strip()
 for row in f['sourceInputs']:assert sha(root/row['file'])==row['sha256']
 tree={}
 for n in (root/'go').rglob('*'):
  if n.name=='.DS_Store':continue
  st=n.lstat();assert st.st_uid==os.getuid() and (stat.S_ISDIR(st.st_mode) or (stat.S_ISREG(st.st_mode) and st.st_nlink==1))
  if stat.S_ISREG(st.st_mode):tree[n.relative_to(root).as_posix()]=sha(n)
 assert tree==f['completeGoTree']
 assert sha(P/'SOURCE-CONTRACT.json')==f['sourceContractSha256']
 assert json.loads((P/'SOURCE-CONTRACT.json').read_text())=={k:f[k] for k in ['root','sourceCommit','sourceInputs']}
 actual_go=sorted(n.relative_to(root).as_posix() for n in (root/'go').rglob('*') if n.is_file() and (n.suffix=='.go' or n.name in ['go.mod','go.sum']))
 assert actual_go==sorted(f['goBuildInputs'])
 for n in actual_go:
  st=(root/n).lstat();assert stat.S_ISREG(st.st_mode) and st.st_nlink==1 and sha(root/n)==f['goBuildInputs'][n]
 for row in f['tools'].values():assert sha(row['path'])==row['sha256']
 assert pathlib.Path(sys.executable).resolve()==pathlib.Path(f['tools']['python']['path'])
 assert sha(root/'scripts/ci/guest-pid1-owned-guard.py')==f['ownedGuardSha256']
 return root
def prepare(root,attempt,arch):
 # Read-only admission; no Docker mutation before the registered guard exists.
 assert sys.platform=='linux' and os.getuid()!=0 and arch in ['amd64','arm64']
 assert re.fullmatch('[a-f0-9]{32}',attempt) and root.resolve()==root
 def read(argv):return subprocess.check_output(argv,cwd=root,timeout=10,text=True).strip()
 assert not read(['git','diff','--name-only','HEAD'])
 commit=read(['git','rev-parse','HEAD']);assert re.fullmatch('[a-f0-9]{40}',commit)
 files=read(['git','ls-files','--','go','deploy/zenithd/acceptance','deploy/zenithd/zenithd.service','scripts/ci/gate-manifest.mjs','scripts/ci/run-guest-file-write-gate.mjs']).splitlines()
 files=sorted(set(files+['scripts/ci/guest-pid1-fixtures.py','scripts/ci/guest-pid1-owned-guard.py']))
 inputs=[{'file':n,'sha256':sha(root/n)} for n in files]
 complete={n.relative_to(root).as_posix():sha(n) for n in (root/'go').rglob('*') if n.is_file() and n.name!='.DS_Store'}
 goinputs={n:h for n,h in complete.items() if n.endswith('.go') or pathlib.Path(n).name in ['go.mod','go.sum']}
 tools={k:{'path':str(pathlib.Path(shutil.which(n)).resolve(strict=True))} for k,n in [('go','go'),('git','git'),('python','python3'),('docker','docker'),('bash','bash')]}
 for row in tools.values():row['sha256']=sha(row['path'])
 actual=json.loads(read([tools['go']['path'],'env','-json','GOVERSION','GOOS','GOARCH','GOROOT']))
 assert actual['GOVERSION']=='go1.27.1' and actual['GOOS']=='linux' and actual['GOARCH']==arch
 assert tools['python']['path']==str(pathlib.Path(sys.executable).resolve(strict=True))
 plugins=[n for n in ['/usr/libexec/docker/cli-plugins','/usr/lib/docker/cli-plugins'] if pathlib.Path(n,'docker-buildx').is_file()]
 assert len(plugins)==1
 tools['buildx']={'path':str(pathlib.Path(plugins[0],'docker-buildx').resolve(strict=True))};tools['buildx']['sha256']=sha(tools['buildx']['path'])
 directory=root/'.data-ci-guest'/('attempt-'+attempt);st=directory.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700
 private=directory/'pid1-private';private.mkdir(mode=0o700)
 f={'root':str(root),'sourceCommit':commit,'sourceInputs':inputs,'completeGoTree':complete,'goBuildInputs':goinputs,'tools':tools,'goRoot':actual['GOROOT'],'path':os.environ['PATH'],'dockerPluginDir':plugins[0],'arch':arch,'attempt':attempt,'setupHeadroomBytes':2_000_000_000,'attemptByteCap':1024**3,'ownedGuardSha256':sha(root/'scripts/ci/guest-pid1-owned-guard.py')}
 write(private/'SOURCE-CONTRACT.json',{k:f[k] for k in ['root','sourceCommit','sourceInputs']});f['sourceContractSha256']=sha(private/'SOURCE-CONTRACT.json')
 write(private/'runtime-inputs.private.json',f)
 return private,f

def main():
 global P,DIAGNOSTIC_RUNTIME_DIRECTORY,DIAGNOSTIC_FAILURE,DIAGNOSTIC_FAILURE_STAGE,DIAGNOSTIC_FAILURE_OPERATION,DIAGNOSTIC_CLEANUP_FAILURE_CLASS,DIAGNOSTIC_CLEANUP_STATE,DIAGNOSTIC_CLEANUP_OPERATION,DIAGNOSTIC_PID1_BASELINE
 assert __debug__
 a=argparse.ArgumentParser();a.add_argument('--root',required=True);a.add_argument('--attempt',required=True);a.add_argument('--arch',required=True);args=a.parse_args()
 os.umask(0o077);root=pathlib.Path(args.root).resolve(strict=True);initialize_diagnostic(root,args.attempt);set_diagnostic_stage('prepare');set_diagnostic_operation('prepare')
 P,f=prepare(root,args.attempt,args.arch);base_image=base_image_for_arch(f['arch']);set_diagnostic_stage('bind');set_diagnostic_operation('bind');root=bind(f)
 assert not pathlib.Path('/c/Users/user/.local/sdk/node22').exists()
 set_diagnostic_stage('disk-admission');set_diagnostic_operation('disk-admission')
 assert shutil.disk_usage(P).free>=FLOOR+f['setupHeadroomBytes']
 os.umask(0o077);token=secrets.token_hex(6);out=P/'runtime';out.mkdir(mode=0o700);DIAGNOSTIC_RUNTIME_DIRECTORY=out
 receipt={'status':'failed','diagnosticOnly':False,'scope':'one actual installed signed-update/rollback native Linux PID1 scenario; no production signer, cloud, default-stack or generic Go skip acceptance','cleanupComplete':False,'phases':[]};write(out/'receipt.private.json',receipt)
 # Exact fresh names are recorded before any delivery; unknown delivery blocks removal.
 name='zenith-mach04-'+token;builder='zenith-owned-'+token;context='zenith-owned-context-'+token
 builder_name='buildx_buildkit_'+builder+'0';cache=builder_name+'_state';tag=name+':fixture'
 env={'PATH':f['path'],'HOME':str(out),'TMPDIR':str(out),'LANG':'C','TZ':'UTC','GOTOOLCHAIN':'local','GOROOT':f['goRoot'],'GOENV':'off','GOFLAGS':'-mod=readonly','GOCACHE':str(out/'go-cache'),'GOMODCACHE':str(out/'go-modules')}
 config=out/'docker';config.mkdir(mode=0o700);write(config/'config.json',{'cliPluginsExtraDirs':[f['dockerPluginDir']]});env['DOCKER_CONFIG']=str(config)
 command=[f['tools']['docker']['path'],'--host='+ENDPOINT]
 set_diagnostic_stage('docker-admission');set_diagnostic_operation('docker-admission')
 guard=OwnedGuard(out,floor=FLOOR,socket_path=ENDPOINT[7:],socket_owner=0,source_contract=P/'SOURCE-CONTRACT.json');assert guard.sourceStartMatched
 pin=None;exec_pin=None;builder_snapshot=None;container_snapshot=None;image=None;context_snapshot=None;cleaning=False;baseline=None
 def save():write(out/'receipt.private.json',receipt)
 def interrupt(signum,frame):raise InterruptedError('owned interrupt')
 signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
 def run(argv,phase,timeout=60,cwd=None,docker=True,extra=None,budget_deadline=None,allow_nonzero=False,stream_phase=None):
  global DIAGNOSTIC_CHILD_EXIT_CODE,DIAGNOSTIC_APT_BUILD_OOM_OBSERVED,DIAGNOSTIC_APT_BUILD_FAILURE_CLASS
  if cleaning:set_diagnostic_stage('cleanup')
  else:
   if phase in RUN_STAGES:set_diagnostic_stage(RUN_STAGES[phase])
   set_diagnostic_operation(operation_for_phase(phase))
  if budget_deadline is not None:
   timeout=min(timeout,budget_deadline-time.monotonic())
   if timeout<=0:raise TimeoutError()
  host_call('pre-run-guard',lambda:guard.check(cleanup=cleaning,bootstrap=phase=='native-info'))
  childenv={**env,**(extra or {})}
  def limits():resource.setrlimit(resource.RLIMIT_FSIZE,(32*1024**2,32*1024**2))
  stream_phase=stream_phase or phase
  stdout=host_call('phase-stream-open',lambda:(out/(stream_phase+'.stdout.private')).open('xb'))
  try:stderr=host_call('phase-stream-open',lambda:(out/(stream_phase+'.stderr.private')).open('xb'))
  except BaseException:
   host_call('phase-stream-close',stdout.close);raise
  try:
   child=host_call('child-spawn',lambda:subprocess.Popen((command+argv) if docker else argv,cwd=cwd,env=childenv,stdout=stdout,stderr=stderr,start_new_session=True,preexec_fn=limits))
   child=host_call('child-register',lambda:guard.register(child));deadline=time.monotonic()+timeout
   if budget_deadline is not None:deadline=min(deadline,budget_deadline)
   try:
    while host_call('child-poll',child.poll) is None:
     host_call('run-guard-check',lambda:guard.check(cleanup=cleaning,bootstrap=phase=='native-info'))
     if time.monotonic()>=deadline:raise TimeoutError()
     total=host_call('output-cap-scan',lambda:output_tree_size(out))
     assert total<=f['attemptByteCap'];time.sleep(.25)
   finally:host_call('child-drain',lambda:guard.drain(child))
  finally:
   try:host_call('phase-stream-close',stdout.close)
   finally:host_call('phase-stream-close',stderr.close)
  if budget_deadline is not None and time.monotonic()>=budget_deadline:raise TimeoutError()
  host_call('phase-receipt-save',lambda:(receipt['phases'].append({'phase':phase,'exitCode':child.returncode}),save()))
  if phase=='apt-image-build':
   DIAGNOSTIC_APT_BUILD_OOM_OBSERVED=bool(re.search(rb'(?i)out of memory|oomkilled',host_call('apt-stderr-read',lambda:(out/(phase+'.stderr.private')).read_bytes())));receipt['aptBuildOOMObserved']=DIAGNOSTIC_APT_BUILD_OOM_OBSERVED;host_call('apt-receipt-save',save)
  if child.returncode!=0:
   if phase=='apt-image-build' and DIAGNOSTIC_FAILURE is None:
    DIAGNOSTIC_APT_BUILD_FAILURE_CLASS=host_call('apt-classifier-read',lambda:classify_apt_build_failure(out/(phase+'.stderr.private')))
   if DIAGNOSTIC_FAILURE is None and DIAGNOSTIC_CHILD_EXIT_CODE is None:DIAGNOSTIC_CHILD_EXIT_CODE=child.returncode
   if not allow_nonzero:raise subprocess.CalledProcessError(child.returncode,'owned-child')
  output=host_call('phase-stdout-read',lambda:(out/(stream_phase+'.stdout.private')).read_bytes())
  return (child.returncode,output) if allow_nonzero else output
 def mutate(argv,phase,timeout=60):
  nonlocal pin
  if cleaning:set_diagnostic_stage('cleanup')
  else:
   if phase in RUN_STAGES:set_diagnostic_stage(RUN_STAGES[phase])
   set_diagnostic_operation(operation_for_phase(phase))
  assert pin is None and exec_pin is None;pin=phase;receipt['unconfirmedDelivery']=phase;save();result=run(argv,phase,timeout);pin=None;receipt['unconfirmedDelivery']=None;save();return result
 def obj(argv,phase,budget_deadline=None,stream_phase=None):return json.loads(run(argv,phase,budget_deadline=budget_deadline,stream_phase=stream_phase))
 def absent(kind,value,phase):
  if kind=='volume':args=['volume','ls','-q','--filter','name=^'+value+'$']
  else:args=['container','ls','-aq','--filter','name=^/'+value+'$']
  assert not run(args,phase).strip()
 def capture_builder(phase):
  descriptor=run(['buildx','inspect',builder],phase+'-descriptor').decode()
  assert re.search(r'^Driver:\s+docker-container\s*$',descriptor,re.M)
  nodes=descriptor.split('Nodes:',1)[1];assert len(re.findall(r'^Name:',nodes,re.M))==1 and re.search(r'^Name:\s+'+re.escape(builder+'0')+r'\s*$',nodes,re.M) and re.search(r'^Endpoint:\s+'+re.escape(context)+r'\s*$',nodes,re.M)
  c=obj(['container','inspect',builder_name],phase+'-container')[0];v=obj(['volume','inspect',cache],phase+'-volume')[0]
  assert c['Name']=='/'+builder_name and re.fullmatch('[a-f0-9]{64}',c['Id']) and c['Config']['Image']==BUILD_IMAGE and c['HostConfig']['Memory']==1024**3
  assert len(c['Mounts'])==1 and c['Mounts'][0]['Type']=='volume' and c['Mounts'][0]['Name']==cache and c['Mounts'][0]['Destination']=='/var/lib/buildkit' and c['Mounts'][0]['RW'] is True
  im=obj(['image','inspect',c['Image']],phase+'-buildkit-image')[0];assert im['Id']==c['Image'] and im['Os']=='linux' and im['Architecture']==f['arch'] and any(n.endswith('@'+BUILD_IMAGE.split('@')[1]) for n in im['RepoDigests'])
  assert v['Name']==cache and v['Driver']==v['Scope']=='local' and not v.get('Options')
  return {'container':{k:c[k] for k in ['Id','Created','Name','Image','Config','HostConfig','Mounts']},'volume':v}
 def release_builder():
  nonlocal builder_snapshot
  assert capture_builder('builder-before-release')==builder_snapshot
  mutate(['buildx','rm',builder],'release-builder',120);absent('container',builder_name,'builder-absent');absent('volume',cache,'cache-absent');builder_snapshot=None
 def owned_container(phase,budget_deadline=None,stream_phase=None):
  c=obj(['container','inspect',name],phase,budget_deadline,stream_phase)[0]
  if phase in GUEST_BASELINE_CONTAINER_PHASES:set_diagnostic_operation('guest-baseline-container-identity')
  if budget_deadline is not None and time.monotonic()>=budget_deadline:raise TimeoutError()
  if phase in GUEST_BASELINE_CONTAINER_PHASES:
   for field,_ in CONTAINER_IDENTITY_FIELDS:
    try:observed=c[field]
    except KeyError:
     set_diagnostic_operation(dict(CONTAINER_IDENTITY_FIELDS)[field]);raise
    if not container_identity_equal(field,container_snapshot[field],observed):
     set_diagnostic_operation(container_identity_failure_operation(field,container_snapshot[field],observed));break
  assert all(container_identity_equal(field,container_snapshot[field],c[field]) for field,_ in CONTAINER_IDENTITY_FIELDS)
  return c
 def verify_pid1_container(c):
  host=c['HostConfig']
  assert host['Privileged'] and host['CgroupnsMode']=='private' and host['Memory']==host['MemorySwap']==512*1024**2 and host['NetworkMode']=='none' and host['PidsLimit']==512 and host['NanoCpus']==2*10**9
  assert len(c['Mounts'])==2 and {(m['Source'],m['Destination'],m['RW']) for m in c['Mounts']}=={(str(src),'/src',False),(str(binaries),'/fixtures',False)}
  assert not host.get('Binds') and not host.get('Devices') and not host.get('CapAdd') and host.get('ReadonlyRootfs') is False
 def reconcile_delivery():
  """Resolve a command whose client outcome was lost; unknown objects stay untouched."""
  nonlocal pin,exec_pin,builder_snapshot,container_snapshot,image,context_snapshot
  if exec_pin is not None:
   assert container_snapshot is not None
   owned_container('recover-exec-container')
   # This container is private to the attempt. Cleanup below stops it, which
   # terminates any delivered exec. Do not try to replay the command.
   exec_pin=None;receipt['unconfirmedExec']=None;save()
  if pin is None:return
  phase=pin
  if phase=='create-owned-context':
   names=run(['context','ls','--format','{{.Name}}'],'recover-context-list').decode().splitlines()
   if context in names:
    found=obj(['context','inspect',context],'recover-context-inspect');assert found[0]['Endpoints']['docker']['Host']==ENDPOINT;context_snapshot=found
   else:context_snapshot=None
  elif phase in ('create-owned-builder','release-builder'):
   names=run(['buildx','ls','--format','{{.Name}}'],'recover-builder-list').decode().splitlines()
   containers=run(['container','ls','-aq','--filter','name=^/'+builder_name+'$'],'recover-builder-container-list').decode().splitlines()
   volumes=run(['volume','ls','-q','--filter','name=^'+cache+'$'],'recover-builder-volume-list').decode().splitlines()
   if builder in names:
    recovered=capture_builder('recover-builder');assert builder_snapshot is None or recovered==builder_snapshot;builder_snapshot=recovered
   else:
    # Partial or ambiguous buildx delivery cannot be safely removed by name.
    assert not containers and not volumes,'unowned-partial-builder-preserved'
    builder_snapshot=None
  elif phase=='apt-image-build':
   ids=run(['image','ls','-q','--no-trunc','--filter','reference='+tag],'recover-image-list').decode().splitlines()
   if ids:
    assert len(ids)==1 and re.fullmatch('[a-f0-9]{64}',ids[0]);loaded=obj(['image','inspect',ids[0]],'recover-image-inspect')[0]
    assert loaded['Os']=='linux' and loaded['Architecture']==f['arch'] and loaded['Config']['Labels']['zenith.mach04.owner']==token and loaded['RepoTags']==[tag] and not loaded.get('RepoDigests')
    image=loaded['Id']
   else:image=None
  elif phase=='create-disposable-pid1':
   ids=run(['container','ls','-aq','--no-trunc','--filter','name=^/'+name+'$'],'recover-pid1-list').decode().splitlines()
   if ids:
    assert len(ids)==1 and re.fullmatch('[a-f0-9]{64}',ids[0]);c=obj(['container','inspect',ids[0]],'recover-pid1-inspect')[0]
    assert c['Id']==ids[0] and c['Name']=='/'+name and c['Config']['Labels']['zenith.mach04.owner']==token and image and c['Image']==image
    verify_pid1_container(c)
    container_snapshot={k:c[k] for k in ['Id','Created','Name','Image','Config','HostConfig','Mounts']}
   else:container_snapshot=None
  elif phase=='stop-owned-pid1':
   assert container_snapshot is not None;owned_container('recover-stop-container')
  elif phase=='remove-owned-container':
   ids=run(['container','ls','-aq','--no-trunc','--filter','name=^/'+name+'$'],'recover-remove-container-list').decode().splitlines()
   if ids:assert len(ids)==1 and container_snapshot is not None and owned_container('recover-remove-container')['Id']==ids[0]
   else:container_snapshot=None
  elif phase=='remove-exact-owned-image':
   if image:
    ids=run(['image','ls','-q','--no-trunc','--filter','reference='+tag],'recover-remove-image-list').decode().splitlines()
    if ids:assert ids==[image] and obj(['image','inspect',image],'recover-remove-image-inspect')[0]['RepoTags']==[tag]
    else:image=None
  elif phase=='remove-owned-context':
   names=run(['context','ls','--format','{{.Name}}'],'recover-remove-context-list').decode().splitlines()
   if context in names:assert context_snapshot is not None and obj(['context','inspect',context],'recover-remove-context-inspect')==context_snapshot
   else:context_snapshot=None
  else:raise AssertionError('unknown delivery retained: '+phase)
  pin=None;receipt['unconfirmedDelivery']=None;save()
 def execute(argv,phase,timeout=60,budget_deadline=None,allow_nonzero=False,stream_phase=None,inspection_retry=None):
  nonlocal exec_pin
  if cleaning:set_diagnostic_stage('cleanup')
  else:
   if phase in RUN_STAGES:set_diagnostic_stage(RUN_STAGES[phase])
   set_diagnostic_operation(operation_for_phase(phase))
  if phase in GUEST_BASELINE_PHASES:set_diagnostic_operation('guest-baseline-running-idle')
  if budget_deadline is not None and time.monotonic()>=budget_deadline:raise TimeoutError()
  assert pin is None and exec_pin is None
  before_stream=pid1_inspection_stream_phase(phase,'before',inspection_retry) if inspection_retry is not None else None
  c=owned_container(phase+'-before',budget_deadline,before_stream)
  if phase in GUEST_BASELINE_PHASES:set_diagnostic_operation('guest-baseline-running-idle')
  if budget_deadline is not None and time.monotonic()>=budget_deadline:raise TimeoutError()
  assert c['State']['Running'] and not c.get('ExecIDs')
  exec_pin=phase;receipt['unconfirmedExec']=phase;save();result=run([f['tools']['go']['path'],'tool','test2json','-t','-p',PACKAGE,*command,'exec',name,*argv] if phase=='actual-one-systemd-scenario' else ['exec',name,*argv],phase,timeout,docker=phase!='actual-one-systemd-scenario',budget_deadline=budget_deadline,allow_nonzero=allow_nonzero,stream_phase=stream_phase)
  after_stream=pid1_inspection_stream_phase(phase,'after',inspection_retry) if inspection_retry is not None else None
  c=owned_container(phase+'-after',budget_deadline,after_stream)
  if phase in GUEST_BASELINE_PHASES:set_diagnostic_operation('guest-baseline-exec-settlement')
  if budget_deadline is not None and time.monotonic()>=budget_deadline:raise TimeoutError()
  assert not c.get('ExecIDs');exec_pin=None;receipt['unconfirmedExec']=None;save();return result
 pid1_baseline_stream='guest-baseline-pid1'
 def capture_pid1_baseline_diagnostic():
  global DIAGNOSTIC_STAGE,DIAGNOSTIC_OPERATION,DIAGNOSTIC_FAILURE,DIAGNOSTIC_FAILURE_STAGE,DIAGNOSTIC_FAILURE_OPERATION,DIAGNOSTIC_CHILD_EXIT_CODE,DIAGNOSTIC_HOST_FAILURE_OPERATION,DIAGNOSTIC_HOST_FAILURE_ERRNO,DIAGNOSTIC_APT_BUILD_OOM_OBSERVED,DIAGNOSTIC_APT_BUILD_FAILURE_CLASS
  saved=(DIAGNOSTIC_STAGE,DIAGNOSTIC_OPERATION,DIAGNOSTIC_FAILURE,DIAGNOSTIC_FAILURE_STAGE,DIAGNOSTIC_FAILURE_OPERATION,DIAGNOSTIC_CHILD_EXIT_CODE,DIAGNOSTIC_HOST_FAILURE_OPERATION,DIAGNOSTIC_HOST_FAILURE_ERRNO,DIAGNOSTIC_APT_BUILD_OOM_OBSERVED,DIAGNOSTIC_APT_BUILD_FAILURE_CLASS)
  try:
   comm=pid1_comm_diagnostic(out,pid1_baseline_stream)
   state=None
   try:state=pid1_container_state_diagnostic(owned_container('guest-baseline-pid1-after',guest_baseline_deadline))
   except BaseException:pass
   return {'comm':comm,'containerState':state} if comm is not None or state is not None else None
  finally:
   (DIAGNOSTIC_STAGE,DIAGNOSTIC_OPERATION,DIAGNOSTIC_FAILURE,DIAGNOSTIC_FAILURE_STAGE,DIAGNOSTIC_FAILURE_OPERATION,DIAGNOSTIC_CHILD_EXIT_CODE,DIAGNOSTIC_HOST_FAILURE_OPERATION,DIAGNOSTIC_HOST_FAILURE_ERRNO,DIAGNOSTIC_APT_BUILD_OOM_OBSERVED,DIAGNOSTIC_APT_BUILD_FAILURE_CLASS)=saved
 try:
  info=obj(['info','--format','{{json .}}'],'native-info');assert info['OSType']=='linux' and info['Architecture'] in (['aarch64','arm64'] if f['arch']=='arm64' else ['x86_64','amd64'])
  guard.add_docker_root(info['DockerRootDir'],headroom=f['setupHeadroomBytes'])
  baseline={'containers':run(['container','ls','-aq','--no-trunc'],'baseline-containers').splitlines(),'images':run(['image','ls','-aq','--no-trunc'],'baseline-images').splitlines(),'volumes':run(['volume','ls','-q'],'baseline-volumes').splitlines()}
  absent('container',name,'test-absent');absent('container',builder_name,'builder-absent-before');absent('volume',cache,'cache-absent-before')
  assert context not in run(['context','ls','--format','{{.Name}}'],'baseline-contexts').decode().splitlines()
  assert builder not in run(['buildx','ls','--format','{{.Name}}'],'baseline-builders').decode().splitlines()
  assert not run(['image','ls','-q',tag],'image-absent').strip()
  binaries=out/'fixtures';binaries.mkdir(mode=0o700)
  resolved=run(['/bin/sh','-c','command -v go; command -v python3; command -v git'],'resolved-build-tools',docker=False).decode().splitlines()
  assert [str(pathlib.Path(n).resolve(strict=True)) for n in resolved]==[str(pathlib.Path(f['tools'][k]['path']).resolve(strict=True)) for k in ['go','python','git']]
  receipt['actualResolvedBuildTools']=resolved;save()
  run(['/bin/bash',str(root/'deploy/zenithd/acceptance/build.sh')],'build-original-fixtures',900,cwd=root,docker=False,extra={'ZENITH_UPDATE_FIXTURE_OUT':str(binaries)})
  set_diagnostic_operation('validate-build-output')
  bind(f);assert (binaries/'source-sha').read_text().strip()==f['sourceCommit'] and (binaries/'source-working-tree.patch').stat().st_size==0
  expected_build_inventory=''.join(f['goBuildInputs'][n]+'  '+n[3:]+'\n' for n in sorted(f['goBuildInputs']))
  assert (binaries/'source-inputs.sha256').read_text()==expected_build_inventory
  receipt['goBuildInventorySha256']=sha(binaries/'source-inputs.sha256');receipt['binaries']={}
  for n in ['zenithd-1.0.0','zenithd-1.1.0','update-systemd.test']:
   p=binaries/n;s=p.lstat();assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid()
   h=p.read_bytes()[:20];assert h[:4]==b'\x7fELF' and h[4:6]==b'\x02\x01' and int.from_bytes(h[18:20],'little')==(183 if f['arch']=='arm64' else 62)
   receipt['binaries'][n]={'sha256':sha(p),'bytes':s.st_size};run([f['tools']['go']['path'],'version','-m',str(p)],'binary-build-info-'+n,docker=False)
  set_diagnostic_operation('prepare-build-context')
  contextdir=out/'build-context';contextdir.mkdir(mode=0o700);shutil.copyfile(root/'deploy/zenithd/acceptance/Dockerfile',contextdir/'Dockerfile');assert sha(contextdir/'Dockerfile')==sha(root/'deploy/zenithd/acceptance/Dockerfile')
  src=out/'source';src.mkdir(mode=0o700)
  for n in ['deploy/zenithd/acceptance/cgroup-check.sh','deploy/zenithd/zenithd.service']:
   target=src/n;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True);shutil.copyfile(root/n,target);assert sha(target)==sha(root/n)
  mutate(['context','create',context,'--docker','host='+ENDPOINT],'create-owned-context');context_snapshot=obj(['context','inspect',context],'context-identity');assert context_snapshot[0]['Endpoints']['docker']['Host']==ENDPOINT
  mutate(['buildx','create','--name',builder,'--driver','docker-container','--driver-opt','default-load=true,image='+BUILD_IMAGE+',memory=1g','--bootstrap',context],'create-owned-builder',180);builder_snapshot=capture_builder('builder-captured');receipt['builder']=builder_snapshot;save()
  mutate(['buildx','build','--builder',builder,'--progress=plain','--platform','linux/'+f['arch'],'--pull','--no-cache','--build-arg','SYSTEMD_BASE='+base_image,'--label','zenith.mach04.owner='+token,'--load','-t',tag,str(contextdir)],'apt-image-build',600)
  loaded=obj(['image','inspect',tag],'loaded-image')[0];assert loaded['Os']=='linux' and loaded['Architecture']==f['arch'] and loaded['Config']['Labels']['zenith.mach04.owner']==token and loaded['RepoTags']==[tag] and not loaded.get('RepoDigests');image=loaded['Id'];receipt['imageInspectSha256']=hashlib.sha256(json.dumps(loaded,sort_keys=True).encode()).hexdigest();receipt['imageId']=image;save()
  release_builder() # The 1GiB apt-only builder is gone before the 512MiB test.
  result=mutate(['run','-d','--name',name,'--label','zenith.mach04.owner='+token,'--platform','linux/'+f['arch'],'--privileged','--cgroupns','private','--network','none','--memory','512m','--memory-swap','512m','--cpus','2','--pids-limit','512','--log-driver','json-file','--log-opt','max-size=1m','--log-opt','max-file=1','--tmpfs','/run:rw,nosuid,nodev,size=64m','--tmpfs','/run/lock:rw,nosuid,nodev,size=16m','--tmpfs','/tmp:rw,nosuid,nodev,size=64m','--mount','type=bind,source='+str(src)+',target=/src,readonly','--mount','type=bind,source='+str(binaries)+',target=/fixtures,readonly',image],'create-disposable-pid1')
  cid=result.decode().strip();assert re.fullmatch('[a-f0-9]{64}',cid)
  c=obj(['container','inspect',name],'container-created')[0];assert c['Id']==cid and c['Image']==image and c['Name']=='/'+name and c['Config']['Labels']['zenith.mach04.owner']==token
  verify_pid1_container(c)
  container_snapshot={k:c[k] for k in ['Id','Created','Name','Image','Config','HostConfig','Mounts']}
  expected_guest_arch='aarch64' if f['arch']=='arm64' else 'x86_64'
  guest_baseline_deadline=time.monotonic()+60
  def pid1_attempt(argv,remaining,retry):
   nonlocal pid1_baseline_stream
   global DIAGNOSTIC_CHILD_EXIT_CODE
   stream_phase='guest-baseline-pid1' if retry==0 else 'guest-baseline-pid1-retry-%03d'%retry
   if retry>0:DIAGNOSTIC_CHILD_EXIT_CODE=None
   result=execute(argv,'guest-baseline-pid1',timeout=remaining,budget_deadline=guest_baseline_deadline,allow_nonzero=True,stream_phase=stream_phase,inspection_retry=retry)
   pid1_baseline_stream=stream_phase
   return result
  recovered=wait_for_systemd_pid1(pid1_attempt,guest_baseline_deadline,time.monotonic,time.sleep)
  if recovered>1:DIAGNOSTIC_CHILD_EXIT_CODE=None
  execute(['/bin/sh','-ec','test "$(uname -m)" = '+expected_guest_arch],'guest-baseline-architecture',budget_deadline=guest_baseline_deadline)
  execute(['/bin/sh','-ec','test -f /sys/fs/cgroup/cgroup.controllers'],'guest-baseline-cgroup',budget_deadline=guest_baseline_deadline)
  execute(['/bin/sh','-ec','test -z "$(find /etc/systemd/system /var/lib /etc /usr/local/lib -maxdepth 1 -name "zenith-mach04-*" -print)"'],'guest-baseline-no-owned-paths',budget_deadline=guest_baseline_deadline)
  receipt['installedAptPackageVersionsSha256']=hashlib.sha256(execute(['dpkg-query','-W','-f=${binary:Package}=${Version}\n'],'installed-apt-package-versions')).hexdigest();save()
  actual=execute(['env','-i','PATH=/usr/sbin:/usr/bin:/sbin:/bin','HOME=/root','ZENITH_TEST_AGENT_UPDATE_SYSTEMD=1','ZENITH_AGENT_UPDATE_DISPOSABLE_SYSTEMD=1','ZENITH_AGENT_UPDATE_REPO=/src','ZENITH_UPDATE_FIXTURE_OUT=/fixtures','ZENITH_AGENT_UPDATE_ARCH='+f['arch'],'/fixtures/update-systemd.test','-test.run','^TestSystemdSignedUpdateAndRollback$','-test.v','-test.timeout=8m'],'actual-one-systemd-scenario',510)
  events=[json.loads(line) for line in actual.splitlines()];assert [e['Test'] for e in events if e.get('Action')=='run']==[CASE] and [e['Test'] for e in events if e.get('Action')=='pass' and 'Test' in e]==[CASE] and not any(e.get('Action') in ['skip','fail'] for e in events) and events[-1]['Action']=='pass' and 'Test' not in events[-1]
  execute(['/bin/sh','-ec','test -z "$(find /etc/systemd/system /var/lib /etc /usr/local/lib -maxdepth 1 -name "zenith-mach04-*" -print)"; test -z "$(systemctl list-units --all --no-legend "zenith-mach04-*" )"'],'independent-guest-fixture-absence')
  for n,b in receipt['binaries'].items():assert sha(binaries/n)==b['sha256']
  bind(f);receipt['passed']=1;receipt['failed']=receipt['skipped']=0;receipt['status']='passed_pending_cleanup';save()
 except BaseException as e:
  DIAGNOSTIC_FAILURE=classify_failure(e);DIAGNOSTIC_FAILURE_STAGE=DIAGNOSTIC_STAGE;DIAGNOSTIC_FAILURE_OPERATION=DIAGNOSTIC_OPERATION;receipt['failureClass']=type(e).__name__;receipt['status']='failed';save()
  if DIAGNOSTIC_FAILURE_STAGE=='guest-baseline' and DIAGNOSTIC_FAILURE_OPERATION=='guest-baseline-pid1' and DIAGNOSTIC_FAILURE=='subprocess':
   try:DIAGNOSTIC_PID1_BASELINE=capture_pid1_baseline_diagnostic()
   except BaseException:DIAGNOSTIC_PID1_BASELINE=None
 finally:
  set_diagnostic_stage('cleanup');set_diagnostic_operation('cleanup-unknown');set_cleanup_operation('cleanup-reconcile');DIAGNOSTIC_CLEANUP_STATE='in-progress';cleaning=True;guard.cleaning=True
  try:
   reconcile_delivery()
   if container_snapshot:
    set_cleanup_operation('cleanup-stop-pid1')
    c=owned_container('before-stop');assert not c.get('ExecIDs');mutate(['stop','--time','20',name],'stop-owned-pid1',60);assert not owned_container('after-stop')['State']['Running']
    set_cleanup_operation('cleanup-remove-pid1');mutate(['rm',name],'remove-owned-container');absent('container',name,'container-absent-after')
   if builder_snapshot:
    set_cleanup_operation('cleanup-release-builder');release_builder()
   if image:
    set_cleanup_operation('cleanup-remove-image')
    current=obj(['image','inspect',image],'image-before-remove')[0];assert current['Id']==image and current['RepoTags']==[tag] and not current.get('RepoDigests') and image.encode() not in baseline['images'];assert not run(['container','ls','-aq','--filter','ancestor='+image],'image-unused').strip();mutate(['image','rm',image],'remove-exact-owned-image')
   if context_snapshot:
    set_cleanup_operation('cleanup-remove-context')
    assert obj(['context','inspect',context],'context-before-remove')==context_snapshot;mutate(['context','rm',context],'remove-owned-context')
   set_cleanup_operation('cleanup-verify-baseline');receipt['retainedPrerequisiteImageIds']=sorted(n.decode() for n in set(run(['image','ls','-aq','--no-trunc'],'remaining-prerequisite-images').splitlines())-set(baseline['images']))
   assert set(baseline['containers'])<=set(run(['container','ls','-aq','--no-trunc'],'baseline-containers-after').splitlines()) and set(baseline['images'])<=set(run(['image','ls','-aq','--no-trunc'],'baseline-images-after').splitlines()) and set(baseline['volumes'])<=set(run(['volume','ls','-q'],'baseline-volumes-after').splitlines())
   bind(f);set_cleanup_operation('cleanup-close-guard');receipt['hostCustody']=guard.close();assert not guard.violation and guard.minimum>=FLOOR and guard.minimum_docker_root is not None and guard.minimum_docker_root>=FLOOR;receipt['cleanupComplete']=True;DIAGNOSTIC_CLEANUP_STATE='completed';DIAGNOSTIC_CLEANUP_FAILURE_CLASS=None;DIAGNOSTIC_CLEANUP_OPERATION=None
   if receipt['status']=='passed_pending_cleanup':receipt['status']='passed'
  except BaseException as e:
   DIAGNOSTIC_CLEANUP_FAILURE_CLASS=classify_failure(e);DIAGNOSTIC_FAILURE=DIAGNOSTIC_FAILURE or DIAGNOSTIC_CLEANUP_FAILURE_CLASS
   DIAGNOSTIC_FAILURE_STAGE=DIAGNOSTIC_FAILURE_STAGE or 'cleanup';DIAGNOSTIC_FAILURE_OPERATION=DIAGNOSTIC_FAILURE_OPERATION or DIAGNOSTIC_CLEANUP_OPERATION or 'cleanup-unknown'
   DIAGNOSTIC_CLEANUP_STATE='failed';receipt['cleanupFailureClass']=type(e).__name__;receipt['cleanupComplete']=False;receipt['status']='failed'
   if not guard.stop.is_set():
    try:receipt['hostCustody']=guard.close()
    except BaseException:receipt['hostCustodyRefused']=True
  save() # All private setup/binary/log files retained; no host tree deletion.
 terminal={'schemaVersion':1,'attempt':f['attempt'],'arch':f['arch'],'emulated':False,'status':receipt['status'],'cleanupComplete':receipt['cleanupComplete'],'delivery':pin,'execDelivery':exec_pin,'sourceCommit':f['sourceCommit'],'sourceContractSha256':f['sourceContractSha256'],'baseImage':base_image,'builderImage':BUILD_IMAGE,'nativeCases':[CASE],'tools':f['tools'],'binaries':receipt.get('binaries'),'guard':receipt.get('hostCustody'),'rawReportSha256':sha(out/'actual-one-systemd-scenario.stdout.private') if (out/'actual-one-systemd-scenario.stdout.private').is_file() else None}
 write(P/'terminal.record',terminal)
 if receipt['status']=='passed':set_diagnostic_stage('complete');sys.stdout.buffer.write((out/'actual-one-systemd-scenario.stdout.private').read_bytes())
 write_diagnostic()
 return 0 if receipt['status']=='passed' else 1
def main_entry():
 global DIAGNOSTIC_FAILURE,DIAGNOSTIC_FAILURE_STAGE,DIAGNOSTIC_FAILURE_OPERATION,DIAGNOSTIC_CLEANUP_STATE
 try:return main()
 except BaseException as error:
  DIAGNOSTIC_FAILURE=classify_failure(error);DIAGNOSTIC_FAILURE_STAGE=DIAGNOSTIC_STAGE;DIAGNOSTIC_FAILURE_OPERATION=DIAGNOSTIC_OPERATION
  if DIAGNOSTIC_CLEANUP_STATE=='not-started':DIAGNOSTIC_CLEANUP_STATE='failed'
  try:write_diagnostic()
  except BaseException:pass
  return 1
if __name__=='__main__':raise SystemExit(main_entry())
