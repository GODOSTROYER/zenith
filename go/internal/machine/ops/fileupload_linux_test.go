//go:build linux

package ops

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

// Reuse the required unprivileged persistent Linux fixture admission. This
// source adds no mount provisioning, privileged execution or synthetic writer.
func uploadFixture(t *testing.T) (*Env, fileUploadArgs, FileUploadProfile, []byte) {
	t.Helper()
	e, _, write, _ := writeFixture(t)
	desired := []byte{0x00, 0xff, 0x80, 0x01, 0x0a, 0x00, 0xfe, 0x7f}
	if err := os.Chmod(write.SourcePath, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(write.SourcePath, desired, 0400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(write.SourcePath, 0400); err != nil {
		t.Fatal(err)
	}
	p := FileUploadProfile{Path: write.Path, SourceRef: "binary", SourcePath: write.SourcePath, SHA256: writeSHA(desired), Mode: "0600", MaxBytes: 1024}
	c := FileUploadConfig{Enabled: true, BackupDir: e.Cfg.FileWrite.BackupDir, MaxBackupBytes: e.Cfg.FileWrite.MaxBackupBytes, MaxBackups: e.Cfg.FileWrite.MaxBackups}
	p.SourceVersion, _ = FileUploadProfileVersion(c, p)
	c.Profiles = []FileUploadProfile{p}
	e.Cfg.FileWrite = FileWriteConfig{}
	e.Cfg.FileUpload = c
	return e, fileUploadArgs{Path: p.Path, SourceRef: p.SourceRef, SourceVersion: p.SourceVersion}, p, desired
}

func uploadRun(t *testing.T, e *Env, a fileUploadArgs) Result {
	t.Helper()
	raw, _ := json.Marshal(a)
	run, err := e.Prepare(OpFileUpload, &Request{Args: raw, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	r, err := run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestUploadBinaryCreateReplaceNoopAndPurposeReceipt(t *testing.T) {
	e, a, p, desired := uploadFixture(t)
	created := uploadRun(t, e, a)
	if !created.OK || created.Data["created"] != true || created.Data["sourceVersion"] != p.SourceVersion || created.Data["contentVersion"] != nil || created.Data["backupRef"] != nil || created.Data["bytesWritten"] != len(desired) {
		t.Fatal("binary absent-target receipt invalid")
	}
	writeAssertBytes(t, p.Path, desired)
	prior := p.SHA256
	a.ExpectedSHA256 = &prior
	noop := uploadRun(t, e, a)
	if !noop.OK || noop.Data["changed"] != false || noop.Data["bytesWritten"] != 0 || noop.Data["transactionRef"] != nil {
		t.Fatal("binary noop did not establish exact postconditions")
	}
	old := []byte{0xff, 0x00, 0x81, 0x03}
	if err := os.WriteFile(p.Path, old, 0600); err != nil {
		t.Fatal(err)
	}
	prior = writeSHA(old)
	replaced := uploadRun(t, e, a)
	ref, ok := replaced.Data["backupRef"].(string)
	if !replaced.OK || !ok || replaced.Data["created"] != false || replaced.Data["effect"] != "committed" {
		t.Fatal("binary replacement did not retain private custody")
	}
	writeAssertBytes(t, p.Path, desired)
	writeAssertBytes(t, filepath.Join(e.Cfg.FileUpload.BackupDir, ref+".data"), old)
	raw, err := os.ReadFile(filepath.Join(e.Cfg.FileUpload.BackupDir, ref+".json"))
	var intent map[string]any
	if err != nil || json.Unmarshal(raw, &intent) != nil || intent["operation"] != OpFileUpload || intent["sourceVersion"] != p.SourceVersion || intent["sourceRef"] != p.SourceRef || intent["contentVersion"] != nil || intent["bytes"] != nil {
		t.Fatal("upload intent did not bind its exact purpose without contents")
	}
}

func TestUploadExactPriorAndNativeSourceGuards(t *testing.T) {
	for _, kind := range []string{"absence-on-existing", "prior-on-absent", "wrong-prior", "source-digest", "source-symlink", "target-symlink", "target-mode", "source-budget", "backup-budget"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, desired := uploadFixture(t)
			old := []byte("prior-upload-fixture")
			prior := writeSHA(old)
			switch kind {
			case "absence-on-existing", "wrong-prior", "target-mode":
				if err := os.WriteFile(p.Path, old, 0600); err != nil {
					t.Fatal(err)
				}
				if kind == "wrong-prior" {
					wrong := strings.Repeat("b", 64)
					a.ExpectedSHA256 = &wrong
				}
				if kind == "target-mode" {
					a.ExpectedSHA256 = &prior
					if err := os.Chmod(p.Path, 0644); err != nil {
						t.Fatal(err)
					}
				}
			case "prior-on-absent":
				a.ExpectedSHA256 = &prior
			case "source-digest":
				if err := os.Chmod(p.SourcePath, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p.SourcePath, old, 0600); err != nil {
					t.Fatal(err)
				}
			case "source-symlink":
				if err := os.Remove(p.SourcePath); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(p.Path, p.SourcePath); err != nil {
					t.Fatal(err)
				}
			case "target-symlink":
				if err := os.Symlink(p.SourcePath, p.Path); err != nil {
					t.Fatal(err)
				}
			case "source-budget":
				e.Cfg.FileUpload.Profiles[0].MaxBytes = int64(len(desired) - 1)
				e.Cfg.FileUpload.Profiles[0].SourceVersion, _ = FileUploadProfileVersion(e.Cfg.FileUpload, e.Cfg.FileUpload.Profiles[0])
				a.SourceVersion = e.Cfg.FileUpload.Profiles[0].SourceVersion
			case "backup-budget":
				e.Cfg.FileUpload.MaxBackupBytes = 1
				e.Cfg.FileUpload.Profiles[0].SourceVersion, _ = FileUploadProfileVersion(e.Cfg.FileUpload, p)
				a.SourceVersion = e.Cfg.FileUpload.Profiles[0].SourceVersion
			}
			if r := uploadRun(t, e, a); r.OK || r.Data["effect"] != "none" {
				t.Fatal("native upload guard permitted effects")
			}
			if kind == "absence-on-existing" || kind == "wrong-prior" || kind == "target-mode" {
				writeAssertBytes(t, p.Path, old)
			}
		})
	}
}

func TestUploadCurrentProfileRecheckedBeforeEffectsAndCommit(t *testing.T) {
	for _, kind := range []string{"disabled-before-run", "removed-before-run", "disabled-before-rename", "removed-before-rename", "source-swap-before-rename", "inactive-write-source-before-rename"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, _ := uploadFixture(t)
			raw, _ := json.Marshal(a)
			run, err := e.Prepare(OpFileUpload, &Request{Args: raw, MaxOutputBytes: 4096})
			if err != nil {
				t.Fatal(err)
			}
			if kind == "disabled-before-run" {
				e.Cfg.FileUpload.Enabled = false
			}
			if kind == "removed-before-run" {
				e.Cfg.FileUpload.Profiles = nil
			}
			e.fileWriteFault = func(phase string) error {
				if phase == "before_rename" {
					if kind == "disabled-before-rename" {
						e.Cfg.FileUpload.Enabled = false
					}
					if kind == "removed-before-rename" {
						e.Cfg.FileUpload.Profiles = nil
					}
					if kind == "inactive-write-source-before-rename" {
						write := uploadProfile(p)
						write.Path = filepath.Join(filepath.Dir(p.Path), "inactive.txt")
						write.SourcePath = p.Path
						wc := FileWriteConfig{BackupDir: filepath.Join(filepath.Dir(e.Cfg.FileUpload.BackupDir), "inactive-backups"), MaxBackupBytes: 4096, MaxBackups: 4}
						write.ContentVersion, _ = FileWriteProfileVersion(wc, write)
						wc.Profiles = []FileWriteProfile{write}
						e.Cfg.FileWrite = wc
					}
					if kind == "source-swap-before-rename" {
						if err := os.Chmod(p.SourcePath, 0600); err != nil {
							t.Fatal(err)
						}
						if err := os.WriteFile(p.SourcePath, []byte("changed-native-source"), 0600); err != nil {
							t.Fatal(err)
						}
					}
				}
				return nil
			}
			r, err := run(context.Background())
			if err != nil || r.OK || r.Data["effect"] != "none" {
				t.Fatal("changed current profile dispatched")
			}
			if _, err := os.Lstat(p.Path); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("refused upload created target")
			}
		})
	}
}

