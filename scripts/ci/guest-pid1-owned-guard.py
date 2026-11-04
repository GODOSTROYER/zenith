import pathlib,json,os,subprocess,signal,threading,time,shutil,stat,hashlib
def disk_sample(path):
 p=pathlib.Path(path);assert p.is_absolute(),'docker_root_not_absolute';resolved=p.resolve(strict=True)
 fd=os.open(resolved,getattr(os,'O_PATH',os.O_RDONLY)|getattr(os,'O_CLOEXEC',0))
 try:
  s=os.fstat(fd);assert stat.S_ISDIR(s.st_mode),'disk_path_not_directory';v=os.fstatvfs(fd)
  info=pathlib.Path('/proc/self/fdinfo',str(fd)).read_text();mount=next(line.split(':',1)[1].strip() for line in info.splitlines() if line.startswith('mnt_id:'))
  ident={'device':s.st_dev,'inode':s.st_ino,'uid':s.st_uid,'gid':s.st_gid,'modeType':stat.S_IFMT(s.st_mode),'mountId':int(mount),'fsid':str(int(v.f_fsid)),'blockSize':v.f_bsize,'fragmentSize':v.f_frsize,'flags':v.f_flag}
  return {'reportedPath':str(p),'resolvedPath':str(resolved),'identity':ident,'capacityBytes':v.f_blocks*v.f_frsize,'freeBytes':v.f_bavail*v.f_frsize}
 finally:os.close(fd)
