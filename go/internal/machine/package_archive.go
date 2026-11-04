package machine

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"path"
	"strconv"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

type pinnedDeb struct {
	Control map[string]string
	Files   map[string]ops.PackagePayloadFile
}

func packageBad() error {
	return errors.New("package metadata is not in the supported pinned data-only format")
}
func packageHash(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// Only the original ar + single gzip member + ordinary ustar dialect is
// accepted. Raw headers are checked before archive/tar can process extensions.
func parsePinnedDeb(raw []byte, p ops.PackageInstallProfile) (pinnedDeb, error) {
	var result pinnedDeb
	if int64(len(raw)) != p.ArchiveBytes || len(raw) > 4<<20 || packageHash(raw) != p.SHA256 || len(raw) < 8 || string(raw[:8]) != "!<arch>\n" {
		return result, packageBad()
	}
	members := map[string][]byte{}
	expectedOrder := []string{"debian-binary", "control.tar.gz", "data.tar.gz"}
	for off := 8; off < len(raw); {
		if len(raw)-off < 60 {
			return result, packageBad()
		}
		h := raw[off : off+60]
		off += 60
		name := strings.TrimSuffix(strings.TrimSpace(string(h[:16])), "/")
		if len(members) >= len(expectedOrder) || name != expectedOrder[len(members)] || (name != "debian-binary" && name != "control.tar.gz" && name != "data.tar.gz") || members[name] != nil || string(h[58:60]) != "`\n" {
			return result, packageBad()
		}
		size, err := strconv.ParseInt(strings.TrimSpace(string(h[48:58])), 10, 64)
		if err != nil || size < 1 || size > 4<<20 || int64(len(raw)-off) < size {
			return result, packageBad()
		}
		members[name] = raw[off : off+int(size)]
		off += int(size)
		if size%2 != 0 {
			if off >= len(raw) || raw[off] != '\n' {
				return result, packageBad()
			}
			off++
		}
	}
	if len(members) != 3 || string(members["debian-binary"]) != "2.0\n" {
		return result, packageBad()
	}
	control, err := packageTar(members["control.tar.gz"], 1<<16)
	if err != nil {
		return result, err
	}
	data, err := packageTar(members["data.tar.gz"], 9<<20)
	if err != nil {
		return result, err
	}
	if len(control) != 1 || control["control"].header.Typeflag != tar.TypeReg || len(control["control"].body) > 16384 {
		return result, packageBad()
	}
	result.Control, err = packageControl(control["control"].body)
	if err != nil {
		return result, err
	}
	allowed := map[string]bool{"Package": true, "Version": true, "Architecture": true, "Maintainer": true, "Description": true, "Section": true, "Priority": true}
	for k := range result.Control {
		if !allowed[k] {
			return result, packageBad()
		}
	}
	if result.Control["Package"] != p.Package || result.Control["Version"] != p.Version || result.Control["Architecture"] != p.Architecture || result.Control["Maintainer"] == "" || result.Control["Description"] == "" {
		return result, packageBad()
	}
	result.Files = map[string]ops.PackagePayloadFile{}
	expected := map[string]ops.PackagePayloadFile{}
	for _, f := range p.Payload {
		expected[f.Path] = f
	}
	for name, entry := range data {
		absolute := "/" + name
		if absolute == "/opt" || absolute == "/opt/zenith-packages" {
			if entry.header.Typeflag != tar.TypeDir || entry.header.Mode != 0755 {
				return result, packageBad()
			}
			continue
		}
		f, ok := expected[absolute]
		if !ok {
			return result, packageBad()
		}
		kind := "file"
		if entry.header.Typeflag == tar.TypeDir {
			kind = "directory"
		}
		mode := strconv.FormatInt(entry.header.Mode, 8)
		mode = "0" + mode
		sum := ""
		if kind == "file" {
			sum = packageHash(entry.body)
		}
		if kind != f.Kind || mode != f.Mode || int64(len(entry.body)) != f.Bytes || sum != f.SHA256 {
			return result, packageBad()
		}
		result.Files[absolute] = f
	}
	if len(result.Files) != len(expected) {
		return result, packageBad()
	}
	return result, nil
}

type packageTarEntry struct {
	header *tar.Header
	body   []byte
}

func packageTar(compressed []byte, limit int64) (map[string]packageTarEntry, error) {
	input := bytes.NewReader(compressed)
	gz, err := gzip.NewReader(input)
	if err != nil {
		return nil, packageBad()
	}
	gz.Multistream(false)
	raw, err := io.ReadAll(io.LimitReader(gz, limit+1))
	closeErr := gz.Close()
	if err != nil || closeErr != nil || int64(len(raw)) > limit || input.Len() != 0 || len(raw)%512 != 0 {
		return nil, packageBad()
	}
	ended := false
	zeros := 0
	for off := 0; off < len(raw); {
		h := raw[off : off+512]
		off += 512
		if bytes.Equal(h, make([]byte, 512)) {
			ended = true
			zeros++
			continue
		}
		if ended {
			return nil, packageBad()
		}
		// No PAX/GNU extension, sparse record, xattr, link, device or base-256 field.
		if (h[156] != '0' && h[156] != 0 && h[156] != '5') || string(h[257:263]) != "ustar\x00" || string(h[263:265]) != "00" || !bytes.Equal(h[157:257], make([]byte, 100)) || h[124]&0x80 != 0 || h[100]&0x80 != 0 || h[108]&0x80 != 0 || h[116]&0x80 != 0 {
			return nil, packageBad()
		}
		size, e := strconv.ParseInt(strings.Trim(string(h[124:136]), " \x00"), 8, 64)
		if e != nil || size < 0 || size > limit || int64(len(raw)-off) < (size+511)/512*512 {
			return nil, packageBad()
		}
		checksum, e := strconv.ParseInt(strings.Trim(string(h[148:156]), " \x00"), 8, 64)
		if e != nil {
			return nil, packageBad()
		}
		sum := int64(0)
		for i, b := range h {
			if i >= 148 && i < 156 {
				sum += 32
			} else {
				sum += int64(b)
			}
		}
		if sum != checksum {
			return nil, packageBad()
		}
		if h[156] == '5' && size != 0 {
			return nil, packageBad()
		}
		padding := raw[off+int(size) : off+int((size+511)/512*512)]
		if !bytes.Equal(padding, make([]byte, len(padding))) {
			return nil, packageBad()
		}
		off += int((size + 511) / 512 * 512)
	}
	if zeros < 2 {
		return nil, packageBad()
	}
	reader := tar.NewReader(bytes.NewReader(raw))
	out := map[string]packageTarEntry{}
	for {
		h, e := reader.Next()
		if e == io.EOF {
			break
		}
		if e != nil || h.Format != tar.FormatUSTAR || h.Uid != 0 || h.Gid != 0 || h.Mode&^0777 != 0 || (h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir) || h.Linkname != "" || len(h.PAXRecords) != 0 || len(out) > 258 {
			return nil, packageBad()
		}
		name := strings.TrimPrefix(h.Name, "./")
		name = strings.TrimSuffix(name, "/")
		if name == "" || name == "." {
			if h.Typeflag == tar.TypeDir && h.Mode == 0755 {
				continue
			}
			return nil, packageBad()
		}
		if name[0] == '/' || path.Clean(name) != name || strings.HasPrefix(name, "../") || strings.ContainsAny(name, "\x00\n\r\\ ") || len(name) > 512 {
			return nil, packageBad()
		}
		if _, ok := out[name]; ok {
			return nil, packageBad()
		}
		body, e := io.ReadAll(io.LimitReader(reader, limit+1))
		if e != nil || int64(len(body)) != h.Size {
			return nil, packageBad()
		}
		out[name] = packageTarEntry{h, body}
	}
	return out, nil
}

func packageControl(raw []byte) (map[string]string, error) {
	if len(raw) == 0 || raw[len(raw)-1] != '\n' || len(raw) > 1<<20 || bytes.ContainsAny(raw, "\x00\r") {
		return nil, packageBad()
	}
	out := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n") {
		i := strings.Index(line, ": ")
		if i < 1 || len(line) > 4096 || out[line[:i]] != "" {
			return nil, packageBad()
		}
		k, v := line[:i], line[i+2:]
		if v == "" || strings.TrimSpace(v) != v {
			return nil, packageBad()
		}
		out[k] = v
	}
	return out, nil
}
