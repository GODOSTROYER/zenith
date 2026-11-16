package kinds

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type digestVectorFile struct {
	Vectors []struct {
		Name  string `json:"name"`
		Files []struct {
			Path       string `json:"path"`
			ContentB64 string `json:"contentB64"`
		} `json:"files"`
		ConfigDigest string `json:"configDigest"`
	} `json:"vectors"`
	Lock *struct {
		Lockfile   string `json:"lockfile"`
		LockDigest string `json:"lockDigest"`
	} `json:"lock"`
}

func loadDigestVectors(t *testing.T, name string) digestVectorFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var v digestVectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	return v
}

func runDigestVectors(t *testing.T, name string) {
	v := loadDigestVectors(t, name)
	for _, c := range v.Vectors {
		t.Run(c.Name, func(t *testing.T) {
			var files []ConfigFile
			for _, f := range c.Files {
				content, err := base64.StdEncoding.DecodeString(f.ContentB64)
				if err != nil {
					t.Fatal(err)
				}
				files = append(files, ConfigFile{Path: f.Path, Content: content})
			}
			if got := ConfigDigest(files); got != c.ConfigDigest {
				t.Fatalf("configDigest %s, want %s", got, c.ConfigDigest)
			}
		})
	}
	if v.Lock != nil {
		if got := LockDigest(v.Lock.Lockfile); got != v.Lock.LockDigest {
			t.Fatalf("lockDigest %s, want %s", got, v.Lock.LockDigest)
		}
	}
}

// The TypeScript side's independently produced golden vector
// (tests/tofu/fixtures/config-digest-vector.json on ws/tofu, copied verbatim).
func TestConfigDigestMatchesTypeScriptVector(t *testing.T) {
	runDigestVectors(t, "config-digest-ts-vector.json")
}

// A second vector produced by a scratch Node script using only node:crypto.
func TestConfigDigestMatchesNodeVector(t *testing.T) {
	runDigestVectors(t, "config-digest-vector.json")
}

func TestConfigDigestIsOrderIndependentAndContentSensitive(t *testing.T) {
	a := ConfigFile{Path: "a.tf.json", Content: []byte("1")}
	b := ConfigFile{Path: "b.tf.json", Content: []byte("2")}
	d1 := ConfigDigest([]ConfigFile{a, b})
	d2 := ConfigDigest([]ConfigFile{b, a})
	if d1 != d2 {
		t.Fatal("digest must not depend on input order")
	}
	if ConfigDigest([]ConfigFile{{Path: "a.tf.json", Content: []byte("1")}, {Path: "b.tf.json", Content: []byte("3")}}) == d1 {
		t.Fatal("digest must depend on content")
	}
	if ConfigDigest([]ConfigFile{{Path: "a.tf.json", Content: []byte("1")}, {Path: "c.tf.json", Content: []byte("2")}}) == d1 {
		t.Fatal("digest must depend on paths")
	}
}

func TestValidateFilePath(t *testing.T) {
	good := []string{"main.tf.json", "modules/net/main.tf.json", "a-b_c.d/x.tfvars.json", "data.json", "t.tftpl"}
	for _, p := range good {
		if err := ValidateFilePath(p, false); err != nil {
			t.Errorf("%q should be accepted: %v", p, err)
		}
	}
	bad := []string{
		"", "/etc/passwd", "../x.tf.json", "a/../b.tf.json", "./a.tf.json", "a//b.tf.json", "a\\b.tf.json", "a b.tf.json",
		".terraform.lock.hcl", ".terraform/x.tf.json", ".git/config", "terraform.tfstate", "x.tfstate.backup", "plan.tfplan",
		".terraformrc", "main.tf", "x.tfvars", "run.sh", "évil.tf.json", "a\x00b.tf.json", strings.Repeat("a", 201) + ".json",
	}
	for _, p := range bad {
		if err := ValidateFilePath(p, false); err == nil {
			t.Errorf("%q should be rejected", p)
		}
	}
	if err := ValidateFilePath("main.tf", true); err != nil {
		t.Errorf("HCL must be accepted with allowUnsafeConfig: %v", err)
	}
	if err := ValidateFilePath("../main.tf", true); err == nil {
		t.Error("traversal is never accepted, even with allowUnsafeConfig")
	}
}

