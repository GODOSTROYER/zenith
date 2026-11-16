package agent

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent/fakecp"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

type rotationProcessor struct{ keys *protocol.KeySet }

func (p *rotationProcessor) Capabilities() []string { return []string{"rotation.fixture"} }

func (p *rotationProcessor) Verify(_ context.Context, token string) (Job, *Rejection) {
	if _, _, err := protocol.VerifyCompact(token, p.keys, "rotation.fixture"); err != nil {
		return nil, &Rejection{Code: "rotation_fixture_rejected", Message: "fixture signature refused"}
	}
	return nil, nil
}

func rotationFixture(t *testing.T) (*Agent, *Identity, *protocol.KeySet, *fakecp.Server) {
	t.Helper()
	cp := fakecp.New(t, "runners", protocol.RunnerProtocol)
	dir := t.TempDir()
	cfg := &Common{ControlPlane: ControlPlaneConfig{URL: cp.URL}, TLS: TLSConfig{CAFile: cp.CAFile(dir)}}
	cfg.ApplyDefaults(filepath.Join(dir, "state"))
	id, err := Register(context.Background(), cfg, RegisterOptions{Kind: RunnerKind, Token: cp.Token, Version: "rotation-fixture", UserAgent: "rotation-fixture"})
	if err != nil {
		t.Fatal("rotation fixture registration failed")
	}
	keys, err := protocol.NewKeySet(id.ControlPlaneKeys)
	if err != nil {
		t.Fatal("rotation fixture pinned keys are invalid")
	}
	a, err := New(Options{Kind: RunnerKind, Config: cfg, Identity: id, Keys: keys, Processor: &rotationProcessor{keys: keys}, Version: "rotation-fixture", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal("rotation fixture agent could not initialize")
	}
	return a, id, keys, cp
}

func persistedRotationKeys(t *testing.T, a *Agent) *protocol.KeySet {
	t.Helper()
	id, err := LoadIdentity(a.cfg.StateDir, RunnerKind)
	if err != nil {
		t.Fatal("persisted rotation identity could not load")
	}
	keys, err := protocol.NewKeySet(id.ControlPlaneKeys)
	if err != nil {
		t.Fatal("persisted rotation keys could not validate")
	}
	for i := 1; i < len(id.ControlPlaneKeys); i++ {
		if id.ControlPlaneKeys[i-1].Kid >= id.ControlPlaneKeys[i].Kid {
			t.Fatal("persisted rotation keys must be sorted and unique")
		}
	}
	return keys
}

func verifyRotationFixture(t *testing.T, keys *protocol.KeySet, cp *protocoltest.ControlPlane, accepted bool) {
	t.Helper()
	token := cp.Sign("rotation.fixture", map[string]string{"fixture": "inert"})
	_, _, err := protocol.VerifyCompact(token, keys, "rotation.fixture")
	if (err == nil) != accepted {
		t.Fatal("rotation signature acceptance differs from expected persisted trust")
	}
}

func TestRotationPersistenceFailureRetriesSameTLSAnnouncement(t *testing.T) {
	for _, obstruction := range []string{"state-directory-file", "identity-target-directory"} {
		t.Run(obstruction, func(t *testing.T) {
			a, original, keys, cp := rotationFixture(t)
			next := protocoltest.New("cp-rotation-next")
			cp.AnnounceKeys(next.Keys()...)
			verifyRotationFixture(t, keys, cp.CP, true)
			verifyRotationFixture(t, keys, next, false)
			var restore func()
			if obstruction == "state-directory-file" {
				backup := a.cfg.StateDir + ".preserved"
				if err := os.Rename(a.cfg.StateDir, backup); err != nil {
					t.Fatal("could not preserve fixture state directory")
				}
				if err := os.WriteFile(a.cfg.StateDir, []byte("storage obstruction"), 0o600); err != nil {
					t.Fatal("could not obstruct fixture storage")
				}
				restore = func() {
					if err := os.Remove(a.cfg.StateDir); err != nil {
						t.Fatal("could not remove fixture storage obstruction")
					}
					if err := os.Rename(backup, a.cfg.StateDir); err != nil {
						t.Fatal("could not restore fixture storage")
					}
				}
			} else {
				path := filepath.Join(a.cfg.StateDir, IdentityFileName)
				backup := path + ".preserved"
				if err := os.Rename(path, backup); err != nil {
					t.Fatal("could not preserve fixture identity")
				}
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal("could not obstruct fixture identity replacement")
				}
				restore = func() {
					if err := os.Remove(path); err != nil {
						t.Fatal("could not remove fixture identity obstruction")
					}
					if err := os.Rename(backup, path); err != nil {
						t.Fatal("could not restore fixture identity")
					}
				}
			}
			// The actual signed heartbeat is TLS-verified, but an actual filesystem error refuses new trust.
			if err := a.heartbeat(context.Background()); err != nil {
				t.Fatal("TLS rotation heartbeat failed")
			}
			if keys.Len() != 1 || a.keys != keys {
				t.Fatal("failed persistence must not publish or replace shared trust")
			}
			verifyRotationFixture(t, keys, cp.CP, true)
			verifyRotationFixture(t, keys, next, false)
			restore()
			if persistedRotationKeys(t, a).Len() != 1 {
				t.Fatal("failed rotation must retain the original persisted trust")
			}
			if err := a.heartbeat(context.Background()); err != nil {
				t.Fatal("recovered TLS rotation heartbeat failed")
			}
			if keys.Len() != 2 || a.keys != keys || len(original.ControlPlaneKeys) != 1 || len(a.opts.Identity.ControlPlaneKeys) != 1 {
				t.Fatal("rotation must publish to the shared key set without mutating registration identity")
			}
			verifyRotationFixture(t, persistedRotationKeys(t, a), next, true)
			verifyRotationFixture(t, keys, cp.CP, true)
			verifyRotationFixture(t, keys, next, true)
			// A fresh process derives its verifier solely from the saved identity.
			loaded, err := LoadIdentity(a.cfg.StateDir, RunnerKind)
			if err != nil {
				t.Fatal("restarted identity could not load")
			}
			restartedKeys, err := protocol.NewKeySet(loaded.ControlPlaneKeys)
			if err != nil {
				t.Fatal("restarted keys could not validate")
			}
			restarted, err := New(Options{Kind: RunnerKind, Config: a.cfg, Identity: loaded, Keys: restartedKeys, Processor: &rotationProcessor{keys: restartedKeys}, Version: "rotation-restart", Logger: a.log})
			if err != nil {
				t.Fatal("restarted rotation agent could not initialize")
			}
			verifyRotationFixture(t, restarted.keys, cp.CP, true)
			verifyRotationFixture(t, restarted.keys, next, true)
			processor := restarted.opts.Processor.(*rotationProcessor)
			if processor.keys != restarted.keys {
				t.Fatal("restarted processor must retain the shared verifier")
			}
			if _, refusal := processor.Verify(context.Background(), next.Sign("rotation.fixture", map[string]string{"fixture": "inert"})); refusal != nil {
				t.Fatal("restarted processor must verify the rotated signature")
			}
			if leftovers, err := filepath.Glob(filepath.Join(a.cfg.StateDir, ".identity-*.tmp")); err != nil || len(leftovers) != 0 {
				t.Fatal("private temporary identity files must be cleaned after failure and success")
			}
		})
	}
}

