package protocol_test

import (
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

var fixedNow = time.Unix(1790000000, 0)

func newVerifier(t *testing.T, cp *protocoltest.ControlPlane) *protocol.Verifier {
	t.Helper()
	return &protocol.Verifier{Keys: cp.KeySet(), Now: func() time.Time { return fixedNow }, Replay: protocol.NewMemoryReplayCache(func() time.Time { return fixedNow })}
}

func jobSpec(cp *protocoltest.ControlPlane) protocoltest.JobSpec {
	cp.Now = func() time.Time { return fixedNow }
	return protocoltest.JobSpec{RunnerID: "run_1", WorkspaceID: "ws_1", Capability: "infrastructure.plan", Kind: "probe.tcp", Payload: map[string]any{"host": "10.0.0.1", "port": 22}}
}

var self = protocol.Self{ID: "run_1", WorkspaceID: "ws_1"}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error %s, got nil", code)
	}
	if got := protocol.CodeOf(err); got != code {
		t.Fatalf("expected code %s, got %s (%v)", code, got, err)
	}
}

func TestVerifyJobValid(t *testing.T) {
	cp := protocoltest.New("cp-1")
	v := newVerifier(t, cp)
	_, tok := cp.Job(jobSpec(cp))
	got, err := v.VerifyJob(tok, self, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Envelope.Kind != "probe.tcp" || got.Grant.CAP != "infrastructure.plan" || got.Grant.AUD != "runner:run_1" {
		t.Fatalf("unexpected result %+v", got)
	}
}

func TestVerifyJobRejections(t *testing.T) {
	cp := protocoltest.New("cp-1")
	other := protocoltest.New("cp-1") // same kid, different key
	cases := []struct {
		name string
		make func() string
		code string
	}{
		{"wrong kid", func() string { return cp.SignWithKid("cp-unknown", protocol.TypJob, map[string]any{"jti": "job_x"}) }, protocol.CodeUnknownKey},
		{"wrong typ", func() string { return cp.Sign(protocol.TypGrant, map[string]any{"jti": "job_x"}) }, protocol.CodeBadType},
		{"signed by a different key", func() string { _, t := other.Job(jobSpec(other)); return t }, protocol.CodeBadSignature},
		{"wrong runnerId", func() string { s := jobSpec(cp); s.RunnerID = "run_other"; _, t := cp.Job(s); return t }, protocol.CodeWrongTarget},
		{"wrong workspace", func() string { s := jobSpec(cp); s.WorkspaceID = "ws_other"; _, t := cp.Job(s); return t }, protocol.CodeWrongTarget},
		{"expired", func() string {
			s := jobSpec(cp)
			s.IAT = fixedNow.Add(-10 * time.Minute)
			s.EXP = fixedNow.Add(-5 * time.Minute)
			_, t := cp.Job(s)
			return t
		}, protocol.CodeExpired},
		{"issued in the future", func() string {
			s := jobSpec(cp)
			s.IAT = fixedNow.Add(10 * time.Minute)
			s.EXP = fixedNow.Add(15 * time.Minute)
			_, t := cp.Job(s)
			return t
		}, protocol.CodeNotYetValid},
		{"wrong protocol", func() string { s := jobSpec(cp); s.EnvelopeProtoID = "zenith.machine/v1"; _, t := cp.Job(s); return t }, protocol.CodeBadProtocol},
		{"missing grant", func() string { s := jobSpec(cp); s.OmitGrant = true; _, t := cp.Job(s); return t }, protocol.CodeGrantInvalid},
		{"grant for another runner", func() string { s := jobSpec(cp); s.GrantAud = "runner:run_other"; _, t := cp.Job(s); return t }, protocol.CodeGrantAudience},
		{"grant for another capability", func() string { s := jobSpec(cp); s.GrantCap = "infrastructure.apply"; _, t := cp.Job(s); return t }, protocol.CodeGrantCapability},
		{"grant for another operation", func() string { s := jobSpec(cp); s.GrantOp = "op_other"; _, t := cp.Job(s); return t }, protocol.CodeGrantOperation},
		{"grant for another workspace", func() string { s := jobSpec(cp); s.GrantWS = "ws_other"; _, t := cp.Job(s); return t }, protocol.CodeGrantWorkspace},
		{"expired grant", func() string {
			s := jobSpec(cp)
			s.GrantEXP = fixedNow.Add(-5 * time.Minute)
			_, t := cp.Job(s)
			return t
		}, protocol.CodeGrantInvalid},
		{"not a JWS", func() string { return "abc" }, protocol.CodeMalformed},
		{"empty", func() string { return "" }, protocol.CodeMalformed},
		{"four parts", func() string { _, t := cp.Job(jobSpec(cp)); return t + ".x" }, protocol.CodeMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := newVerifier(t, cp)
			_, err := v.VerifyJob(tc.make(), self, nil)
			wantCode(t, err, tc.code)
		})
	}
}

