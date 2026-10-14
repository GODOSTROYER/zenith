package release

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

type fixture struct {
	dir, seed, keys string
	pin             protocol.KeyEntry
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	dir := t.TempDir()
	f := fixture{dir: dir, seed: filepath.Join(dir, "seed")}
	var out, errb bytes.Buffer
	if code := Run([]string{"keygen", "--kid", "rel-1", "--private-out", f.seed}, &out, &errb); code != 0 {
		t.Fatalf("keygen: %s", errb.String())
	}
	if err := json.Unmarshal(out.Bytes(), &f.pin); err != nil {
		t.Fatal(err)
	}
	f.keys = filepath.Join(dir, "keys.json")
	if err := os.WriteFile(f.keys, []byte("["+strings.TrimSpace(out.String())+"]"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"linux-amd64", "linux-arm64"} {
		if err := os.MkdirAll(filepath.Join(dir, "dist", d), 0o755); err != nil {
			t.Fatal(err)
		}
		for _, c := range []string{"zenithd", "zenith-runner"} {
			if err := os.WriteFile(filepath.Join(dir, "dist", d, c), []byte(c+d), 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	return f
}

func (f fixture) sign(t *testing.T, component string, extra ...string) (string, int, string) {
	t.Helper()
	outFile := filepath.Join(f.dir, "updater-"+component+".json")
	args := append([]string{"sign", "--key", f.seed, "--kid", "rel-1", "--component", component, "--version", "1.2.3", "--seq", "7",
		"--dist", filepath.Join(f.dir, "dist"), "--out", outFile}, extra...)
	var out, errb bytes.Buffer
	code := Run(args, &out, &errb)
	return outFile, code, errb.String()
}

func manifestBody(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	body, err := protocol.B64Decode(env.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestSignUsesFlatAssetNamesUnderGitHubReleaseBase(t *testing.T) {
	f := newFixture(t)
	stage := filepath.Join(f.dir, "stage")
	path, code, msg := f.sign(t, "zenith-runner", "--repository", "owner/repo", "--tag", "v1.2.3", "--stage-dir", stage)
	if code != 0 {
		t.Fatal(msg)
	}
	body := manifestBody(t, path)
	for _, want := range []string{
		"https://github.com/owner/repo/releases/download/v1.2.3/zenith-runner-linux-amd64",
		"https://github.com/owner/repo/releases/download/v1.2.3/zenith-runner-linux-arm64",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("manifest lacks %s: %s", want, body)
		}
	}
	for _, name := range []string{"zenith-runner-linux-amd64", "zenith-runner-linux-amd64.sha256", "zenith-runner-linux-arm64", "zenith-runner-linux-arm64.sha256"} {
		if _, err := os.Stat(filepath.Join(stage, name)); err != nil {
			t.Fatalf("missing staged asset %s", name)
		}
	}
	sum, _ := os.ReadFile(filepath.Join(stage, "zenith-runner-linux-amd64.sha256"))
	if !strings.HasSuffix(string(sum), "  zenith-runner-linux-amd64\n") {
		t.Fatalf("checksum file %q", sum)
	}
	if !strings.Contains(body, strings.Fields(string(sum))[0]) {
		t.Fatal("staged checksum does not match the signed manifest")
	}
}

func TestSignWithMirrorBaseUsesSameFlatNames(t *testing.T) {
	f := newFixture(t)
	path, code, msg := f.sign(t, "zenithd", "--base-url", "https://mirror.example.com/zenith/v1.2.3/")
	if code != 0 {
		t.Fatal(msg)
	}
	if body := manifestBody(t, path); !strings.Contains(body, "https://mirror.example.com/zenith/v1.2.3/zenithd-linux-amd64") {
		t.Fatalf("unexpected urls: %s", body)
	}
}

func TestSignRefusesAmbiguousOrMissingBase(t *testing.T) {
	f := newFixture(t)
	cases := [][]string{
		{},
		{"--base-url", "https://x.example.com/v1", "--repository", "o/r", "--tag", "v1"},
		{"--repository", "o/r"},
		{"--repository", "bad", "--tag", "v1"},
		{"--base-url", "https://x.example.com/v1", "--valid-days", "91"},
	}
	for _, extra := range cases {
		if _, code, _ := f.sign(t, "zenithd", extra...); code == 0 {
			t.Fatalf("%v must fail", extra)
		}
	}
}

func TestVerifyAssets(t *testing.T) {
	f := newFixture(t)
	stage := filepath.Join(f.dir, "stage")
	path, code, msg := f.sign(t, "zenithd", "--repository", "owner/repo", "--tag", "v1.2.3", "--stage-dir", stage)
	if code != 0 {
		t.Fatal(msg)
	}
	verify := func() int {
		var out, errb bytes.Buffer
		return Run([]string{"verify", "--manifest", path, "--keys", f.keys, "--assets", stage}, &out, &errb)
	}
	if verify() != 0 {
		t.Fatal("staged assets must verify")
	}
	asset := filepath.Join(stage, "zenithd-linux-arm64")
	if err := os.WriteFile(asset, []byte("tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	if verify() == 0 {
		t.Fatal("a changed asset must fail")
	}
	_ = os.Remove(asset)
	if verify() == 0 {
		t.Fatal("a missing asset must fail")
	}
	mirror, code, msg := f.sign(t, "zenith-runner", "--base-url", "https://mirror.example.com/v1.2.3")
	if code != 0 {
		t.Fatal(msg)
	}
	var out, errb bytes.Buffer
	if Run([]string{"verify", "--manifest", mirror, "--keys", f.keys, "--assets", filepath.Join(f.dir, "nowhere")}, &out, &errb) == 0 {
		t.Fatal("an unstaged asset directory must fail")
	}
}

func TestVerifyFlags(t *testing.T) {
	f := newFixture(t)
	path, code, msg := f.sign(t, "zenithd", "--base-url", "https://x.example.com/v1.2.3")
	if code != 0 {
		t.Fatal(msg)
	}
	ok := func(args ...string) bool {
		var out, errb bytes.Buffer
		return Run(append([]string{"verify", "--manifest", path}, args...), &out, &errb) == 0
	}
	if !ok("--keys", f.keys) || !ok("--keys", f.keys, "--component", "zenithd", "--channel", "stable") {
		t.Fatal("verify against the pinned key file must pass")
	}
	if !ok("--kid", "rel-1", "--public-key", f.pin.PublicKey) {
		t.Fatal("single key flags must still work")
	}
	if ok("--keys", f.keys, "--component", "zenith-runner") {
		t.Fatal("wrong component must fail")
	}
	if ok("--keys", f.keys, "--channel", "beta") {
		t.Fatal("wrong channel must fail")
	}
	if ok() || ok("--keys", f.keys, "--kid", "rel-1") {
		t.Fatal("missing or ambiguous key source must fail")
	}
	other := newFixture(t)
	if ok("--keys", other.keys) {
		t.Fatal("a key that did not sign the manifest must fail")
	}
	empty := filepath.Join(f.dir, "empty.json")
	_ = os.WriteFile(empty, []byte("[]"), 0o644)
	if ok("--keys", empty) {
		t.Fatal("an empty pin list must fail")
	}
}