func cfgFile(path, content string) ConfigFile {
	return ConfigFile{Path: path, Content: []byte(content)}
}

func TestGuardConfigRejectsCodeExecutionAndHostAccess(t *testing.T) {
	cases := map[string]string{
		"local-exec provisioner":     `{"resource":{"null_resource":{"x":{"provisioner":[{"local-exec":{"command":"curl evil"}}]}}}}`,
		"terraform_data provisioner": `{"resource":{"terraform_data":{"x":{"provisioner":{"local-exec":{"command":"id"}}}}}}`,
		"connection block":           `{"resource":{"aws_instance":{"x":{"connection":{"type":"ssh"}}}}}`,
		"external data source":       `{"data":{"external":{"x":{"program":["sh","-c","id"]}}}}`,
		"http data source":           `{"data":{"http":{"x":{"url":"http://169.254.169.254/latest/meta-data/"}}}}`,
		"local_file data":            `{"data":{"local_file":{"x":{"filename":"/var/run/secrets/kubernetes.io/serviceaccount/token"}}}}`,
		"local_file resource":        `{"resource":{"local_file":{"x":{"filename":"/etc/cron.d/x","content":"x"}}}}`,
		"local_sensitive_file":       `{"resource":{"local_sensitive_file":{"x":{"filename":"/tmp/x","content":"x"}}}}`,
		"external provider":          `{"provider":{"external":{}}}`,
		"required external":          `{"terraform":{"required_providers":{"ext":{"source":"hashicorp/external","version":"2.0.0"}}}}`,
		"required http":              `{"terraform":{"required_providers":{"http":{"source":"registry.opentofu.org/hashicorp/http"}}}}`,
		"remote module":              `{"module":{"m":{"source":"git::https://evil.example/repo.git"}}}`,
		"registry module":            `{"module":{"m":{"source":"terraform-aws-modules/vpc/aws"}}}`,
		"module path traversal":      `{"module":{"m":{"source":"./../../etc"}}}`,
		"local backend path":         `{"terraform":{"backend":{"local":{"path":"/etc/passwd"}}}}`,
		"local backend workdir":      `{"terraform":{"backend":{"local":{"workspace_dir":"/"}}}}`,
		"terraform block array":      `{"terraform":[{"required_providers":{"external":{"source":"hashicorp/external"}}}]}`,
	}
	for name, doc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := GuardConfig([]ConfigFile{cfgFile("main.tf.json", doc)}); err == nil {
				t.Fatalf("expected the guard to reject %s", name)
			}
		})
	}
}

func TestGuardConfigAcceptsOrdinaryConfigAndReportsBackend(t *testing.T) {
	doc := `{
	  "terraform": {"required_providers": {"aws": {"source": "hashicorp/aws", "version": "= 6.1.0"}},
	                "backend": {"s3": {"bucket": "state", "key": "k", "region": "ap-south-1"}}},
	  "provider": {"aws": {"region": "ap-south-1"}},
	  "resource": {"aws_s3_bucket": {"b": {"bucket": "x"}}, "terraform_data": {"t": {"input": "ok"}}},
	  "data": {"aws_caller_identity": {"me": {}}},
	  "module": {"m": {"source": "./modules/m"}}
	}`
	facts, err := GuardConfig([]ConfigFile{cfgFile("main.tf.json", doc), cfgFile("data.json", "not checked: not a tf.json")})
	if err != nil {
		t.Fatal(err)
	}
	if facts.Backend != "s3" {
		t.Fatalf("backend %q", facts.Backend)
	}
	// the compiler's own local backend (relative path) is accepted for test workspaces
	facts, err = GuardConfig([]ConfigFile{cfgFile("backend.tf.json", `{"terraform":{"backend":{"local":{"path":"terraform.tfstate"}}}}`)})
	if err != nil || facts.Backend != "local" {
		t.Fatalf("%v %q", err, facts.Backend)
	}
	facts, err = GuardConfig([]ConfigFile{cfgFile("main.tf.json", `{"resource":{}}`)})
	if err != nil || facts.Backend != "" {
		t.Fatalf("no backend block means an implicit local backend: %v %q", err, facts.Backend)
	}
	if _, err := GuardConfig([]ConfigFile{cfgFile("main.tf.json", "{not json")}); err == nil {
		t.Fatal("invalid JSON must be rejected")
	}
}
