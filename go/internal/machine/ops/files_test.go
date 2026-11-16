package ops_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

type fileEnv struct {
	root    string // the allowed directory
	outside string // a directory NOT in the allowlist
	state   string
	env     *ops.Env
}

func newFileEnv(t *testing.T) *fileEnv {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fileEnv{root: filepath.Join(base, "allowed"), outside: filepath.Join(base, "outside"), state: filepath.Join(base, "allowed", "zenithd-state")}
	for _, d := range []string{f.root, f.outside, f.state} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	f.env = &ops.Env{
		StateDir: f.state, ConfigFile: filepath.Join(f.root, "zenithd.yaml"),
		Cfg: ops.Config{Files: ops.FilesConfig{ReadAllow: []string{f.root, filepath.Join(base, "sibling-file.txt")}}},
	}
	return f
}

func (f *fileEnv) read(t *testing.T, args map[string]any) (ops.Result, error) {
	t.Helper()
	run, err := prep(t, f.env, ops.OpFileRead, args)
	if err != nil {
		return ops.Result{}, err
	}
	return run(context.Background())
}

func TestFileReadReturnsBoundedRedactedContent(t *testing.T) {
	f := newFileEnv(t)
	writeFile(t, filepath.Join(f.root, "app.conf"), "listen 8080\napi_key = sk_live_abcdef1234567890abcdef\nname = demo\n")
	res, err := f.read(t, map[string]any{"path": filepath.Join(f.root, "app.conf")})
	if err != nil {
		t.Fatal(err)
	}
	d := res.Data
	content := d["content"].(string)
	if d["encoding"] != "utf8" || strings.Contains(content, "sk_live_abcdef1234567890abcdef") || !strings.Contains(content, "listen 8080") || d["redacted"] != true {
		t.Fatalf("%v", d)
	}
	if d["sizeBytes"].(int64) == 0 || len(d["sha256"].(string)) != 64 || d["truncated"] != false {
		t.Fatalf("%v", d)
	}

	// maxBytes and request-level budgets both bound reads from the start.
	writeFile(t, filepath.Join(f.root, "big.txt"), strings.Repeat("0123456789", 100))
	res, err = f.read(t, map[string]any{"path": filepath.Join(f.root, "big.txt"), "maxBytes": 20})
	if err != nil {
		t.Fatal(err)
	}
	if res.Data["content"] != "01234567890123456789" || res.Data["truncated"] != true || res.Data["bytesRead"] != 20 {
		t.Fatalf("%v", res.Data)
	}
	raw, _ := json.Marshal(map[string]any{"path": filepath.Join(f.root, "big.txt"), "maxBytes": 999999})
	run, err := f.env.Prepare(ops.OpFileRead, &ops.Request{Args: raw, MaxOutputBytes: 100})
	if err != nil {
		t.Fatal(err)
	}
	res, err = run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Data["bytesRead"] != 100 || res.Data["truncated"] != true {
		t.Fatalf("%v", res.Data)
	}
	for _, old := range []string{"offset", "length"} {
		if _, err := f.read(t, map[string]any{"path": filepath.Join(f.root, "big.txt"), old: 20}); err == nil {
			t.Fatalf("%s must be rejected", old)
		}
	}

}

func TestFileReadBinaryIsFlaggedAndContentOmitted(t *testing.T) {
	f := newFileEnv(t)
	if err := os.WriteFile(filepath.Join(f.root, "blob.bin"), []byte{0, 1, 2, 255, 254}, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := f.read(t, map[string]any{"path": filepath.Join(f.root, "blob.bin")})
	if err != nil {
		t.Fatal(err)
	}
	if res.Data["encoding"] != "utf8" || res.Data["binary"] != true || res.Data["content"] != "" || res.Data["bytesRead"] != 5 {
		t.Fatalf("%v", res.Data)
	}

}

func TestFileReadAllowlistAndTraversal(t *testing.T) {
	f := newFileEnv(t)
	writeFile(t, filepath.Join(f.root, "ok.txt"), "ok")
	writeFile(t, filepath.Join(f.outside, "secret.txt"), "top secret")
	writeFile(t, f.root+"-sibling/x.txt", "sibling prefix")
	if err := os.WriteFile(filepath.Join(filepath.Dir(f.root), "sibling-file.txt"), []byte("single allowed file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.read(t, map[string]any{"path": filepath.Join(f.root, "ok.txt")}); err != nil {
		t.Fatal(err)
	}
	if res, err := f.read(t, map[string]any{"path": filepath.Join(filepath.Dir(f.root), "sibling-file.txt")}); err != nil || res.Data["content"] != "single allowed file" {
		t.Fatalf("a single allowed file path works: %v %v", res, err)
	}
	for name, p := range map[string]string{
		"outside the allowlist":    filepath.Join(f.outside, "secret.txt"),
		"dot-dot escape":           filepath.Join(f.root, "..", "outside", "secret.txt"),
		"prefix but not directory": f.root + "-sibling/x.txt",
		"etc passwd":               "/etc/passwd",
		"relative path":            "allowed/ok.txt",
		"relative traversal":       "../../etc/passwd",
		"empty":                    "",
		"root":                     "/",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := f.read(t, map[string]any{"path": p})
			if err == nil {
				t.Fatal("must be rejected")
			}
			if c := protocol.CodeOf(err); c != protocol.CodeNotAllowed && c != protocol.CodeInvalidPayload {
				t.Fatalf("unexpected code %s: %v", c, err)
			}
		})
	}
	_, err := f.read(t, map[string]any{"path": filepath.Join(f.root, "ok\x00.txt")})
	if err == nil {
		t.Fatal("a NUL byte in the path must be rejected")
	}
	// an empty allowlist turns the operation off
	off := &ops.Env{}
	_, err = prep(t, off, ops.OpFileRead, map[string]any{"path": "/etc/hostname"})
	wantCode(t, err, protocol.CodeDisabledByConfig)
}

