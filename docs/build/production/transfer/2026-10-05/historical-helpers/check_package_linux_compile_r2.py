import json,hashlib,os,pathlib,subprocess,datetime
R=pathlib.Path('/Users/saivedanthava/.codex/zenith-production');W=R/'worktrees/guest-package-native-status-20261005';F=R/'logs/guest-package-native-compatibility-20261005/revision6/FROZEN-SOURCE-CORRECTED.json';D=R/'logs/guest-package-linux-compile-root-r2-20261005';assert not D.exists();D.mkdir(mode=0o700)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();assert sha(F)=='8ecf6ecd4c26162739b2ae374869c42c58bf70a5f5cf9e6945893ddf43951af6';f=json.loads(F.read_text());I=F.parent/'FULL-AFTER-INVENTORY.json';assert sha(I)==f['fullAfterInventory']['sha256'];inv=json.loads(I.read_text());names=[n for n in inv if n.startswith('go/')]
def exact():
 for n in names:assert (W/n).is_file() and not (W/n).is_symlink() and sha(W/n)==inv[n]['sha256'],n
exact();env={k:v for k,v in os.environ.items() if k in ['HOME','PATH','TMPDIR','LANG']};env.update({'PATH':'/Users/saivedanthava/.codex/zenith-w8/tools/go/bin:/usr/bin:/bin:/usr/sbin:/sbin','GOTOOLCHAIN':'local','GOMAXPROCS':'2','GOMEMLIMIT':'1200MiB','GOOS':'linux','GOARCH':'arm64','CGO_ENABLED':'0','GOPROXY':'off','GOSUMDB':'off'})
j={'status':'failed_or_incomplete','recordedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Actual root Darwin-host Go cross-compilation/typecheck for Linux ARM64 only; no test binary executed, no native/installed/default acceptance','candidateTree':f['candidateTree'],'freezeSha256':sha(F),'steps':[]}
def save():(D/'receipt.json').write_text(json.dumps(j,indent=2)+'\n')
save()
try:
 for name,argv in [('version',['go','version']),('format',['gofmt','-l','internal/machine/package_helper_linux.go','internal/machine/package_helper_linux_test.go']),('linux-vet',['go','vet','-p=1','./internal/machine']),('linux-test-compile',['go','test','-c','-p=1','-o',str(D/'machine-linux-arm64.test'),'./internal/machine']),('binary-type',['file',str(D/'machine-linux-arm64.test')])]:
  with (D/(name+'.stdout')).open('xb') as o,(D/(name+'.stderr')).open('xb') as e:p=subprocess.run(argv,cwd=W/'go',env=env,stdout=o,stderr=e,timeout=600)
  j['steps'].append({'id':name,'argv':argv,'exitCode':p.returncode});save();assert p.returncode==0,name
  if name=='format':assert (D/(name+'.stdout')).stat().st_size==0
 exact();j.update(status='passed_compile_only',sourceUnchanged=True,binarySha256=sha(D/'machine-linux-arm64.test'),testsExecuted=0);save();print(json.dumps(j))
except BaseException as e:j['errorType']=type(e).__name__;save();raise
