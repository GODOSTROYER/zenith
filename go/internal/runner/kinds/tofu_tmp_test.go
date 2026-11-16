package kinds

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
)

func TestTofuScratchIsolation(t *testing.T) {
	for _, longTempRoot := range []bool{false, true} {
		name := "deep workspace"
		if longTempRoot {
			name = "deep workspace and OS temp root"
		}
		t.Run(name, func(t *testing.T) {
			h := newTofuHarness(t, func(c *TofuConfig) {
				c.PassEnv = append(c.PassEnv, "TMPDIR", "HOME", "TF_DATA_DIR", "TF_INPUT")
			})
			for _, key := range []string{"TMPDIR", "HOME", "TF_DATA_DIR", "TF_INPUT"} {
				h.env[key] = "must-not-override"
			}
			workspace := filepath.Join(h.work, strings.Repeat("nested", 20))
			if err := os.MkdirAll(workspace, 0o700); err != nil {
				t.Fatal(err)
			}
			if longTempRoot {
				t.Setenv("TMPDIR", workspace)
			}
			env, cleanup, err := h.tofu.buildEnv(workspace)
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			values := map[string]string{}
			for _, entry := range env {
				key, value, _ := strings.Cut(entry, "=")
				if _, exists := values[key]; exists {
					t.Fatalf("duplicate child environment key %s", key)
				}
				values[key] = value
			}
			if values["HOME"] != filepath.Join(workspace, ".home") || values["TF_DATA_DIR"] != filepath.Join(workspace, ".terraform") || values["TF_INPUT"] != "0" {
				t.Fatal("fixed job environment was overridden")
			}
			scratch := values["TMPDIR"]
			if !filepath.IsAbs(scratch) || scratch == workspace || scratch == os.TempDir() {
				t.Fatalf("scratch must be a separate private directory: %s", scratch)
			}
			info, err := os.Lstat(scratch)
			if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
				t.Fatalf("scratch must be a 0700 directory: %v, %v", info, err)
			}
			if runtime.GOOS != "windows" {
				listener, err := net.Listen("unix", filepath.Join(scratch, "plugin1234567890"))
				if err != nil {
					t.Fatalf("provider socket must fit even with a deep workspace: %v", err)
				}
				if err := listener.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(scratch, "provider-temp"), []byte("temporary"), 0o600); err != nil {
				t.Fatal(err)
			}
			cleanup()
			if _, err := os.Stat(scratch); !os.IsNotExist(err) {
				t.Fatalf("scratch was not removed: %v", err)
			}
		})
	}
}

func assertTofuScratchRemoved(t *testing.T, h *tofuHarness, expected int) {
	t.Helper()
	seen := map[string]bool{}
	for line := range strings.SplitSeq(h.calls(), "\n") {
		if scratch, ok := strings.CutPrefix(line, "scratch "); ok {
			seen[scratch] = true
			if _, err := os.Stat(scratch); !os.IsNotExist(err) {
				t.Errorf("child temporary directory was not removed: %v", err)
			}
		}
	}
	if len(seen) != expected {
		t.Errorf("expected %d distinct version/job scratch directories, got %d", expected, len(seen))
	}
}

func TestTofuScratchLifecycle(t *testing.T) {
	for _, name := range []string{"success", "init failure", "apply failure", "version failure", "timeout", "cancellation"} {
		t.Run(name, func(t *testing.T) {
			h := newTofuHarness(t, nil)
			behavior := ""
			expectedStatus := agent.StatusSucceeded
			expectedDirs := 2
			switch name {
			case "init failure":
				behavior, expectedStatus = "initfail", agent.StatusFailed
			case "apply failure":
				behavior, expectedStatus, expectedDirs = "applyfail", agent.StatusFailed, 4
			case "version failure":
				h.env["FAKE_TOFU_VERSION"] = "1.13.0"
				expectedStatus, expectedDirs = agent.StatusFailed, 1
			case "timeout":
				behavior, expectedStatus = "slow", agent.StatusTimedOut
			case "cancellation":
				behavior, expectedStatus = "slow", agent.StatusFailed
			}
			files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", behavior}}
			var outcome Outcome
			if name == "cancellation" {
				run, err := h.prepare("infrastructure.plan", payload("plan", files, nil), 0)
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				timer := time.AfterFunc(700*time.Millisecond, cancel)
				defer timer.Stop()
				outcome = run(ctx, &memSink{})
			} else {
				deadline := 30 * time.Second
				if name == "timeout" {
					deadline = 1500 * time.Millisecond
				}
				outcome, _ = h.runWith("infrastructure.plan", payload("plan", files, nil), 0, deadline)
				if name == "apply failure" {
					if outcome.Status != agent.StatusSucceeded {
						t.Fatalf("plan: %+v", outcome)
					}
					sha := resultMap(t, outcome)["planFileSha256"].(string)
					outcome, _ = h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": sha}))
				}
			}
			if outcome.Status != expectedStatus {
				t.Fatalf("expected %s, got %+v", expectedStatus, outcome)
			}
			assertTofuScratchRemoved(t, h, expectedDirs)
			if entries, err := os.ReadDir(h.work); err != nil || len(entries) != 0 {
				t.Fatalf("workspace cleanup failed: %v, %v", entries, err)
			}
		})
	}
}

func TestTofuScratchConcurrentJobs(t *testing.T) {
	h := newTofuHarness(t, func(c *TofuConfig) { c.MaxConcurrent = 4 })
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Go(func() {
			// Different configuration digests avoid serializing on the plan lock.
			files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", strings.Repeat("x", i+1)}}
			outcome, _ := h.run("infrastructure.plan", payload("plan", files, nil))
			if outcome.Status != agent.StatusSucceeded {
				t.Errorf("%+v", outcome)
			}
		})
	}
	wg.Wait()
	assertTofuScratchRemoved(t, h, 8)
}