class OwnedGuard:
 def __init__(self,folder,floor=12_000_000_000,socket_path=None,expected_socket=None,source_contract=None,socket_owner=None,journal="owned-guard.private.json"):
  self.source_contract=pathlib.Path(source_contract);self.folder=pathlib.Path(folder);self.journal=journal;assert not (self.folder/journal).exists();self.floor=floor;self.disk_custody={'attempt':disk_sample(self.folder),'dockerRoot':None};self.disk_custody['attempt']['minimumFreeBytes']=self.disk_custody['attempt'].pop('freeBytes');self.disk_failure=None;self.minimum=self.disk_custody['attempt']['minimumFreeBytes'];self.minimum_docker_root=None;self.children=[];self.owned={};self.lock=threading.RLock();self.violation=self.minimum<self.floor;self.cleaning=False;self.stop=threading.Event();self.socket_path=pathlib.Path(socket_path) if socket_path else None;self.socket_identity=None
  if self.socket_path:
   resolved=self.socket_path.resolve(strict=True);st=resolved.lstat();assert stat.S_ISSOCK(st.st_mode) and st.st_uid==(os.getuid() if socket_owner is None else socket_owner)
   raw=self.socket_path.lstat();self.socket_identity={'resolved':str(resolved),'target':[st.st_uid,st.st_dev,st.st_ino,stat.S_IFMT(st.st_mode)],'alias':[raw.st_uid,raw.st_dev,raw.st_ino,stat.S_IFMT(raw.st_mode)],'link':os.readlink(self.socket_path) if self.socket_path.is_symlink() else None}
  if expected_socket is not None:assert self.socket_identity==expected_socket,'Docker socket changed after admission'
  self.sourceStartMatched=self.source_matches()
  self.thread=threading.Thread(target=self.monitor,daemon=True);self.thread.start()
 def add_docker_root(self,path,headroom=0):
  with self.lock:
   assert self.disk_custody['dockerRoot'] is None
   try:row=disk_sample(path)
   except BaseException as e:
    self.disk_failure='docker_root_unavailable';self.violation=True
    raise RuntimeError(self.disk_failure) from e
   row['minimumFreeBytes']=row.pop('freeBytes');self.disk_custody['dockerRoot']=row;self.minimum_docker_root=row['minimumFreeBytes']
   self.update_disks()
   assert self.disk_custody['attempt']['minimumFreeBytes']>=self.floor+headroom and row['minimumFreeBytes']>=self.floor+headroom,'disk_floor_setup_headroom'
 def update_disks(self):
  for name in ('attempt','dockerRoot'):
   previous=self.disk_custody[name]
   if previous is None:
    if name=='dockerRoot':continue
    raise RuntimeError('disk_path_unavailable')
   current=disk_sample(previous['reportedPath'])
   if current['resolvedPath']!=previous['resolvedPath'] or current['identity']!=previous['identity']:
    self.disk_failure='filesystem_identity_changed';raise RuntimeError(self.disk_failure)
   previous['capacityBytes']=current['capacityBytes'];previous['minimumFreeBytes']=min(previous['minimumFreeBytes'],current['freeBytes'])
   if name=='attempt':self.minimum=previous['minimumFreeBytes']
   else:self.minimum_docker_root=previous['minimumFreeBytes']
   if current['freeBytes']<self.floor:self.violation=True
 def source_matches(self):
  try:
   c=json.loads((self.source_contract).read_text());root=pathlib.Path(c['root'])
   assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True,timeout=5).strip()==c['sourceCommit']
   assert not subprocess.check_output(['git','diff','--name-only','HEAD'],cwd=root,timeout=5).strip()
   for row in c['sourceInputs']:assert hashlib.sha256((root/row['file']).read_bytes()).hexdigest()==row['sha256']
   return True
  except BaseException:return False
 def processes(self):
  # Linux proc start ticks are finer and unambiguous across PID reuse; ps lstart
  # has only second precision and could authorize a recycled process-group ID.
  rows={}
  for entry in pathlib.Path('/proc').iterdir():
   if not entry.name.isdigit():continue
   pid=int(entry.name)
   try:
    raw=(entry/'stat').read_text();end=raw.rfind(')');fields=raw[end+2:].split()
    status=(entry/'status').read_text();uidline=next(line for line in status.splitlines() if line.startswith('Uid:')).split()
    rows[pid]={'pid':pid,'ppid':int(fields[1]),'pgid':int(fields[2]),'session':int(fields[3]),'startTicks':int(fields[19]),'uid':int(uidline[2])}
   except (FileNotFoundError,ProcessLookupError,PermissionError,StopIteration,ValueError,IndexError):
    # Processes may disappear while the snapshot is being collected.
    continue
  return rows
 def observe(self):
  with self.lock:
   rows=self.processes();roots={pid:old['rootPid'] for pid,old in self.owned.items() if pid in rows and rows[pid]['startTicks']==old['startTicks'] and rows[pid]['uid']==old['uid']}
   for child in self.children:
    if child.poll() is None and child.pid in rows:roots.setdefault(child.pid,child.pid)
   for _ in range(20):
    added={pid:roots[row['ppid']] for pid,row in rows.items() if row['ppid'] in roots and pid not in roots}
    if not added:break
    roots.update(added)
   for pid,root in roots.items():
    row=rows[pid];assert row['uid']==os.getuid()
    if pid not in self.owned:self.owned[pid]={**row,'observedPgids':[],'rootPid':root}
    assert self.owned[pid]['startTicks']==row['startTicks'] and self.owned[pid]['uid']==row['uid'] and self.owned[pid]['rootPid']==root
    if row['pgid'] not in self.owned[pid]['observedPgids']:self.owned[pid]['observedPgids'].append(row['pgid'])
 def register(self,child):
  with self.lock:self.children.append(child)
  self.observe();return child
 def check_socket(self):
  if not self.socket_path:return
  expected=self.socket_identity;resolved=self.socket_path.resolve(strict=True);s=resolved.lstat();raw=self.socket_path.lstat()
  assert str(resolved)==expected['resolved'] and [s.st_uid,s.st_dev,s.st_ino,stat.S_IFMT(s.st_mode)]==expected['target'] and [raw.st_uid,raw.st_dev,raw.st_ino,stat.S_IFMT(raw.st_mode)]==expected['alias'] and (os.readlink(self.socket_path) if self.socket_path.is_symlink() else None)==expected['link']
 def check(self,cleanup=False,bootstrap=False):
  try:self.update_disks()
  except BaseException as e:
   self.disk_failure=self.disk_failure or type(e).__name__;self.violation=True
   if not cleanup:raise
  self.check_socket()
  if not cleanup:assert self.sourceStartMatched and not self.violation and self.minimum>=self.floor and (bootstrap or self.minimum_docker_root is not None and self.minimum_docker_root>=self.floor)
 def monitor(self):
  while not self.stop.wait(.25):
   try:
    self.update_disks()
    self.observe()
   except BaseException as e:self.disk_failure=self.disk_failure or type(e).__name__;self.violation=True
 def members(self,pgid):return [row for row in self.processes().values() if row['pgid']==pgid]
 def absent(self,pgid):return not self.members(pgid)
 def signal(self,pgid,signum):
  self.observe();rows=self.processes();members=[row for row in rows.values() if row['pgid']==pgid]
  if not members:return
  assert all(row['pid'] in self.owned and self.owned[row['pid']]['startTicks']==row['startTicks'] and self.owned[row['pid']]['uid']==row['uid']==os.getuid() and self.owned[row['pid']]['session']==row['session'] and pgid in self.owned[row['pid']]['observedPgids'] for row in members),'ambiguous_process_group_retained'
  # Signal each checked identity through pidfd. Never signal a numeric pgid: a
  # concurrently recycled PID/PGID must not redirect cleanup to an outsider.
  for row in members:
   if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):raise RuntimeError('pidfd_required')
   fd=os.pidfd_open(row['pid'])
   try:
    again=self.processes().get(row['pid']);assert again==row and self.owned[row['pid']]['startTicks']==row['startTicks']
    signal.pidfd_send_signal(fd,signum)
   finally:os.close(fd)
 def groups(self,root=None):
  return {pgid for row in self.owned.values() if root is None or row['rootPid']==root for pgid in row['observedPgids']}
 def drain_groups(self,groups):
  for pgid in groups:
   if self.absent(pgid):continue
   self.signal(pgid,signal.SIGTERM);deadline=time.monotonic()+10
   while not self.absent(pgid) and time.monotonic()<deadline:time.sleep(.1)
   if not self.absent(pgid):
    self.signal(pgid,signal.SIGKILL);deadline=time.monotonic()+10
    while not self.absent(pgid) and time.monotonic()<deadline:time.sleep(.1)
   assert self.absent(pgid),'owned descendant group retained'
 def drain(self,child):
  if child.poll() is None:
   self.signal(child.pid,signal.SIGTERM)
   try:child.communicate(timeout=10)
   except subprocess.TimeoutExpired:
    if child.poll() is None:self.signal(child.pid,signal.SIGKILL)
    child.communicate(timeout=10)
  self.observe();self.drain_groups(self.groups(child.pid))
  assert child.poll() is not None and self.absent(child.pid)
 def close(self):
  failure=None
  try:
   for child in self.children:self.drain(child)
   self.observe();self.drain_groups(self.groups())
  except BaseException as e:failure=type(e).__name__
  self.stop.set();self.thread.join(timeout=6)
  try:self.observe();self.update_disks()
  except BaseException as e:failure=type(e).__name__;self.disk_failure=self.disk_failure or type(e).__name__
  source_end=self.source_matches();groups=self.groups();absent=all(self.absent(pgid) for pgid in groups)
  disk_floor_bad=self.disk_failure is not None or self.minimum<self.floor or self.minimum_docker_root is None or self.minimum_docker_root<self.floor
  out={'minimumFreeBytes':self.minimum,'dockerRootMinimumFreeBytes':self.minimum_docker_root,'diskCustody':self.disk_custody,'diskFailure':self.disk_failure,'floorViolation':self.violation or disk_floor_bad,'ownedProcesses':list(self.owned.values()),'observedOwnedGroups':sorted(groups),'socketCustody':self.socket_identity,'allRegisteredGroupsAbsent':all(c.poll() is not None and self.absent(c.pid) for c in self.children),'allObservedOwnedGroupsAbsent':absent,'cleanupFailure':failure,'cleanupMode':self.cleaning,'sourceStartMatched':self.sourceStartMatched,'sourceEndMatched':source_end}
  p=self.folder/self.journal
  with p.open('x') as f:f.write(json.dumps(out,indent=2)+'\n')
  p.chmod(0o600)
  assert not self.thread.is_alive() and failure is None and absent and out['allRegisteredGroupsAbsent']
  assert self.cleaning or (not out['floorViolation'] and self.sourceStartMatched and source_end),'sticky disk floor/source refusal'
  return out