func TestVerifyJobTamperedPayload(t *testing.T) {
	cp := protocoltest.New("cp-1")
	v := newVerifier(t, cp)
	_, tok := cp.Job(jobSpec(cp))
	parts := strings.Split(tok, ".")
	raw, _ := protocol.B64Decode(parts[1])
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	m["kind"] = "aws.http"
	tampered, _ := json.Marshal(m)
	parts[1] = protocol.B64Encode(tampered)
	_, err := v.VerifyJob(strings.Join(parts, "."), self, nil)
	wantCode(t, err, protocol.CodeBadSignature)
}

func TestVerifyRejectsNoneAndOtherAlgorithms(t *testing.T) {
	cp := protocoltest.New("cp-1")
	v := newVerifier(t, cp)
	for _, alg := range []string{"none", "HS256", "RS256", "ES256", "eddsa"} {
		hdr, _ := json.Marshal(map[string]string{"alg": alg, "kid": "cp-1", "typ": protocol.TypJob})
		tok := protocol.B64Encode(hdr) + "." + protocol.B64Encode([]byte(`{"jti":"job_x"}`)) + "."
		if alg != "none" {
			tok += protocol.B64Encode(make([]byte, 64))
		}
		_, err := v.VerifyJob(tok, self, nil)
		wantCode(t, err, protocol.CodeUnsupportedAlg)
	}
}

func TestVerifyRejectsHeaderWithExtraMembers(t *testing.T) {
	cp := protocoltest.New("cp-1")
	hdr, _ := json.Marshal(map[string]any{"alg": "EdDSA", "kid": "cp-1", "typ": protocol.TypJob, "jku": "https://evil.example/keys"})
	pl := []byte(`{"jti":"job_x"}`)
	signing := protocol.B64Encode(hdr) + "." + protocol.B64Encode(pl)
	tok := signing + "." + protocol.B64Encode(ed25519.Sign(cp.Priv, []byte(signing)))
	_, _, err := protocol.VerifyCompact(tok, cp.KeySet(), protocol.TypJob)
	wantCode(t, err, protocol.CodeMalformed)
}

func TestVerifyJobReplay(t *testing.T) {
	cp := protocoltest.New("cp-1")
	v := newVerifier(t, cp)
	_, tok := cp.Job(jobSpec(cp))
	if _, err := v.VerifyJob(tok, self, nil); err != nil {
		t.Fatal(err)
	}
	_, err := v.VerifyJob(tok, self, nil)
	wantCode(t, err, protocol.CodeReplay)
}

func TestVerifyJobSkewBoundary(t *testing.T) {
	cp := protocoltest.New("cp-1")
	try := func(iat, exp time.Time) error {
		v := newVerifier(t, cp)
		s := jobSpec(cp)
		s.IAT, s.EXP = iat, exp
		_, tok := cp.Job(s)
		_, err := v.VerifyJob(tok, self, nil)
		return err
	}
	if err := try(fixedNow.Add(59*time.Second), fixedNow.Add(5*time.Minute)); err != nil {
		t.Fatalf("iat 59s in the future should be tolerated: %v", err)
	}
	if err := try(fixedNow.Add(61*time.Second), fixedNow.Add(5*time.Minute)); err == nil {
		t.Fatal("iat 61s in the future must be rejected")
	}
	if err := try(fixedNow.Add(-5*time.Minute), fixedNow.Add(-59*time.Second)); err != nil {
		t.Fatalf("exp 59s in the past should be tolerated: %v", err)
	}
	if err := try(fixedNow.Add(-5*time.Minute), fixedNow.Add(-61*time.Second)); err == nil {
		t.Fatal("exp 61s in the past must be rejected")
	}
}

