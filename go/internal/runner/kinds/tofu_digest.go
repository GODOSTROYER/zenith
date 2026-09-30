package kinds

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// ConfigFile is one decoded workspace file.
type ConfigFile struct {
	Path    string
	Content []byte
}

// ConfigDigest computes the workspace digest exactly as src/lib/tofu does
// (docs/platform/RUNNER-PROTOCOL.md, "tofu.run"):
//
//	lines   = for each file, sorted ascending by path:
//	            path + 0x00 + lowercase_hex(sha256(raw content bytes)) + 0x0A
//	digest  = lowercase_hex(sha256(concatenation of lines))
//
// The lockfile is NOT part of it (it is pinned separately as lockDigest).
// Paths are restricted to [A-Za-z0-9._/-], so byte order and the UTF-16 code
// unit order of a JavaScript sort() coincide. The input slice is not
// modified. Duplicate paths must be rejected by the caller (ValidateFiles).
func ConfigDigest(files []ConfigFile) string {
	sorted := make([]ConfigFile, len(files))
	copy(sorted, files)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	h := sha256.New()
	for _, f := range sorted {
		sum := sha256.Sum256(f.Content)
		h.Write([]byte(f.Path))
		h.Write([]byte{0})
		h.Write([]byte(hex.EncodeToString(sum[:])))
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// LockDigest is the SHA-256 (hex) of the lockfile contents.
func LockDigest(lockfile string) string {
	sum := sha256.Sum256([]byte(lockfile))
	return hex.EncodeToString(sum[:])
}

var tofuPathRe = regexp.MustCompile(`^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`)

// Extensions accepted by default. HCL (.tf/.tfvars) cannot be structurally
// checked by the runner, so it is accepted only with allowUnsafeConfig.
var (
	safeExts   = []string{".tf.json", ".tfvars.json", ".json", ".tftpl", ".txt"}
	unsafeExts = []string{".tf", ".tfvars", ".hcl"}
)

// ValidateFilePath checks one workspace-relative path.
func ValidateFilePath(p string, allowUnsafe bool) error {
	if p == "" || len(p) > 200 {
		return fmt.Errorf("file path is empty or too long")
	}
	if !tofuPathRe.MatchString(p) {
		return fmt.Errorf("file path %q must be a relative path of [A-Za-z0-9._-] segments", clip(p, 60))
	}
	for _, seg := range strings.Split(p, "/") {
		switch {
		case seg == "." || seg == "..":
			return fmt.Errorf("file path %q contains a dot segment", clip(p, 60))
		case strings.HasPrefix(seg, ".terraform"), seg == ".git", strings.HasPrefix(seg, ".tofu"):
			return fmt.Errorf("file path %q uses a reserved name", clip(p, 60))
		}
	}
	lower := strings.ToLower(p)
	for _, bad := range []string{".tfstate", ".tfstate.backup", ".tfplan", ".tfrc"} {
		if strings.HasSuffix(lower, bad) {
			return fmt.Errorf("file %q would seed state, plans or CLI config and is not allowed", clip(p, 60))
		}
	}
	if strings.HasSuffix(lower, ".terraformrc") || lower == "terraform.rc" {
		return fmt.Errorf("file %q would change CLI configuration", clip(p, 60))
	}
	exts := safeExts
	if allowUnsafe {
		exts = append(append([]string{}, safeExts...), unsafeExts...)
	}
	for _, e := range exts {
		if strings.HasSuffix(lower, e) {
			return nil
		}
	}
	return fmt.Errorf("file %q has an extension the runner does not accept (allowed: %s)", clip(p, 60), strings.Join(exts, " "))
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

/* ---------------------------- configuration guard --------------------------- */

// Findings of the structural guard over *.tf.json files.
type configFacts struct {
	// Backend is the backend type declared (`terraform.backend`), "cloud" for a
	// `terraform.cloud` block, or "" when none is declared (implicit local).
	Backend string
}

// deniedResourceTypes and deniedProviders name types that run commands or
// read/write arbitrary files on the runner host.
var (
	deniedTypes     = map[string]bool{"external": true, "http": true, "local_file": true, "local_sensitive_file": true}
	deniedProviders = map[string]bool{"external": true, "http": true, "local": true}
)

// GuardConfig inspects *.tf.json files for constructs that execute code or
// touch the runner's own filesystem: provisioners, the external/http/local
// providers and data sources, and module sources that download code. It is
// defense in depth against a compromised or buggy compiler, NOT a sandbox
// (HCL files are refused outright unless allowUnsafeConfig is set, since they
// cannot be inspected this way). It also reports the declared backend.
func GuardConfig(files []ConfigFile) (configFacts, error) {
	var facts configFacts
	for _, f := range files {
		if !strings.HasSuffix(strings.ToLower(f.Path), ".tf.json") {
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal(f.Content, &doc); err != nil {
			return facts, fmt.Errorf("%s is not valid JSON: %v", clip(f.Path, 60), err)
		}
		if err := guardDoc(f.Path, doc, &facts); err != nil {
			return facts, err
		}
	}
	return facts, nil
}

func guardDoc(path string, doc map[string]any, facts *configFacts) error {
	// resource "<type>" "<name>" { provisioner ... } and denied types.
	if res, ok := doc["resource"].(map[string]any); ok {
		for typ, byName := range res {
			if deniedTypes[typ] {
				return fmt.Errorf("%s: resource type %q is not allowed (it acts on the runner host)", clip(path, 60), typ)
			}
			names, _ := byName.(map[string]any)
			for _, body := range names {
				if err := guardResourceBody(path, typ, body); err != nil {
					return err
				}
			}
		}
	}
	if data, ok := doc["data"].(map[string]any); ok {
		for typ := range data {
			if deniedTypes[typ] {
				return fmt.Errorf("%s: data source %q is not allowed (it acts on the runner host or makes arbitrary requests)", clip(path, 60), typ)
			}
		}
	}
	if prov, ok := doc["provider"].(map[string]any); ok {
		for name := range prov {
			if deniedProviders[name] {
				return fmt.Errorf("%s: provider %q is not allowed", clip(path, 60), name)
			}
		}
	}
	if mods, ok := doc["module"].(map[string]any); ok {
		for name, m := range mods {
			mm, _ := m.(map[string]any)
			src, _ := mm["source"].(string)
			if !strings.HasPrefix(src, "./") || strings.Contains(src, "..") {
				return fmt.Errorf("%s: module %q source must be a local ./ path shipped in the workspace files", clip(path, 60), clip(name, 40))
			}
		}
	}
	if tf, ok := doc["terraform"]; ok {
		if err := guardTerraformBlock(path, tf, facts); err != nil {
			return err
		}
	}
	return nil
}

// guardResourceBody rejects provisioners and connection blocks.
func guardResourceBody(path, typ string, body any) error {
	m, ok := body.(map[string]any)
	if !ok {
		return nil
	}
	if _, has := m["provisioner"]; has {
		return fmt.Errorf("%s: resource %q uses a provisioner, which runs commands on the runner host", clip(path, 60), typ)
	}
	if _, has := m["connection"]; has {
		return fmt.Errorf("%s: resource %q uses a connection block, which is only needed by provisioners", clip(path, 60), typ)
	}
	return nil
}

// guardTerraformBlock handles the `terraform` block, which JSON allows to be an
// object or an array of objects.
func guardTerraformBlock(path string, tf any, facts *configFacts) error {
	var blocks []map[string]any
	switch v := tf.(type) {
	case map[string]any:
		blocks = append(blocks, v)
	case []any:
		for _, e := range v {
			if m, ok := e.(map[string]any); ok {
				blocks = append(blocks, m)
			}
		}
	}
	for _, b := range blocks {
		if rp, ok := b["required_providers"]; ok {
			for _, m := range asMaps(rp) {
				for name, spec := range m {
					if deniedProviders[name] {
						return fmt.Errorf("%s: required provider %q is not allowed", clip(path, 60), name)
					}
					if sm, ok := spec.(map[string]any); ok {
						if src, _ := sm["source"].(string); src != "" {
							last := src[strings.LastIndex(src, "/")+1:]
							if deniedProviders[last] {
								return fmt.Errorf("%s: provider source %q is not allowed", clip(path, 60), clip(src, 60))
							}
						}
					}
				}
			}
		}
		if be, ok := b["backend"]; ok {
			for _, m := range asMaps(be) {
				for typ, cfg := range m {
					facts.Backend = typ
					if typ == "local" {
						for _, c := range asMaps(cfg) {
							if _, has := c["path"]; has {
								return fmt.Errorf("%s: the local backend 'path' setting is not allowed", clip(path, 60))
							}
							if _, has := c["workspace_dir"]; has {
								return fmt.Errorf("%s: the local backend 'workspace_dir' setting is not allowed", clip(path, 60))
							}
						}
					}
				}
			}
		}
		if _, ok := b["cloud"]; ok {
			facts.Backend = "cloud"
		}
	}
	return nil
}

func asMaps(v any) []map[string]any {
	switch t := v.(type) {
	case map[string]any:
		return []map[string]any{t}
	case []any:
		var out []map[string]any
		for _, e := range t {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}
