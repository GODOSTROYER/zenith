//go:build linux

package ops

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
)

// Required tests fail (never skip) without an unprivileged, non-symlinked,
// privately writable fixture root on the root mount. /tmp is intentionally
// outside the production guard; root must provision the Linux test user.
func writeFixture(t *testing.T) (*Env, fileWriteArgs, FileWriteProfile, string) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Fatal("required Linux file.write suite must run as an unprivileged user")
	}
	root := os.Getenv("ZENITH_FILE_WRITE_TEST_ROOT")
	if root == "" {
		var err error
		root, err = os.UserHomeDir()
		if err != nil {
			t.Fatal(err)
		}
	}
	base, err := os.MkdirTemp(root, "fwtest-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(base) })
	for _, d := range []string{"app", "templates", "backups", "outside"} {
		if err := os.Mkdir(filepath.Join(base, d), 0700); err != nil {
			t.Fatal(err)
		}
	}
	source := filepath.Join(base, "templates", "approved.txt")
	if err := os.WriteFile(source, []byte("approved-inert-fixture\n"), 0400); err != nil {
		t.Fatal(err)
	}
	p := FileWriteProfile{Path: filepath.Join(base, "app", "settings.txt"), ContentRef: "settings", ContentVersion: "v1", SourcePath: source, SHA256: writeSHA([]byte("approved-inert-fixture\n")), Mode: "0600", MaxBytes: 1024}
	e := &Env{Cfg: Config{FileWrite: FileWriteConfig{Enabled: true, BackupDir: filepath.Join(base, "backups"), MaxBackups: 32, MaxBackupBytes: 32768, Profiles: []FileWriteProfile{p}}}}
	version, err := FileWriteProfileVersion(e.Cfg.FileWrite, p)
	if err != nil {
		t.Fatal(err)
	}
	p.ContentVersion = version
	e.Cfg.FileWrite.Profiles = []FileWriteProfile{p}
	a := fileWriteArgs{Path: p.Path, ContentRef: p.ContentRef, ContentVersion: p.ContentVersion}
	if d, err := writeDir(filepath.Dir(p.Path), false); err != nil {
		t.Fatal("fixture tree does not meet required Linux guard:", err)
	} else {
		d.Close()
	}
	return e, a, p, base
}
func writeRun(t *testing.T, e *Env, a fileWriteArgs) Result {
	t.Helper()
	raw, _ := json.Marshal(a)
	run, err := e.Prepare(OpFileWrite, &Request{Args: raw, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	r, err := run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func writeAssertBytes(t *testing.T, p string, want []byte) {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil || !bytes.Equal(b, want) {
		t.Fatal("filesystem bytes differ from expected inert fixture")
	}
}
func TestWriteCreateReplaceNoop(t *testing.T) {
	e, a, p, _ := writeFixture(t)
	created := writeRun(t, e, a)
	if !created.OK || created.Data["created"] != true || created.Data["backupRef"] != nil || created.Data["postcondition"] != "verified" {
		t.Fatal("create receipt invalid", created.Data)
	}
	writeAssertBytes(t, p.Path, []byte("approved-inert-fixture\n"))
	h := p.SHA256
	a.ExpectedSHA256 = &h
	noop := writeRun(t, e, a)
	if !noop.OK || noop.Data["changed"] != false || noop.Data["bytesWritten"] != 0 {
		t.Fatal("noop did not verify")
	}
	old := []byte("prior-inert-fixture\n")
	if err := os.WriteFile(p.Path, old, 0600); err != nil {
		t.Fatal(err)
	}
	prior := writeSHA(old)
	a.ExpectedSHA256 = &prior
	replaced := writeRun(t, e, a)
	if !replaced.OK || replaced.Data["created"] != false {
		t.Fatal("replace failed", replaced.Data)
	}
	ref, ok := replaced.Data["backupRef"].(string)
	if !ok {
		t.Fatal("replacement must retain private backup")
	}
	writeAssertBytes(t, filepath.Join(e.Cfg.FileWrite.BackupDir, ref+".data"), old)
	for _, ext := range []string{".data", ".json"} {
		st, err := os.Stat(filepath.Join(e.Cfg.FileWrite.BackupDir, ref+ext))
		if err != nil || st.Mode().Perm() != 0600 {
			t.Fatal("retained backup is not private")
		}
	}
	wire, _ := json.Marshal(replaced)
	if bytes.Contains(wire, old) || bytes.Contains(wire, []byte("approved-inert-fixture")) || bytes.Contains(wire, []byte(p.SourcePath)) {
		t.Fatal("result leaked local contents/source")
	}
}
func TestWritePriorVersionSourceAndCapacityRefusal(t *testing.T) {
	for _, kind := range []string{"prior", "create-only", "version", "source", "capacity", "private-store", "target-mode", "target-hardlink", "source-hardlink", "source-symlink", "parent-mode"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, base := writeFixture(t)
			old := []byte("unchanged-inert-fixture")
			os.WriteFile(p.Path, old, 0600)
			h := writeSHA(old)
			a.ExpectedSHA256 = &h
			switch kind {
			case "prior":
				bad := writeSHA([]byte("other"))
				a.ExpectedSHA256 = &bad
			case "create-only":
				a.ExpectedSHA256 = nil
			case "version":
				a.ContentVersion = strings.Repeat("b", 64)
			case "source":
				os.Chmod(p.SourcePath, 0600)
				os.WriteFile(p.SourcePath, []byte("unapproved-inert-fixture"), 0600)
			case "capacity":
				e.Cfg.FileWrite.MaxBackupBytes = 1
				writeReversion(t, e, &a, &p)
			case "private-store":
				os.Chmod(e.Cfg.FileWrite.BackupDir, 0755)
			case "target-mode":
				os.Chmod(p.Path, 0755)
			case "target-hardlink":
				if err := os.Link(p.Path, filepath.Join(base, "outside", "alias")); err != nil {
					t.Fatal(err)
				}
			case "source-hardlink":
				if err := os.Link(p.SourcePath, filepath.Join(base, "outside", "alias")); err != nil {
					t.Fatal(err)
				}
			case "source-symlink":
				os.Remove(p.SourcePath)
				os.Symlink(p.Path, p.SourcePath)
			case "parent-mode":
				os.Chmod(filepath.Dir(p.Path), 0777)
			}
			raw, _ := json.Marshal(a)
			run, err := e.Prepare(OpFileWrite, &Request{Args: raw, MaxOutputBytes: 4096})
			if err == nil {
				r, er := run(context.Background())
				if er != nil || r.OK || r.Data["effect"] != "none" {
					t.Fatal("unsafe write was not a precommit refusal")
				}
			}
			writeAssertBytes(t, p.Path, old)
		})
	}
}
func TestWriteSymlinkFIFODeviceMountAndOwnership(t *testing.T) {
	for _, kind := range []string{"symlink", "parent-symlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, base := writeFixture(t)
			sentinel := filepath.Join(base, "outside", "sentinel.txt")
			os.WriteFile(sentinel, []byte("outside-inert-sentinel"), 0600)
			switch kind {
			case "symlink":
				os.Symlink(sentinel, p.Path)
			case "parent-symlink":
				os.Rename(filepath.Dir(p.Path), filepath.Join(base, "saved-app"))
				os.Symlink(filepath.Join(base, "outside"), filepath.Dir(p.Path))
			case "fifo":
				if err := syscall.Mkfifo(p.Path, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if r := writeRun(t, e, a); r.OK || r.Data["effect"] != "none" {
				t.Fatal("nonregular target was accepted")
			}
			writeAssertBytes(t, sentinel, []byte("outside-inert-sentinel"))
		})
	}
	if d, err := writeDir("/proc", false); err == nil {
		d.Close()
		t.Fatal("actual mount transition accepted")
	}
	if d, err := writeDir("/etc", false); err == nil {
		d.Close()
		t.Fatal("directory belonging to another UID accepted")
	}
	dev, err := os.Open("/dev")
	if err != nil {
		t.Fatal(err)
	}
	defer dev.Close()
	if _, _, err := writeRead(dev, "null", 1024, false); err == nil {
		t.Fatal("actual device accepted")
	}
	if d, err := writeDir("/tmp", false); err == nil {
		d.Close()
		t.Fatal("unsafe writable ancestor accepted")
	}
}
func TestWriteFaultAndCancelPhases(t *testing.T) {
	for _, stage := range []string{"file_sync", "prepared", "backup_file_sync", "intent_file_sync", "backup_directory_sync", "backup", "before_rename", "after_rename", "before_directory_sync", "directory_sync", "postcondition"} {
		for _, cancelled := range []bool{false, true} {
			t.Run(stage+strconv.FormatBool(cancelled), func(t *testing.T) {
				e, a, p, _ := writeFixture(t)
				old := []byte("old-inert-fixture")
				os.WriteFile(p.Path, old, 0600)
				h := writeSHA(old)
				a.ExpectedSHA256 = &h
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				e.fileWriteFault = func(s string) error {
					if s == stage {
						if cancelled {
							cancel()
							return nil
						}
						return errors.New("inert injected fault")
					}
					return nil
				}
				r, err := runFileWrite(ctx, e, a, p)
				if err != nil || r.OK {
					t.Fatal("fault claimed success")
				}
				committed := stage == "after_rename" || stage == "before_directory_sync" || stage == "directory_sync" || stage == "postcondition"
				if committed {
					if r.Data["effect"] != "unknown" || r.Data["error"] != "mutation_uncertain" || r.Data["backupRef"] == nil {
						t.Fatal("rename uncertainty lost")
					}
					writeAssertBytes(t, p.Path, []byte("approved-inert-fixture\n"))
				} else {
					if r.Data["effect"] != "none" {
						t.Fatal("precommit failure claimed mutation")
					}
					writeAssertBytes(t, p.Path, old)
				}
				if committed {
					e.fileWriteFault = nil
					r = writeRun(t, e, a)
					if r.OK {
						t.Fatal("restart replay overwrote a subsequently committed target")
					}
				}
			})
		}
	}
}
func TestWriteIndependentPostconditionAndTargetSwap(t *testing.T) {
	for _, stage := range []string{"before_rename", "postcondition", "noop"} {
		t.Run(stage, func(t *testing.T) {
			e, a, p, base := writeFixture(t)
			old := []byte("old-inert-fixture")
			if stage == "noop" {
				old = []byte("approved-inert-fixture\n")
			}
			os.WriteFile(p.Path, old, 0600)
			h := writeSHA(old)
			a.ExpectedSHA256 = &h
			sentinel := filepath.Join(base, "outside", "sentinel.txt")
			os.WriteFile(sentinel, []byte("outside-inert-sentinel"), 0600)
			e.fileWriteFault = func(s string) error {
				if s == stage {
					if err := os.Remove(p.Path); err != nil {
						return err
					}
					return os.Symlink(sentinel, p.Path)
				}
				return nil
			}
			r := writeRun(t, e, a)
			if r.OK {
				t.Fatal("independent measurement missed substituted target")
			}
			if stage == "postcondition" && r.Data["effect"] != "unknown" {
				t.Fatal("postcommit uncertainty lost")
			}
			writeAssertBytes(t, sentinel, []byte("outside-inert-sentinel"))
		})
	}
}
func TestWriteConcurrentWritersAndDirectorySwapStress(t *testing.T) {
	e, a, p, base := writeFixture(t)
	var wg sync.WaitGroup
	results := make(chan Result, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := runFileWrite(context.Background(), e, a, p)
			if err != nil {
				results <- Result{}
				return
			}
			results <- r
		}()
	}
	wg.Wait()
	close(results)
	successes := 0
	for r := range results {
		if r.OK {
			successes++
		}
	}
	if successes != 1 {
		t.Fatal("create-only writers were not serialized")
	}
	sentinel := filepath.Join(base, "outside", "settings.txt")
	os.WriteFile(sentinel, []byte("outside-inert-sentinel"), 0600)
	app := filepath.Dir(p.Path)
	saved := filepath.Join(base, "saved-app")
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if os.Rename(app, saved) == nil {
				_ = os.Symlink(filepath.Join(base, "outside"), app)
				_ = os.Remove(app)
				_ = os.Rename(saved, app)
			}
		}
	}()
	h := p.SHA256
	a.ExpectedSHA256 = &h
	for i := 0; i < 200; i++ {
		_, _ = runFileWrite(context.Background(), e, a, p)
	}
	close(stop)
	<-done
	writeAssertBytes(t, sentinel, []byte("outside-inert-sentinel"))
	targetSaved := filepath.Join(base, "saved-target.txt")
	targetStop := make(chan struct{})
	targetDone := make(chan struct{})
	go func() {
		defer close(targetDone)
		for {
			select {
			case <-targetStop:
				return
			default:
			}
			if os.Rename(p.Path, targetSaved) == nil {
				_ = os.Symlink(sentinel, p.Path)
				_ = os.Remove(p.Path)
				_ = os.Rename(targetSaved, p.Path)
			}
		}
	}()
	for i := 0; i < 200; i++ {
		_, _ = runFileWrite(context.Background(), e, a, p)
	}
	close(targetStop)
	<-targetDone
	writeAssertBytes(t, sentinel, []byte("outside-inert-sentinel"))
}