func TestUploadFaultCustodyAndNoAutomaticReplay(t *testing.T) {
	for _, phase := range []string{"file_sync", "backup_file_sync", "intent_file_sync", "backup_directory_sync", "before_rename", "after_rename", "directory_sync", "postcondition"} {
		t.Run(phase, func(t *testing.T) {
			e, a, p, desired := uploadFixture(t)
			old := []byte("old-native-upload")
			if err := os.WriteFile(p.Path, old, 0600); err != nil {
				t.Fatal(err)
			}
			prior := writeSHA(old)
			a.ExpectedSHA256 = &prior
			e.fileWriteFault = func(at string) error {
				if at == phase {
					return errors.New("inert-private-fault")
				}
				return nil
			}
			r := uploadRun(t, e, a)
			uncertain := phase == "after_rename" || phase == "directory_sync" || phase == "postcondition"
			if r.OK || (r.Data["effect"] == "unknown") != uncertain {
				t.Fatal("upload fault lost effect classification")
			}
			if uncertain {
				if r.Data["error"] != "mutation_uncertain" || r.Data["transactionRef"] == nil || r.Data["backupRef"] == nil {
					t.Fatal("uncertain upload lost retained intent or backup")
				}
				writeAssertBytes(t, p.Path, desired)
				e.fileWriteFault = nil
				if replay := uploadRun(t, e, a); replay.OK || replay.Data["effect"] != "none" {
					t.Fatal("old prior digest replayed uncertain upload")
				}
			} else {
				writeAssertBytes(t, p.Path, old)
			}
			if strings.Contains(r.Err, "inert-private-fault") {
				t.Fatal("private fault escaped fixed diagnostics")
			}
		})
	}
}

