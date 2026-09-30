package kinds

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

type k8sHarness struct {
	t         *testing.T
	kind      *K8s
	tokenFile string
	mu        sync.Mutex
	seen      []capturedReq
}

func newK8sHarness(t *testing.T, cfg K8sConfig, handler http.HandlerFunc) *k8sHarness {
	t.Helper()
	h := &k8sHarness{t: t}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		h.mu.Lock()
		h.seen = append(h.seen, capturedReq{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: body})
		h.mu.Unlock()
		if handler != nil {
			handler(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "x=y")
		_, _ = w.Write([]byte(`{"kind":"PodList","items":[]}`))
	}))
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	caFile := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	h.tokenFile = filepath.Join(dir, "token")
	if err := os.WriteFile(h.tokenFile, []byte("sa-token-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.APIServer, cfg.CAFile, cfg.TokenFile = srv.URL, caFile, h.tokenFile
	k, err := NewK8s(cfg, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	h.kind = k
	return h
}

func (h *k8sHarness) prepare(capability string, pl map[string]any, maxOut int64) (Runnable, error) {
	raw, _ := json.Marshal(pl)
	if maxOut == 0 {
		maxOut = 1 << 20
	}
	return h.kind.Prepare(&Request{JTI: "job_k", Capability: capability, Payload: raw, Timeout: 10 * time.Second, MaxOutputBytes: maxOut})
}

func (h *k8sHarness) run(capability string, pl map[string]any) Outcome {
	h.t.Helper()
	run, err := h.prepare(capability, pl, 0)
	if err != nil {
		h.t.Fatalf("prepare: %v", err)
	}
	return run(context.Background(), agent.DiscardSink{})
}

var k8sAllow = map[string][]string{
	"infrastructure.observe": {"GET /api/v1/namespaces/*/pods", "GET /api/v1/namespaces/*/pods/*", "GET /apis/apps/v1/namespaces/*/deployments/**", "GET /api/v1/namespaces"},
	"service.scale":          {"PATCH /apis/apps/v1/namespaces/*/deployments/*/scale", "GET /apis/apps/v1/namespaces/*/deployments/*/scale"},
	"secret.write":           {"POST /api/v1/namespaces/*/secrets", "GET /api/v1/namespaces/*/secrets/**"},
}

func TestK8sProxiesAllowedRequestWithServiceAccountToken(t *testing.T) {
	h := newK8sHarness(t, K8sConfig{Allow: k8sAllow}, nil)
	o := h.run("infrastructure.observe", map[string]any{"method": "GET", "path": "/api/v1/namespaces/prod/pods?labelSelector=app%3Dweb&limit=50"})
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	res := resultMap(t, o)
	body, _ := base64.StdEncoding.DecodeString(res["bodyB64"].(string))
	if res["status"].(float64) != 200 || !strings.Contains(string(body), "PodList") {
		t.Fatalf("%v", res)
	}
	if _, leaked := res["headers"].(map[string]any)["set-cookie"]; leaked {
		t.Fatal("set-cookie must not be returned")
	}
	seen := h.seen[len(h.seen)-1]
	if seen.Header.Get("Authorization") != "Bearer sa-token-1" || seen.Path != "/api/v1/namespaces/prod/pods" || seen.Query != "labelSelector=app%3Dweb&limit=50" {
		t.Fatalf("%+v", seen)
	}
	raw, _ := json.Marshal(o)
	if strings.Contains(string(raw), "sa-token-1") {
		t.Fatal("the service account token must never appear in a result")
	}
	// projected tokens rotate: the file is re-read for every request
	_ = os.WriteFile(h.tokenFile, []byte("sa-token-2\n"), 0o600)
	h.run("infrastructure.observe", map[string]any{"method": "GET", "path": "/api/v1/namespaces/prod/pods/web-1"})
	if got := h.seen[len(h.seen)-1].Header.Get("Authorization"); got != "Bearer sa-token-2" {
		t.Fatalf("token was not re-read: %s", got)
	}
}

func TestK8sAllowlistIsDefaultDeny(t *testing.T) {
	h := newK8sHarness(t, K8sConfig{Allow: k8sAllow}, nil)
	cases := map[string]map[string]any{
		"other resource":                {"method": "GET", "path": "/api/v1/namespaces/prod/configmaps"},
		"wrong verb":                    {"method": "DELETE", "path": "/api/v1/namespaces/prod/pods/web-1"},
		"cluster-wide list":             {"method": "GET", "path": "/api/v1/pods"},
		"extra segment":                 {"method": "GET", "path": "/api/v1/namespaces/prod/pods/web-1/status"},
		"nodes":                         {"method": "GET", "path": "/api/v1/nodes"},
		"namespace name is one segment": {"method": "GET", "path": "/api/v1/namespaces/a/b/pods"},
	}
	for name, pl := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := h.prepare("infrastructure.observe", pl, 0)
			expectPrepareCode(t, err, protocol.CodeNotAllowed)
		})
	}
	_, err := h.prepare("logs.read", map[string]any{"method": "GET", "path": "/api/v1/namespaces/prod/pods"}, 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed) // capability without entries
	// the scale capability cannot read pods, the observe capability cannot scale
	_, err = h.prepare("service.scale", map[string]any{"method": "GET", "path": "/api/v1/namespaces/prod/pods"}, 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed)
	_, err = h.prepare("infrastructure.observe", map[string]any{"method": "PATCH", "path": "/apis/apps/v1/namespaces/prod/deployments/web/scale", "bodyB64": b64(`{"spec":{"replicas":9}}`), "contentType": "application/merge-patch+json"}, 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed)
	if len(h.seen) != 0 {
		t.Fatal("nothing may be sent for a rejected job")
	}
}