// The child exits at an actual commit boundary, leaving retained on-disk
// custody. No engine restart performs replay, pruning or blind rollback.
func TestWriteCrashChild(t *testing.T) {
	root := os.Getenv("ZENITH_WRITE_CRASH_ROOT")
	if root == "" {
		return
	}
	source := filepath.Join(root, "templates", "approved.txt")
	target := filepath.Join(root, "app", "settings.txt")
	p := FileWriteProfile{Path: target, ContentRef: "settings", ContentVersion: "v1", SourcePath: source, SHA256: writeSHA([]byte("approved-inert-fixture\n")), Mode: "0600", MaxBytes: 1024}
	e := &Env{Cfg: Config{FileWrite: FileWriteConfig{Enabled: true, BackupDir: filepath.Join(root, "backups"), MaxBackups: 32, MaxBackupBytes: 32768, Profiles: []FileWriteProfile{p}}}}
	version, err := FileWriteProfileVersion(e.Cfg.FileWrite, p)
	if err != nil {
		t.Fatal(err)
	}
	p.ContentVersion = version
	e.Cfg.FileWrite.Profiles = []FileWriteProfile{p}
	h := writeSHA([]byte("old-inert-fixture"))
	a := fileWriteArgs{Path: target, ContentRef: "settings", ContentVersion: p.ContentVersion, ExpectedSHA256: &h}
	e.fileWriteFault = func(stage string) error {
		if stage == os.Getenv("ZENITH_WRITE_CRASH_STAGE") {
			os.Exit(73)
		}
		return nil
	}
	_, _ = runFileWrite(context.Background(), e, a, p)
	t.Fatal("crash boundary was not reached")
}
func TestWriteCrashCustodyAndRestart(t *testing.T) {
	for _, stage := range []string{"file_sync", "prepared", "backup", "after_rename", "before_directory_sync", "directory_sync"} {
		t.Run(stage, func(t *testing.T) {
			e, a, p, base := writeFixture(t)
			old := []byte("old-inert-fixture")
			os.WriteFile(p.Path, old, 0600)
			h := writeSHA(old)
			a.ExpectedSHA256 = &h
			cmd := exec.Command(os.Args[0], "-test.run=^TestWriteCrashChild$")
			cmd.Env = append(os.Environ(), "ZENITH_WRITE_CRASH_ROOT="+base, "ZENITH_WRITE_CRASH_STAGE="+stage)
			err := cmd.Run()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 73 {
				t.Fatal("child did not exit at required filesystem boundary")
			}
			committed := stage == "after_rename" || stage == "before_directory_sync" || stage == "directory_sync"
			if committed {
				writeAssertBytes(t, p.Path, []byte("approved-inert-fixture\n"))
				if r := writeRun(t, e, a); r.OK {
					t.Fatal("restart replayed old signed prior")
				}
			} else {
				writeAssertBytes(t, p.Path, old)
			}
			if stage != "prepared" && stage != "file_sync" {
				entries, er := os.ReadDir(e.Cfg.FileWrite.BackupDir)
				if er != nil || len(entries) != 2 {
					t.Fatal("durable backup and intent were not retained")
				}
			}
		})
	}
}

