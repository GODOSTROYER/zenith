//go:build linux

package machine

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

func requirePackageNative(t *testing.T) {
	t.Helper()
	if os.Getenv("ZENITH_TEST_PACKAGE_INSTALL_REQUIRED") != "1" {
		t.Skip("owned disposable Debian package lane is not enabled")
	}
	marker, e := packageRootRead("/run/zenith-package-acceptance-owned", 128)
	if e != nil || string(marker) != "zenith-owned-disposable-package-install-v1\n" || os.Geteuid() != 0 || !packageSupportedHost(context.Background()) {
		t.Fatal("required owning disposable Debian prerequisites are unavailable")
	}
}
func TestPackageHelperNativeNoFollowAndCustody(t *testing.T) {
	requirePackageNative(t)
	packageAssertNativeRootDescriptors(t)
	packageAssertNativeHomeParents(t)
	base := packageHelperState + "/descriptor-controls"
	if os.Mkdir(base, 0700) != nil {
		t.Fatal("descriptor control must begin absent")
	}
	source := base + "/source"
	if packageWriteExclusive(source, []byte("data")) != nil {
		t.Fatal("private source unavailable")
	}
	f, e := packageRootOpen(source, syscall.O_RDONLY, 0)
	if e != nil {
		t.Fatal("authentic private descriptor refused")
	}
	f.Close()
	if os.Symlink(source, base+"/alias") != nil {
		t.Fatal("symlink setup")
	}
	if f, e := packageRootOpen(base+"/alias", syscall.O_RDONLY, 0); e == nil {
		f.Close()
		t.Fatal("symlink source followed")
	}
	if os.Chmod(source, 0666) != nil {
		t.Fatal("mode setup")
	}
	if f, e := packageRootOpen(source, syscall.O_RDONLY, 0); e == nil {
		f.Close()
		t.Fatal("writable source accepted")
	}
	os.Chmod(source, 0600)
	if os.Link(source, base+"/hardlink") != nil {
		t.Fatal("link setup")
	}
	if f, e := packageRootOpen(source, syscall.O_RDONLY, 0); e == nil {
		f.Close()
		t.Fatal("multiply linked source accepted")
	}
}
func TestPackageFrontendLockIndependentProcess(t *testing.T) {
	if os.Getenv("ZENITH_PACKAGE_LOCK_CHILD") == "1" {
		f, e := packageRootOpen("/var/lib/dpkg/lock-frontend", syscall.O_RDWR, 0)
		if e != nil {
			os.Exit(2)
		}
		defer f.Close()
		l := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: 0, Len: 0}
		if syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &l) == nil {
			os.Exit(3)
		}
		os.Exit(0)
	}
	requirePackageNative(t)
	f, e := packageRootOpen("/var/lib/dpkg/lock-frontend", syscall.O_RDWR, 0)
	if e != nil {
		t.Fatal("frontend lock unavailable")
	}
	defer f.Close()
	l := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: 0, Len: 0}
	if syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &l) != nil {
		t.Fatal("native frontend lock unavailable")
	}
	if _, e := packageNativeSnapshot(); e != nil {
		t.Fatal("native snapshot unavailable")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestPackageFrontendLockIndependentProcess$")
	cmd.Env = append(ops.SafeEnv(), "ZENITH_PACKAGE_LOCK_CHILD=1")
	if e := cmd.Run(); e != nil {
		t.Fatal("native snapshot closed or lost the actual fcntl lock")
	}
}
func TestPackageNativeSignedFirstInstallAndNonReplay(t *testing.T) {
	requirePackageNative(t)
	// The root provisions this fixed empty custody tree in an owned disposable
	// guest. This test never adopts/deletes an existing configuration or package.
	for _, dir := range []string{packageHelperState, packageHelperState + "/archives", packageHelperState + "/staged", packageHelperState + "/backups", packageHelperState + "/intents", "/opt/zenith-packages", "/etc/zenithd"} {
		f, e := packageRootOpen(dir, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
		if e != nil {
			t.Fatal("required fixed custody directory unavailable")
		}
		f.Close()
	}
	if packageUnknownIntents() {
		t.Fatal("native intent prerequisites unavailable")
	}
	raw, p := packageModelDeb(t, strings.Replace(packageModelControl, "Architecture: amd64", "Architecture: "+runtime.GOARCH, 1), packageModelEntries())
	p.Architecture = runtime.GOARCH
	p.ProfileVersion = ""
	version, e := ops.PackageInstallProfileVersion(p)
	if e != nil {
		t.Fatal(e)
	}
	p.ProfileVersion = version
	cp := protocoltest.New("package-native-fixture")
	c := packageHelperConfig{MachineID: "mac_package_fixture", WorkspaceID: "ws_package_fixture", DaemonUID: 12345, Keys: cp.Keys(), PackageInstall: ops.PackageInstallConfig{Enabled: true, Profiles: []ops.PackageInstallProfile{p}}}
	configRaw, e := json.Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	if packageWriteExclusive(packageHelperConfigPath, configRaw) != nil || packageWriteExclusive(p.SourcePath, raw) != nil {
		t.Fatal("native fixture must begin without existing source/configuration")
	}
	registeredBefore, e := packageNativeSnapshot()
	if e != nil || !packageNativeEffectiveRegistrations(registeredBefore.Files, registeredBefore.Installed) {
		t.Fatal("actual registered native metadata/config prerequisites unavailable")
	}
	if !packageNativeSafeCommand(packageNativeInstallCommand(packageNativePolicyStage)) {
		t.Fatal("canonical native safe command is unavailable")
	}
	if bytes.Equal(registeredBefore.Files[packageNativeDockerSpeedupKey], []byte(packageNativeDockerSpeedup)) && packageNativeRegistrations(registeredBefore.Files, registeredBefore.Installed) {
		t.Fatal("observed raw unsafe policy was treated as safe without canonical override")
	}
	if !packageReady(context.Background(), c) {
		t.Fatal("eligible actual host/archive/native profile was not ready")
	}
	if packageStrictReplay() != nil {
		t.Fatal("native replay framing unavailable")
	}
	cache, e := protocol.OpenFileReplayCache(packageHelperState+"/replay.jsonl", time.Now)
	if e != nil {
		t.Fatal(e)
	}
	defer cache.Close()
	verifier := &protocol.Verifier{Keys: cp.KeySet(), Replay: cache, Now: time.Now}
	sequence := 0
	signed := func(args ops.PackageInstallArgs, mutate func(*protocol.GrantClaims)) string {
		sequence++
		now := time.Now()
		op := "package_operation_" + strings.Repeat("x", sequence)
		grant := protocol.GrantClaims{JTI: "package_grant_" + strings.Repeat("x", sequence), ISS: "zenith-control-plane", AUD: "machine:" + c.MachineID, SUB: "user_fixture", IAT: now.Unix(), EXP: now.Add(time.Minute).Unix(), CAP: ops.OpPackageInstall, OP: op, Digest: "native-fixture", WS: c.WorkspaceID, Res: "resource_package", Constraints: map[string]any{"maxOutputBytes": float64(4096)}}
		if mutate != nil {
			mutate(&grant)
		}
		argsRaw, _ := json.Marshal(args)
		return cp.Sign(protocol.TypMachine, protocol.MachineEnvelope{Protocol: protocol.MachineProtocol, JTI: "package_request_" + strings.Repeat("x", sequence), MachineID: c.MachineID, WorkspaceID: c.WorkspaceID, OperationID: op, Operation: ops.OpPackageInstall, Args: argsRaw, Grant: cp.Sign(protocol.TypGrant, grant), IAT: now.Unix(), EXP: now.Add(time.Minute).Unix(), TimeoutSec: 30, MaxOutputBytes: 4096})
	}
	args := ops.PackageInstallArgs{ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion}
	// These use genuine verifier-produced identities and positively owned native
	// config. No callback supplies authorization to the helper's final check.
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	if _, e := packageNativeSnapshotContext(cancelled); e == nil {
		t.Fatal("cancelled caller reached native proof")
	}
	expiring, e := verifier.VerifyMachine(signed(args, func(g *protocol.GrantClaims) { g.EXP = time.Now().Add(6 * time.Second).Unix() }), protocol.Self{ID: c.MachineID, WorkspaceID: c.WorkspaceID}, nil)
	if e != nil || !packageCurrent(c, configRaw, expiring, p) {
		t.Fatal("genuine signed expiry control was not current before proof")
	}
	if !packageNativeEffectiveSafeIO(context.Background()) {
		t.Fatal("native safe proof was unavailable before expiry control")
	}
	if wait := time.Until(time.Unix(expiring.Grant.EXP, 0)); wait > 0 {
		time.Sleep(wait)
	}
	if packageCurrent(c, configRaw, expiring, p) {
		t.Fatal("signed expiry after native proof retained authority")
	}
	currentVM, e := verifier.VerifyMachine(signed(args, nil), protocol.Self{ID: c.MachineID, WorkspaceID: c.WorkspaceID}, nil)
	if e != nil || !packageCurrent(c, configRaw, currentVM, p) || !packageNativeEffectiveSafeIO(context.Background()) {
		t.Fatal("genuine current profile control unavailable")
	}
	ownedConfig, e := packageRootOpen(packageHelperConfigPath, syscall.O_RDWR, 0)
	if e != nil {
		t.Fatal("owned config descriptor unavailable")
	}
	defer ownedConfig.Close()
	originalConfigStat, e := ownedConfig.Stat()
	if e != nil {
		t.Fatal("owned config identity unavailable")
	}
	restoreConfig := func() bool {
		if _, e := ownedConfig.WriteAt(configRaw, 0); e != nil {
			return false
		}
		if ownedConfig.Truncate(int64(len(configRaw))) != nil || ownedConfig.Sync() != nil {
			return false
		}
		current, e := ownedConfig.Stat()
		if e != nil || !os.SameFile(originalConfigStat, current) || originalConfigStat.Mode() != current.Mode() {
			return false
		}
		raw, e := packageRootRead(packageHelperConfigPath, int64(len(configRaw)))
		return e == nil && bytes.Equal(raw, configRaw)
	}
	defer func() {
		if !restoreConfig() {
			t.Error("owned profile control restoration unavailable")
		}
	}()
	changedConfig := c
	changedConfig.DaemonUID++
	changedRaw, e := json.Marshal(changedConfig)
	if e != nil {
		t.Fatal("owned changed profile fixture unavailable")
	}
	if _, e := ownedConfig.WriteAt(changedRaw, 0); e != nil || ownedConfig.Truncate(int64(len(changedRaw))) != nil || ownedConfig.Sync() != nil {
		t.Fatal("owned changed profile control unavailable")
	}
	if packageCurrent(c, configRaw, currentVM, p) {
		t.Fatal("changed current profile after native proof retained authority")
	}
	if !restoreConfig() || !packageCurrent(c, configRaw, currentVM, p) {
		t.Fatal("restored genuine current profile unavailable")
	}
	for _, test := range []struct {
		name   string
		change func(*protocol.GrantClaims)
	}{
		{"foreign audience", func(g *protocol.GrantClaims) { g.AUD = "machine:foreign" }},
		{"foreign operation", func(g *protocol.GrantClaims) { g.OP = "foreign" }},
		{"foreign workspace", func(g *protocol.GrantClaims) { g.WS = "foreign" }},
		{"missing resource", func(g *protocol.GrantClaims) { g.Res = "" }},
		{"unknown constraint", func(g *protocol.GrantClaims) { g.Constraints["pathPrefixes"] = []any{"/opt"} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			before, e := packageNativeSnapshot()
			if e != nil {
				t.Fatal("native prerequisites unavailable")
			}
			r := packageInstall(context.Background(), c, configRaw, verifier, signed(args, test.change))
			after, e := packageNativeSnapshot()
			if e != nil || r.OK || r.Data["effect"] != "none" || !reflect.DeepEqual(before.Digests, after.Digests) {
				t.Fatal("invalid signed authority reached native writes")
			}
		})
	}
	token := signed(args, nil)
	result := packageInstall(context.Background(), c, configRaw, verifier, token)
	if !result.OK || result.Data["changed"] != true || result.Data["effect"] != "committed" || result.Data["postcondition"] != "verified" || packageUnknownIntents() || !packagePayloadCheck(p, false) {
		t.Fatal("actual signed native dpkg did not establish complete postconditions")
	}
	before, e := packageNativeSnapshot()
	if e != nil {
		t.Fatal("verified native snapshot unavailable")
	}
	packageAssertRegisteredPreservation(t, registeredBefore, before, p.Package)
	for _, next := range []string{token, signed(args, nil)} {
		r := packageInstall(context.Background(), c, configRaw, verifier, next)
		after, e := packageNativeSnapshot()
		if e != nil || r.OK || !reflect.DeepEqual(before.Digests, after.Digests) {
			t.Fatal("replay or fresh absence request repeated installation")
		}
	}
	current := p.Version
	args.ExpectedInstalledVersion = &current
	noop := packageInstall(context.Background(), c, configRaw, verifier, signed(args, nil))
	if !noop.OK || noop.Data["changed"] != false || noop.Data["effect"] != "none" {
		t.Fatal("exact installed-state verified no-op refused")
	}
	noopNative, e := packageNativeSnapshot()
	if e != nil || !reflect.DeepEqual(before.Files, noopNative.Files) || !reflect.DeepEqual(before.Installed, noopNative.Installed) {
		t.Fatal("verified no-op changed actual native state")
	}
	packageAssertRegisteredPreservation(t, registeredBefore, noopNative, p.Package)
	orphan := packageHelperState + "/staged/pi_cccccccccccccccccccccccccccccccc.deb"
	if packageWriteExclusive(orphan, []byte("owned orphan control")) != nil || !packageUnknownIntents() {
		t.Fatal("orphan preparation was treated as fresh custody")
	}
	blockedOrphan := packageInstall(context.Background(), c, configRaw, verifier, signed(args, nil))
	afterOrphan, e := packageNativeSnapshot()
	if e != nil || blockedOrphan.OK || !reflect.DeepEqual(before.Digests, afterOrphan.Digests) {
		t.Fatal("orphan custody allowed native replay")
	}
	if os.Remove(orphan) != nil || packageSyncDir(filepath.Dir(orphan)) != nil || packageUnknownIntents() {
		t.Fatal("exact owned orphan test restoration failed")
	}
	ref := "pi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	intent := packageIntent{Ref: ref, RequestID: "request_unknown", OperationID: "operation_unknown", GrantJTI: "grant_unknown", ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion, NativeDigests: before.Digests}
	if packageWritePhase(intent, "accepted") != nil || !packageUnknownIntents() {
		t.Fatal("durable unresolved intent was not retained")
	}
	blocked := packageInstall(context.Background(), c, configRaw, verifier, signed(args, nil))
	if blocked.OK || blocked.Data["effect"] != "none" {
		t.Fatal("new JTI escaped unresolved native custody")
	}
	if _, e := os.Stat(filepath.Join(packageHelperState, "intents", ref+".accepted.json")); e != nil {
		t.Fatal("unresolved intent vanished")
	}
}

func TestPackageWireRejectsAncillaryRights(t *testing.T) {
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(t.TempDir(), "socket"), Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	result := make(chan error, 1)
	go func() {
		conn, e := listener.AcceptUnix()
		if e != nil {
			result <- e
			return
		}
		defer conn.Close()
		_, e = packageReadWire(conn, packageWireLimit)
		result <- e
	}()
	client, e := net.DialUnix("unix", nil, listener.Addr().(*net.UnixAddr))
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	f, e := os.Open(os.DevNull)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if _, _, e = client.WriteMsgUnix([]byte(`{"kind":"availability"}`), syscall.UnixRights(int(f.Fd())), nil); e != nil {
		t.Fatal(e)
	}
	client.CloseWrite()
	select {
	case e := <-result:
		if e == nil {
			t.Fatal("ancillary descriptor entered closed request parser")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ancillary refusal did not terminate")
	}
}
func TestPackageNativeDeclaredMountAndACLRefusals(t *testing.T) {
	requirePackageNative(t)
	// Root provisions these exact private acceptance fixtures. It owns their
	// mount/ACL setup and teardown; the test neither mounts nor adopts a path.
	for _, item := range []struct {
		path   string
		parent string
		acl    bool
	}{
		{packageHelperState + "/mount-controls/nested/source", packageHelperState + "/mount-controls", false},
		{packageHelperState + "/mount-controls/file", packageHelperState + "/mount-controls", false},
		{packageHelperState + "/acl-controls/source", "", true},
	} {
		fd, e := syscall.Open(item.path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if e != nil {
			t.Fatal("required actual mount/ACL fixture unavailable")
		}
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) != nil || st.Uid != 0 || st.Mode&0022 != 0 {
			syscall.Close(fd)
			t.Fatal("fixture ordinary ownership must be valid")
		}
		if item.acl {
			n, e := syscall.Getxattr(item.path, "system.posix_acl_access", nil)
			if e != nil || n <= 0 {
				syscall.Close(fd)
				t.Fatal("required actual access ACL missing")
			}
		} else {
			parent, e := syscall.Open(item.parent, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
			if e != nil {
				syscall.Close(fd)
				t.Fatal("mount fixture parent unavailable")
			}
			a, ae := packageMount(fd)
			b, be := packageMount(parent)
			syscall.Close(parent)
			if ae != nil || be != nil || a == b {
				syscall.Close(fd)
				t.Fatal("required actual bind/file mount missing")
			}
		}
		syscall.Close(fd)
		if f, e := packageRootOpen(item.path, syscall.O_RDONLY, 0); e == nil {
			f.Close()
			t.Fatal("actual unexpected mount or ACL custody accepted")
		}
	}
}

// Native direct acceptance reads the genuine original state; it never empties,
// fabricates, repairs or rewrites dpkg registrations/config to obtain a positive.
func packageAssertRegisteredPreservation(t *testing.T, before, after packageNativeState, target string) {
	t.Helper()
	for name, raw := range before.Files {
		if name == "status" || name == "status-old" || name == "info/"+target+".list" || name == "info/"+target+".md5sums" {
			continue
		}
		if !reflect.DeepEqual(raw, after.Files[name]) {
			t.Fatal("actual unrelated native/config/identity bytes changed")
		}
	}
	for name := range after.Files {
		if name != "status" && name != "status-old" && name != "info/"+target+".list" && name != "info/"+target+".md5sums" {
			if _, ok := before.Files[name]; !ok {
				t.Fatal("unexpected native/config/identity record introduced")
			}
		}
	}
	for name, tuple := range before.Installed {
		if name != target && !reflect.DeepEqual(tuple, after.Installed[name]) {
			t.Fatal("unrelated actual installed package tuple changed")
		}
	}
}

func TestPackageNativeReadbackPreservesRegistryAndIdentity(t *testing.T) {
	// Modeled state exercises the actual postcondition helper; this is not a
	// native install, privileged external race or installed-service claim.
	for _, test := range []struct {
		name   string
		mutate func(*packageNativeState)
	}{
		{"diversion bytes changed after child", func(s *packageNativeState) { s.Files["diversions"] = []byte("/srv/one\n/srv/two\ndash\n") }},
		{"trigger interest changed after child", func(s *packageNativeState) { s.Files["triggers/File"] = nil }},
		{"native config changed after child", func(s *packageNativeState) { s.Files["config/dpkg.cfg.d/docker"] = []byte("# changed\n") }},
		{"identity bytes changed after child", func(s *packageNativeState) { s.Files["identity/passwd"] = []byte("root:x:1:0:root:/root:/bin/sh\n") }},
		{"pending native activation introduced after child", func(s *packageNativeState) { s.Files["triggers/Unincorp"] = []byte("ldconfig -\n") }},
		{"unrelated installed tuple changed after child", func(s *packageNativeState) { s.Installed["dash"]["Version"] = "changed" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			files, installed, c, p, deb := packageNativeModel(t)
			before := packageNativeState{Files: files, Installed: installed, Digests: map[string]string{}}
			after := packageNativeState{Files: map[string][]byte{}, Installed: map[string]map[string]string{}, Digests: map[string]string{}}
			for name, raw := range files {
				before.Digests[name] = packageHash(raw)
				after.Files[name] = append([]byte{}, raw...)
			}
			for name, tuple := range installed {
				after.Installed[name] = map[string]string{}
				for key, value := range tuple {
					after.Installed[name][key] = value
				}
			}
			after.Installed[p.Package] = map[string]string{"Status": "install ok installed"}
			for key, value := range deb.Control {
				after.Installed[p.Package][key] = value
			}
			list := []string{"/.", "/opt", "/opt/zenith-packages"}
			for _, f := range p.Payload {
				list = append(list, f.Path)
			}
			after.Files["info/"+p.Package+".list"] = []byte(strings.Join(list, "\n") + "\n")
			for name, raw := range after.Files {
				after.Digests[name] = packageHash(raw)
			}
			if !packageNativeAfter(before, after, p, deb) || !packageNativeAdmits(after.Files, after.Installed, c, p, deb) {
				t.Fatal("unchanged registered model prerequisite refused")
			}
			test.mutate(&after)
			for name, raw := range after.Files {
				after.Digests[name] = packageHash(raw)
			}
			if packageNativeAfter(before, after, p, deb) && packageNativeAdmits(after.Files, after.Installed, c, p, deb) {
				t.Fatal("unexpected native change could be verified")
			}
		})
	}
}

func packageSameHomeFixture(name string, original syscall.Stat_t) bool {
	var current syscall.Stat_t
	return syscall.Lstat(name, &current) == nil && current.Dev == original.Dev && current.Ino == original.Ino && current.Mode == original.Mode && current.Uid == original.Uid && current.Gid == original.Gid && current.Nlink == original.Nlink
}
func packageAssertNativeHomeParents(t *testing.T) {
	t.Helper()
	if _, e := os.Lstat("/nonexistent"); !os.IsNotExist(e) {
		t.Fatal("fixed native HOME parent must begin absent")
	}
	before, e := packageNativeSnapshot()
	if e != nil {
		t.Fatal("original native prerequisites unavailable before HOME controls")
	}
	const target = "/run/zenith-package-home-fixture"
	for _, kind := range []string{"protected directory", "writable directory", "symlink", "regular file"} {
		if _, e := os.Lstat("/nonexistent"); !os.IsNotExist(e) {
			t.Fatal("HOME control cannot adopt an existing path")
		}
		switch kind {
		case "protected directory":
			if os.Mkdir("/nonexistent", 0700) != nil {
				t.Fatal("owned HOME directory setup failed")
			}
		case "writable directory":
			if os.Mkdir("/nonexistent", 0700) != nil || os.Chmod("/nonexistent", 0777) != nil {
				t.Fatal("owned writable HOME setup failed")
			}
		case "symlink":
			if os.Mkdir(target, 0700) != nil || os.Chmod(target, 0777) != nil || os.Symlink(target, "/nonexistent") != nil {
				t.Fatal("owned HOME alias setup failed")
			}
		case "regular file":
			fd, e := syscall.Open("/nonexistent", syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW, 0600)
			if e != nil {
				t.Fatal("owned HOME file setup failed")
			}
			syscall.Close(fd)
		}
		var original, targetOriginal syscall.Stat_t
		if syscall.Lstat("/nonexistent", &original) != nil || original.Uid != 0 || original.Gid != 0 {
			t.Fatal("owned HOME parent identity unavailable")
		}
		if kind == "symlink" && (syscall.Lstat(target, &targetOriginal) != nil || targetOriginal.Uid != 0 || targetOriginal.Gid != 0) {
			t.Fatal("owned HOME target identity unavailable")
		}
		if _, e := packageNativeSnapshot(); e == nil {
			t.Fatal("existing HOME parent supplied native config authority")
		}
		if kind == "writable directory" || kind == "symlink" {
			// Fixed native test-only actor; this cannot grant production exec or
			// helper authority. The genuine installed dash is world-executable,
			// unlike a Go test binary inside a private build directory.
			childCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			child := exec.CommandContext(childCtx, "/usr/bin/dash", "-c", "umask 077; printf '%s\n' 'pre-invoke /usr/bin/false' > /nonexistent/.dpkg.cfg")
			child.Env = ops.SafeEnv()
			child.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 12345, Gid: 12345}}
			e := child.Run()
			cancel()
			if e != nil {
				t.Fatal("independent nonprivileged HOME config writer failed")
			}
			if !packageSameHomeFixture("/nonexistent", original) || (kind == "symlink" && !packageSameHomeFixture(target, targetOriginal)) {
				t.Fatal("owned HOME fixture identity changed")
			}
			var config syscall.Stat_t
			if syscall.Lstat("/nonexistent/.dpkg.cfg", &config) != nil || config.Mode != syscall.S_IFREG|0600 || config.Uid != 12345 || config.Gid != 12345 || config.Nlink != 1 {
				t.Fatal("nonprivileged home config was not genuinely created")
			}
			if _, e := packageNativeSnapshot(); e == nil {
				t.Fatal("late local HOME hook input was accepted")
			}
			if os.Remove("/nonexistent/.dpkg.cfg") != nil {
				t.Fatal("exact owned HOME config restoration failed")
			}
		}
		if !packageSameHomeFixture("/nonexistent", original) || os.Remove("/nonexistent") != nil {
			t.Fatal("exact owned HOME parent restoration failed")
		}
		if kind == "symlink" && (!packageSameHomeFixture(target, targetOriginal) || os.Remove(target) != nil) {
			t.Fatal("exact owned HOME alias target restoration failed")
		}
		after, e := packageNativeSnapshot()
		if e != nil || !reflect.DeepEqual(before.Files, after.Files) || !reflect.DeepEqual(before.Installed, after.Installed) {
			t.Fatal("HOME controls changed original native state or failed restored absence")
		}
	}
}

// These controls mutate only fresh descriptors beneath the already owned native
// fixture. Neither the host/container root nor the actual chroot root is changed.
func packageAssertNativeRootDescriptors(t *testing.T) {
	t.Helper()
	root, e := packageOpenProtectedRoot()
	if e != nil {
		t.Fatal("actual protected root descriptor unavailable")
	}
	defer syscall.Close(root)
	var rootBefore, rootAfter syscall.Stat_t
	if syscall.Fstat(root, &rootBefore) != nil || !packageRootDescriptorSafe(root) {
		t.Fatal("actual root descriptor failed its owning policy")
	}
	before, e := packageNativeSnapshot()
	if e != nil {
		t.Fatal("native state unavailable before private root descriptor controls")
	}
	base := packageHelperState + "/root-descriptor-controls"
	if os.Mkdir(base, 0700) != nil {
		t.Fatal("private root descriptor control must begin absent")
	}
	fd, e := syscall.Open(base, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		t.Fatal("owned directory descriptor unavailable")
	}
	defer syscall.Close(fd)
	var owned syscall.Stat_t
	if syscall.Fstat(fd, &owned) != nil || !packageRootDescriptorSafe(fd) {
		t.Fatal("authentic protected directory control refused")
	}
	for _, mode := range []uint32{0720, 0702, 0777, 01700, 02700, 04700} {
		if syscall.Fchmod(fd, mode) != nil || packageRootDescriptorSafe(fd) {
			t.Fatal("writable or special root descriptor admitted")
		}
		if syscall.Fchmod(fd, 0700) != nil || !packageRootDescriptorSafe(fd) {
			t.Fatal("exact protected descriptor mode restoration failed")
		}
	}
	if syscall.Fchown(fd, 12345, 0) != nil || packageRootDescriptorSafe(fd) {
		t.Fatal("foreign root descriptor owner admitted")
	}
	if syscall.Fchown(fd, 0, 0) != nil || !packageRootDescriptorSafe(fd) {
		t.Fatal("exact protected descriptor owner restoration failed")
	}
	// Linux's real POSIX ACL encoding: owner rwx, named uid r-x, group none,
	// mask r-x and other none. Mode has no group/other write, so ACL is decisive.
	acl := []byte{2, 0, 0, 0, 1, 0, 7, 0, 255, 255, 255, 255, 2, 0, 5, 0, 57, 48, 0, 0, 4, 0, 0, 0, 255, 255, 255, 255, 16, 0, 5, 0, 255, 255, 255, 255, 32, 0, 0, 0, 255, 255, 255, 255}
	for _, name := range []string{"system.posix_acl_access", "system.posix_acl_default"} {
		if syscall.Setxattr(base, name, acl, 0) != nil {
			t.Fatal("actual root descriptor ACL control unavailable")
		}
		var withACL syscall.Stat_t
		if syscall.Fstat(fd, &withACL) != nil || withACL.Mode&0022 != 0 || packageRootDescriptorSafe(fd) {
			t.Fatal("ACL-bearing root descriptor admitted")
		}
		if syscall.Removexattr(base, name) != nil || syscall.Fchmod(fd, 0700) != nil || !packageRootDescriptorSafe(fd) {
			t.Fatal("exact protected descriptor ACL restoration failed")
		}
	}
	file := base + "/file"
	fileFD, e := syscall.Open(file, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e != nil {
		t.Fatal("owned non-directory root descriptor control unavailable")
	}
	fileSafe := packageRootDescriptorSafe(fileFD)
	closeErr := syscall.Close(fileFD)
	if fileSafe || closeErr != nil || os.Remove(file) != nil {
		t.Fatal("non-directory root descriptor admitted or restoration failed")
	}
	if !packageSameHomeFixture(base, owned) || os.Remove(base) != nil {
		t.Fatal("exact owned root descriptor fixture changed or restoration failed")
	}
	if syscall.Fstat(root, &rootAfter) != nil || rootBefore.Dev != rootAfter.Dev || rootBefore.Ino != rootAfter.Ino || rootBefore.Mode != rootAfter.Mode || rootBefore.Uid != rootAfter.Uid || rootBefore.Gid != rootAfter.Gid || !packageRootDescriptorSafe(root) {
		t.Fatal("actual root identity changed during private descriptor controls")
	}
	after, e := packageNativeSnapshot()
	if e != nil || !reflect.DeepEqual(before.Files, after.Files) || !reflect.DeepEqual(before.Installed, after.Installed) {
		t.Fatal("private root descriptor controls changed original native state")
	}
}

func TestPackageNativeEffectivePolicyPreservesRawReadback(t *testing.T) {
	// Modeled postcondition, not installed-host acceptance. Original raw config
	// still participates in every exact native after-child digest comparison.
	files, installed, c, p, deb := packageNativeModel(t)
	files[packageNativeDockerSpeedupKey] = []byte(packageNativeDockerSpeedup)
	if !packageNativeEffectiveAdmits(files, installed, c, p, deb) {
		t.Fatal("observed effective policy refused")
	}
	before := packageNativeState{Files: files, Installed: installed, Digests: map[string]string{}}
	after := packageNativeState{Files: map[string][]byte{}, Installed: map[string]map[string]string{}, Digests: map[string]string{}}
	for name, raw := range files {
		before.Digests[name] = packageHash(raw)
		after.Files[name] = bytes.Clone(raw)
	}
	for name, tuple := range installed {
		after.Installed[name] = map[string]string{}
		for key, value := range tuple {
			after.Installed[name][key] = value
		}
	}
	after.Installed[p.Package] = map[string]string{"Status": "install ok installed"}
	for key, value := range deb.Control {
		after.Installed[p.Package][key] = value
	}
	list := []string{"/.", "/opt", "/opt/zenith-packages"}
	for _, f := range p.Payload {
		list = append(list, f.Path)
	}
	after.Files["info/"+p.Package+".list"] = []byte(strings.Join(list, "\n") + "\n")
	for name, raw := range after.Files {
		after.Digests[name] = packageHash(raw)
	}
	if !packageNativeAfter(before, after, p, deb) || !packageNativeEffectiveAdmits(after.Files, after.Installed, c, p, deb) {
		t.Fatal("exact raw native metadata readback refused")
	}
	after.Files[packageNativeDockerSpeedupKey] = []byte("# changed after child\nforce-unsafe-io\n")
	after.Digests[packageNativeDockerSpeedupKey] = packageHash(after.Files[packageNativeDockerSpeedupKey])
	if packageNativeAfter(before, after, p, deb) {
		t.Fatal("native effective policy waived changed raw config bytes")
	}
}

func TestPackageNativeStatusMultilineHeaders(t *testing.T) {
	// Modeled native status syntax, not a manufactured installed database. Root's
	// read-only dpkg1.21.23 capture has an empty Conffiles first line followed by
	// continuations. No bytes in the actual native fixture are written here.
	const installed = "Package: observed-status\nStatus: install ok installed\nArchitecture: arm64\nVersion: 1\n"
	const continuation = " /etc/observed.conf 00000000000000000000000000000000\n"
	for _, test := range []struct {
		name     string
		raw      string
		parsed   bool
		admitted bool
		conffile string
	}{
		{"observed empty multiline first line preserves continuation bytes", installed + "Conffiles:\n" + continuation + "Description: ordinary native description\n continued description\n", true, true, "\n" + strings.TrimSuffix(continuation, "\n")},
		{"existing space separated empty first line remains compatible", installed + "Conffiles: \n" + continuation, true, true, "\n" + strings.TrimSuffix(continuation, "\n")},
		{"case insensitive recognized native identity remains canonical", "pAcKaGe: observed-status\nsTaTuS: install ok installed\naRcHiTeCtUrE: arm64\nvErSiOn: 1\niNsTaLlEd-SiZe: 0\ncOnFfIlEs:\n" + continuation, true, true, "\n" + strings.TrimSuffix(continuation, "\n")},
		{"duplicate empty field refuses", installed + "Conffiles:\nConffiles:\n" + continuation, false, false, ""},
		{"case variant duplicate empty field refuses", installed + "Conffiles:\nconffiles:\n" + continuation, false, false, ""},
		{"empty first value cannot hide a later duplicate", "Package:\nPackage: observed-status\n", false, false, ""},
		{"case variant duplicate nonempty field refuses", installed + "status: install ok installed\n", false, false, ""},
		{"whitespace inside field name refuses", installed + "Bad Name: value\n", false, false, ""},
		{"comment prefix cannot introduce a field", installed + "#Field: value\n", false, false, ""},
		{"hyphen prefix cannot introduce a field", installed + "-Field: value\n", false, false, ""},
		{"nonempty value without canonical space refuses", "Package:observed-status\n", false, false, ""},
		{"empty field name refuses", installed + ": value\n", false, false, ""},
		{"orphan continuation refuses", " orphan\n" + installed, false, false, ""},
		{"NUL in native field refuses", installed + "Description: value\x00replacement\n", false, false, ""},
		{"carriage return in native field refuses", installed + "Description: value\r\n", false, false, ""},
		{"overlong native line refuses", installed + "Description: " + strings.Repeat("x", 8193) + "\n", false, false, ""},
		{"pending native status remains inadmissible", strings.Replace(installed, "install ok installed", "install ok unpacked", 1), true, false, ""},
		{"missing native status remains inadmissible", strings.Replace(installed, "Status: install ok installed\n", "", 1), true, false, ""},
		{"empty package identity remains inadmissible", strings.Replace(installed, "Package: observed-status\n", "Package:\n", 1), true, false, ""},
		{"missing native architecture remains inadmissible", strings.Replace(installed, "Architecture: arm64\n", "", 1), true, false, ""},
		{"pending triggers remain inadmissible", installed + "Triggers-Pending: ldconfig\n", true, false, ""},
		{"awaited triggers remain inadmissible", installed + "Triggers-Awaited: libc-bin\n", true, false, ""},
		{"lone lowercase pending field cannot hide native trigger work", installed + "triggers-pending: ldconfig\n", true, false, ""},
		{"lone mixed case awaited field cannot hide native trigger work", installed + "tRiGgErS-aWaItEd: libc-bin\n", true, false, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := []byte(test.raw)
			before := bytes.Clone(raw)
			tuple, e := packageStatusControl(raw)
			if (e == nil) != test.parsed || !bytes.Equal(raw, before) {
				t.Fatal("native status grammar or raw-byte preservation changed")
			}
			if e != nil {
				return
			}
			if tuple["Conffiles"] != test.conffile {
				t.Fatal("native multiline value bytes changed")
			}
			if test.admitted && (tuple["Package"] != "observed-status" || tuple["Status"] != "install ok installed" || tuple["Architecture"] != "arm64" || tuple["Version"] != "1") {
				t.Fatal("native recognized field identity changed")
			}
			files, current, _, _, _ := packageNativeModel(t)
			current[tuple["Package"]] = tuple
			if packageNativeRegistrations(files, current) != test.admitted {
				t.Fatal("native installed identity status architecture or pending-state guard changed")
			}
		})
	}
}
