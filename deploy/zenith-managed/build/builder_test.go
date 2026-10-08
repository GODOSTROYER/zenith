package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func archiveFor(t *testing.T, name string, kind byte, body string) ([]byte, string) {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	size := int64(len(body))
	if kind != tar.TypeReg {
		size = 0
	}
	if e := tw.WriteHeader(&tar.Header{Name: name, Typeflag: kind, Mode: 0755, Size: size, Linkname: "outside"}); e != nil {
		t.Fatal(e)
	}
	if size > 0 {
		if _, e := tw.Write([]byte(body)); e != nil {
			t.Fatal(e)
		}
	}
	if e := tw.Close(); e != nil {
		t.Fatal(e)
	}
	if e := gz.Close(); e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(b.Bytes())
	return b.Bytes(), hex.EncodeToString(sum[:])
}
func TestExtractDigestBoundRegularFile(t *testing.T) {
	b, d := archiveFor(t, "app/run", tar.TypeReg, "executable")
	dir := t.TempDir()
	if e := extract(b, dir, d); e != nil {
		t.Fatal(e)
	}
	data, e := os.ReadFile(filepath.Join(dir, "app/run"))
	if e != nil || string(data) != "executable" {
		t.Fatal("bytes changed")
	}
	stat, e := os.Stat(filepath.Join(dir, "app/run"))
	want := os.FileMode(0700)
	// Windows exposes DOS writability as 0666; native Linux/macOS retain the strict POSIX 0700 check.
	if runtime.GOOS == "windows" {
		want = 0666
	}
	if e != nil || stat.Mode().Perm() != want {
		t.Fatal("executable intent changed")
	}
}
func TestRejectSourceDigestSubstitution(t *testing.T) {
	b, _ := archiveFor(t, "file", tar.TypeReg, "x")
	if extract(b, t.TempDir(), string(bytes.Repeat([]byte("0"), 64))) == nil {
		t.Fatal("accepted wrong digest")
	}
}
func TestRejectArchiveEscape(t *testing.T) {
	for _, name := range []string{"../outside", "/absolute", "app/../../escape", "app\\escape", "C:escape", "app/./file"} {
		t.Run(name, func(t *testing.T) {
			b, d := archiveFor(t, name, tar.TypeReg, "x")
			if extract(b, t.TempDir(), d) == nil {
				t.Fatal("accepted unsafe path")
			}
		})
	}
}
func TestRejectArchiveSpecialEntries(t *testing.T) {
	for _, kind := range []byte{tar.TypeSymlink, tar.TypeLink, tar.TypeChar, tar.TypeFifo} {
		t.Run(string(kind), func(t *testing.T) {
			b, d := archiveFor(t, "link", kind, "")
			if extract(b, t.TempDir(), d) == nil {
				t.Fatal("accepted special entry")
			}
		})
	}
}

func TestDiscoveryEnvironmentStrippedBeforeIsolation(t *testing.T) {
	keys := []string{"KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "KUBERNETES_SERVICE_PORT_HTTPS", "KUBERNETES_PORT", "KUBERNETES_PORT_443_TCP", "KUBERNETES_PORT_443_TCP_PROTO", "KUBERNETES_PORT_443_TCP_PORT", "KUBERNETES_PORT_443_TCP_ADDR"}
	for _, key := range keys {
		t.Setenv(key, "fixture-discovery")
	}
	// A fake credential is built at runtime and must remain visible to the rejecting guard.
	fakeToken := t.Name() + "-" + t.TempDir()
	t.Setenv("KUBERNETES_BEARER_TOKEN", fakeToken)
	if err := stripKubeDiscoveryEnv(); err != nil {
		t.Fatal(err)
	}
	for _, key := range keys {
		if _, exists := os.LookupEnv(key); exists {
			t.Fatalf("discovery variable survived: %s", key)
		}
	}
	if os.Getenv("KUBERNETES_BEARER_TOKEN") != fakeToken || noDeploymentEnv() {
		t.Fatal("credential variable was hidden or accepted")
	}
}