// Required real bind-mount coverage. The Linux verification owner provisions
// disposable fixtures as host root, then runs this suite as the test UID and
// tears them down. This source work never mounts or starts a service.
func TestWriteExactMountAnchorsAndEscapes(t *testing.T) {
	e, a, p, _ := writeFixture(t)
	root := os.Getenv("ZENITH_FILE_WRITE_MOUNT_FIXTURES")
	if root == "" {
		t.Fatal("required actual-mount suite needs ZENITH_FILE_WRITE_MOUNT_FIXTURES; no mocked or skipped mount proof")
	}
	anchor := filepath.Join(root, "anchor")
	backup := filepath.Join(root, "backup-anchor")
	d, err := writeDir(anchor, false)
	if err != nil {
		t.Fatal("exact configured mount anchor refused", err)
	}
	defer d.Close()
	b, err := writeDir(backup, true)
	if err != nil {
		t.Fatal("private configured backup mount anchor refused", err)
	}
	defer b.Close()
	r, err := os.Open("/")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	rootMount, er := writeMount(int(r.Fd()))
	anchorMount, ea := writeMount(int(d.Fd()))
	backupMount, eb := writeMount(int(b.Fd()))
	if er != nil || ea != nil || eb != nil || anchorMount == rootMount || backupMount == rootMount {
		t.Fatal("positive fixtures must be actual independent final-directory mounts")
	}
	p.Path = filepath.Join(anchor, "settings.txt")
	a.Path = p.Path
	e.Cfg.FileWrite.Profiles = []FileWriteProfile{p}
	e.Cfg.FileWrite.BackupDir = backup
	writeReversion(t, e, &a, &p)
	if _, err := os.Lstat(p.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("mount fixture target must begin absent")
	}
	if result := writeRun(t, e, a); !result.OK {
		t.Fatal("exact final-parent mount anchor did not create")
	}
	prior := []byte("mounted-prior-inert-fixture")
	if err := os.WriteFile(p.Path, prior, 0600); err != nil {
		t.Fatal(err)
	}
	h := writeSHA(prior)
	a.ExpectedSHA256 = &h
	result := writeRun(t, e, a)
	if !result.OK {
		t.Fatal("mounted-anchor replacement failed")
	}
	ref, ok := result.Data["backupRef"].(string)
	if !ok {
		t.Fatal("mounted replacement lost backup")
	}
	writeAssertBytes(t, filepath.Join(backup, ref+".data"), prior)
	if nested, err := writeDir(filepath.Join(root, "nested", "parent"), false); err == nil {
		nested.Close()
		t.Fatal("unexpected mount transition in ancestor accepted")
	}
	fileAnchor := filepath.Join(root, "file-anchor")
	fd, err := writeDir(fileAnchor, false)
	if err != nil {
		t.Fatal(err)
	}
	defer fd.Close()
	file, err := writeOpen(fd, "target.txt")
	if err != nil {
		t.Fatal(err)
	}
	fileMount, ef := writeMount(int(file.Fd()))
	parentMount, ep := writeMount(int(fd.Fd()))
	file.Close()
	if ef != nil || ep != nil || fileMount == parentMount {
		t.Fatal("negative file fixture must be an actual regular-file bind mount")
	}
	before, err := os.ReadFile(filepath.Join(fileAnchor, "target.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := writeRead(fd, "target.txt", 1024, false); err == nil {
		t.Fatal("mounted target below anchor accepted")
	}
	p.Path = filepath.Join(fileAnchor, "target.txt")
	a.Path = p.Path
	h = writeSHA(before)
	a.ExpectedSHA256 = &h
	e.Cfg.FileWrite.Profiles = []FileWriteProfile{p}
	writeReversion(t, e, &a, &p)
	if result := writeRun(t, e, a); result.OK || result.Data["effect"] != "none" {
		t.Fatal("file mount allowed mutation")
	}
	writeAssertBytes(t, p.Path, before)
}

func TestWriteModeBoundsBackupExhaustionAndSourceSwap(t *testing.T) {
	t.Run("fixed0640", func(t *testing.T) {
		e, a, p, _ := writeFixture(t)
		p.Mode = "0640"
		writeReversion(t, e, &a, &p)
		if r := writeRun(t, e, a); !r.OK {
			t.Fatal("fixed0640 create failed")
		}
		st, err := os.Stat(p.Path)
		if err != nil || st.Mode().Perm() != 0640 {
			t.Fatal("fixed mode was not independently applied")
		}
	})
	t.Run("bounded-source", func(t *testing.T) {
		e, a, p, _ := writeFixture(t)
		p.MaxBytes = 2
		writeReversion(t, e, &a, &p)
		if r := writeRun(t, e, a); r.OK {
			t.Fatal("oversized local source accepted")
		}
		if _, err := os.Lstat(p.Path); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("source refusal created a destination")
		}
	})
	t.Run("retained-capacity", func(t *testing.T) {
		e, a, p, _ := writeFixture(t)
		e.Cfg.FileWrite.MaxBackups = 1
		writeReversion(t, e, &a, &p)
		if r := writeRun(t, e, a); !r.OK {
			t.Fatal("first transaction failed")
		}
		old := []byte("capacity-prior-inert-fixture")
		os.WriteFile(p.Path, old, 0600)
		h := writeSHA(old)
		a.ExpectedSHA256 = &h
		if r := writeRun(t, e, a); r.OK || r.Data["effect"] != "none" {
			t.Fatal("exhausted retained transaction capacity accepted mutation")
		}
		writeAssertBytes(t, p.Path, old)
		entries, err := os.ReadDir(e.Cfg.FileWrite.BackupDir)
		if err != nil || len(entries) != 1 {
			t.Fatal("exhausted capacity pruned retained custody")
		}
	})
	t.Run("source-swapped-before-commit", func(t *testing.T) {
		e, a, p, _ := writeFixture(t)
		old := []byte("old-inert-fixture")
		os.WriteFile(p.Path, old, 0600)
		h := writeSHA(old)
		a.ExpectedSHA256 = &h
		e.fileWriteFault = func(stage string) error {
			if stage == "before_rename" {
				if err := os.Rename(p.SourcePath, p.SourcePath+".old"); err != nil {
					return err
				}
				return os.WriteFile(p.SourcePath, []byte("approved-inert-fixture\n"), 0400)
			}
			return nil
		}
		if r := writeRun(t, e, a); r.OK || r.Data["effect"] != "none" {
			t.Fatal("changed source identity was accepted")
		}
		writeAssertBytes(t, p.Path, old)
	})
}