func TestK8sBuiltInRefusals(t *testing.T) {
	// entries that would otherwise match: the built-in refusals still apply
	wide := map[string][]string{"infrastructure.observe": {"GET /**", "POST /**", "PATCH /**"}}
	h := newK8sHarness(t, K8sConfig{Allow: wide}, nil)
	bad := map[string]map[string]any{
		"secrets":                  {"method": "GET", "path": "/api/v1/namespaces/prod/secrets"},
		"a secret":                 {"method": "GET", "path": "/api/v1/namespaces/prod/secrets/db-password"},
		"all secrets":              {"method": "GET", "path": "/api/v1/secrets"},
		"exec":                     {"method": "POST", "path": "/api/v1/namespaces/prod/pods/web-1/exec?command=sh"},
		"attach":                   {"method": "POST", "path": "/api/v1/namespaces/prod/pods/web-1/attach"},
		"portforward":              {"method": "POST", "path": "/api/v1/namespaces/prod/pods/web-1/portforward"},
		"pod proxy":                {"method": "GET", "path": "/api/v1/namespaces/prod/pods/web-1/proxy/admin"},
		"service proxy":            {"method": "GET", "path": "/api/v1/namespaces/prod/services/db/proxy"},
		"node proxy":               {"method": "GET", "path": "/api/v1/nodes/n1/proxy/logs"},
		"serviceaccount token":     {"method": "POST", "path": "/api/v1/namespaces/prod/serviceaccounts/default/token", "bodyB64": b64("{}")},
		"watch":                    {"method": "GET", "path": "/api/v1/namespaces/prod/pods?watch=true"},
		"watch numeric":            {"method": "GET", "path": "/api/v1/namespaces/prod/pods?watch=1"},
		"follow logs":              {"method": "GET", "path": "/api/v1/namespaces/prod/pods/web-1/log?follow=true"},
		"dot segment":              {"method": "GET", "path": "/api/v1/namespaces/prod/../kube-system/pods"},
		"encoded dot segment":      {"method": "GET", "path": "/api/v1/namespaces/prod/%2e%2e/kube-system/pods"},
		"encoded slash":            {"method": "GET", "path": "/api/v1/namespaces/prod%2Fpods"},
		"double slash":             {"method": "GET", "path": "/api/v1//namespaces/prod/pods"},
		"relative path":            {"method": "GET", "path": "api/v1/namespaces"},
		"backslash":                {"method": "GET", "path": "/api/v1/namespaces\\prod"},
		"absolute url":             {"method": "GET", "path": "https://evil.example.com/api/v1/namespaces"},
		"scheme-relative":          {"method": "GET", "path": "//evil.example.com/api"},
		"non-ascii":                {"method": "GET", "path": "/api/v1/namespaces/pröd"},
		"bad method":               {"method": "CONNECT", "path": "/api/v1/namespaces"},
		"unsupported content type": {"method": "POST", "path": "/api/v1/namespaces/prod/configmaps", "bodyB64": b64("{}"), "contentType": "text/html"},
		"unknown field":            {"method": "GET", "path": "/api/v1/namespaces", "impersonate": "admin"},
		"bad base64":               {"method": "POST", "path": "/api/v1/namespaces/prod/configmaps", "bodyB64": "!!"},
	}
	for name, pl := range bad {
		t.Run(name, func(t *testing.T) {
			if _, err := h.prepare("infrastructure.observe", pl, 0); err == nil {
				t.Fatal("must be rejected")
			}
		})
	}
	if len(h.seen) != 0 {
		t.Fatal("nothing may be sent for a rejected job")
	}
	// Secrets are reachable only when the operator explicitly opts in.
	hs := newK8sHarness(t, K8sConfig{Allow: k8sAllow, AllowSecrets: true}, nil)
	if _, err := hs.prepare("secret.write", map[string]any{"method": "GET", "path": "/api/v1/namespaces/prod/secrets/db"}, 0); err != nil {
		t.Fatal(err)
	}
}

