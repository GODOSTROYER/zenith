//go:build linux

package machine

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// Only fixed, operator-provisioned mount anchors may change mount identity.
// Nested/file mounts and volatile/network custody are refused. A privileged
// operator replacing the helper's mounts is outside the supported actor model.
func packageMount(fd int) (string, error) {
	raw, e := os.ReadFile(fmt.Sprintf("/proc/self/fdinfo/%d", fd))
	if e != nil || len(raw) > 4096 {
		return "", packageBad()
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "mnt_id:") {
			id := strings.TrimSpace(strings.TrimPrefix(line, "mnt_id:"))
			if _, e := strconv.ParseUint(id, 10, 64); e == nil {
				return id, nil
			}
		}
	}
	return "", packageBad()
}
func packagePersistent(fd int) bool {
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
func packagePersistentPath(name string) bool {
	for _, root := range []string{packageHelperState, "/var/lib/dpkg", "/opt/zenith-packages"} {
		if name == root || strings.HasPrefix(name, root+"/") {
			return true
		}
	}
	return false
}
func packageMountAnchor(name string) bool {
	switch name {
	case "/usr", "/etc", "/etc/zenithd", "/var/lib/dpkg", packageHelperState, "/opt/zenith-packages", "/run", "/run/zenithd-package-install":
		return true
	}
	return false
}

// The filesystem root is the parent of fixed HOME and every descriptor walk.
// Checking only child components would leave a writable root able to introduce
// an absent HOME after native capture. The descriptor itself supplies authority.
func packageRootDescriptorSafe(fd int) bool {
	var before, after syscall.Stat_t
	if syscall.Fstat(fd, &before) != nil || before.Mode&syscall.S_IFMT != syscall.S_IFDIR || before.Uid != 0 || before.Mode&07022 != 0 {
		return false
	}
	names := make([]byte, 4096)
	n, e := syscall.Listxattr(fmt.Sprintf("/proc/self/fd/%d", fd), names)
	if (e != nil && e != syscall.ENOTSUP) || n < 0 || n > len(names) || bytes.Contains(names[:max(n, 0)], []byte("system.posix_acl_")) {
		return false
	}
	return syscall.Fstat(fd, &after) == nil && before.Dev == after.Dev && before.Ino == after.Ino && before.Mode == after.Mode && before.Uid == after.Uid && before.Gid == after.Gid
}
func packageOpenProtectedRoot() (int, error) {
	fd, e := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		return -1, packageBad()
	}
	if !packageRootDescriptorSafe(fd) {
		syscall.Close(fd)
		return -1, packageBad()
	}
	return fd, nil
}

// Walk descriptors rather than following customer-controlled path aliases.
func packageRootOpen(name string, flags int, mode uint32) (*os.File, error) {
	if !filepath.IsAbs(name) || filepath.Clean(name) != name || name == "/" {
		return nil, packageBad()
	}
	fd, err := packageOpenProtectedRoot()
	if err != nil {
		return nil, err
	}
	mount, e := packageMount(fd)
	if e != nil {
		syscall.Close(fd)
		return nil, e
	}
	parts := strings.Split(strings.TrimPrefix(name, "/"), "/")
	current := ""
	for i, part := range parts {
		current += "/" + part
		nextFlags := syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
		if i == len(parts)-1 {
			nextFlags = flags | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
		}
		next, e := syscall.Openat(fd, part, nextFlags, mode)
		syscall.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
		nextMount, me := packageMount(fd)
		var st syscall.Stat_t
		if me != nil || (mount != nextMount && !packageMountAnchor(current)) || syscall.Fstat(fd, &st) != nil || st.Uid != 0 || st.Mode&07022 != 0 || (st.Mode&syscall.S_IFMT == syscall.S_IFREG && st.Nlink != 1) {
			syscall.Close(fd)
			return nil, packageBad()
		}
		mount = nextMount
		names := make([]byte, 4096)
		n, e := syscall.Listxattr(fmt.Sprintf("/proc/self/fd/%d", fd), names)
		if (e != nil && e != syscall.ENOTSUP) || n < 0 || n > len(names) || bytes.Contains(names[:max(n, 0)], []byte("system.posix_acl_")) {
			syscall.Close(fd)
			return nil, packageBad()
		}
	}
	if packagePersistentPath(name) && !packagePersistent(fd) {
		syscall.Close(fd)
		return nil, packageBad()
	}
	return os.NewFile(uintptr(fd), name), nil
}

