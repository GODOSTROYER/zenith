#!/usr/bin/env python3
"""Mandatory fresh native SYS1 phase. Outputs are private until owned cleanup succeeds."""
import argparse,hashlib,json,os,pathlib,re,resource,secrets,shutil,signal,stat,subprocess,sys,time
import importlib.util
_guard_spec=importlib.util.spec_from_file_location('guest_pid1_guard',pathlib.Path(__file__).with_name('guest-pid1-owned-guard.py'))
_guard_module=importlib.util.module_from_spec(_guard_spec);_guard_spec.loader.exec_module(_guard_module)
OwnedGuard=_guard_module.OwnedGuard
P=pathlib.Path(__file__).resolve().parent
FLOOR=12_000_000_000
ENDPOINT='unix:///var/run/docker.sock'
CASE='TestSystemdSignedUpdateAndRollback'
PACKAGE='github.com/GODOSTROYER/zenith/go/internal/runner/update'
BASE_IMAGE='ubuntu:24.04@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7'
BUILD_IMAGE='moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea'
DIAGNOSTIC_STAGES={'prepare','bind','disk-admission','docker-admission','fixture-build','buildkit-builder','pid1-container','guest-baseline','guest-prerequisite','actual-systemd-case','guest-postcondition','cleanup','complete','unknown'}
DIAGNOSTIC_FAILURES={'assertion','filesystem','subprocess','timeout','interrupt','json','other'}
DIAGNOSTIC_CLEANUP={'not-started','in-progress','completed','failed'}
DIAGNOSTIC_STAGE='prepare'
DIAGNOSTIC_DIRECTORY=None
DIAGNOSTIC_FAILURE=None
DIAGNOSTIC_FAILURE_STAGE=None
DIAGNOSTIC_OPERATION='prepare'
DIAGNOSTIC_FAILURE_OPERATION=None
DIAGNOSTIC_CLEANUP_STATE='not-started'
DIAGNOSTIC_CLEANUP_FAILURE_CLASS=None
DIAGNOSTIC_CLEANUP_OPERATION=None
DIAGNOSTIC_OPERATIONS={
 'prepare','bind','disk-admission','docker-admission','resolve-build-tools','build-original-fixtures',
 'validate-build-output','binary-build-metadata','prepare-build-context','create-context','verify-context','create-builder',
 'verify-builder','build-apt-image','load-apt-image','release-builder','create-pid1','verify-pid1','guest-baseline',
 'guest-prerequisite','actual-systemd-case','guest-postcondition','cleanup-reconcile','cleanup-stop-pid1',
 'cleanup-remove-pid1','cleanup-release-builder','cleanup-remove-image','cleanup-remove-context',
 'cleanup-verify-baseline','cleanup-close-guard','cleanup-unknown','unknown'
}
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
 'pid1-cgroup-and-clean-baseline':'guest-baseline','installed-apt-package-versions':'guest-prerequisite',
 'actual-one-systemd-scenario':'actual-systemd-case','independent-guest-fixture-absence':'guest-postcondition'
}
RUN_STAGES={
 'native-info':'docker-admission','baseline-containers':'docker-admission','baseline-images':'docker-admission','baseline-volumes':'docker-admission',
 'test-absent':'docker-admission','builder-absent-before':'docker-admission','cache-absent-before':'docker-admission','baseline-contexts':'docker-admission','baseline-builders':'docker-admission','image-absent':'docker-admission',
 'resolved-build-tools':'fixture-build','build-original-fixtures':'fixture-build','binary-build-info-zenithd-1.0.0':'fixture-build','binary-build-info-zenithd-1.1.0':'fixture-build','binary-build-info-update-systemd.test':'fixture-build',
 'create-owned-context':'buildkit-builder','context-identity':'buildkit-builder','create-owned-builder':'buildkit-builder','builder-captured':'buildkit-builder',
 'apt-image-build':'buildkit-builder','loaded-image':'buildkit-builder','release-builder':'buildkit-builder',
 'create-disposable-pid1':'pid1-container','container-created':'pid1-container',
 'pid1-cgroup-and-clean-baseline':'guest-baseline','installed-apt-package-versions':'guest-prerequisite','actual-one-systemd-scenario':'actual-systemd-case',
 'independent-guest-fixture-absence':'guest-postcondition'
}
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
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
def initialize_diagnostic(root,attempt):
 global DIAGNOSTIC_DIRECTORY
 if not re.fullmatch('[a-f0-9]{32}',attempt) or root.resolve()!=root:raise RuntimeError('diagnostic_scope')
 base=root/'.data-ci-guest';directory=base/('attempt-'+attempt)
 for path in (base,directory):
  st=path.lstat()
  assert stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700
 DIAGNOSTIC_DIRECTORY=directory