func TestRotationInvalidDuplicateConflictAndPinnedLimit(t *testing.T) {
	a, _, keys, cp := rotationFixture(t)
	next := protocoltest.New("cp-first")
	conflict := protocoltest.New(next.Kid)
	initialConflict := protocoltest.New(cp.CP.Kid)
	valid := next.Keys()[0]
	a.acceptNextKeys([]protocol.KeyEntry{
		{Kid: "", PublicKey: valid.PublicKey},
		{Kid: strings.Repeat("x", 129), PublicKey: valid.PublicKey},
		{Kid: "invalid-public", PublicKey: "invalid"},
		initialConflict.Keys()[0], valid, valid, conflict.Keys()[0],
	})
	if keys.Len() != 2 || persistedRotationKeys(t, a).Len() != 2 {
		t.Fatal("only one valid new immutable kid may be accepted")
	}
	verifyRotationFixture(t, keys, cp.CP, true)
	verifyRotationFixture(t, keys, initialConflict, false)
	verifyRotationFixture(t, keys, next, true)
	verifyRotationFixture(t, keys, conflict, false)
	var batch []protocol.KeyEntry
	for i := 0; i < maxPinnedKeys-2; i++ {
		batch = append(batch, protocoltest.New(fmt.Sprintf("cp-fill-%d", i)).Keys()[0])
	}
	a.acceptNextKeys(batch)
	if keys.Len() != maxPinnedKeys || persistedRotationKeys(t, a).Len() != maxPinnedKeys {
		t.Fatal("all permitted announcements must remain persisted at the pin limit")
	}
	path := filepath.Join(a.cfg.StateDir, IdentityFileName)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("could not read bounded fixture identity")
	}
	overflow := protocoltest.New("cp-over-limit")
	a.acceptNextKeys(append([]protocol.KeyEntry{valid, conflict.Keys()[0], overflow.Keys()[0]}, batch...))
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) || keys.Len() != maxPinnedKeys {
		t.Fatal("duplicate, conflict and over-limit announcements must not replace or evict persisted keys")
	}
	verifyRotationFixture(t, keys, overflow, false)
	verifyRotationFixture(t, persistedRotationKeys(t, a), next, true)
}

