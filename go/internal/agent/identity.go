package agent

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// IdentityFileName is the identity file inside the state directory.
const IdentityFileName = "identity.json"

// Kind selects runner vs machine wiring.
type Kind struct {
	// Name is "runner" or "machine".
	Name string
	// Protocol is the protocol id embedded in every signed string.
	Protocol string
	// Collection is the URL collection: "runners" or "machines".
	Collection string
}

// RunnerKind and MachineKind are the two agent kinds.
var (
	RunnerKind  = Kind{Name: "runner", Protocol: protocol.RunnerProtocol, Collection: "runners"}
	MachineKind = Kind{Name: "machine", Protocol: protocol.MachineProtocol, Collection: "machines"}
)

// Identity is the persisted registration result. The private key never
// leaves the host: it is stored 0600 in the state directory and used only to
// sign requests.
type Identity struct {
	Version          int                 `json:"version"`
	Kind             string              `json:"kind"`
	ID               string              `json:"id"`
	WorkspaceID      string              `json:"workspaceId"`
	ControlPlaneURL  string              `json:"controlPlaneUrl"`
	Protocol         string              `json:"protocol"`
	PublicKey        string              `json:"publicKey"`  // base64url raw 32 bytes
	PrivateKey       string              `json:"privateKey"` // base64url raw 32-byte Ed25519 seed
	ControlPlaneKeys []protocol.KeyEntry `json:"controlPlaneKeys"`
	PollIntervalSec  int                 `json:"pollIntervalSec"`
	RegisteredAt     time.Time           `json:"registeredAt"`
}

// GenerateKey creates a fresh Ed25519 identity key pair.
func GenerateKey() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}

// PrivateKeyBytes decodes the stored seed into a signing key.
func (id *Identity) PrivateKeyBytes() (ed25519.PrivateKey, error) {
	seed, err := protocol.B64Decode(id.PrivateKey)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("identity private key is malformed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// String never prints the private key.
func (id *Identity) String() string {
	return fmt.Sprintf("identity{%s %s ws=%s}", id.Kind, id.ID, id.WorkspaceID)
}

// SaveIdentity writes the identity atomically with mode 0600 (directory 0700).
func SaveIdentity(stateDir string, id *Identity) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}
	raw, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(stateDir, IdentityFileName)
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("write identity: %w", err)
	}
	if _, err := f.Write(append(raw, '\n')); err != nil {
		f.Close()
		return fmt.Errorf("write identity: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("write identity: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("write identity: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("write identity: %w", err)
	}
	return nil
}

// ErrNoIdentity means the agent has not registered yet.
var ErrNoIdentity = errors.New("agent is not registered (no identity file)")

// LoadIdentity reads and validates the identity. On Unix it refuses a file
// readable by group or others, because the private key lives in it.
func LoadIdentity(stateDir string, kind Kind) (*Identity, error) {
	path := filepath.Join(stateDir, IdentityFileName)
	st, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNoIdentity
	}
	if err != nil {
		return nil, fmt.Errorf("stat identity: %w", err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("identity file %s has insecure permissions %o (expected 0600); fix with chmod 600", path, st.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read identity: %w", err)
	}
	var id Identity
	if err := json.Unmarshal(raw, &id); err != nil {
		return nil, fmt.Errorf("identity file is corrupt: %w", err)
	}
	if id.Kind != kind.Name {
		return nil, fmt.Errorf("identity is for a %q agent, not %q", id.Kind, kind.Name)
	}
	if !protocol.ValidID(id.ID) || id.WorkspaceID == "" || id.Protocol != kind.Protocol {
		return nil, errors.New("identity file is incomplete or for a different protocol")
	}
	key, err := id.PrivateKeyBytes()
	if err != nil {
		return nil, err
	}
	if protocol.B64Encode(key.Public().(ed25519.PublicKey)) != id.PublicKey {
		return nil, errors.New("identity public key does not match its private key")
	}
	if len(id.ControlPlaneKeys) == 0 {
		return nil, errors.New("identity holds no pinned control-plane keys")
	}
	return &id, nil
}