func writeReversion(t *testing.T, e *Env, a *fileWriteArgs, p *FileWriteProfile) {
	t.Helper()
	version, err := FileWriteProfileVersion(e.Cfg.FileWrite, *p)
	if err != nil {
		t.Fatal(err)
	}
	p.ContentVersion = version
	e.Cfg.FileWrite.Profiles = []FileWriteProfile{*p}
	a.ContentVersion = version
	a.Path = p.Path
	a.ContentRef = p.ContentRef
}
func TestWriteImmutableVersionCannotBeReused(t *testing.T) {
	for _, field := range []string{"pinned-bytes", "mode", "path", "ref", "source", "byte-bound", "backup-dir", "backup-bytes", "backup-count"} {
		t.Run(field, func(t *testing.T) {
			e, a, p, base := writeFixture(t)
			oldVersion := a.ContentVersion
			switch field {
			case "pinned-bytes":
				os.Chmod(p.SourcePath, 0600)
				if err := os.WriteFile(p.SourcePath, []byte("different-approved-inert-fixture"), 0600); err != nil {
					t.Fatal(err)
				}
				os.Chmod(p.SourcePath, 0400)
				p.SHA256 = writeSHA([]byte("different-approved-inert-fixture"))
			case "mode":
				p.Mode = "0640"
			case "path":
				p.Path = filepath.Join(base, "app", "other.txt")
			case "ref":
				p.ContentRef = "other-settings"
			case "source":
				p.SourcePath = filepath.Join(base, "templates", "other.txt")
				if err := os.WriteFile(p.SourcePath, []byte("approved-inert-fixture\n"), 0400); err != nil {
					t.Fatal(err)
				}
			case "byte-bound":
				p.MaxBytes = 512
			case "backup-dir":
				e.Cfg.FileWrite.BackupDir = filepath.Join(base, "other-backups")
				if err := os.Mkdir(e.Cfg.FileWrite.BackupDir, 0700); err != nil {
					t.Fatal(err)
				}
			case "backup-bytes":
				e.Cfg.FileWrite.MaxBackupBytes = 65536
			case "backup-count":
				e.Cfg.FileWrite.MaxBackups = 16
			}
			e.Cfg.FileWrite.Profiles = []FileWriteProfile{p}
			if ValidateFileWriteConfig(e.Cfg.FileWrite) == nil {
				t.Fatal("reused local version accepted changed immutable semantics")
			}
			raw, _ := json.Marshal(a)
			if _, err := e.Prepare(OpFileWrite, &Request{Args: raw, MaxOutputBytes: 4096}); err == nil {
				t.Fatal("old approved version admitted after local semantic change")
			}
			result, err := runFileWrite(context.Background(), e, a, p)
			if err != nil || result.OK || result.Data["effect"] != "none" {
				t.Fatal("runtime did not independently reject reused version")
			}
			if _, err := os.Lstat(a.Path); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("refused old version caused a file effect")
			}
			writeReversion(t, e, &a, &p)
			if a.ContentVersion == oldVersion {
				t.Fatal("immutable semantic change did not alter version")
			}
			if result := writeRun(t, e, a); !result.OK {
				t.Fatal("new reviewed deterministic version did not execute real write")
			}
			desired, err := os.ReadFile(p.SourcePath)
			if err != nil {
				t.Fatal(err)
			}
			writeAssertBytes(t, p.Path, desired)
		})
	}
}

