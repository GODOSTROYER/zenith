package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// b64 is the URL-safe, unpadded, strict base64 used everywhere on the wire
// (JWS parts, public keys, nonces, signatures).
var b64 = base64.RawURLEncoding.Strict()

// B64Encode encodes bytes as unpadded base64url.
func B64Encode(b []byte) string { return b64.EncodeToString(b) }

// B64Decode decodes strict unpadded base64url.
func B64Decode(s string) ([]byte, error) { return b64.DecodeString(s) }

// KeyEntry is a pinned control-plane public key as delivered at registration
// and in heartbeat `nextKeys`.
type KeyEntry struct {
	Kid       string `json:"kid"`
	PublicKey string `json:"publicKey"` // base64url raw 32 bytes
}

// KeySet is the set of control-plane Ed25519 public keys an agent pins.
// It is safe for concurrent use.
type KeySet struct {
	mu   sync.RWMutex
	keys map[string]ed25519.PublicKey
}

// NewKeySet builds a KeySet from registration entries.
func NewKeySet(entries []KeyEntry) (*KeySet, error) {
	ks := &KeySet{keys: map[string]ed25519.PublicKey{}}
	for _, e := range entries {
		if err := ks.Add(e); err != nil {
			return nil, err
		}
	}
	return ks, nil
}

// Add pins (or replaces) one key. It validates the kid and key length.
func (ks *KeySet) Add(e KeyEntry) error {
	if e.Kid == "" || len(e.Kid) > 128 {
		return fmt.Errorf("control-plane key has an invalid kid")
	}
	raw, err := B64Decode(e.PublicKey)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return fmt.Errorf("control-plane key %q is not a base64url raw 32-byte Ed25519 public key", e.Kid)
	}
	ks.mu.Lock()
	defer ks.mu.Unlock()
	ks.keys[e.Kid] = ed25519.PublicKey(raw)
	return nil
}

// Get returns the key pinned under kid.
func (ks *KeySet) Get(kid string) (ed25519.PublicKey, bool) {
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	k, ok := ks.keys[kid]
	return k, ok
}

// Len returns the number of pinned keys.
func (ks *KeySet) Len() int {
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	return len(ks.keys)
}

// Entries returns the pinned keys, for persistence.
func (ks *KeySet) Entries() []KeyEntry {
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	out := make([]KeyEntry, 0, len(ks.keys))
	for kid, k := range ks.keys {
		out = append(out, KeyEntry{Kid: kid, PublicKey: B64Encode(k)})
	}
	return out
}

// Header is the protected JWS header. Only these three members are accepted.
type Header struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	Typ string `json:"typ"`
}

// VerifyCompact verifies a compact JWS against the pinned keys and returns the
// header and the raw payload bytes. It enforces, in order: size, three-part
// structure, strict header shape, alg == EdDSA, typ == wantTyp, kid pinned,
// and the Ed25519 signature over `<b64 header>.<b64 payload>`.
//
// The payload is returned undecoded so callers parse it into the right type;
// nothing in the payload is trusted before this function returns nil.
func VerifyCompact(token string, keys *KeySet, wantTyp string) (Header, []byte, error) {
	var h Header
	if len(token) == 0 || len(token) > MaxTokenBytes {
		return h, nil, Errorf(CodeMalformed, "token size out of range")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return h, nil, Errorf(CodeMalformed, "compact JWS must have three parts")
	}
	hdrBytes, err := B64Decode(parts[0])
	if err != nil {
		return h, nil, Errorf(CodeMalformed, "header is not base64url")
	}
	dec := json.NewDecoder(bytes.NewReader(hdrBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&h); err != nil {
		return Header{}, nil, Errorf(CodeMalformed, "header is not a valid JWS header")
	}
	if dec.More() {
		return Header{}, nil, Errorf(CodeMalformed, "trailing data after header")
	}
	if h.Alg != AlgEdDSA {
		return h, nil, Errorf(CodeUnsupportedAlg, "alg must be %s", AlgEdDSA)
	}
	if h.Typ != wantTyp {
		return h, nil, Errorf(CodeBadType, "typ must be %s", wantTyp)
	}
	if h.Kid == "" {
		return h, nil, Errorf(CodeUnknownKey, "kid is required")
	}
	pub, ok := keys.Get(h.Kid)
	if !ok {
		return h, nil, Errorf(CodeUnknownKey, "kid %q is not pinned", truncate(h.Kid, 64))
	}
	sig, err := B64Decode(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return h, nil, Errorf(CodeBadSignature, "signature is not a base64url Ed25519 signature")
	}
	if !ed25519.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
		return h, nil, Errorf(CodeBadSignature, "signature does not verify against the pinned key")
	}
	payload, err := B64Decode(parts[1])
	if err != nil {
		return h, nil, Errorf(CodeMalformed, "payload is not base64url")
	}
	return h, payload, nil
}

// UnverifiedJTI extracts the `jti` of a token WITHOUT verifying it. It exists
// only so an agent can report a `rejected` result for a job whose signature
// failed; the value is untrusted and is validated as an identifier.
func UnverifiedJTI(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := B64Decode(parts[1])
	if err != nil {
		return ""
	}
	var p struct {
		JTI string `json:"jti"`
	}
	if json.Unmarshal(raw, &p) != nil || !ValidID(p.JTI) {
		return ""
	}
	return p.JTI
}

// ValidID reports whether s is a plausible Zenith identifier (job ids,
// runner ids, ...). It is used before ids are placed in URL paths.
func ValidID(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-', c == '.', c == ':':
		default:
			return false
		}
	}
	return true
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