func packageRootRead(name string, limit int64) ([]byte, error) {
	f, e := packageRootOpen(name, syscall.O_RDONLY, 0)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	var before, after syscall.Stat_t
	if syscall.Fstat(int(f.Fd()), &before) != nil || before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Size < 0 || before.Size > limit {
		return nil, packageBad()
	}
	raw, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e != nil || int64(len(raw)) != before.Size || syscall.Fstat(int(f.Fd()), &after) != nil || before.Dev != after.Dev || before.Ino != after.Ino || before.Size != after.Size || before.Mode != after.Mode || before.Uid != after.Uid || before.Gid != after.Gid || before.Nlink != after.Nlink || before.Mtim != after.Mtim || before.Ctim != after.Ctim {
		return nil, packageBad()
	}
	return raw, nil
}
func packageSyncDir(name string) error {
	f, e := packageRootOpen(name, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}

func readPackageHelperConfig() (packageHelperConfig, []byte, error) {
	var c packageHelperConfig
	raw, e := packageRootRead(packageHelperConfigPath, 1<<20)
	if e != nil || strictPackageJSON(raw, &c) != nil || !packageHelperConfigValid(c) {
		return c, nil, packageBad()
	}
	return c, raw, nil
}
func packagePeer(c *net.UnixConn, uid uint32) bool {
	raw, e := c.SyscallConn()
	if e != nil {
		return false
	}
	ok := false
	if raw.Control(func(fd uintptr) {
		u, e := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		ok = e == nil && u.Uid == uid
	}) != nil {
		return false
	}
	return ok
}
func packageSocketDirectory() bool {
	f, e := packageRootOpen(filepath.Dir(packageHelperSocket), syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
	if e != nil {
		return false
	}
	f.Close()
	return true
}
func packageHelperRoundTrip(ctx context.Context, request packageWireRequest) (packageWireResponse, error) {
	var response packageWireResponse
	if !packageSocketDirectory() {
		return response, packageBad()
	}
	st, e := os.Lstat(packageHelperSocket)
	if e != nil || st.Mode()&os.ModeSocket == 0 || st.Mode().Perm() != 0600 {
		return response, packageBad()
	}
	raw, e := json.Marshal(request)
	if e != nil || len(raw) > packageWireLimit {
		return response, packageBad()
	}
	d := net.Dialer{}
	conn, e := d.DialContext(ctx, "unix", packageHelperSocket)
	if e != nil {
		return response, e
	}
	defer conn.Close()
	uc, ok := conn.(*net.UnixConn)
	if !ok || !packagePeer(uc, 0) {
		return response, packageBad()
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(2 * time.Second)
	}
	if conn.SetDeadline(deadline) != nil {
		return response, packageBad()
	}
	// Cancellation interrupts a blocked socket without making an effect claim.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()
	if _, e = conn.Write(append(raw, '\n')); e != nil {
		return response, e
	}
	if uc.CloseWrite() != nil {
		return response, packageBad()
	}
	reply, e := packageReadWire(uc, 8192)
	if e != nil || strictPackageJSON(reply, &response) != nil {
		return response, packageBad()
	}
	return response, nil
}

// Ancillary messages are outside this closed protocol. Close any received
// rights immediately, then refuse without decoding or entering an operation.
func packageReadWire(conn *net.UnixConn, limit int) ([]byte, error) {
	out := make([]byte, 0, limit)
	data := make([]byte, 4096)
	control := make([]byte, syscall.CmsgSpace(16*4))
	for {
		n, oob, flags, _, e := conn.ReadMsgUnix(data, control)
		if oob > 0 || flags&syscall.MSG_CTRUNC != 0 {
			messages, _ := syscall.ParseSocketControlMessage(control[:oob])
			for _, message := range messages {
				rights, _ := syscall.ParseUnixRights(&message)
				for _, fd := range rights {
					syscall.Close(fd)
				}
			}
			return nil, packageBad()
		}
		if n > 0 {
			if len(out)+n > limit {
				return nil, packageBad()
			}
			out = append(out, data[:n]...)
		}
		if e == io.EOF {
			return out, nil
		}
		if e != nil {
			return nil, e
		}
		if n == 0 {
			return out, nil
		}
	}
}

type packageNativeState struct {
	Files     map[string][]byte
	Digests   map[string]string
	Installed map[string]map[string]string
}

func packageNativeSnapshot() (packageNativeState, error) {
	return packageNativeSnapshotContext(context.Background())
}
func packageNativeSnapshotContext(ctx context.Context) (packageNativeState, error) {
	s := packageNativeState{Files: map[string][]byte{}, Digests: map[string]string{}, Installed: map[string]map[string]string{}}
	if ctx.Err() != nil {
		return s, packageBad()
	}
	// SafeEnv fixes HOME=/nonexistent. Require that parent itself absent beneath
	// protected root: a writable directory or alias could let another local
	// writer introduce .dpkg.cfg after this snapshot, before dpkg loads it.
	root, e := packageOpenProtectedRoot()
	if e != nil {
		return s, e
	}
	defer syscall.Close(root)
	home, e := syscall.Openat(root, "nonexistent", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e == nil {
		syscall.Close(home)
		return s, packageBad()
	}
	if e != syscall.ENOENT || !packageRootDescriptorSafe(root) {
		return s, packageBad()
	}
	total := int64(0)
	var walk func(string) error
	walk = func(dir string) error {
		f, e := packageRootOpen(dir, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
		if e != nil {
			return e
		}
		entries, e := f.ReadDir(4097)
		f.Close()
		if (e != nil && e != io.EOF) || len(entries) > 4096 {
			return packageBad()
		}
		for _, entry := range entries {
			name := filepath.Join(dir, entry.Name())
			rel := strings.TrimPrefix(name, "/var/lib/dpkg/")
			// Closing another descriptor for either lock inode would release POSIX locks.
			if rel == "lock" || rel == "lock-frontend" || rel == "triggers/Lock" {
				continue
			}
			if entry.IsDir() {
				if e := walk(name); e != nil {
					return e
				}
				continue
			}
			if !entry.Type().IsRegular() {
				return packageBad()
			}
			raw, e := packageRootRead(name, 2<<20)
			if e != nil {
				return e
			}
			total += int64(len(raw))
			if total > 16<<20 || len(s.Files) >= 8192 {
				return packageBad()
			}
			if strings.HasPrefix(rel, "updates/") && len(raw) > 0 {
				return packageBad()
			}
			s.Files[rel] = raw
			s.Digests[rel] = packageHash(raw)
		}
		return nil
	}
	if e := walk("/var/lib/dpkg"); e != nil {
		return s, e
	}
	cfg, e := packageRootRead("/etc/dpkg/dpkg.cfg", 65536)
	if e != nil {
		return s, e
	}
	configs := map[string][]byte{"dpkg.cfg": cfg}
	dir, e := packageRootOpen("/etc/dpkg/dpkg.cfg.d", syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
	if e != nil {
		return s, e
	}
	entries, e := dir.ReadDir(65)
	dir.Close()
	if (e != nil && e != io.EOF) || len(entries) > 64 {
		return s, packageBad()
	}
	for _, entry := range entries {
		if entry.IsDir() {
			return s, packageBad()
		}
		raw, e := packageRootRead("/etc/dpkg/dpkg.cfg.d/"+entry.Name(), 65536)
		if e != nil {
			return s, e
		}
		configs["dpkg.cfg.d/"+entry.Name()] = raw
	}
	for name, raw := range configs {
		s.Files["config/"+name] = raw
		s.Digests["config/"+name] = packageHash(raw)
	}
	// Named statoverride identities are admitted only from actual protected
	// local files with a files-first NSS contract. These exact inputs join the
	// immutable snapshot/backup and must survive the native child unchanged.
	if len(s.Files["statoverride"]) != 0 {
		for _, name := range []string{"passwd", "group", "nsswitch.conf"} {
			raw, e := packageRootRead("/etc/"+name, 1<<20)
			if e != nil {
				return s, e
			}
			s.Files["identity/"+name] = raw
			s.Digests["identity/"+name] = packageHash(raw)
		}
	}
	for _, block := range bytes.Split(s.Files["status"], []byte("\n\n")) {
		if len(bytes.TrimSpace(block)) == 0 {
			continue
		}
		m, e := packageStatusControl(block)
		if e != nil || m["Package"] == "" || (m["Status"] != "install ok installed" && m["Status"] != "hold ok installed") || m["Triggers-Pending"] != "" || m["Triggers-Awaited"] != "" || s.Installed[m["Package"]] != nil {
			return s, packageBad()
		}
		s.Installed[m["Package"]] = m
	}
	if !packageNativeEffectiveRegistrations(s.Files, s.Installed) {
		return s, packageBad()
	}
	if bytes.Equal(s.Files[packageNativeDockerSpeedupKey], []byte(packageNativeDockerSpeedup)) && !packageNativeEffectiveSafeIO(ctx) {
		return s, packageBad()
	}
	if ctx.Err() != nil {
		return s, packageBad()
	}
	return s, nil
}

// The exact observed Docker default is admitted only after this fixed read-only
// native observation confirms the same safe options used by the real install.
func packageNativeEffectiveSafeIO(parent context.Context) bool {
	command := packageNativeInstallCommand(packageNativePolicyStage)
	if !packageNativeSafeCommand(command) {
		return false
	}
	command.Args = []string{command.Args[0], command.Args[1], "--force-help"}
	command.MaxStdout = 65536
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	result, e := (ops.ExecRunner{}).Run(ctx, command)
	return e == nil && ctx.Err() == nil && result.ExitCode == 0 && !result.StdoutTrunc && !result.StderrTrunc && packageNativeSafeFlags(result.Stdout)
}
func packageStatusControl(raw []byte) (map[string]string, error) {
	// Native installed descriptions may contain continuation lines. They are
	// opaque comparison data, never arguments or permissions.
	m := map[string]string{}
	seen := map[string]bool{}
	last := ""
	for _, line := range strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n") {
		if len(line) > 8192 || strings.ContainsAny(line, "\x00\r") {
			return nil, packageBad()
		}
		if strings.HasPrefix(line, " ") {
			if last == "" {
				return nil, packageBad()
			}
			m[last] += "\n" + line
			continue
		}
		i := strings.IndexByte(line, ':')
		if i < 1 || (i+1 < len(line) && line[i+1] != ' ') {
			return nil, packageBad()
		}
		name := line[:i]
		if name[0] == '#' || name[0] == '-' {
			return nil, packageBad()
		}
		for _, c := range name {
			if c < 33 || c > 126 || c == ':' {
				return nil, packageBad()
			}
		}
		key := strings.ToLower(name)
		if seen[key] {
			return nil, packageBad()
		}
		seen[key] = true
		last = name
		// Native field names are case-insensitive. Normalize recognized
		// installed identity/readback fields so a lone spelling variant cannot
		// hide a missing identity, pending trigger or mismatched version.
		switch key {
		case "package":
			last = "Package"
		case "status":
			last = "Status"
		case "architecture":
			last = "Architecture"
		case "version":
			last = "Version"
		case "installed-size":
			last = "Installed-Size"
		case "conffiles":
			last = "Conffiles"
		case "triggers-pending":
			last = "Triggers-Pending"
		case "triggers-awaited":
			last = "Triggers-Awaited"
		}
		// dpkg's multiline Conffiles first line ends at the colon; native
		// continuation bytes follow. A space remains required before a value.
		m[last] = ""
		if i+1 < len(line) {
			m[last] = line[i+2:]
		}
	}
	return m, nil
}

func packageNativeTarget(s packageNativeState, p ops.PackageInstallProfile, deb pinnedDeb) bool {
	target := s.Installed[p.Package]
	if target == nil || target["Status"] != "install ok installed" || target["Version"] != p.Version || target["Architecture"] != p.Architecture {
		return false
	}
	for k, v := range target {
		if k == "Status" || k == "Installed-Size" {
			continue
		}
		if deb.Control[k] != v {
			return false
		}
	}
	for k, v := range deb.Control {
		if target[k] != v {
			return false
		}
	}
	allowed := map[string]bool{"info/" + p.Package + ".list": true, "info/" + p.Package + ".md5sums": true}
	for k := range s.Files {
		if strings.HasPrefix(k, "info/"+p.Package+".") && !allowed[k] {
			return false
		}
	}
	list, ok := s.Files["info/"+p.Package+".list"]
	if !ok {
		return false
	}
	expected := map[string]bool{"/.": true, "/opt": true, "/opt/zenith-packages": true}
	for _, f := range p.Payload {
		expected[f.Path] = true
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSuffix(string(list), "\n"), "\n") {
		if !expected[line] || seen[line] {
			return false
		}
		seen[line] = true
	}
	for _, f := range p.Payload {
		if !seen[f.Path] {
			return false
		}
	}
	return true
}
func packageNativeAfter(before, after packageNativeState, p ops.PackageInstallProfile, deb pinnedDeb) bool {
	if !packageNativeTarget(after, p, deb) || len(after.Installed) != len(before.Installed)+1 {
		return false
	}
	for k, v := range before.Installed {
		if k != p.Package && !reflect.DeepEqual(v, after.Installed[k]) {
			return false
		}
	}
	allowed := map[string]bool{"status": true, "status-old": true, "info/" + p.Package + ".list": true, "info/" + p.Package + ".md5sums": true}
	for k, v := range before.Digests {
		if !allowed[k] && after.Digests[k] != v {
			return false
		}
	}
	for k, v := range after.Digests {
		if !allowed[k] && before.Digests[k] != v {
			return false
		}
	}
	return true
}

func packagePayloadCheck(p ops.PackageInstallProfile, absent bool) bool {
	for _, entry := range p.Payload {
		st, e := os.Lstat(entry.Path)
		if absent {
			if e == nil || !os.IsNotExist(e) {
				return false
			}
			continue
		}
		if e != nil {
			return false
		}
		f, e := packageRootOpen(entry.Path, syscall.O_RDONLY, 0)
		if e != nil {
			return false
		}
		actual, e := f.Stat()
		if e != nil {
			f.Close()
			return false
		}
		wantMode := os.FileMode(0644)
		if entry.Mode == "0755" {
			wantMode = 0755
		}
		if actual.Mode().Perm() != wantMode || (entry.Kind == "directory") != actual.IsDir() {
			f.Close()
			return false
		}
		if entry.Kind == "file" {
			raw, e := io.ReadAll(io.LimitReader(f, entry.Bytes+1))
			if e != nil || int64(len(raw)) != entry.Bytes || packageHash(raw) != entry.SHA256 {
				f.Close()
				return false
			}
		}
		f.Close()
		_ = st
	}
	return true
}

type packageIntent struct {
	Ref            string            `json:"ref"`
	RequestID      string            `json:"requestId"`
	OperationID    string            `json:"operationId"`
	GrantJTI       string            `json:"grantJti"`
	ProfileRef     string            `json:"profileRef"`
	ProfileVersion string            `json:"profileVersion"`
	Phase          string            `json:"phase"`
	NativeDigests  map[string]string `json:"nativeDigests"`
}

func packageWriteExclusive(name string, raw []byte) error {
	f, e := packageRootOpen(name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(raw)
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return packageSyncDir(filepath.Dir(name))
}
func packageWritePhase(intent packageIntent, phase string) error {
	intent.Phase = phase
	raw, e := json.Marshal(intent)
	if e != nil || len(raw) >= 1<<20 {
		return packageBad()
	}
	return packageWriteExclusive(packageHelperState+"/intents/"+intent.Ref+"."+phase+".json", append(raw, '\n'))
}
func packageUnknownIntents() bool {
	f, e := packageRootOpen(packageHelperState+"/intents", syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
	if e != nil {
		return true
	}
	entries, e := f.ReadDir(4097)
	f.Close()
	if (e != nil && e != io.EOF) || len(entries) > 4096 {
		return true
	}
	accepted, verified := map[string]packageIntent{}, map[string]packageIntent{}
	for _, entry := range entries {
		raw, e := packageRootRead(packageHelperState+"/intents/"+entry.Name(), 1<<20)
		var intent packageIntent
		if e != nil || strictPackageJSON(raw, &intent) != nil || !packageIntentRef(intent.Ref) || entry.Name() != intent.Ref+"."+intent.Phase+".json" || (intent.Phase != "accepted" && intent.Phase != "verified") {
			return true
		}
		if !protocol.ValidID(intent.RequestID) || !protocol.ValidID(intent.OperationID) || !protocol.ValidID(intent.GrantJTI) || intent.ProfileRef == "" || len(intent.ProfileVersion) != 64 || len(intent.NativeDigests) == 0 || len(intent.NativeDigests) > 8192 {
			return true
		}
		intent.Phase = ""
		if strings.HasSuffix(entry.Name(), ".accepted.json") {
			accepted[intent.Ref] = intent
		} else {
			verified[intent.Ref] = intent
		}
	}
	for ref, intent := range accepted {
		other, ok := verified[ref]
		if !ok || !reflect.DeepEqual(intent, other) {
			return true
		}
	}
	for ref := range verified {
		if _, ok := accepted[ref]; !ok {
			return true
		}
	}
	// A preparation that died before its accepted record is still custody. Do
	// not delete it or infer that a new signed request may safely take its place.
	for _, kind := range []string{"staged", "backups"} {
		dir, e := packageRootOpen(packageHelperState+"/"+kind, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
		if e != nil {
			return true
		}
		items, e := dir.ReadDir(4097)
		dir.Close()
		if (e != nil && e != io.EOF) || len(items) > 4096 {
			return true
		}
		for _, item := range items {
			ref := item.Name()
			if kind == "staged" {
				ref = strings.TrimSuffix(ref, ".deb")
				if item.Name() != ref+".deb" || !item.Type().IsRegular() {
					return true
				}
			} else if !item.IsDir() {
				return true
			}
			if !packageIntentRef(ref) {
				return true
			}
			if _, ok := accepted[ref]; !ok {
				return true
			}
		}
	}
	return false
}

// This is a fixed storage admission bound, not a retention/pruning policy.
// Every retained intent, stage and backup counts, even after verified success.
func packageCustodyBytes() (int64, error) {
	total := int64(0)
	files := 0
	var scan func(string, int) error
	scan = func(name string, depth int) error {
		if depth > 2 {
			return packageBad()
		}
		dir, e := packageRootOpen(name, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
		if e != nil {
			return e
		}
		entries, e := dir.ReadDir(4097)
		dir.Close()
		if (e != nil && e != io.EOF) || len(entries) > 4096 {
			return packageBad()
		}
		for _, entry := range entries {
			path := filepath.Join(name, entry.Name())
			if entry.IsDir() {
				if e := scan(path, depth+1); e != nil {
					return e
				}
				continue
			}
			if !entry.Type().IsRegular() {
				return packageBad()
			}
			f, e := packageRootOpen(path, syscall.O_RDONLY, 0)
			if e != nil {
				return e
			}
			st, e := f.Stat()
			f.Close()
			if e != nil || st.Size() < 0 {
				return packageBad()
			}
			total += st.Size()
			files++
			if total > 64<<20 || files > 32768 {
				return packageBad()
			}
		}
		return nil
	}
	for _, kind := range []string{"intents", "staged", "backups"} {
		if e := scan(packageHelperState+"/"+kind, 0); e != nil {
			return 0, e
		}
	}
	return total, nil
}

func packageIntentRef(ref string) bool {
	if !strings.HasPrefix(ref, "pi_") || len(ref) != 35 {
		return false
	}
	raw, e := hex.DecodeString(ref[3:])
	return e == nil && len(raw) == 16 && ref == "pi_"+hex.EncodeToString(raw)
}

func packageStrictReplay() error {
	// Inspect framing before FileReplayCache can ignore or compact torn records.
	raw, e := packageRootRead(packageHelperState+"/replay.jsonl", 4<<20)
	if os.IsNotExist(e) {
		return packageWriteExclusive(packageHelperState+"/replay.jsonl", nil)
	}
	if e != nil {
		return e
	}
	if len(raw) > 0 && raw[len(raw)-1] != '\n' {
		return packageBad()
	}
	for _, line := range bytes.Split(bytes.TrimSuffix(raw, []byte("\n")), []byte("\n")) {
		if len(line) == 0 {
			if len(raw) == 0 {
				continue
			}
			return packageBad()
		}
		var item struct {
			K string `json:"k"`
			E int64  `json:"e"`
		}
		if strictPackageJSON(line, &item) != nil || !strings.HasPrefix(item.K, "mreq:") || !protocol.ValidID(strings.TrimPrefix(item.K, "mreq:")) || item.E <= 0 {
			return packageBad()
		}
	}
	return nil
}

func packageSupportedHost(ctx context.Context) bool {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return false
	}
	release, e := packageRootRead("/usr/lib/os-release", 16384)
	if e != nil {
		return false
	}
	fields := map[string]string{}
	for _, line := range strings.Split(string(release), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if ok {
			fields[k] = strings.Trim(v, "\"")
		}
	}
	if fields["ID"] != "debian" || fields["VERSION_ID"] != "12" {
		return false
	}
	f, e := packageRootOpen("/usr/bin/dpkg", syscall.O_RDONLY, 0)
	if e != nil {
		return false
	}
	f.Close()
	result, e := (ops.ExecRunner{}).Run(ctx, ops.CmdSpec{Path: "/usr/bin/dpkg", Args: []string{"--version"}, Env: ops.SafeEnv(), MaxStdout: 4096, MaxStderr: 0})
	return e == nil && result.ExitCode == 0 && !result.StdoutTrunc && bytes.Contains(result.Stdout, []byte("version 1.21."))
}

func packagePayloadRoot() bool {
	for _, name := range []string{"/opt", "/opt/zenith-packages"} {
		f, e := packageRootOpen(name, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
		if e != nil {
			return false
		}
		st, e := f.Stat()
		f.Close()
		if e != nil || st.Mode().Perm() != 0755 {
			return false
		}
	}
	return true
}
func packageForeignClaims(before packageNativeState, p ops.PackageInstallProfile) bool {
	base := "/opt/zenith-packages/" + p.ProfileRef
	for name, content := range before.Files {
		if strings.HasPrefix(name, "info/") && strings.HasSuffix(name, ".list") && name != "info/"+p.Package+".list" {
			for _, line := range strings.Split(string(content), "\n") {
				if line == base || strings.HasPrefix(line, base+"/") {
					return true
				}
			}
		}
	}
	return false
}

func packageReady(ctx context.Context, c packageHelperConfig) bool {
	if !packageHelperConfigValid(c) || packageUnknownIntents() || !packageSupportedHost(ctx) {
		return false
	}
	if _, e := packageCustodyBytes(); e != nil {
		return false
	}
	lock, e := packageRootOpen("/var/lib/dpkg/lock-frontend", syscall.O_RDWR, 0)
	if e != nil {
		return false
	}
	defer lock.Close()
	flock := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: 0, Len: 0}
	if syscall.FcntlFlock(lock.Fd(), syscall.F_SETLK, &flock) != nil {
		return false
	}
	native, e := packageNativeSnapshotContext(ctx)
	if e != nil {
		return false
	}
	if !packagePayloadRoot() {
		return false
	}
	for _, p := range c.PackageInstall.Profiles {
		if ctx.Err() != nil || p.Architecture != runtime.GOARCH {
			return false
		}
		raw, e := packageRootRead(p.SourcePath, p.ArchiveBytes)
		if e != nil || packageForeignClaims(native, p) {
			return false
		}
		deb, e := parsePinnedDeb(raw, p)
		if e != nil || !packageNativeEffectiveAdmits(native.Files, native.Installed, c, p, deb) {
			return false
		}
		if native.Installed[p.Package] != nil {
			if !packageNativeTarget(native, p, deb) || !packagePayloadCheck(p, false) {
				return false
			}
		} else if !packagePayloadCheck(p, true) {
			return false
		}
	}
	return ctx.Err() == nil
}

func packageInstall(ctx context.Context, c packageHelperConfig, configRaw []byte, verifier *protocol.Verifier, token string) ops.Result {
	none := ops.PackageInstallFailure("none", "")
	if packageUnknownIntents() {
		return none
	}
	vm, e := verifier.VerifyMachine(token, protocol.Self{ID: c.MachineID, WorkspaceID: c.WorkspaceID}, func(env *protocol.MachineEnvelope) error {
		if env.Operation != ops.OpPackageInstall {
			return protocol.Errorf(protocol.CodeNotAllowed, "package helper accepts only package.install")
		}
		return nil
	})
	if e == nil && packageSyncDir(packageHelperState) != nil {
		return none
	}
	if e != nil || !protocol.ValidID(vm.Envelope.OperationID) || !protocol.ValidID(vm.Grant.JTI) || vm.Grant.Res == "" || len(vm.Grant.Res) > 128 || ops.ValidatePackageInstallConstraints(vm.Envelope.Args, vm.Grant.Constraints) != nil {
		return none
	}
	args, e := ops.ParsePackageInstallArgs(vm.Envelope.Args)
	if e != nil {
		return none
	}
	var p ops.PackageInstallProfile
	for _, profile := range c.PackageInstall.Profiles {
		if profile.ProfileRef == args.ProfileRef && profile.ProfileVersion == args.ProfileVersion {
			p = profile
		}
	}
	if p.ProfileRef == "" || p.Architecture != runtime.GOARCH {
		return none
	}
	timeout := vm.Envelope.TimeoutSec
	if timeout < 1 || timeout > 300 || vm.Envelope.MaxOutputBytes < 2048 {
		return none
	}
	for key, value := range vm.Grant.Constraints {
		n := int(value.(float64))
		if key == "maxTimeoutSec" {
			timeout = min(timeout, n)
		} else if key == "maxOutputBytes" && n < 2048 {
			return none
		}
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	if !packageSupportedHost(ctx) {
		return none
	}
	lock, e := packageRootOpen("/var/lib/dpkg/lock-frontend", syscall.O_RDWR, 0)
	if e != nil {
		return none
	}
	defer lock.Close()
	flock := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: 0, Start: 0, Len: 0}
	// Native dpkg frontend protocol is a POSIX fcntl lock, never flock.
	if syscall.FcntlFlock(lock.Fd(), syscall.F_SETLK, &flock) != nil {
		return none
	}
	before, e := packageNativeSnapshotContext(ctx)
	if e != nil || ctx.Err() != nil {
		return none
	}
	if !packagePayloadRoot() || packageForeignClaims(before, p) {
		return none
	}
	raw, e := packageRootRead(p.SourcePath, p.ArchiveBytes)
	if e != nil {
		return none
	}
	deb, e := parsePinnedDeb(raw, p)
	if e != nil || !packageNativeEffectiveAdmits(before.Files, before.Installed, c, p, deb) {
		return none
	}
	if current := before.Installed[p.Package]; current != nil {
		if args.ExpectedInstalledVersion == nil || *args.ExpectedInstalledVersion != p.Version || current["Version"] != p.Version || current["Architecture"] != p.Architecture || current["Status"] != "install ok installed" || !packageNativeTarget(before, p, deb) || !packagePayloadCheck(p, false) {
			return none
		}
		final, e := packageNativeSnapshotContext(ctx)
		if e != nil || !reflect.DeepEqual(final.Digests, before.Digests) || !packageNativeEffectiveAdmits(final.Files, final.Installed, c, p, deb) || !packageNativeTarget(final, p, deb) || !packagePayloadCheck(p, false) || !packageCurrent(c, configRaw, vm, p) || ctx.Err() != nil {
			return none
		}
		return ops.Result{OK: true, Data: map[string]any{"profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion, "package": p.Package, "version": p.Version, "changed": false, "phase": "verified", "effect": "none", "postcondition": "verified"}}
	}
	if args.ExpectedInstalledVersion != nil || !packagePayloadCheck(p, true) {
		return none
	}
	retained, e := packageCustodyBytes()
	if e != nil {
		return none
	}
	reserve := int64(len(raw))
	for _, body := range before.Files {
		reserve += int64(len(body))
	}
	intentRaw, e := json.Marshal(packageIntent{NativeDigests: before.Digests})
	if e != nil || len(intentRaw) >= 1<<20 {
		return none
	}
	reserve += 2 * int64(len(intentRaw)+4096)
	if retained+reserve > 64<<20 {
		return none
	}
	id := make([]byte, 16)
	if _, e := rand.Read(id); e != nil {
		return none
	}
	ref := "pi_" + hex.EncodeToString(id)
	staged := packageHelperState + "/staged/" + ref + ".deb"
	if packageWriteExclusive(staged, raw) != nil {
		return none
	}
	// The staged inode is root-only, fsynced and exact. Fixed argv never reopens
	// the customer source path. Direct privileged writers are an excluded actor.
	stagedRaw, e := packageRootRead(staged, p.ArchiveBytes)
	if e != nil || !bytes.Equal(stagedRaw, raw) {
		return none
	}
	backup := packageHelperState + "/backups/" + ref
	if e = os.Mkdir(backup, 0700); e != nil {
		return none
	}
	if packageSyncDir(filepath.Dir(backup)) != nil {
		return none
	}
	names := make([]string, 0, len(before.Files))
	for name := range before.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	// Backup filenames are hashes, not reopenings of any lock inode.
	for _, name := range names {
		if packageWriteExclusive(backup+"/"+packageHash([]byte(name)), before.Files[name]) != nil {
			return none
		}
	}
	intent := packageIntent{ref, vm.Envelope.JTI, vm.Envelope.OperationID, vm.Grant.JTI, p.ProfileRef, p.ProfileVersion, "accepted", before.Digests}
	if packageWritePhase(intent, "accepted") != nil {
		return ops.PackageInstallFailure("unknown", ref)
	}
	// Any refusal from this point retains unknown intent, including current profile
	// or time loss before child entry. It cannot become fresh through a new JTI.
	unknown := ops.PackageInstallFailure("unknown", ref)
	if !packageCurrent(c, configRaw, vm, p) || ctx.Err() != nil {
		return unknown
	}
	final, e := packageNativeSnapshotContext(ctx)
	if e != nil || !reflect.DeepEqual(final.Digests, before.Digests) || !packageNativeEffectiveAdmits(final.Files, final.Installed, c, p, deb) || !packagePayloadRoot() || packageForeignClaims(final, p) || !packagePayloadCheck(p, true) {
		return unknown
	}
	finalArchive, e := packageRootRead(staged, p.ArchiveBytes)
	if e != nil || packageHash(finalArchive) != p.SHA256 {
		return unknown
	}
	command := packageNativeInstallCommand(staged)
	if !packageNativeSafeCommand(command) || !packageCurrent(c, configRaw, vm, p) || ctx.Err() != nil {
		return unknown
	}
	result, e := (ops.ExecRunner{}).Run(ctx, command)
	if e != nil || ctx.Err() != nil || result.ExitCode != 0 {
		return unknown
	}
	after, e := packageNativeSnapshotContext(ctx)
	if e != nil || !packageNativeAfter(before, after, p, deb) || !packageNativeEffectiveAdmits(after.Files, after.Installed, c, p, deb) || !packagePayloadCheck(p, false) || !packageCurrent(c, configRaw, vm, p) {
		return unknown
	}
	if packageWritePhase(intent, "verified") != nil {
		return unknown
	}
	return ops.Result{OK: true, Data: map[string]any{"profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion, "package": p.Package, "version": p.Version, "changed": true, "phase": "verified", "effect": "committed", "postcondition": "verified", "transactionRef": ref}}
}
func packageCurrent(c packageHelperConfig, raw []byte, vm *protocol.VerifiedMachine, p ops.PackageInstallProfile) bool {
	current, currentRaw, e := readPackageHelperConfig()
	if e != nil || !bytes.Equal(raw, currentRaw) || !reflect.DeepEqual(c, current) {
		return false
	}
	now := time.Now().Unix()
	if now >= vm.Envelope.EXP || now >= vm.Grant.EXP || now < vm.Envelope.IAT-60 || now < vm.Grant.IAT-60 {
		return false
	}
	version, e := ops.PackageInstallProfileVersion(p)
	return e == nil && version == p.ProfileVersion
}

func runPackageHelper(ctx context.Context) error {
	if os.Geteuid() != 0 {
		return packageBad()
	}
	c, _, e := readPackageHelperConfig()
	if e != nil {
		return e
	}
	// All custody directories must be installed explicitly by the local operator.
	for _, dir := range []string{packageHelperState, packageHelperState + "/intents", packageHelperState + "/backups", packageHelperState + "/staged", packageHelperState + "/archives", filepath.Dir(packageHelperSocket)} {
		f, e := packageRootOpen(dir, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
		if e != nil {
			return e
		}
		st, e := f.Stat()
		f.Close()
		if e != nil || (strings.HasPrefix(dir, packageHelperState) && st.Mode().Perm() != 0700) {
			return packageBad()
		}
	}
	lifetime, e := packageRootOpen(packageHelperState+"/lifetime.lock", syscall.O_RDWR|syscall.O_CREAT, 0600)
	if e != nil {
		return e
	}
	defer lifetime.Close()
	if syscall.Flock(int(lifetime.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return packageBad()
	}
	// Acquire cross-process custody before reading or opening replay/intent state.
	if packageUnknownIntents() || packageStrictReplay() != nil {
		return packageBad()
	}
	replay, e := protocol.OpenFileReplayCache(packageHelperState+"/replay.jsonl", time.Now)
	if e != nil {
		return packageBad()
	}
	defer replay.Close()
	if packageSyncDir(packageHelperState) != nil {
		return packageBad()
	}
	if _, e = os.Lstat(packageHelperSocket); !os.IsNotExist(e) {
		return packageBad()
	} // no stale socket adoption/deletion
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: packageHelperSocket, Net: "unix"})
	if e != nil {
		return packageBad()
	}
	defer listener.Close()
	listener.SetUnlinkOnClose(true)
	var original, secured, owned syscall.Stat_t
	if syscall.Lstat(packageHelperSocket, &original) != nil || original.Mode&syscall.S_IFMT != syscall.S_IFSOCK || original.Uid != 0 || original.Gid != 0 || original.Nlink != 1 {
		return packageBad()
	}
	// Set the private mode while root still owns the fresh socket. The dedicated
	// unit needs only CAP_CHOWN for the following transfer, never CAP_FOWNER.
	if os.Chmod(packageHelperSocket, 0600) != nil || syscall.Lstat(packageHelperSocket, &secured) != nil || secured.Dev != original.Dev || secured.Ino != original.Ino || secured.Mode != syscall.S_IFSOCK|0600 || secured.Uid != 0 || secured.Gid != 0 || secured.Nlink != 1 {
		return packageBad()
	}
	if os.Chown(packageHelperSocket, int(c.DaemonUID), 0) != nil || syscall.Lstat(packageHelperSocket, &owned) != nil || owned.Dev != original.Dev || owned.Ino != original.Ino || owned.Mode != syscall.S_IFSOCK|0600 || owned.Uid != c.DaemonUID || owned.Gid != 0 || owned.Nlink != 1 {
		return packageBad()
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			listener.Close()
		case <-done:
		}
	}()
	for {
		conn, e := listener.AcceptUnix()
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return packageBad()
		}
		func() {
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(310 * time.Second))
			current, raw, e := readPackageHelperConfig()
			if e != nil || current.DaemonUID != c.DaemonUID || !packagePeer(conn, current.DaemonUID) {
				return
			}
			input, e := packageReadWire(conn, packageWireLimit)
			var request packageWireRequest
			if e != nil || strictPackageJSON(input, &request) != nil {
				return
			}
			reply := packageWireResponse{MachineID: current.MachineID, WorkspaceID: current.WorkspaceID}
			switch request.Kind {
			case "availability":
				if request.Token != "" {
					return
				}
				readyCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
				reply.Ready = packageReady(readyCtx, current)
				cancel()
				if reply.Ready {
					reply.Profiles = packageMetadata(current)
				}
			case "install":
				if request.Token == "" {
					return
				}
				keys, e := protocol.NewKeySet(current.Keys)
				if e != nil {
					return
				}
				v := &protocol.Verifier{Keys: keys, Now: time.Now, Replay: replay}
				result := packageInstall(ctx, current, raw, v, request.Token)
				reply.Result = &result
			default:
				return
			}
			encoded, e := json.Marshal(reply)
			if e == nil && len(encoded) <= 8192 {
				conn.Write(append(encoded, '\n'))
			}
		}()
	}
}