func fileWriteGoldenFixtures(t *testing.T) []fileWriteGoldenFixture {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Fatal("authentic file.write goldens require an unprivileged Linux user")
	}
	// Canonical immutable versions include paths, so the disposable fixture
	// root is intentionally fixed across generation and comparison.
	root := "/opt/zenith-file-write-golden"
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("provision an empty unprivileged-owned /opt/zenith-file-write-golden for actual Linux mapper proof")
	}
	for _, dir := range []string{"app", "templates", "backups"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		for _, dir := range []string{"app", "templates", "backups"} {
			_ = os.RemoveAll(filepath.Join(root, dir))
		}
	})
	source := filepath.Join(root, "templates", "approved.txt")
	desired := []byte("approved-inert-fixture\n")
	if err := os.WriteFile(source, desired, 0400); err != nil {
		t.Fatal(err)
	}
	p := FileWriteProfile{Path: filepath.Join(root, "app", "settings.txt"), ContentRef: "settings", SourcePath: source, SHA256: writeSHA(desired), Mode: "0600", MaxBytes: 1024}
	e := &Env{Cfg: Config{FileWrite: FileWriteConfig{Enabled: true, BackupDir: filepath.Join(root, "backups"), MaxBackups: 32, MaxBackupBytes: 32768}}}
	a := fileWriteArgs{}
	writeReversion(t, e, &a, &p)
	snapshots := []fileWriteGoldenFixture{}
	capture := func(name string, r Result, a fileWriteArgs) {
		// Assert physical receipt files before normalizing random opaque IDs.
		for _, key := range []string{"transactionRef", "backupRef"} {
			ref, ok := r.Data[key].(string)
			if !ok {
				continue
			}
			suffix := ".json"
			if key == "backupRef" {
				suffix = ".data"
			}
			st, err := os.Stat(filepath.Join(e.Cfg.FileWrite.BackupDir, ref+suffix))
			if err != nil || st.Mode().Perm() != 0600 {
				t.Fatal("actual mapper receipt has no private retained filesystem custody")
			}
		}
		copied := map[string]any{}
		for key, value := range r.Data {
			copied[key] = value
		}
		r.Data = copied
		if r.Data["transactionRef"] != nil {
			r.Data["transactionRef"] = "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		}
		if r.Data["backupRef"] != nil {
			r.Data["backupRef"] = "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		}
		snapshots = append(snapshots, fileWriteGoldenFixture{name, a, r})
	}
	created := writeRun(t, e, a)
	if !created.OK {
		t.Fatal("actual Linux golden create failed")
	}
	writeAssertBytes(t, p.Path, desired)
	capture("file.write", created, a)
	h := p.SHA256
	a.ExpectedSHA256 = &h
	noop := writeRun(t, e, a)
	if !noop.OK || noop.Data["changed"] != false {
		t.Fatal("actual Linux golden noop failed")
	}
	capture("file.write-noop", noop, a)
	old := []byte("old-inert-fixture")
	if err := os.WriteFile(p.Path, old, 0600); err != nil {
		t.Fatal(err)
	}
	prior := writeSHA(old)
	a.ExpectedSHA256 = &prior
	replaced := writeRun(t, e, a)
	if !replaced.OK {
		t.Fatal("actual Linux golden replace failed")
	}
	ref := replaced.Data["backupRef"].(string)
	writeAssertBytes(t, filepath.Join(e.Cfg.FileWrite.BackupDir, ref+".data"), old)
	capture("file.write-replace", replaced, a)
	failed := writeRun(t, e, a)
	if failed.OK || failed.Data["effect"] != "none" {
		t.Fatal("actual Linux golden prior refusal failed")
	}
	capture("file.write-prior-refused", failed, a)
	if err := os.WriteFile(p.Path, old, 0600); err != nil {
		t.Fatal(err)
	}
	e.fileWriteFault = func(stage string) error {
		if stage == "after_rename" {
			return errors.New("inert golden boundary fault")
		}
		return nil
	}
	uncertain := writeRun(t, e, a)
	if uncertain.OK || uncertain.Data["effect"] != "unknown" {
		t.Fatal("actual Linux golden lost rename uncertainty")
	}
	writeAssertBytes(t, p.Path, desired)
	capture("file.write-uncertain", uncertain, a)
	return snapshots
}

func TestWriteRejectsActualAccessAndDefaultACLs(t *testing.T) {
	for _, kind := range []string{"target-access", "parent-default"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, _ := writeFixture(t)
			old := []byte("old-inert-fixture")
			if err := os.WriteFile(p.Path, old, 0600); err != nil {
				t.Fatal(err)
			}
			h := writeSHA(old)
			a.ExpectedSHA256 = &h
			// Actual Linux POSIX ACL xattr v2 with a named user and read mask. A mode
			// check alone would see an otherwise permitted 0640 target.
			acl := make([]byte, 4+5*8)
			binary.LittleEndian.PutUint32(acl[:4], 2)
			tags := []uint16{1, 2, 4, 16, 32}
			perms := []uint16{6, 4, 0, 4, 0}
			for i, tag := range tags {
				offset := 4 + i*8
				binary.LittleEndian.PutUint16(acl[offset:offset+2], tag)
				binary.LittleEndian.PutUint16(acl[offset+2:offset+4], perms[i])
				id := uint32(0xffffffff)
				if tag == 2 {
					id = uint32(os.Geteuid() + 1)
				}
				binary.LittleEndian.PutUint32(acl[offset+4:offset+8], id)
			}
			target := p.Path
			attr := "system.posix_acl_access"
			if kind == "parent-default" {
				target = filepath.Dir(p.Path)
				attr = "system.posix_acl_default"
			}
			if err := syscall.Setxattr(target, attr, acl, 0); err != nil {
				t.Fatal("required actual ACL fixture could not be provisioned", err)
			}
			if r := writeRun(t, e, a); r.OK || r.Data["effect"] != "none" {
				t.Fatal("extended ACL widened fixed profile authority")
			}
			writeAssertBytes(t, p.Path, old)
		})
	}
}
func TestWriteBackupByteBudgetRetainsSparseCustody(t *testing.T) {
	e, a, p, _ := writeFixture(t)
	retained := filepath.Join(e.Cfg.FileWrite.BackupDir, "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.data")
	f, err := os.OpenFile(retained, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(e.Cfg.FileWrite.MaxBackupBytes + 1); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()
	if r := writeRun(t, e, a); r.OK || r.Data["effect"] != "none" {
		t.Fatal("exhausted sparse backup bytes allowed mutation")
	}
	if _, err := os.Stat(retained); err != nil {
		t.Fatal("budget refusal pruned retained custody")
	}
	if _, err := os.Lstat(p.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("backup budget refusal created destination")
	}
}
