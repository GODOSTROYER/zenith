//go:build linux

package ops

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"syscall"
)

func fileWritePlatform() bool { return true }

// Each exact operator-configured parent is an independent mount anchor.
// A transition is allowed only AT that final trusted directory, never in its
// ancestors or below it. No caller selects a mount root or creates a parent.
// Mode bits alone do not bound a named-user ACL (especially 0640). Reject
// access/default ACLs rather than silently widening the local profile.
func writeNoACL(fd int) bool {
	for _, name := range []string{"system.posix_acl_access", "system.posix_acl_default"} {
		n, err := syscall.Getxattr(fmt.Sprintf("/proc/self/fd/%d", fd), name, nil)
		if err != nil && err != syscall.ENODATA && err != syscall.EOPNOTSUPP {
			return false
		}
		if n > 0 {
			return false
		}
	}
	return true
}
func writeMount(fd int) (string, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/self/fdinfo/%d", fd))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "mnt_id:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "mnt_id:")), nil
		}
	}
	return "", syscall.EPERM
}

// The opt-in is for persistent local Linux filesystems with file/directory
// fsync semantics; volatile, network, FUSE and overlay stores are refused.
func writePersistentFS(fd int) bool {
	var st syscall.Statfs_t
	if syscall.Fstatfs(fd, &st) != nil {
		return false
	}
	switch uint64(uint32(st.Type)) {
	case 0xef53, 0x58465342, 0x9123683e:
		return true
	}
	return false
}
func writeDir(p string, private bool) (*os.File, error) {
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "directory")
	mount, err := writeMount(fd)
	if err != nil {
		f.Close()
		return nil, err
	}
	var base syscall.Stat_t
	if syscall.Fstat(fd, &base) != nil || base.Uid != 0 || base.Mode&07022 != 0 || !writeNoACL(fd) {
		f.Close()
		return nil, syscall.EPERM
	}
	components := strings.Split(strings.TrimPrefix(p, "/"), "/")
	for index, c := range components {
		if c == "" {
			continue
		}
		next, err := syscall.Openat(int(f.Fd()), c, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			f.Close()
			return nil, err
		}
		f.Close()
		f = os.NewFile(uintptr(next), "directory")
		currentMount, me := writeMount(next)
		var st syscall.Stat_t
		if me != nil || (index != len(components)-1 && currentMount != mount) || syscall.Fstat(next, &st) != nil || (index != len(components)-1 && st.Dev != base.Dev) || st.Mode&07022 != 0 || !writeNoACL(next) || (st.Uid != 0 && st.Uid != uint32(os.Geteuid())) {
			f.Close()
			return nil, syscall.EPERM
		}
	}
	var st syscall.Stat_t
	if syscall.Fstat(int(f.Fd()), &st) != nil || !writePersistentFS(int(f.Fd())) || st.Uid != uint32(os.Geteuid()) || (private && st.Mode&07777 != 0700) {
		f.Close()
		return nil, syscall.EPERM
	}
	return f, nil
}
func writeStat(f *os.File) (syscall.Stat_t, error) {
	var s syscall.Stat_t
	err := syscall.Fstat(int(f.Fd()), &s)
	return s, err
}
func writeSame(a, b syscall.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Size == b.Size && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid && a.Nlink == b.Nlink && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func writeDirSame(p string, f *os.File, private bool) bool {
	g, err := writeDir(p, private)
	if err != nil {
		return false
	}
	defer g.Close()
	a, ea := writeStat(f)
	b, eb := writeStat(g)
	am, ae := writeMount(int(f.Fd()))
	bm, be := writeMount(int(g.Fd()))
	return ae == nil && be == nil && am == bm && ea == nil && eb == nil && a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid
}
func writeOpen(dir *os.File, name string) (*os.File, error) {
	fd, err := syscall.Openat(int(dir.Fd()), name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), "local-file"), nil
}
func writeRead(dir *os.File, name string, max int64, template bool) ([]byte, syscall.Stat_t, error) {
	f, err := writeOpen(dir, name)
	if err != nil {
		return nil, syscall.Stat_t{}, err
	}
	defer f.Close()
	st, err := writeStat(f)
	ds, de := writeStat(dir)
	fm, fe := writeMount(int(f.Fd()))
	dm, dem := writeMount(int(dir.Fd()))
	uid := uint32(os.Geteuid())
	if err != nil || de != nil || fe != nil || dem != nil || fm != dm || st.Dev != ds.Dev || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Nlink != 1 || st.Size < 0 || st.Size > max || (st.Uid != uid && !(template && st.Uid == 0)) || st.Mode&07137 != 0 || !writeNoACL(int(f.Fd())) {
		return nil, st, syscall.EPERM
	}
	// Templates may be 0400/0440/0600/0640; targets may be 0600/0640 only.
	perm := st.Mode & 07777
	if perm != 0400 && perm != 0440 && perm != 0600 && perm != 0640 {
		return nil, st, syscall.EPERM
	}
	if !template && perm != 0600 && perm != 0640 {
		return nil, st, syscall.EPERM
	}
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	after, ae := writeStat(f)
	if err != nil || ae != nil || int64(len(b)) != st.Size || !writeSame(st, after) {
		return nil, st, syscall.EPERM
	}
	return b, st, nil
}
func writeSHA(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
func writeOpaque() (string, error) {
	b := make([]byte, 16)
	_, err := rand.Read(b)
	return "fw_" + hex.EncodeToString(b), err
}
func writeExclusive(dir *os.File, name string, b []byte, mode uint32, beforeSync func() error) (*os.File, error) {
	fd, err := syscall.Openat(int(dir.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "private-file")
	fs, fe := writeStat(f)
	ds, de := writeStat(dir)
	fm, me := writeMount(fd)
	dm, dme := writeMount(int(dir.Fd()))
	if fe != nil || de != nil || me != nil || dme != nil || fm != dm || fs.Dev != ds.Dev || fs.Nlink != 1 || fs.Uid != uint32(os.Geteuid()) || !writeNoACL(fd) {
		f.Close()
		return f, syscall.EPERM
	}
	n, err := f.Write(b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = f.Chmod(os.FileMode(mode))
	}
	if err == nil && beforeSync != nil {
		err = beforeSync()
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		f.Close()
		return f, err
	}
	return f, nil
}
func writeBudget(dir *os.File, c FileWriteConfig, additional int64, entries int) bool {
	// ReadDir uses a duplicated independent file description on the pinned fd.
	scanFD, err := syscall.Openat(int(dir.Fd()), ".", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	scan := os.NewFile(uintptr(scanFD), "private-backups")
	defer scan.Close()
	names, err := scan.Readdirnames(c.MaxBackups*2 + 1)
	if err != nil && err != io.EOF {
		return false
	}
	if len(names)+entries > c.MaxBackups*2 {
		return false
	}
	records := 0
	total := additional
	if total > c.MaxBackupBytes {
		return false
	}
	for _, name := range names {
		if !strings.HasPrefix(name, "fw_") || (!strings.HasSuffix(name, ".json") && !strings.HasSuffix(name, ".data")) {
			return false
		}
		f, err := writeOpen(dir, name)
		if err != nil {
			return false
		}
		st, err := writeStat(f)
		fm, fe := writeMount(int(f.Fd()))
		dm, de := writeMount(int(dir.Fd()))
		f.Close()
		if err != nil || fe != nil || de != nil || fm != dm || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Mode&07777 != 0600 || st.Uid != uint32(os.Geteuid()) || st.Nlink != 1 || st.Size < 0 {
			return false
		}
		if strings.HasSuffix(name, ".json") {
			records++
		}
		if st.Size > c.MaxBackupBytes-total {
			return false
		}
		total += st.Size
	}
	return total <= c.MaxBackupBytes && records+1 <= c.MaxBackups
}
func writeFault(e *Env, stage string) error {
	if e.fileWriteFault != nil {
		return e.fileWriteFault(stage)
	}
	return nil
}

func runFileWrite(ctx context.Context, e *Env, a fileWriteArgs, p FileWriteProfile) (Result, error) {
	return runFileMutation(ctx, e, a, p, fileWritePurpose)
}

func runFileMutation(ctx context.Context, e *Env, a fileWriteArgs, p FileWriteProfile, purpose fileMutationPurpose) (Result, error) {
	fileWriteMu.Lock()
	defer fileWriteMu.Unlock()
	cfg, enabled := mutationConfig(e, purpose)
	phase := "guard"
	effect := "none"
	backup := ""
	transaction := ""
	fail := func() (Result, error) {
		r := mutationFailure(purpose, phase, effect, backup)
		if transaction != "" {
			r.Data["transactionRef"] = transaction
		}
		return r, nil
	}
	if ctx.Err() != nil || os.Geteuid() == 0 || !enabled || ValidateFileMutationConfig(e.Cfg) != nil {
		return fail()
	}
	version, versionErr := mutationProfileVersion(e, purpose, p)
	if versionErr != nil || version != p.ContentVersion || version != a.ContentVersion || a.Path != p.Path || a.ContentRef != p.ContentRef {
		return fail()
	}
	for _, d := range []string{e.StateDir, e.ConfigFile, e.AuditFile, cfg.BackupDir} {
		if d != "" && (underPrefix(a.Path, d) || underPrefix(p.SourcePath, d)) {
			return fail()
		}
	}
	targetDir := path.Dir(a.Path)
	sourceDir := path.Dir(p.SourcePath)
	parent, err := writeDir(targetDir, false)
	if err != nil {
		return fail()
	}
	defer parent.Close()
	src, err := writeDir(sourceDir, false)
	if err != nil {
		return fail()
	}
	defer src.Close()
	store, err := writeDir(cfg.BackupDir, true)
	if err != nil {
		return fail()
	}
	defer store.Close()
	// Independent instances of zenithd share an advisory lock on private storage.
	if syscall.Flock(int(store.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return fail()
	}
	defer syscall.Flock(int(store.Fd()), syscall.LOCK_UN)
	desired, sourceStat, err := writeRead(src, path.Base(p.SourcePath), p.MaxBytes, true)
	if err != nil || writeSHA(desired) != p.SHA256 {
		return fail()
	}
	old, oldStat, oldErr := writeRead(parent, path.Base(a.Path), p.MaxBytes, false)
	exists := oldErr == nil
	if oldErr != nil && !errors.Is(oldErr, syscall.ENOENT) {
		return fail()
	}
	if (exists && (a.ExpectedSHA256 == nil || writeSHA(old) != *a.ExpectedSHA256)) || (!exists && a.ExpectedSHA256 != nil) {
		return fail()
	}
	mode := uint32(0600)
	if p.Mode == "0640" {
		mode = 0640
	}
	verifySource := func() bool {
		b, st, er := writeRead(src, path.Base(p.SourcePath), p.MaxBytes, true)
		checkedVersion, ve := mutationProfileVersion(e, purpose, p)
		return ValidateFileMutationConfig(e.Cfg) == nil && ve == nil && checkedVersion == a.ContentVersion && er == nil && writeSame(st, sourceStat) && writeSHA(b) == p.SHA256 && writeDirSame(sourceDir, src, false)
	}
	verifyOld := func() bool {
		b, st, er := writeRead(parent, path.Base(a.Path), p.MaxBytes, false)
		if !exists {
			return errors.Is(er, syscall.ENOENT)
		}
		return er == nil && writeSame(st, oldStat) && bytes.Equal(b, old)
	}
	success := func(changed bool) (Result, error) {
		d := map[string]any{"path": a.Path, "contentVersion": a.ContentVersion, "changed": changed, "created": changed && !exists, "bytesWritten": 0, "postcondition": "verified", "phase": "verified", "effect": "none"}
		if purpose == fileUploadPurpose {
			delete(d, "contentVersion")
			d["sourceVersion"] = a.ContentVersion
		}
		if changed {
			d["bytesWritten"] = len(desired)
			d["effect"] = "committed"
			d["transactionRef"] = transaction
		}
		if backup != "" {
			d["backupRef"] = backup
		}
		return Result{OK: true, Data: d}, nil
	}
	if exists && bytes.Equal(old, desired) && oldStat.Mode&07777 == mode {
		phase = "postcondition"
		if writeFault(e, "noop") != nil || ctx.Err() != nil || !verifyOld() || !verifySource() || !writeDirSame(targetDir, parent, false) {
			return fail()
		}
		existing, er := writeOpen(parent, path.Base(a.Path))
		if er != nil {
			return fail()
		}
		syncErr := existing.Sync()
		closeErr := existing.Close()
		if syncErr != nil || closeErr != nil || parent.Sync() != nil || !verifyOld() || ctx.Err() != nil {
			return fail()
		}
		return success(false)
	}
	phase = "prepare"
	token, err := writeOpaque()
	if err != nil {
		return fail()
	}
	tempName := token + ".tmp"
	temp, err := writeExclusive(parent, tempName, desired, mode, func() error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return writeFault(e, "file_sync")
	})
	if err != nil {
		if temp != nil {
			_ = syscall.Unlinkat(int(parent.Fd()), tempName)
		}
		return fail()
	}
	defer temp.Close()
	renamed := false
	defer func() {
		if !renamed {
			_ = syscall.Unlinkat(int(parent.Fd()), tempName)
		}
	}()
	tempStat, err := writeStat(temp)
	if err != nil || writeFault(e, "prepared") != nil || ctx.Err() != nil {
		return fail()
	}
	phase = "backup"
	// Durable intent is retained for create AND replace. A restart never replays
	// it: an unresolved intent means a human must reconcile independently.
	intent := map[string]any{"version": 1, "path": a.Path, "contentRef": a.ContentRef, "contentVersion": a.ContentVersion, "priorSha256": a.ExpectedSHA256, "desiredSha256": p.SHA256, "mode": p.Mode, "created": !exists, "state": "commit-may-have-run"}
	if purpose == fileUploadPurpose {
		delete(intent, "contentRef")
		delete(intent, "contentVersion")
		intent["operation"] = OpFileUpload
		intent["sourceRef"] = a.ContentRef
		intent["sourceVersion"] = a.ContentVersion
	}
	if purpose == serviceConfigurePurpose {
		delete(intent, "contentRef")
		delete(intent, "contentVersion")
		intent["operation"] = OpServiceConfigure
		intent["profileRef"] = a.ContentRef
		intent["profileVersion"] = a.ContentVersion
	}
	if exists {
		intent["priorMode"] = oldStat.Mode & 07777
		intent["priorUID"] = oldStat.Uid
		intent["priorGID"] = oldStat.Gid
		intent["priorBytes"] = len(old)
	}
	record, _ := json.Marshal(intent)
	entries := 1
	size := int64(len(record))
	if exists {
		entries++
		size += int64(len(old))
	}
	currentCfg, _ := mutationConfig(e, purpose)
	if !writeBudget(store, currentCfg, size, entries) || !writeDirSame(currentCfg.BackupDir, store, true) {
		return fail()
	}
	transaction = token
	if exists {
		backup = token
		f, er := writeExclusive(store, token+".data", old, 0600, func() error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return writeFault(e, "backup_file_sync")
		})
		if er != nil {
			return fail()
		}
		if f.Close() != nil {
			return fail()
		}
	}
	f, err := writeExclusive(store, token+".json", record, 0600, func() error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return writeFault(e, "intent_file_sync")
	})
	if err != nil {
		return fail()
	}
	if f.Close() != nil || writeFault(e, "backup_directory_sync") != nil || ctx.Err() != nil || store.Sync() != nil || writeFault(e, "backup") != nil {
		return fail()
	}
	phase = "commit"
	verifyTemp := func() bool {
		b, st, er := writeRead(parent, tempName, p.MaxBytes, false)
		return er == nil && writeSame(st, tempStat) && bytes.Equal(b, desired) && st.Mode&07777 == mode
	}
	if writeFault(e, "before_rename") != nil || ctx.Err() != nil || !verifySource() || !verifyOld() || !verifyTemp() || !writeDirSame(targetDir, parent, false) || !writeDirSame(mutationBackupDir(e, purpose), store, true) {
		return fail()
	}
	// Linux rename is relative to the same pinned parent. There is no universal
	// compare-and-swap against an external process sharing our UID. Provisioning
	// a trusted parent and excluding such writers is an operator prerequisite.
	if syscall.Renameat(int(parent.Fd()), tempName, int(parent.Fd()), path.Base(a.Path)) != nil {
		return fail()
	}
	renamed = true
	effect = "unknown"
	phase = "rename"
	if writeFault(e, "after_rename") != nil || ctx.Err() != nil {
		return fail()
	}
	phase = "directory_sync"
	if writeFault(e, "before_directory_sync") != nil || ctx.Err() != nil || parent.Sync() != nil || writeFault(e, "directory_sync") != nil || ctx.Err() != nil {
		return fail()
	}
	phase = "postcondition"
	if writeFault(e, "postcondition") != nil {
		return fail()
	}
	measured, st, err := writeRead(parent, path.Base(a.Path), p.MaxBytes, false)
	if err != nil || st.Dev != tempStat.Dev || st.Ino != tempStat.Ino || st.Mode&07777 != mode || !bytes.Equal(measured, desired) || !writeDirSame(targetDir, parent, false) || ctx.Err() != nil {
		return fail()
	}
	// The retained intent remains conservative if a crash loses the reply.
	return success(true)
}
