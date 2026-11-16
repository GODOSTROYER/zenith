package protocol_test

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

// Golden vectors are shared with the TypeScript control plane. Regenerate
// (only when the wire format intentionally changes) with:
//
//	ZENITH_UPDATE_VECTORS=1 go test ./internal/protocol -run Vector
func seedBytes(start byte) []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

type signingVector struct {
	Description    string            `json:"description"`
	AgentSeedHex   string            `json:"agentSeedHex"`
	AgentPublicKey string            `json:"agentPublicKey"`
	Protocol       string            `json:"protocol"`
	AgentID        string            `json:"agentId"`
	Method         string            `json:"method"`
	PathAndQuery   string            `json:"pathAndQuery"`
	Body           string            `json:"body"`
	Timestamp      int64             `json:"timestamp"`
	Nonce          string            `json:"nonce"`
	ContentSHA256  string            `json:"contentSha256"`
	SigningString  string            `json:"signingString"`
	Signature      string            `json:"signature"`
	Headers        map[string]string `json:"headers"`
}

func buildSigningVector(t *testing.T) signingVector {
	t.Helper()
	priv := ed25519.NewKeyFromSeed(seedBytes(1))
	v := signingVector{
		Description: "Ed25519 (RFC 8032) is deterministic: the same seed and signing string always give this signature. " +
			"The signing string is the six fields joined by \\n with no trailing newline.",
		AgentSeedHex: hex.EncodeToString(seedBytes(1)),
		Protocol:     protocol.RunnerProtocol,
		AgentID:      "run_golden",
		Method:       "post", // lower case on purpose: the string builder upper-cases it
		PathAndQuery: "/api/platform/v1/runners/run_golden/poll?after=42",
		Body:         `{"max":1,"waitSec":20}`,
		Timestamp:    1790000000,
		Nonce:        protocol.B64Encode(seedBytes(0x40)[:16]),
	}
	v.AgentPublicKey = protocol.B64Encode(priv.Public().(ed25519.PublicKey))
	v.ContentSHA256 = protocol.BodySHA256Hex([]byte(v.Body))
	v.SigningString = protocol.SigningString(v.Protocol, v.Method, v.PathAndQuery, v.Timestamp, v.Nonce, v.ContentSHA256)
	v.Signature = protocol.B64Encode(ed25519.Sign(priv, []byte(v.SigningString)))
	v.Headers = map[string]string{
		protocol.HeaderAgent:         v.AgentID,
		protocol.HeaderTimestamp:     "1790000000",
		protocol.HeaderNonce:         v.Nonce,
		protocol.HeaderContentSHA256: v.ContentSHA256,
		protocol.HeaderSignature:     v.Signature,
	}
	return v
}

func writeOrCompare(t *testing.T, name string, v any) {
	t.Helper()
	path := filepath.Join("testdata", name)
	want, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	if os.Getenv("ZENITH_UPDATE_VECTORS") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s is missing (generate with ZENITH_UPDATE_VECTORS=1): %v", path, err)
	}
	if !bytes.Equal(bytes.TrimSpace(got), bytes.TrimSpace(want)) {
		t.Fatalf("%s is stale: the wire format changed. Regenerate with ZENITH_UPDATE_VECTORS=1 and update the TypeScript side.\nfile:\n%s\ncomputed:\n%s", path, got, want)
	}
}

func TestSigningVector(t *testing.T) {
	v := buildSigningVector(t)
	writeOrCompare(t, "signing-vector.json", v)

	if strings.HasSuffix(v.SigningString, "\n") {
		t.Fatal("the signing string must not end with a newline")
	}
	fields := strings.Split(v.SigningString, "\n")
	if len(fields) != 6 || fields[0] != protocol.RunnerProtocol || fields[1] != "POST" || fields[5] != v.ContentSHA256 {
		t.Fatalf("unexpected signing string %q", v.SigningString)
	}
	// Server-side verification with the published public key must accept the vector.
	pub, _ := protocol.B64Decode(v.AgentPublicKey)
	h := http.Header{}
	for k, val := range v.Headers {
		h.Set(k, val)
	}
	if err := protocol.VerifyRequest(ed25519.PublicKey(pub), v.Protocol, "POST", v.PathAndQuery, []byte(v.Body), h, time.Unix(v.Timestamp, 0)); err != nil {
		t.Fatalf("vector does not verify: %v", err)
	}
}

