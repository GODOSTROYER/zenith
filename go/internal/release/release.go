// Package release is the signed release channel for the Zenith agents.
//
// A release manifest names one component version per channel and, for each
// platform, the artifact URL, size and SHA-256. The manifest is signed offline
// with an Ed25519 release key; agents pin the release PUBLIC keys in their own
// local config (never taken from the manifest, the artifact host or the
// control plane), so neither a compromised download host nor a compromised
// control plane can make an agent run an unsigned binary.
//
// Replay and rollback protection live in the signed fields: `seq` is a
// monotonically increasing sequence the agent persists, `expiresAt` bounds how
// long a captured manifest stays usable, and a lower version is only accepted
// when the signed manifest itself says `allowDowngrade` (an explicit signed
// rollback release).
package release

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// Schema is the manifest schema id; it is also the signing domain separator.
const Schema = "zenith.release/v1"

const signingPrefix = Schema + "\n"

// Limits.
const (
	MaxManifestBytes = 256 << 10
	MaxArtifactBytes = 256 << 20
	MaxManifestLife  = 90 * 24 * time.Hour
	maxClockSkew     = 5 * time.Minute
	maxArtifacts     = 16
	maxSignatures    = 8
	maxVersionLen    = 64
)

// Components that ship through the channel.
const (
	ComponentRunner  = "zenith-runner"
	ComponentZenithd = "zenithd"
)

