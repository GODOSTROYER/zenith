package release_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/release"
)

func keypair(t *testing.T) (ed25519.PrivateKey, protocol.KeyEntry) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv, protocol.KeyEntry{Kid: "rel-1", PublicKey: protocol.B64Encode(pub)}
}

func manifest(now time.Time) release.Manifest {
	return release.Manifest{
		Channel: "stable", Component: release.ComponentZenithd, Version: "1.2.0", Seq: 5,
		IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339),
		Artifacts: []release.Artifact{{OS: "linux", Arch: "amd64", URL: "https://dl.example.com/zenithd", SHA256: strings.Repeat("ab", 32), Size: 1000}},
	}
}

func signed(t *testing.T, priv ed25519.PrivateKey, m release.Manifest) []byte {
	t.Helper()
	env, err := release.Sign(priv, "rel-1", m)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	return raw
}

func TestSignVerifyRoundTrip(t *testing.T) {
	priv, pub := keypair(t)
	now := time.Now()
	m, err := release.Verify(signed(t, priv, manifest(now)), []protocol.KeyEntry{pub}, now)
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != "1.2.0" || m.Seq != 5 {
		t.Fatalf("unexpected manifest %+v", m)
	}
	if _, ok := m.Find("linux", "amd64"); !ok {
		t.Fatal("artifact not found")
	}
}

func TestVerifyRejectsWrongKeyTamperExpiryAndUnknownFields(t *testing.T) {
	priv, pub := keypair(t)
	_, otherPub := keypair(t)
	otherPub.Kid = "rel-1"
	now := time.Now()
	raw := signed(t, priv, manifest(now))

	if _, err := release.Verify(raw, []protocol.KeyEntry{otherPub}, now); err == nil {
		t.Fatal("a manifest signed by an unpinned key must not verify")
	}
	if _, err := release.Verify(raw, nil, now); err == nil {
		t.Fatal("no pinned keys must fail")
	}
	// tamper with the manifest body: swap the sha256 inside the signed bytes
	var env release.Envelope
	_ = json.Unmarshal(raw, &env)
	body, _ := protocol.B64Decode(env.Manifest)
	tampered := strings.Replace(string(body), strings.Repeat("ab", 32), strings.Repeat("cd", 32), 1)
	env.Manifest = protocol.B64Encode([]byte(tampered))
	bad, _ := json.Marshal(env)
	if _, err := release.Verify(bad, []protocol.KeyEntry{pub}, now); err == nil {
		t.Fatal("a tampered manifest must not verify")
	}
	if _, err := release.Verify(raw, []protocol.KeyEntry{pub}, now.Add(48*time.Hour)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("an expired manifest must be refused, got %v", err)
	}
	if _, err := release.Verify([]byte(`{"manifest":"","signatures":[],"extra":1}`), []protocol.KeyEntry{pub}, now); err == nil {
		t.Fatal("unknown envelope fields must be refused")
	}
}

func TestSignRefusesUnusableManifests(t *testing.T) {
	priv, _ := keypair(t)
	now := time.Now()
	cases := map[string]func(*release.Manifest){
		"http url":      func(m *release.Manifest) { m.Artifacts[0].URL = "http://dl.example.com/zenithd" },
		"bad digest":    func(m *release.Manifest) { m.Artifacts[0].SHA256 = "xyz" },
		"zero size":     func(m *release.Manifest) { m.Artifacts[0].Size = 0 },
		"bad version":   func(m *release.Manifest) { m.Version = "latest" },
		"zero seq":      func(m *release.Manifest) { m.Seq = 0 },
		"long lifetime": func(m *release.Manifest) { m.ExpiresAt = now.Add(200 * 24 * time.Hour).Format(time.RFC3339) },
		"no artifacts":  func(m *release.Manifest) { m.Artifacts = nil },
	}
	for name, mutate := range cases {
		m := manifest(now)
		mutate(&m)
		if _, err := release.Sign(priv, "rel-1", m); err == nil {
			t.Errorf("%s: expected the manifest to be refused", name)
		}
	}
	m := manifest(now)
	m.Artifacts[0].URL = "http://127.0.0.1:9/zenithd"
	if _, err := release.Sign(priv, "rel-1", m); err != nil {
		t.Errorf("loopback http is allowed for local development: %v", err)
	}
}

func TestDecideEnforcesSequenceChannelAndDowngradeRules(t *testing.T) {
	now := time.Now()
	m := manifest(now)
	mp := &m
	if d := release.Decide(mp, "stable", release.ComponentZenithd, "1.1.0", 4); !d.Apply {
		t.Fatalf("a newer version with a newer seq applies: %s", d.Reason)
	}
	if d := release.Decide(mp, "stable", release.ComponentZenithd, "1.1.0", 5); d.Apply {
		t.Fatal("a replayed seq must not apply")
	}
	if d := release.Decide(mp, "beta", release.ComponentZenithd, "1.1.0", 0); d.Apply {
		t.Fatal("another channel must not apply")
	}
	if d := release.Decide(mp, "stable", release.ComponentRunner, "1.1.0", 0); d.Apply {
		t.Fatal("another component must not apply")
	}
	if d := release.Decide(mp, "stable", release.ComponentZenithd, "1.2.0", 0); d.Apply {
		t.Fatal("the same version must not apply")
	}
	if d := release.Decide(mp, "stable", release.ComponentZenithd, "1.3.0", 0); d.Apply {
		t.Fatal("a downgrade must not apply without a signed rollback release")
	}
	m.AllowDowngrade = true
	if d := release.Decide(mp, "stable", release.ComponentZenithd, "1.3.0", 0); !d.Apply {
		t.Fatalf("a signed rollback release may downgrade: %s", d.Reason)
	}
	if d := release.Decide(mp, "stable", release.ComponentZenithd, "unknown", 0); d.Apply {
		t.Fatal("an incomparable running version is never replaced automatically")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{{"1.0.0", "1.0.0", 0}, {"1.2.0", "1.10.0", -1}, {"2.0.0", "1.99.99", 1}, {"1.0.0-rc.1", "1.0.0", -1}, {"1.0.0", "1.0.0-rc.1", 1}, {"0.0.0-dev", "0.0.1", -1}}
	for _, c := range cases {
		got, ok := release.CompareVersions(c.a, c.b)
		if !ok || got != c.want {
			t.Errorf("CompareVersions(%s,%s)=%d,%v want %d", c.a, c.b, got, ok, c.want)
		}
	}
	if _, ok := release.CompareVersions("unknown", "1.0.0"); ok {
		t.Error("non-semantic versions are not comparable")
	}
}
