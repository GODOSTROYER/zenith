package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent/update"
	updatecontrol "github.com/GODOSTROYER/zenith/go/internal/runner/update"
)

type updateHeartbeatTransport func(*http.Request) (*http.Response, error)

func (f updateHeartbeatTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// The TLS protocol fixture verifies real agent request signatures. This wrapper
// adds the control response using the fixture's pinned signing key; no cloud or
// production API is involved.
func TestHeartbeatWiresDurableUpdateControlAndWake(t *testing.T) {
	base, _, _, cp := rotationFixture(t)
	base.cfg.Update.Enabled = true
	client := *cp.Client()
	transport := client.Transport
	var nonce string
	badNonce := false
	client.Transport = updateHeartbeatTransport(func(req *http.Request) (*http.Response, error) {
		body, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		var sent heartbeatRequest
		err = json.NewDecoder(body).Decode(&sent)
		body.Close()
		if err != nil {
			return nil, err
		}
		if len(sent.UpdateControlNonce) != 22 || sent.UpdateControlNonce == nonce {
			t.Error("heartbeat must send a fresh control nonce")
		}
		nonce = sent.UpdateControlNonce
		if !strings.Contains(strings.Join(sent.Capabilities, ","), "agent.update.control.v1") {
			t.Error("enabled agent must advertise the installed control loop")
		}
		res, err := transport.RoundTrip(req)
		if err != nil {
			return nil, err
		}
		var reply heartbeatResponse
		err = json.NewDecoder(res.Body).Decode(&reply)
		res.Body.Close()
		if err != nil {
			return nil, err
		}
		boundNonce := nonce
		if badNonce {
			boundNonce = strings.Repeat("x", 22)
		}
		now := time.Now().Unix()
		reply.UpdateControl = cp.CP.Sign(updatecontrol.Type, updatecontrol.Directive{
			Schema: updatecontrol.Schema, WorkspaceID: cp.Workspace, AgentID: cp.AgentID,
			Kind: RunnerKind.Name, Nonce: boundNonce, Revision: 1, Hold: true,
			IssuedAt: now, ExpiresAt: now + 60,
		})
		raw, err := json.Marshal(reply)
		if err != nil {
			return nil, err
		}
		res.Body = io.NopCloser(bytes.NewReader(raw))
		res.ContentLength = int64(len(raw))
		return res, nil
	})
	opts := base.opts
	opts.HTTPClient = &client
	a, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	if a.updateControl == nil || a.updater == nil {
		t.Fatal("local enablement must install both update controllers")
	}
	if err := a.heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if !a.waitUpdate(ctx, time.Hour) {
		t.Fatal("accepted changed intent must wake the update loop")
	}
	check := func(controller *updatecontrol.Controller) {
		t.Helper()
		out, err := controller.CheckAndStage(context.Background(), a.cfg.StateDir, ComponentOf(RunnerKind), a.opts.Version, a.updater.Settings(), update.ManagerOptions{})
		if err != nil || out.Staged || out.Reason != "control-plane update hold" {
			t.Fatal("heartbeat hold must gate automatic staging")
		}
	}
	check(a.updateControl)
	restarted, err := updatecontrol.Open(a.cfg.StateDir, updatecontrol.Binding{WorkspaceID: cp.Workspace, AgentID: cp.AgentID, Kind: RunnerKind.Name}, nil)
	if err != nil {
		t.Fatal(err)
	}
	check(restarted)
	badNonce = true
	if err := a.heartbeat(context.Background()); err != nil {
		t.Fatal("unavailable update authority must preserve normal authenticated heartbeat health")
	}
	check(a.updateControl)
	select {
	case <-a.updateControl.Wake():
		t.Fatal("refused directive must not wake staging")
	default:
	}
}