func TestPrecheckRunsBeforeGrant(t *testing.T) {
	cp := protocoltest.New("cp-1")
	v := newVerifier(t, cp)
	s := jobSpec(cp)
	s.OmitGrant = true
	_, tok := cp.Job(s)
	_, err := v.VerifyJob(tok, self, func(*protocol.JobEnvelope) error {
		return protocol.Errorf(protocol.CodeKindDisabled, "kind is disabled")
	})
	wantCode(t, err, protocol.CodeKindDisabled) // not grant_invalid: precheck comes first per spec order
}

func TestVerifyMachine(t *testing.T) {
	cp := protocoltest.New("cp-1")
	cp.Now = func() time.Time { return fixedNow }
	mself := protocol.Self{ID: "mac_1", WorkspaceID: "ws_1"}
	spec := protocoltest.MachineSpec{MachineID: "mac_1", WorkspaceID: "ws_1", Operation: "service.status", Args: map[string]any{"unit": "nginx.service"}}

	v := newVerifier(t, cp)
	_, tok := cp.Machine(spec)
	got, err := v.VerifyMachine(tok, mself, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Envelope.Operation != "service.status" || got.Grant.AUD != "machine:mac_1" {
		t.Fatalf("unexpected %+v", got)
	}
	// replay
	_, err = v.VerifyMachine(tok, mself, nil)
	wantCode(t, err, protocol.CodeReplay)
	// a job token is not a machine token
	_, jt := cp.Job(jobSpec(cp))
	_, err = newVerifier(t, cp).VerifyMachine(jt, mself, nil)
	wantCode(t, err, protocol.CodeBadType)
	// wrong machine
	bad := spec
	bad.MachineID = "mac_other"
	_, tok2 := cp.Machine(bad)
	_, err = newVerifier(t, cp).VerifyMachine(tok2, mself, nil)
	wantCode(t, err, protocol.CodeWrongTarget)
	// grant capability must equal the operation
	bad = spec
	bad.GrantCap = "machine.exec"
	_, tok3 := cp.Machine(bad)
	_, err = newVerifier(t, cp).VerifyMachine(tok3, mself, nil)
	wantCode(t, err, protocol.CodeGrantCapability)
	// a runner grant audience is not accepted by a machine
	bad = spec
	bad.GrantAud = "runner:run_1"
	_, tok4 := cp.Machine(bad)
	_, err = newVerifier(t, cp).VerifyMachine(tok4, mself, nil)
	wantCode(t, err, protocol.CodeGrantAudience)
}

func TestNextKeyRotationVerifiesBothKeys(t *testing.T) {
	old := protocoltest.New("cp-old")
	next := protocoltest.New("cp-new")
	ks := old.KeySet()
	if err := ks.Add(next.Keys()[0]); err != nil {
		t.Fatal(err)
	}
	for _, cp := range []*protocoltest.ControlPlane{old, next} {
		tok := cp.Sign(protocol.TypGrant, map[string]any{"jti": "x"})
		if _, _, err := protocol.VerifyCompact(tok, ks, protocol.TypGrant); err != nil {
			t.Fatalf("%s: %v", cp.Kid, err)
		}
	}
	if err := ks.Add(protocol.KeyEntry{Kid: "bad", PublicKey: "AAAA"}); err == nil {
		t.Fatal("a short key must be rejected")
	}
}

func TestUnverifiedJTI(t *testing.T) {
	cp := protocoltest.New("cp-1")
	jti, tok := cp.Job(jobSpec(cp))
	if got := protocol.UnverifiedJTI(tok); got != jti {
		t.Fatalf("got %q want %q", got, jti)
	}
	if protocol.UnverifiedJTI("garbage") != "" {
		t.Fatal("garbage must yield no jti")
	}
	evil := cp.Sign(protocol.TypJob, map[string]any{"jti": "../../etc/passwd"})
	if protocol.UnverifiedJTI(evil) != "" {
		t.Fatal("a jti that is not a plain identifier must be ignored")
	}
}
