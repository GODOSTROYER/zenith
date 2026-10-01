package ops

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

func init() { register(Operation{Name: OpFileRead, Prepare: prepareFileRead}) }

type fileReadArgs struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset"`
	Length int64  `json:"length"`
}

// ValidateReadAllow checks files.readAllow at startup: absolute, cleaned, and
// not the filesystem root.
func ValidateReadAllow(prefixes []string) error {
	for _, p := range prefixes {
		if !filepath.IsAbs(p) || filepath.Clean(p) != p || p == "/" {
			return fmt.Errorf("files.readAllow entry %q must be a clean absolute path other than /", clip(p, 60))
		}
	}
	return nil
}

// underPrefix reports whether p is prefix itself or inside it (on a path
// boundary: /etc/app does not contain /etc/application).
func underPrefix(p, prefix string) bool {
	if p == prefix {
		return true
	}
	sep := string(filepath.Separator)
	return strings.HasPrefix(p, strings.TrimSuffix(prefix, sep)+sep)
}

func underAny(p string, prefixes []string) bool {
	for _, pre := range prefixes {
		if underPrefix(p, pre) {
			return true
		}
	}
	return false
}

// resolveReadable applies the file.read guard and returns the resolved path.
//
//  1. args.path must be absolute and, cleaned, lie inside a readAllow prefix
//     (so paths outside the allowlist are refused without touching the disk);
//  2. symlinks are resolved with filepath.EvalSymlinks and the RESOLVED path
//     must again lie inside a (resolved) readAllow prefix: a symlink under an
//     allowed directory that points outside it is refused;
//  3. zenithd's own state directory and config file are never readable.
func (e *Env) resolveReadable(path string) (string, error) {
	allow := e.Cfg.Files.ReadAllow
	if len(allow) == 0 {
		return "", disabled("file.read is disabled: files.readAllow is empty on this machine")
	}
	clean, err := absClean(path)
	if err != nil {
		return "", err
	}
	if !underAny(clean, allow) {
		return "", notAllowed("path is outside files.readAllow on this machine")
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("file_not_found: %s", clip(clean, 120))
		}
		return "", fmt.Errorf("file_unreadable: %v", pathErr(err))
	}
	var resolvedAllow []string
	for _, a := range allow {
		if r, err := filepath.EvalSymlinks(a); err == nil {
			resolvedAllow = append(resolvedAllow, r)
		}
	}
	if !underAny(resolved, resolvedAllow) {
		return "", notAllowed("the path resolves (through a symbolic link) outside files.readAllow")
	}
	for _, deny := range e.hardDenied() {
		if underPrefix(resolved, deny) {
			return "", notAllowed("that path holds zenithd's own state and is never readable")
		}
	}
	return resolved, nil
}

// hardDenied lists resolved paths file.read can never serve, whatever the
// allowlist says.
func (e *Env) hardDenied() []string {
	var out []string
	for _, p := range []string{e.StateDir, e.ConfigFile} {
		if p == "" {
			continue
		}
		out = append(out, filepath.Clean(p))
		if r, err := filepath.EvalSymlinks(p); err == nil {
			out = append(out, r)
		}
	}
	return out
}

func pathErr(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

func prepareFileRead(e *Env, req *Request) (Runnable, error) {
	var a fileReadArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if a.Path == "" {
		return nil, invalid("path is required")
	}
	if a.Offset < 0 || a.Length < 0 {
		return nil, invalid("offset and length must not be negative")
	}
	if len(e.Cfg.Files.ReadAllow) == 0 {
		return nil, disabled("file.read is disabled: files.readAllow is empty on this machine")
	}
	clean, err := absClean(a.Path)
	if err != nil {
		return nil, err
	}
	if !underAny(clean, e.Cfg.Files.ReadAllow) {
		return nil, notAllowed("path is outside files.readAllow on this machine")
	}
	limit := e.Cfg.Files.MaxReadBytes
	if limit <= 0 {
		limit = 1 << 20
	}
	limit = min(limit, req.MaxOutputBytes)
	length := a.Length
	if length == 0 || length > limit {
		length = limit
	}
	return func(ctx context.Context) (Result, error) {
		resolved, err := e.resolveReadable(clean)
		if err != nil {
			// A guard refusal discovered at run time (the link target) is a
			// rejection; anything else is a failed read.
			return Result{}, err
		}
		f, err := openReadOnly(resolved)
		if err != nil {
			return Result{}, fmt.Errorf("file_unreadable: %v", pathErr(err))
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return Result{}, fmt.Errorf("file_unreadable: %v", pathErr(err))
		}
		if !st.Mode().IsRegular() {
			return Result{}, fmt.Errorf("not_a_regular_file: only regular files can be read")
		}
		if a.Offset > st.Size() {
			return Result{OK: false, Data: map[string]any{"path": resolved, "sizeBytes": st.Size(), "offset": a.Offset}, Err: "offset_beyond_end"}, nil
		}
		if _, err := f.Seek(a.Offset, io.SeekStart); err != nil {
			return Result{}, fmt.Errorf("file_unreadable: %v", pathErr(err))
		}
		buf, err := io.ReadAll(io.LimitReader(f, length+1))
		if err != nil {
			return Result{}, fmt.Errorf("file_unreadable: %v", pathErr(err))
		}
		more := int64(len(buf)) > length
		if more {
			buf = buf[:length]
		}
		sum := sha256.Sum256(buf)
		data := map[string]any{
			"path": resolved, "sizeBytes": st.Size(), "offset": a.Offset, "length": len(buf),
			"truncated": more, "sha256": hex.EncodeToString(sum[:]),
		}
		if isText(buf) {
			red := redact.String(string(buf))
			data["encoding"] = "utf8"
			data["content"] = red
			data["redacted"] = red != string(buf)
		} else {
			data["encoding"] = "base64"
			data["content"] = base64.StdEncoding.EncodeToString(buf)
			data["redacted"] = false
		}
		return Result{OK: true, Data: data}, nil
	}, nil
}

// isText reports whether b is valid UTF-8 without NUL bytes. A read that
// stops in the middle of a multi-byte character is still text.
func isText(b []byte) bool {
	for _, c := range b {
		if c == 0 {
			return false
		}
	}
	if utf8.Valid(b) {
		return true
	}
	// tolerate a truncated final rune
	for i := 1; i <= 3 && i <= len(b); i++ {
		if utf8.Valid(b[:len(b)-i]) {
			return true
		}
	}
	return false
}
