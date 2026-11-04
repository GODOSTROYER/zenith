// Package protocoltest builds correctly signed job, machine-request and grant
// tokens for tests, playing the part of the control plane. It is test support
// only; nothing in a shipped binary imports it.
package protocoltest

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// ControlPlane is a fake control-plane signing identity.
type ControlPlane struct {
	Kid  string
	Priv ed25519.PrivateKey
	Pub  ed25519.PublicKey
	Now  func() time.Time
	seq  atomic.Int64
}

// New creates a control plane with a random key.
func New(kid string) *ControlPlane {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return &ControlPlane{Kid: kid, Priv: priv, Pub: pub, Now: time.Now}
}

// FromSeed creates a control plane with a deterministic key (golden vectors).
func FromSeed(kid string, seed []byte) *ControlPlane {
	priv := ed25519.NewKeyFromSeed(seed)
	return &ControlPlane{Kid: kid, Priv: priv, Pub: priv.Public().(ed25519.PublicKey), Now: time.Now}
}

// Keys returns the pinned-key entries an agent learns at registration.
func (c *ControlPlane) Keys() []protocol.KeyEntry {
	return []protocol.KeyEntry{{Kid: c.Kid, PublicKey: protocol.B64Encode(c.Pub)}}
}

// KeySet returns a KeySet containing this control plane's key.
func (c *ControlPlane) KeySet() *protocol.KeySet {
	ks, err := protocol.NewKeySet(c.Keys())
	if err != nil {
		panic(err)
	}
	return ks
}

// Sign produces a compact JWS with the given typ over claims.
func (c *ControlPlane) Sign(typ string, claims any) string { return c.SignWithKid(c.Kid, typ, claims) }

// SignWithKid is Sign with an explicit kid (to test unknown-kid handling).
func (c *ControlPlane) SignWithKid(kid, typ string, claims any) string {
	hdr, _ := json.Marshal(map[string]string{"alg": "EdDSA", "kid": kid, "typ": typ})
	pl, err := json.Marshal(claims)
	if err != nil {
		panic(err)
	}
	signing := protocol.B64Encode(hdr) + "." + protocol.B64Encode(pl)
	sig := ed25519.Sign(c.Priv, []byte(signing))
	return signing + "." + protocol.B64Encode(sig)
}

// JobSpec describes a runner job. Zero values get sensible defaults.
type JobSpec struct {
	JTI            string
	RunnerID       string
	WorkspaceID    string
	OperationID    string
	Capability     string
	Kind           string
	Payload        any
	TimeoutSec     int
	MaxOutputBytes int64
	IAT, EXP       time.Time // default now / now+5m
	Constraints    map[string]any

	// Overrides to construct invalid grants.
	GrantAud        string
	GrantCap        string
	GrantOp         string
	GrantWS         string
	GrantEXP        time.Time
	OmitGrant       bool
	EnvelopeProtoID string
}

func (c *ControlPlane) next(prefix string) string {
	return fmt.Sprintf("%s_%d_%d", prefix, c.Now().UnixNano(), c.seq.Add(1))
}

// Grant builds a grant JWS.
func (c *ControlPlane) Grant(aud, cap, op, ws string, exp time.Time, constraints map[string]any) string {
	now := c.Now()
	claims := protocol.GrantClaims{
		JTI: c.next("grt"), ISS: "zenith-control-plane", AUD: aud, SUB: "user_test",
		IAT: now.Unix(), EXP: exp.Unix(), CAP: cap, OP: op, Digest: "sha256:test", WS: ws,
		Constraints: constraints,
	}
	return c.Sign(protocol.TypGrant, claims)
}