func TestUploadRejectsActualAccessAndDefaultACLs(t *testing.T) {
	for _, kind := range []string{"target-access", "parent-default"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, _ := uploadFixture(t)
			old := []byte("old-upload-acl")
			if err := os.WriteFile(p.Path, old, 0600); err != nil {
				t.Fatal(err)
			}
			prior := writeSHA(old)
			a.ExpectedSHA256 = &prior
			acl := make([]byte, 4+5*8)
			binary.LittleEndian.PutUint32(acl[:4], 2)
			for i, tag := range []uint16{1, 2, 4, 16, 32} {
				offset := 4 + i*8
				binary.LittleEndian.PutUint16(acl[offset:offset+2], tag)
				binary.LittleEndian.PutUint16(acl[offset+2:offset+4], []uint16{6, 4, 0, 4, 0}[i])
				id := uint32(0xffffffff)
				if tag == 2 {
					id = uint32(os.Geteuid() + 1)
				}
				binary.LittleEndian.PutUint32(acl[offset+4:offset+8], id)
			}
			target, attr := p.Path, "system.posix_acl_access"
			if kind == "parent-default" {
				target, attr = filepath.Dir(p.Path), "system.posix_acl_default"
			}
			if err := syscall.Setxattr(target, attr, acl, 0); err != nil {
				t.Fatal("actual Linux ACL prerequisite unavailable", err)
			}
			if r := uploadRun(t, e, a); r.OK || r.Data["effect"] != "none" {
				t.Fatal("actual ACL widened upload authority")
			}
			writeAssertBytes(t, p.Path, old)
		})
	}
}

