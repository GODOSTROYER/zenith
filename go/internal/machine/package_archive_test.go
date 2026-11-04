package machine

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"strings"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

func packageModelTar(t *testing.T, entries []packageTarEntry) []byte {
	t.Helper()
	var raw bytes.Buffer
	w := tar.NewWriter(&raw)
	for _, entry := range entries {
		if e := w.WriteHeader(entry.header); e != nil {
			t.Fatal(e)
		}
		if _, e := w.Write(entry.body); e != nil {
			t.Fatal(e)
		}
	}
	if w.Close() != nil {
		t.Fatal("tar close")
	}
	var packed bytes.Buffer
	g := gzip.NewWriter(&packed)
	g.Write(raw.Bytes())
	g.Close()
	return packed.Bytes()
}
func packageModelDeb(t *testing.T, control string, data []packageTarEntry) ([]byte, ops.PackageInstallProfile) {
	t.Helper()
	parts := []struct {
		name string
		raw  []byte
	}{{"debian-binary", []byte("2.0\n")}, {"control.tar.gz", packageModelTar(t, []packageTarEntry{{&tar.Header{Name: "./control", Typeflag: tar.TypeReg, Mode: 0644, Size: int64(len(control)), Format: tar.FormatUSTAR}, []byte(control)}})}, {"data.tar.gz", packageModelTar(t, data)}}
	var out bytes.Buffer
	out.WriteString("!<arch>\n")
	for _, part := range parts {
		out.WriteString(fmt.Sprintf("%-16s%-12d%-6d%-6d%-8o%-10d`\n", part.name+"/", 0, 0, 0, 0644, len(part.raw)))
		out.Write(part.raw)
		if len(part.raw)%2 != 0 {
			out.WriteByte('\n')
		}
	}
	p := ops.PackageInstallProfile{ProfileRef: "bundle", Package: "zenith-data-bundle", Version: "1.0", Architecture: "amd64", SourcePath: packageHelperState + "/archives/bundle.deb", SHA256: packageHash(out.Bytes()), ArchiveBytes: int64(out.Len()), Payload: []ops.PackagePayloadFile{{Path: "/opt/zenith-packages/bundle", Kind: "directory", Mode: "0755"}, {Path: "/opt/zenith-packages/bundle/data", Kind: "file", Mode: "0644", Bytes: 1, SHA256: packageHash([]byte{0x5a})}}}
	v, e := ops.PackageInstallProfileVersion(p)
	if e != nil {
		t.Fatal(e)
	}
	p.ProfileVersion = v
	return out.Bytes(), p
}
func packageModelEntries() []packageTarEntry {
	return []packageTarEntry{{&tar.Header{Name: "./opt/zenith-packages/bundle/", Typeflag: tar.TypeDir, Mode: 0755, Format: tar.FormatUSTAR}, nil}, {&tar.Header{Name: "./opt/zenith-packages/bundle/data", Typeflag: tar.TypeReg, Mode: 0644, Size: 1, Format: tar.FormatUSTAR}, []byte{0x5a}}}
}

const packageModelControl = "Package: zenith-data-bundle\nVersion: 1.0\nArchitecture: amd64\nMaintainer: Local Administrator\nDescription: Pinned data fixture\n"

func TestPackageArchiveAuthenticSupportedDialect(t *testing.T) {
	raw, p := packageModelDeb(t, packageModelControl, packageModelEntries())
	deb, e := parsePinnedDeb(raw, p)
	if e != nil || len(deb.Files) != 2 {
		t.Fatal("supported exact archive refused")
	}
}
func TestPackageArchiveRefusesScriptsDependenciesAndForeignIdentity(t *testing.T) {
	for _, control := range []string{packageModelControl + "Depends: libc6\n", packageModelControl + "Triggers: local\n", packageModelControl + "Conffiles: /etc/tool\n", strings.Replace(packageModelControl, "Version: 1.0", "Version: 2.0", 1), packageModelControl + "Package: foreign\n"} {
		raw, p := packageModelDeb(t, control, packageModelEntries())
		if _, e := parsePinnedDeb(raw, p); e == nil {
			t.Fatal("unsupported control semantics accepted")
		}
	}
}
func TestPackageArchiveRefusesLinksModesPathsAndMissingPayload(t *testing.T) {
	for _, mutate := range []func([]packageTarEntry) []packageTarEntry{func(v []packageTarEntry) []packageTarEntry {
		v[1].header.Typeflag = tar.TypeSymlink
		v[1].header.Linkname = "/etc/target"
		v[1].header.Size = 0
		v[1].body = nil
		return v
	}, func(v []packageTarEntry) []packageTarEntry { v[1].header.Mode = 04755; return v }, func(v []packageTarEntry) []packageTarEntry { v[1].header.Name = "../../etc/target"; return v }, func(v []packageTarEntry) []packageTarEntry { return v[:1] }, func(v []packageTarEntry) []packageTarEntry { v[1].body = []byte{0x5b}; return v }} {
		entries := mutate(packageModelEntries())
		raw, p := packageModelDeb(t, packageModelControl, entries)
		if _, e := parsePinnedDeb(raw, p); e == nil {
			t.Fatal("unsafe or incomplete payload accepted")
		}
	}
}
func TestPackageArchiveRefusesTrailingMembersAndPurposeHashDrift(t *testing.T) {
	raw, p := packageModelDeb(t, packageModelControl, packageModelEntries())
	for _, value := range [][]byte{append(append([]byte(nil), raw...), []byte("trailing")...), raw[:len(raw)-1]} {
		q := p
		q.ArchiveBytes = int64(len(value))
		q.SHA256 = packageHash(value)
		if _, e := parsePinnedDeb(value, q); e == nil {
			t.Fatal("malformed archive accepted")
		}
	}
	p.SHA256 = strings.Repeat("a", 64)
	if _, e := parsePinnedDeb(raw, p); e == nil {
		t.Fatal("foreign archive pin accepted")
	}
}
func TestPackageArchiveRefusesPaxAndMultipleGzipMembers(t *testing.T) {
	entries := packageModelEntries()
	entries[1].header.Format = tar.FormatPAX
	entries[1].header.PAXRecords = map[string]string{"vendor.unsafe": "value"}
	packed := packageModelTar(t, entries)
	if _, e := packageTar(packed, 9<<20); e == nil {
		t.Fatal("PAX extension accepted")
	}
	good := packageModelTar(t, packageModelEntries())
	both := append(append([]byte(nil), good...), good...)
	if _, e := packageTar(both, 9<<20); e == nil {
		t.Fatal("extra compressed member accepted")
	}
}