// Job builds a signed runner job and returns its jti and compact JWS.
func (c *ControlPlane) Job(s JobSpec) (jti, token string) {
	now := c.Now()
	if s.JTI == "" {
		s.JTI = c.next("job")
	}
	if s.WorkspaceID == "" {
		s.WorkspaceID = "ws_test"
	}
	if s.OperationID == "" {
		s.OperationID = c.next("op")
	}
	if s.IAT.IsZero() {
		s.IAT = now
	}
	if s.EXP.IsZero() {
		s.EXP = now.Add(5 * time.Minute)
	}
	if s.TimeoutSec == 0 {
		s.TimeoutSec = 60
	}
	if s.MaxOutputBytes == 0 {
		s.MaxOutputBytes = 1 << 20
	}
	if s.EnvelopeProtoID == "" {
		s.EnvelopeProtoID = protocol.RunnerProtocol
	}
	grant := ""
	if !s.OmitGrant {
		aud, cap, op, ws, gexp := s.GrantAud, s.GrantCap, s.GrantOp, s.GrantWS, s.GrantEXP
		if aud == "" {
			aud = "runner:" + s.RunnerID
		}
		if cap == "" {
			cap = s.Capability
		}
		if op == "" {
			op = s.OperationID
		}
		if ws == "" {
			ws = s.WorkspaceID
		}
		if gexp.IsZero() {
			gexp = now.Add(5 * time.Minute)
		}
		grant = c.Grant(aud, cap, op, ws, gexp, s.Constraints)
	}
	payload, err := json.Marshal(s.Payload)
	if err != nil {
		panic(err)
	}
	env := protocol.JobEnvelope{
		Protocol: s.EnvelopeProtoID, JTI: s.JTI, RunnerID: s.RunnerID, WorkspaceID: s.WorkspaceID,
		OperationID: s.OperationID, Capability: s.Capability, Kind: s.Kind, Payload: payload,
		Grant: grant, IAT: s.IAT.Unix(), EXP: s.EXP.Unix(), TimeoutSec: s.TimeoutSec, MaxOutputBytes: s.MaxOutputBytes,
	}
	return s.JTI, c.Sign(protocol.TypJob, env)
}

// MachineSpec describes a zenithd request.
type MachineSpec struct {
	JTI            string
	MachineID      string
	WorkspaceID    string
	OperationID    string
	Operation      string
	Args           any
	TimeoutSec     int
	MaxOutputBytes int64
	IAT, EXP       time.Time
	Constraints    map[string]any

	GrantAud  string
	GrantCap  string
	GrantOp   string
	GrantWS   string
	OmitGrant bool
}

// Machine builds a signed machine request.
func (c *ControlPlane) Machine(s MachineSpec) (jti, token string) {
	now := c.Now()
	if s.JTI == "" {
		s.JTI = c.next("mreq")
	}
	if s.WorkspaceID == "" {
		s.WorkspaceID = "ws_test"
	}
	if s.OperationID == "" {
		s.OperationID = c.next("op")
	}
	if s.IAT.IsZero() {
		s.IAT = now
	}
	if s.EXP.IsZero() {
		s.EXP = now.Add(5 * time.Minute)
	}
	if s.TimeoutSec == 0 {
		s.TimeoutSec = 30
	}
	if s.MaxOutputBytes == 0 {
		s.MaxOutputBytes = 64 << 10
	}
	grant := ""
	if !s.OmitGrant {
		aud, cap, op, ws := s.GrantAud, s.GrantCap, s.GrantOp, s.GrantWS
		if aud == "" {
			aud = "machine:" + s.MachineID
		}
		if cap == "" {
			cap = s.Operation
		}
		if op == "" {
			op = s.OperationID
		}
		if ws == "" {
			ws = s.WorkspaceID
		}
		grant = c.Grant(aud, cap, op, ws, now.Add(5*time.Minute), s.Constraints)
	}
	args := json.RawMessage("{}")
	if s.Args != nil {
		b, err := json.Marshal(s.Args)
		if err != nil {
			panic(err)
		}
		args = b
	}
	env := protocol.MachineEnvelope{
		Protocol: protocol.MachineProtocol, JTI: s.JTI, MachineID: s.MachineID, WorkspaceID: s.WorkspaceID,
		OperationID: s.OperationID, Operation: s.Operation, Args: args, Grant: grant,
		IAT: s.IAT.Unix(), EXP: s.EXP.Unix(), TimeoutSec: s.TimeoutSec, MaxOutputBytes: s.MaxOutputBytes,
	}
	return s.JTI, c.Sign(protocol.TypMachine, env)
}