func TestUploadCancellationBeforeEffects(t *testing.T) {
	e, a, p, _ := uploadFixture(t)
	raw, _ := json.Marshal(a)
	run, err := e.Prepare(OpFileUpload, &Request{Args: raw, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r, err := run(ctx)
	if err != nil || r.OK || r.Data["effect"] != "none" {
		t.Fatal("cancelled upload performed effects")
	}
	if _, err := os.Lstat(p.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled upload created target")
	}
}

func TestUploadAndWriteShareBackupCapacityAcrossConcurrentOperations(t *testing.T) {
	e, a, p, _ := uploadFixture(t)
	e.Cfg.FileUpload.MaxBackups = 1
	p.SourceVersion, _ = FileUploadProfileVersion(e.Cfg.FileUpload, p)
	e.Cfg.FileUpload.Profiles = []FileUploadProfile{p}
	a.SourceVersion = p.SourceVersion
	write := uploadProfile(p)
	write.Path = filepath.Join(filepath.Dir(p.Path), "other.txt")
	wc := FileWriteConfig{Enabled: true, BackupDir: e.Cfg.FileUpload.BackupDir, MaxBackups: 1, MaxBackupBytes: e.Cfg.FileUpload.MaxBackupBytes}
	write.ContentVersion, _ = FileWriteProfileVersion(wc, write)
	wc.Profiles = []FileWriteProfile{write}
	other := &Env{Cfg: Config{FileWrite: wc}}
	wa := fileWriteArgs{Path: write.Path, ContentRef: write.ContentRef, ContentVersion: write.ContentVersion}
	rawUpload, _ := json.Marshal(a)
	rawWrite, _ := json.Marshal(wa)
	uploadRun, err := e.Prepare(OpFileUpload, &Request{Args: rawUpload, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	writeRun, err := other.Prepare(OpFileWrite, &Request{Args: rawWrite, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan Result, 2)
	var workers sync.WaitGroup
	for _, run := range []Runnable{uploadRun, writeRun} {
		workers.Add(1)
		go func(run Runnable) {
			defer workers.Done()
			r, err := run(context.Background())
			if err != nil {
				r.OK = false
			}
			results <- r
		}(run)
	}
	workers.Wait()
	close(results)
	accepted := 0
	for r := range results {
		if r.OK {
			accepted++
		} else if r.Data == nil || r.Data["effect"] != "none" {
			t.Fatal("concurrent refusal lost definite effect custody")
		}
	}
	if accepted != 1 {
		t.Fatal("upload and write oversubscribed shared retained intent capacity")
	}
	entries, err := os.ReadDir(e.Cfg.FileUpload.BackupDir)
	if err != nil || len(entries) != 1 {
		t.Fatal("shared backup capacity differs from retained intent count")
	}
}

func TestUploadExactMountedParentAndMountedFileRefusal(t *testing.T) {
	e, a, p, desired := uploadFixture(t)
	root := os.Getenv("ZENITH_FILE_WRITE_MOUNT_FIXTURES")
	if root == "" {
		t.Fatal("required actual upload mount suite needs owned ZENITH_FILE_WRITE_MOUNT_FIXTURES")
	}
	anchor, backup := filepath.Join(root, "anchor"), filepath.Join(root, "backup-anchor")
	parent, err := writeDir(anchor, false)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	store, err := writeDir(backup, true)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	base, err := os.Open("/")
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	pm, pe := writeMount(int(parent.Fd()))
	sm, se := writeMount(int(store.Fd()))
	rm, re := writeMount(int(base.Fd()))
	if pe != nil || se != nil || re != nil || pm == rm || sm == rm {
		t.Fatal("actual independent mounted anchors required")
	}
	p.Path = filepath.Join(anchor, "upload.bin")
	e.Cfg.FileUpload.BackupDir = backup
	p.SourceVersion, _ = FileUploadProfileVersion(e.Cfg.FileUpload, p)
	e.Cfg.FileUpload.Profiles = []FileUploadProfile{p}
	a.Path, a.SourceVersion = p.Path, p.SourceVersion
	if _, err := os.Lstat(p.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("owned upload mount target must start absent")
	}
	if r := uploadRun(t, e, a); !r.OK {
		t.Fatal("actual exact mounted parent refused upload create")
	}
	writeAssertBytes(t, p.Path, desired)
	old := []byte{0xfe, 0x00, 0x11}
	if err := os.WriteFile(p.Path, old, 0600); err != nil {
		t.Fatal(err)
	}
	prior := writeSHA(old)
	a.ExpectedSHA256 = &prior
	r := uploadRun(t, e, a)
	ref, ok := r.Data["backupRef"].(string)
	if !r.OK || !ok {
		t.Fatal("actual mounted upload replacement lost backup")
	}
	writeAssertBytes(t, filepath.Join(backup, ref+".data"), old)
	p.Path = filepath.Join(root, "file-anchor", "target.txt")
	before, err := os.ReadFile(p.Path)
	if err != nil {
		t.Fatal(err)
	}
	p.SourceVersion, _ = FileUploadProfileVersion(e.Cfg.FileUpload, p)
	e.Cfg.FileUpload.Profiles = []FileUploadProfile{p}
	a.Path, a.SourceVersion = p.Path, p.SourceVersion
	prior = writeSHA(before)
	fd, err := writeDir(filepath.Dir(p.Path), false)
	if err != nil {
		t.Fatal(err)
	}
	defer fd.Close()
	file, err := writeOpen(fd, filepath.Base(p.Path))
	if err != nil {
		t.Fatal(err)
	}
	fm, fe := writeMount(int(file.Fd()))
	dm, de := writeMount(int(fd.Fd()))
	file.Close()
	if fe != nil || de != nil || fm == dm {
		t.Fatal("actual regular-file bind mount required")
	}
	if r := uploadRun(t, e, a); r.OK || r.Data["effect"] != "none" {
		t.Fatal("mounted file beneath anchor admitted upload")
	}
	writeAssertBytes(t, p.Path, before)
}