var (
	channelRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	semverRe  = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]{1,32})?$`)
	sha256Re  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	osArchRe  = regexp.MustCompile(`^[a-z0-9_]{1,16}$`)
)

// Artifact is one downloadable binary.
type Artifact struct {
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Manifest is the signed release description.
type Manifest struct {
	Schema         string     `json:"schema"`
	Channel        string     `json:"channel"`
	Component      string     `json:"component"`
	Version        string     `json:"version"`
	Seq            int64      `json:"seq"`
	IssuedAt       string     `json:"issuedAt"`
	ExpiresAt      string     `json:"expiresAt"`
	AllowDowngrade bool       `json:"allowDowngrade,omitempty"`
	Artifacts      []Artifact `json:"artifacts"`
}

// Signature is one detached signature over the manifest bytes.
type Signature struct {
	KID string `json:"kid"`
	Sig string `json:"sig"` // base64url Ed25519 signature
}

// Envelope is what the release channel serves: the exact manifest bytes
// (base64url) and the signatures over them. Signing the bytes, not a parsed
// form, removes every canonicalisation question.
type Envelope struct {
	Manifest   string      `json:"manifest"`
	Signatures []Signature `json:"signatures"`
}

// Sign produces the envelope for a manifest. The manifest is validated first so
// an unusable release cannot be published by accident.
func Sign(priv ed25519.PrivateKey, kid string, m Manifest) (Envelope, error) {
	if m.Schema == "" {
		m.Schema = Schema
	}
	if err := m.validate(); err != nil {
		return Envelope{}, err
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return Envelope{}, err
	}
	sig := ed25519.Sign(priv, append([]byte(signingPrefix), raw...))
	return Envelope{Manifest: protocol.B64Encode(raw), Signatures: []Signature{{KID: kid, Sig: protocol.B64Encode(sig)}}}, nil
}

// Verify checks the envelope against the pinned release keys (any one valid
// signature suffices) and returns the validated manifest. now is the verifier's
// clock. Unknown fields, oversize input, an expired manifest or an invalid
// signature are all errors; nothing about the manifest is trusted before the
// signature verifies.
func Verify(raw []byte, pinned []protocol.KeyEntry, now time.Time) (*Manifest, error) {
	if len(raw) > MaxManifestBytes {
		return nil, errors.New("release envelope is too large")
	}
	if len(pinned) == 0 {
		return nil, errors.New("no release public keys are pinned")
	}
	var env Envelope
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		return nil, fmt.Errorf("release envelope is malformed: %w", err)
	}
	if len(env.Signatures) == 0 || len(env.Signatures) > maxSignatures {
		return nil, errors.New("release envelope has no usable signatures")
	}
	body, err := protocol.B64Decode(env.Manifest)
	if err != nil || len(body) == 0 || len(body) > MaxManifestBytes {
		return nil, errors.New("release manifest encoding is invalid")
	}
	keys := map[string]ed25519.PublicKey{}
	for _, k := range pinned {
		pub, err := protocol.B64Decode(k.PublicKey)
		if err != nil || len(pub) != ed25519.PublicKeySize || k.Kid == "" {
			return nil, fmt.Errorf("pinned release key %q is invalid", k.Kid)
		}
		keys[k.Kid] = ed25519.PublicKey(pub)
	}
	msg := append([]byte(signingPrefix), body...)
	verified := false
	for _, s := range env.Signatures {
		pub, ok := keys[s.KID]
		if !ok {
			continue
		}
		sig, err := protocol.B64Decode(s.Sig)
		if err != nil || len(sig) != ed25519.SignatureSize {
			continue
		}
		if ed25519.Verify(pub, msg, sig) {
			verified = true
			break
		}
	}
	if !verified {
		return nil, errors.New("release manifest signature does not verify against any pinned release key")
	}
	var m Manifest
	md := json.NewDecoder(bytes.NewReader(body))
	md.DisallowUnknownFields()
	if err := md.Decode(&m); err != nil {
		return nil, fmt.Errorf("release manifest is malformed: %w", err)
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	issued, _ := time.Parse(time.RFC3339, m.IssuedAt)
	expires, _ := time.Parse(time.RFC3339, m.ExpiresAt)
	if issued.After(now.Add(maxClockSkew)) {
		return nil, errors.New("release manifest is issued in the future")
	}
	if !expires.After(now) {
		return nil, errors.New("release manifest has expired")
	}
	return &m, nil
}

func (m *Manifest) validate() error {
	switch {
	case m.Schema != Schema:
		return fmt.Errorf("release manifest schema must be %s", Schema)
	case !channelRe.MatchString(m.Channel):
		return errors.New("release manifest channel is invalid")
	case m.Component != ComponentRunner && m.Component != ComponentZenithd:
		return errors.New("release manifest component is invalid")
	case len(m.Version) > maxVersionLen || !semverRe.MatchString(m.Version):
		return errors.New("release manifest version must be semantic (MAJOR.MINOR.PATCH[-pre])")
	case m.Seq < 1:
		return errors.New("release manifest seq must be positive")
	case len(m.Artifacts) == 0 || len(m.Artifacts) > maxArtifacts:
		return errors.New("release manifest must list between 1 and 16 artifacts")
	}
	issued, err := time.Parse(time.RFC3339, m.IssuedAt)
	if err != nil {
		return errors.New("release manifest issuedAt is invalid")
	}
	expires, err := time.Parse(time.RFC3339, m.ExpiresAt)
	if err != nil {
		return errors.New("release manifest expiresAt is invalid")
	}
	if !expires.After(issued) || expires.Sub(issued) > MaxManifestLife {
		return errors.New("release manifest lifetime must be positive and at most 90 days")
	}
	seen := map[string]bool{}
	for _, a := range m.Artifacts {
		if !osArchRe.MatchString(a.OS) || !osArchRe.MatchString(a.Arch) {
			return errors.New("release artifact os/arch is invalid")
		}
		if seen[a.OS+"/"+a.Arch] {
			return errors.New("release manifest lists a platform twice")
		}
		seen[a.OS+"/"+a.Arch] = true
		if !sha256Re.MatchString(a.SHA256) {
			return errors.New("release artifact sha256 must be 64 lowercase hex characters")
		}
		if a.Size < 1 || a.Size > MaxArtifactBytes {
			return errors.New("release artifact size is out of range")
		}
		if err := ValidateArtifactURL(a.URL); err != nil {
			return err
		}
	}
	return nil
}

// ValidateArtifactURL requires https (plain http only for a loopback host, for
// local development) with no credentials, query or fragment.
func ValidateArtifactURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("release artifact url must be an absolute URL without credentials, query or fragment")
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		h := u.Hostname()
		if strings.EqualFold(h, "localhost") {
			return nil
		}
		if ip := net.ParseIP(h); ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return errors.New("release artifact url must be https")
}

// Find returns the artifact for a platform.
func (m *Manifest) Find(goos, goarch string) (Artifact, bool) {
	for _, a := range m.Artifacts {
		if a.OS == goos && a.Arch == goarch {
			return a, true
		}
	}
	return Artifact{}, false
}

// Decision is what an agent should do with a verified manifest.
type Decision struct {
	Apply  bool
	Reason string
}

// Decide applies the anti-replay and anti-rollback rules to a verified
// manifest. current is the running version, lastSeq the highest seq the agent
// has ever accepted, channel and component what the agent follows.
func Decide(m *Manifest, channel, component, current string, lastSeq int64) Decision {
	switch {
	case m.Channel != channel:
		return Decision{false, "manifest is for another channel"}
	case m.Component != component:
		return Decision{false, "manifest is for another component"}
	case m.Seq <= lastSeq:
		return Decision{false, "manifest sequence is not newer than one already accepted (replay or stale mirror)"}
	}
	cmp, ok := CompareVersions(m.Version, current)
	switch {
	case !ok:
		return Decision{false, "current version is not comparable; refusing to change it automatically"}
	case cmp == 0:
		return Decision{false, "already running this version"}
	case cmp < 0 && !m.AllowDowngrade:
		return Decision{false, "manifest would downgrade and is not a signed rollback release"}
	}
	return Decision{true, ""}
}

// CompareVersions compares two semantic versions: -1, 0, 1. ok is false when
// either is not semantic (the "unknown" placeholder, for example).
func CompareVersions(a, b string) (int, bool) {
	pa, ok1 := parseSemver(a)
	pb, ok2 := parseSemver(b)
	if !ok1 || !ok2 {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if pa.n[i] != pb.n[i] {
			if pa.n[i] < pb.n[i] {
				return -1, true
			}
			return 1, true
		}
	}
	switch {
	case pa.pre == pb.pre:
		return 0, true
	case pa.pre == "":
		return 1, true
	case pb.pre == "":
		return -1, true
	case pa.pre < pb.pre:
		return -1, true
	}
	return 1, true
}

type semver struct {
	n   [3]int64
	pre string
}

func parseSemver(s string) (semver, bool) {
	s = strings.TrimPrefix(s, "v")
	m := semverRe.FindStringSubmatch(s)
	if m == nil {
		return semver{}, false
	}
	var v semver
	for i := 0; i < 3; i++ {
		n, err := strconv.ParseInt(m[i+1], 10, 64)
		if err != nil {
			return semver{}, false
		}
		v.n[i] = n
	}
	v.pre = strings.TrimPrefix(m[4], "-")
	return v, true
}