func TestFileReadRefusesSymlinkEscapes(t *testing.T) {
	f := newFileEnv(t)
	writeFile(t, filepath.Join(f.outside, "secret.txt"), "top secret")
	writeFile(t, filepath.Join(f.root, "real.txt"), "inside")
	links := map[string]string{
		"file link to outside":      filepath.Join(f.outside, "secret.txt"),
		"directory link to outside": f.outside,
		"protected host file":       "/etc/passwd",
		"relative escape":           "../outside/secret.txt",
	}
	for name, target := range links {
		link := filepath.Join(f.root, strings.NewReplacer(" ", "_", "/", "_").Replace(name))
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		path := link
		if strings.HasPrefix(name, "directory") {
			path = filepath.Join(link, "secret.txt")
		}
		t.Run(name, func(t *testing.T) {
			_, err := f.read(t, map[string]any{"path": path})
			wantCode(t, err, protocol.CodeNotAllowed)
		})
	}
	// chained links: allowed -> allowed -> outside
	if err := os.Symlink(filepath.Join(f.outside, "secret.txt"), filepath.Join(f.root, "hop2")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(f.root, "hop2"), filepath.Join(f.root, "hop1")); err != nil {
		t.Fatal(err)
	}
	_, err := f.read(t, map[string]any{"path": filepath.Join(f.root, "hop1")})
	wantCode(t, err, protocol.CodeNotAllowed)
	// a link that stays inside the allowlist is fine
	if err := os.Symlink(filepath.Join(f.root, "real.txt"), filepath.Join(f.root, "good-link")); err != nil {
		t.Fatal(err)
	}
	res, err := f.read(t, map[string]any{"path": filepath.Join(f.root, "good-link")})
	if err != nil || res.Data["content"] != "inside" || res.Data["path"] != filepath.Join(f.root, "good-link") {
		t.Fatalf("%v %v", res.Data, err)
	}
}

func TestFileReadNeverServesZenithdsOwnState(t *testing.T) {
	f := newFileEnv(t)
	writeFile(t, filepath.Join(f.state, "identity.json"), `{"privateKey":"SECRET-SEED"}`)
	writeFile(t, filepath.Join(f.root, "zenithd.yaml"), "config")
	_, err := f.read(t, map[string]any{"path": filepath.Join(f.state, "identity.json")})
	wantCode(t, err, protocol.CodeNotAllowed) // inside readAllow, still refused
	_, err = f.read(t, map[string]any{"path": filepath.Join(f.root, "zenithd.yaml")})
	wantCode(t, err, protocol.CodeNotAllowed)
	// a link from an innocent name into the state dir
	if err := os.Symlink(filepath.Join(f.state, "identity.json"), filepath.Join(f.root, "innocent.txt")); err != nil {
		t.Fatal(err)
	}
	_, err = f.read(t, map[string]any{"path": filepath.Join(f.root, "innocent.txt")})
	wantCode(t, err, protocol.CodeNotAllowed)
}

func TestFileReadFailuresAreFailedResultsNotRejections(t *testing.T) {
	f := newFileEnv(t)
	_, err := f.read(t, map[string]any{"path": filepath.Join(f.root, "missing.txt")})
	if err == nil || !strings.HasPrefix(err.Error(), "file_not_found") || protocol.CodeOf(err) != protocol.CodeInternal {
		t.Fatalf("%v", err)
	}
	if err := os.Mkdir(filepath.Join(f.root, "adir"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err = f.read(t, map[string]any{"path": filepath.Join(f.root, "adir")})
	if err == nil || !strings.Contains(err.Error(), "not_a_regular_file") {
		t.Fatalf("%v", err)
	}
	for _, args := range []map[string]any{{"path": "/x", "offset": -1}, {"path": "/x", "length": -1}, {}, {"path": "/x", "encoding": "hex"}} {
		if _, err := prep(t, f.env, ops.OpFileRead, args); err == nil {
			t.Errorf("%v must be rejected", args)
		}
	}
}