func TestK8sWriteWithBody(t *testing.T) {
	h := newK8sHarness(t, K8sConfig{Allow: k8sAllow}, nil)
	o := h.run("service.scale", map[string]any{"method": "PATCH", "path": "/apis/apps/v1/namespaces/prod/deployments/web/scale", "bodyB64": b64(`{"spec":{"replicas":3}}`), "contentType": "application/merge-patch+json"})
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	seen := h.seen[len(h.seen)-1]
	if seen.Method != "PATCH" || seen.Header.Get("Content-Type") != "application/merge-patch+json" || string(seen.Body) != `{"spec":{"replicas":3}}` {
		t.Fatalf("%+v", seen)
	}
}

func TestK8sResponseCapAndErrors(t *testing.T) {
	h := newK8sHarness(t, K8sConfig{Allow: k8sAllow}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("y", 5000)))
	})
	run, err := h.prepare("infrastructure.observe", map[string]any{"method": "GET", "path": "/api/v1/namespaces"}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	o := run(context.Background(), agent.DiscardSink{})
	if o.Status != agent.StatusFailed || !strings.Contains(o.Error, "response_too_large") || resultMap(t, o)["bodyB64"] != nil {
		t.Fatalf("%+v", o)
	}
	// 4xx from the API server is an observation
	h2 := newK8sHarness(t, K8sConfig{Allow: k8sAllow}, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) })
	if o := h2.run("infrastructure.observe", map[string]any{"method": "GET", "path": "/api/v1/namespaces"}); o.Status != agent.StatusSucceeded || resultMap(t, o)["status"].(float64) != 403 {
		t.Fatalf("%+v", o)
	}
	// a missing token file is a job failure that does not leak paths or tokens
	_ = os.Remove(h2.tokenFile)
	if o := h2.run("infrastructure.observe", map[string]any{"method": "GET", "path": "/api/v1/namespaces"}); o.Status != agent.StatusFailed || !strings.Contains(o.Error, "k8s_token_unavailable") {
		t.Fatalf("%+v", o)
	}
}

func TestK8sConfigValidation(t *testing.T) {
	get := func(string) string { return "" }
	if _, err := NewK8s(K8sConfig{APIServer: "http://apiserver.example.com"}, get); err == nil {
		t.Fatal("plain http to a non-loopback API server must be refused")
	}
	if _, err := NewK8s(K8sConfig{}, get); err == nil {
		t.Fatal("no API server and not in a cluster must be an error")
	}
	if _, err := NewK8s(K8sConfig{APIServer: "https://10.0.0.1", CAFile: "/nonexistent/ca.crt"}, get); err == nil {
		t.Fatal("an unreadable CA must fail at startup")
	}
	if _, err := NewK8s(K8sConfig{APIServer: "http://127.0.0.1:1", Allow: map[string][]string{"c": {"ec2:Describe*"}}}, get); err == nil {
		t.Fatal("entries must be METHOD /path")
	}
	if _, err := NewK8s(K8sConfig{APIServer: "http://127.0.0.1:1", Allow: map[string][]string{"c": {"GET /a/**/b"}}}, get); err == nil {
		t.Fatal("'**' must be last")
	}
	env := map[string]string{"KUBERNETES_SERVICE_HOST": "10.96.0.1", "KUBERNETES_SERVICE_PORT": "443"}
	k, err := NewK8s(K8sConfig{CAFile: "/nonexistent"}, func(k string) string { return env[k] })
	_ = k
	if err == nil || !strings.Contains(err.Error(), "CA") {
		t.Fatalf("in-cluster defaults derive the API server from the environment; the CA is then required: %v", err)
	}
}