func TestSignRequestRoundTripAndTamperDetection(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1790000000, 0)
	body := []byte(`{"a":1}`)
	sr, err := protocol.SignRequest(priv, "run_1", protocol.RunnerProtocol, "POST", "/x?y=1", body, now, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := http.Header{}
	sr.Apply(h)
	if err := protocol.VerifyRequest(pub, protocol.RunnerProtocol, "POST", "/x?y=1", body, h, now); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func() error{
		"different method": func() error {
			return protocol.VerifyRequest(pub, protocol.RunnerProtocol, "GET", "/x?y=1", body, h, now)
		},
		"different path": func() error {
			return protocol.VerifyRequest(pub, protocol.RunnerProtocol, "POST", "/x?y=2", body, h, now)
		},
		"different protocol": func() error {
			return protocol.VerifyRequest(pub, protocol.MachineProtocol, "POST", "/x?y=1", body, h, now)
		},
		"different body": func() error {
			return protocol.VerifyRequest(pub, protocol.RunnerProtocol, "POST", "/x?y=1", []byte(`{"a":2}`), h, now)
		},
		"clock skew": func() error {
			return protocol.VerifyRequest(pub, protocol.RunnerProtocol, "POST", "/x?y=1", body, h, now.Add(61*time.Second))
		},
	}
	for name, f := range cases {
		if f() == nil {
			t.Errorf("%s must fail verification", name)
		}
	}
	if err := protocol.VerifyRequest(pub, protocol.RunnerProtocol, "POST", "/x?y=1", body, h, now.Add(59*time.Second)); err != nil {
		t.Errorf("59 s of skew must be tolerated: %v", err)
	}
}

func TestEmptyBodyDigest(t *testing.T) {
	// SHA-256 of the empty string, required by the spec for body-less requests.
	if got := protocol.BodySHA256Hex(nil); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatal(got)
	}
}

// TestJWSVector emits a control-plane-signed job for the TypeScript side to
// verify with `jose`, proving both implementations agree on header shape,
// base64url and the Ed25519 signature input.
func TestJWSVector(t *testing.T) {
	cp := protocoltest.FromSeed("cp-golden", seedBytes(0x21))
	fixed := time.Unix(1790000000, 0)
	cp.Now = func() time.Time { return fixed }
	spec := protocoltest.JobSpec{
		JTI: "job_golden", RunnerID: "run_golden", WorkspaceID: "ws_golden", OperationID: "op_golden",
		Capability: "infrastructure.plan", Kind: "probe.tcp",
		Payload:    map[string]any{"host": "10.0.0.1", "port": 22, "timeoutMs": 2000},
		TimeoutSec: 60, MaxOutputBytes: 65536, IAT: fixed, EXP: fixed.Add(5 * time.Minute), GrantEXP: fixed.Add(5 * time.Minute),
	}
	_, tok := cp.Job(spec)
	parts := strings.Split(tok, ".")
	hdr, _ := protocol.B64Decode(parts[0])
	pl, _ := protocol.B64Decode(parts[1])
	var payload any
	_ = json.Unmarshal(pl, &payload)
	grantParts := strings.Split(payload.(map[string]any)["grant"].(string), ".")
	gpl, _ := protocol.B64Decode(grantParts[1])
	var grantClaims any
	_ = json.Unmarshal(gpl, &grantClaims)

	vec := map[string]any{
		"description": "Compact JWS job signed by the fake control plane. Verify with Ed25519 over 'header.payload' " +
			"using controlPlanePublicKey; the embedded grant is a second JWS (typ zenith-grant+jwt) signed by the same key. " +
			"jti values in the grant are derived from the clock and will differ if regenerated at another time; the fixed clock keeps them stable.",
		"controlPlaneSeedHex":   hex.EncodeToString(seedBytes(0x21)),
		"controlPlanePublicKey": protocol.B64Encode(cp.Pub),
		"kid":                   "cp-golden",
		"nowUnix":               fixed.Unix(),
		"runnerId":              "run_golden",
		"workspaceId":           "ws_golden",
		"jobToken":              tok,
		"jobHeader":             json.RawMessage(hdr),
		"jobPayload":            payload,
		"grantClaims":           grantClaims,
	}
	writeOrCompare(t, "jws-vector.json", vec)

	v := &protocol.Verifier{Keys: cp.KeySet(), Now: func() time.Time { return fixed }, Replay: protocol.NewMemoryReplayCache(func() time.Time { return fixed })}
	if _, err := v.VerifyJob(tok, protocol.Self{ID: "run_golden", WorkspaceID: "ws_golden"}, nil); err != nil {
		t.Fatalf("golden job must verify: %v", err)
	}
}