def write_diagnostic():
 if DIAGNOSTIC_DIRECTORY is None:return
 failure_stage=DIAGNOSTIC_FAILURE_STAGE or (DIAGNOSTIC_STAGE if DIAGNOSTIC_FAILURE is not None else 'complete')
 row={'schemaVersion':2,'failureStage':failure_stage,'failureClass':DIAGNOSTIC_FAILURE,'failureOperation':DIAGNOSTIC_FAILURE_OPERATION,'cleanupState':DIAGNOSTIC_CLEANUP_STATE,'cleanupFailureClass':DIAGNOSTIC_CLEANUP_FAILURE_CLASS,'cleanupOperation':DIAGNOSTIC_CLEANUP_OPERATION}
 assert row['failureStage'] in DIAGNOSTIC_STAGES and (row['failureClass'] is None or row['failureClass'] in DIAGNOSTIC_FAILURES) and row['cleanupState'] in DIAGNOSTIC_CLEANUP
 assert (row['failureClass'] is None) == (row['failureStage']=='complete' and row['failureOperation'] is None and row['cleanupState']=='completed')
 assert row['failureClass'] is None or row['failureOperation'] in DIAGNOSTIC_OPERATIONS
 assert (row['cleanupFailureClass'] is None) == (row['cleanupOperation'] is None)
 assert row['cleanupFailureClass'] is None or row['cleanupFailureClass'] in DIAGNOSTIC_FAILURES and row['cleanupOperation'] in DIAGNOSTIC_OPERATIONS and row['cleanupState']=='failed'
 target=DIAGNOSTIC_DIRECTORY/'pid1-diagnostic.private.json';tmp=DIAGNOSTIC_DIRECTORY/('.pid1-diagnostic-'+secrets.token_hex(8)+'.tmp')
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
 try:
  with os.fdopen(fd,'wb',closefd=False) as out:out.write((json.dumps(row,separators=(',',':'))+'\n').encode());out.flush();os.fsync(fd)
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
 global P,DIAGNOSTIC_FAILURE,DIAGNOSTIC_FAILURE_STAGE,DIAGNOSTIC_FAILURE_OPERATION,DIAGNOSTIC_CLEANUP_FAILURE_CLASS,DIAGNOSTIC_CLEANUP_STATE,DIAGNOSTIC_CLEANUP_OPERATION
 assert __debug__
 a=argparse.ArgumentParser();a.add_argument('--root',required=True);a.add_argument('--attempt',required=True);a.add_argument('--arch',required=True);args=a.parse_args()
 os.umask(0o077);root=pathlib.Path(args.root).resolve(strict=True);initialize_diagnostic(root,args.attempt);set_diagnostic_stage('prepare');set_diagnostic_operation('prepare')
 P,f=prepare(root,args.attempt,args.arch);set_diagnostic_stage('bind');set_diagnostic_operation('bind');root=bind(f)
 assert not pathlib.Path('/c/Users/user/.local/sdk/node22').exists()
 set_diagnostic_stage('disk-admission');set_diagnostic_operation('disk-admission')
 assert shutil.disk_usage(P).free>=FLOOR+f['setupHeadroomBytes']
 os.umask(0o077);token=secrets.token_hex(6);out=P/'runtime';out.mkdir(mode=0o700)
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
 def run(argv,phase,timeout=60,cwd=None,docker=True,extra=None):
  if cleaning:set_diagnostic_stage('cleanup')
  else:
   if phase in RUN_STAGES:set_diagnostic_stage(RUN_STAGES[phase])
   set_diagnostic_operation(operation_for_phase(phase))
  guard.check(cleanup=cleaning,bootstrap=phase=='native-info')
  childenv={**env,**(extra or {})}
  def limits():resource.setrlimit(resource.RLIMIT_FSIZE,(32*1024**2,32*1024**2))
  with (out/(phase+'.stdout.private')).open('xb') as stdout,(out/(phase+'.stderr.private')).open('xb') as stderr:
   child=guard.register(subprocess.Popen((command+argv) if docker else argv,cwd=cwd,env=childenv,stdout=stdout,stderr=stderr,start_new_session=True,preexec_fn=limits));deadline=time.monotonic()+timeout
   try:
    while child.poll() is None:
     guard.check(cleanup=cleaning,bootstrap=phase=='native-info')
     if time.monotonic()>=deadline:raise TimeoutError()
     assert sum(p.stat().st_size for p in out.rglob('*') if p.is_file() and not p.is_symlink())<=f['attemptByteCap'];time.sleep(.25)
   finally:guard.drain(child)
  receipt['phases'].append({'phase':phase,'exitCode':child.returncode});save()
  if phase=='apt-image-build':receipt['aptBuildOOMObserved']=bool(re.search(rb'(?i)out of memory|oomkilled', (out/(phase+'.stderr.private')).read_bytes()));save()
  if child.returncode!=0:raise subprocess.CalledProcessError(child.returncode,'owned-child')
  return (out/(phase+'.stdout.private')).read_bytes()
 def mutate(argv,phase,timeout=60):
  nonlocal pin
  if cleaning:set_diagnostic_stage('cleanup')
  else:
   if phase in RUN_STAGES:set_diagnostic_stage(RUN_STAGES[phase])
   set_diagnostic_operation(operation_for_phase(phase))
  assert pin is None and exec_pin is None;pin=phase;receipt['unconfirmedDelivery']=phase;save();result=run(argv,phase,timeout);pin=None;receipt['unconfirmedDelivery']=None;save();return result
 def obj(argv,phase):return json.loads(run(argv,phase))
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
 def owned_container(phase):
  c=obj(['container','inspect',name],phase)[0]
  assert {k:c[k] for k in ['Id','Created','Name','Image','Config','HostConfig','Mounts']}==container_snapshot
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
 def execute(argv,phase,timeout=60):
  nonlocal exec_pin
  if cleaning:set_diagnostic_stage('cleanup')
  else:
   if phase in RUN_STAGES:set_diagnostic_stage(RUN_STAGES[phase])
   set_diagnostic_operation(operation_for_phase(phase))
  assert pin is None and exec_pin is None;c=owned_container(phase+'-before');assert c['State']['Running'] and not c.get('ExecIDs')
  exec_pin=phase;receipt['unconfirmedExec']=phase;save();result=run([f['tools']['go']['path'],'tool','test2json','-t','-p',PACKAGE,*command,'exec',name,*argv] if phase=='actual-one-systemd-scenario' else ['exec',name,*argv],phase,timeout,docker=phase!='actual-one-systemd-scenario')
  assert not owned_container(phase+'-after').get('ExecIDs');exec_pin=None;receipt['unconfirmedExec']=None;save();return result
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
  mutate(['buildx','build','--builder',builder,'--platform','linux/'+f['arch'],'--pull','--no-cache','--build-arg','SYSTEMD_BASE='+BASE_IMAGE,'--label','zenith.mach04.owner='+token,'--load','-t',tag,str(contextdir)],'apt-image-build',600)
  loaded=obj(['image','inspect',tag],'loaded-image')[0];assert loaded['Os']=='linux' and loaded['Architecture']==f['arch'] and loaded['Config']['Labels']['zenith.mach04.owner']==token and loaded['RepoTags']==[tag] and not loaded.get('RepoDigests');image=loaded['Id'];receipt['imageInspectSha256']=hashlib.sha256(json.dumps(loaded,sort_keys=True).encode()).hexdigest();receipt['imageId']=image;save()
  release_builder() # The 1GiB apt-only builder is gone before the 512MiB test.
  result=mutate(['run','-d','--name',name,'--label','zenith.mach04.owner='+token,'--platform','linux/'+f['arch'],'--privileged','--cgroupns','private','--network','none','--memory','512m','--memory-swap','512m','--cpus','2','--pids-limit','512','--log-driver','json-file','--log-opt','max-size=1m','--log-opt','max-file=1','--tmpfs','/run:rw,nosuid,nodev,size=64m','--tmpfs','/run/lock:rw,nosuid,nodev,size=16m','--tmpfs','/tmp:rw,nosuid,nodev,size=64m','--mount','type=bind,source='+str(src)+',target=/src,readonly','--mount','type=bind,source='+str(binaries)+',target=/fixtures,readonly',image],'create-disposable-pid1')
  cid=result.decode().strip();assert re.fullmatch('[a-f0-9]{64}',cid)
  c=obj(['container','inspect',name],'container-created')[0];assert c['Id']==cid and c['Image']==image and c['Name']=='/'+name and c['Config']['Labels']['zenith.mach04.owner']==token
  verify_pid1_container(c)
  container_snapshot={k:c[k] for k in ['Id','Created','Name','Image','Config','HostConfig','Mounts']}
  execute(['/bin/sh','-ec','test "$(cat /proc/1/comm)" = systemd; test "$(uname -m)" = '+('aarch64' if f['arch']=='arm64' else 'x86_64')+'; test -f /sys/fs/cgroup/cgroup.controllers; test -z "$(find /etc/systemd/system /var/lib /etc /usr/local/lib -maxdepth 1 -name "zenith-mach04-*" -print)"'],'pid1-cgroup-and-clean-baseline')
  receipt['installedAptPackageVersionsSha256']=hashlib.sha256(execute(['dpkg-query','-W','-f=${binary:Package}=${Version}\n'],'installed-apt-package-versions')).hexdigest();save()
  actual=execute(['env','-i','PATH=/usr/sbin:/usr/bin:/sbin:/bin','HOME=/root','ZENITH_TEST_AGENT_UPDATE_SYSTEMD=1','ZENITH_AGENT_UPDATE_DISPOSABLE_SYSTEMD=1','ZENITH_AGENT_UPDATE_REPO=/src','ZENITH_UPDATE_FIXTURE_OUT=/fixtures','ZENITH_AGENT_UPDATE_ARCH='+f['arch'],'/fixtures/update-systemd.test','-test.run','^TestSystemdSignedUpdateAndRollback$','-test.v','-test.timeout=8m'],'actual-one-systemd-scenario',510)
  events=[json.loads(line) for line in actual.splitlines()];assert [e['Test'] for e in events if e.get('Action')=='run']==[CASE] and [e['Test'] for e in events if e.get('Action')=='pass' and 'Test' in e]==[CASE] and not any(e.get('Action') in ['skip','fail'] for e in events) and events[-1]['Action']=='pass' and 'Test' not in events[-1]
  execute(['/bin/sh','-ec','test -z "$(find /etc/systemd/system /var/lib /etc /usr/local/lib -maxdepth 1 -name "zenith-mach04-*" -print)"; test -z "$(systemctl list-units --all --no-legend "zenith-mach04-*" )"'],'independent-guest-fixture-absence')
  for n,b in receipt['binaries'].items():assert sha(binaries/n)==b['sha256']
  bind(f);receipt['passed']=1;receipt['failed']=receipt['skipped']=0;receipt['status']='passed_pending_cleanup';save()
 except BaseException as e:DIAGNOSTIC_FAILURE=classify_failure(e);DIAGNOSTIC_FAILURE_STAGE=DIAGNOSTIC_STAGE;DIAGNOSTIC_FAILURE_OPERATION=DIAGNOSTIC_OPERATION;receipt['failureClass']=type(e).__name__;receipt['status']='failed';save()
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
 terminal={'schemaVersion':1,'attempt':f['attempt'],'arch':f['arch'],'emulated':False,'status':receipt['status'],'cleanupComplete':receipt['cleanupComplete'],'delivery':pin,'execDelivery':exec_pin,'sourceCommit':f['sourceCommit'],'sourceContractSha256':f['sourceContractSha256'],'baseImage':BASE_IMAGE,'builderImage':BUILD_IMAGE,'nativeCases':[CASE],'tools':f['tools'],'binaries':receipt.get('binaries'),'guard':receipt.get('hostCustody'),'rawReportSha256':sha(out/'actual-one-systemd-scenario.stdout.private') if (out/'actual-one-systemd-scenario.stdout.private').is_file() else None}
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