func TestRotationConcurrentReadersObservePersistenceBeforePublication(t *testing.T) {
	a, _, keys, cp := rotationFixture(t)
	var next []protocol.KeyEntry
	for i := 0; i < maxPinnedKeys-1; i++ {
		next = append(next, protocoltest.New(fmt.Sprintf("cp-concurrent-%d", i)).Keys()[0])
	}
	oldToken := cp.CP.Sign("rotation.fixture", map[string]string{"fixture": "inert"})
	failures := make(chan error, 1)
	report := func(message string) {
		select {
		case failures <- errors.New(message):
		default:
		}
	}
	stop := make(chan struct{})
	seenPublication := make(chan struct{}, 1)
	ready := make(chan struct{}, 8)
	var readers sync.WaitGroup
	for i := 0; i < 8; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			ready <- struct{}{}
			for {
				select {
				case <-stop:
					return
				default:
				}
				if _, _, err := protocol.VerifyCompact(oldToken, keys, "rotation.fixture"); err != nil {
					report("rotation lost original signature trust")
					return
				}
				entries := keys.Entries()
				if keys.Len() > maxPinnedKeys || len(a.opts.Identity.ControlPlaneKeys) != 1 {
					report("rotation exceeded its limit or mutated shared identity")
					return
				}
				if len(entries) == 1 {
					continue
				}
				id, err := LoadIdentity(a.cfg.StateDir, RunnerKind)
				if err != nil {
					report("a concurrent reader could not load the persisted identity")
					return
				}
				persisted, err := protocol.NewKeySet(id.ControlPlaneKeys)
				if err != nil {
					report("a concurrent reader observed invalid persisted keys")
					return
				}
				for _, entry := range entries {
					pinned, ok := persisted.Get(entry.Kid)
					if !ok || protocol.B64Encode(pinned) != entry.PublicKey {
						report("shared trust was published before its exact persisted key")
						return
					}
				}
				select {
				case seenPublication <- struct{}{}:
				default:
				}
			}
		}()
	}
	for i := 0; i < 8; i++ {
		<-ready
	}
	var writers sync.WaitGroup
	for _, entry := range next {
		writers.Add(1)
		go func(k protocol.KeyEntry) {
			defer writers.Done()
			for i := 0; i < 3; i++ {
				a.acceptNextKeys([]protocol.KeyEntry{k, k})
			}
		}(entry)
	}
	writers.Wait()
	select {
	case <-seenPublication:
	case <-time.After(5 * time.Second):
		report("concurrent readers never observed published rotation trust")
	}
	close(stop)
	readers.Wait()
	select {
	case err := <-failures:
		t.Fatal(err)
	default:
	}
	if a.keys != keys || keys.Len() != maxPinnedKeys || persistedRotationKeys(t, a).Len() != maxPinnedKeys {
		t.Fatal("concurrent announcements must preserve every accepted key in the same shared verifier")
	}
}

func TestRotationOwnsImmutableRegistrationSnapshot(t *testing.T) {
	a, original, keys, _ := rotationFixture(t)
	wantPath := a.itemPath("/heartbeat")
	original.ID = "run_changed"
	original.ControlPlaneKeys[0].Kid = "changed"
	original.PrivateKey = "changed"
	if a.itemPath("/heartbeat") != wantPath || a.opts.Identity.ControlPlaneKeys[0].Kid == "changed" {
		t.Fatal("agent must not share mutable registration metadata with its caller")
	}
	private, err := a.opts.Identity.PrivateKeyBytes()
	if err != nil || len(private) != ed25519.PrivateKeySize || a.keys != keys {
		t.Fatal("immutable registration snapshot must retain its signing identity and shared trust")
	}
}
