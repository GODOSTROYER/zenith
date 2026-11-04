package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// HostInfo is the `host` object sent at registration and in heartbeats.
type HostInfo struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
}

// LocalHost describes this process's platform.
func LocalHost() HostInfo { return HostInfo{OS: runtime.GOOS, Arch: runtime.GOARCH} }

// RegisterOptions parameterize Register.
type RegisterOptions struct {
	Kind         Kind
	Token        string
	Version      string
	Capabilities []string
	UserAgent    string
	// Force allows replacing an existing identity (a new registration token is
	// still required).
	Force bool
}

type registerRequest struct {
	Token        string            `json:"token"`
	PublicKey    string            `json:"publicKey"`
	Name         string            `json:"name"`
	Version      string            `json:"version"`
	Capabilities []string          `json:"capabilities"`
	Labels       map[string]string `json:"labels"`
	Host         HostInfo          `json:"host"`
	// Protocols are the protocol ids this agent speaks, newest first. The control
	// plane picks the newest it also serves, or answers 426 upgrade_required when
	// none is inside its support window (PROD-OPS-03).
	Protocols []string `json:"protocols"`
}

type registerResponse struct {
	ID               string              `json:"id"`
	WorkspaceID      string              `json:"workspaceId"`
	ControlPlaneKeys []protocol.KeyEntry `json:"controlPlaneKeys"`
	PollIntervalSec  int                 `json:"pollIntervalSec"`
	Protocol         string              `json:"protocol"`
}

// Register generates an identity key, registers with the control plane using
// the single-use token, and persists the identity (0600). The token is never
// logged or stored. If registration fails no identity file is written.
func Register(ctx context.Context, cfg *Common, opts RegisterOptions) (*Identity, error) {
	if strings.TrimSpace(opts.Token) == "" {
		return nil, errors.New("a registration token is required")
	}
	if _, err := LoadIdentity(cfg.StateDir, opts.Kind); err == nil && !opts.Force {
		return nil, fmt.Errorf("this agent is already registered (%s/%s); use --force with a new token to re-register", cfg.StateDir, IdentityFileName)
	}
	tlsCfg, err := BuildTLS(cfg.TLS)
	if err != nil {
		return nil, err
	}
	client, err := NewClient(cfg.ControlPlane.URL, NewHTTPClient(tlsCfg), nil, "", opts.Kind.Protocol, opts.UserAgent, nil)
	if err != nil {
		return nil, err
	}
	pub, priv, err := GenerateKey()
	if err != nil {
		return nil, err
	}
	req := registerRequest{
		Token:        strings.TrimSpace(opts.Token),
		PublicKey:    protocol.B64Encode(pub),
		Name:         cfg.Name,
		Version:      opts.Version,
		Capabilities: opts.Capabilities,
		Labels:       cfg.Labels,
		Host:         LocalHost(),
		Protocols:    []string{opts.Kind.Protocol},
	}
	if req.Labels == nil {
		req.Labels = map[string]string{}
	}
	var resp registerResponse
	path := protocol.APIPrefix + "/" + opts.Kind.Collection + "/register"
	_, err = client.Do(ctx, http.MethodPost, path, req, &resp, 30*time.Second, 1<<20)
	if err != nil {
		var he *HTTPError
		if errors.As(err, &he) {
			return nil, fmt.Errorf("registration rejected (%d %s): check that the token is unused, unexpired and for a %s agent", he.Status, he.Code, opts.Kind.Name)
		}
		return nil, fmt.Errorf("registration failed: %w", err)
	}
	if resp.Protocol != "" && resp.Protocol != opts.Kind.Protocol {
		return nil, fmt.Errorf("the control plane selected protocol %q, which this agent does not speak (%s); upgrade the agent", resp.Protocol, opts.Kind.Protocol)
	}
	if !protocol.ValidID(resp.ID) || resp.WorkspaceID == "" {
		return nil, errors.New("registration response is missing id or workspaceId")
	}
	if resp.Protocol != opts.Kind.Protocol {
		return nil, fmt.Errorf("control plane speaks protocol %q, this agent speaks %q", resp.Protocol, opts.Kind.Protocol)
	}
	if _, err := protocol.NewKeySet(resp.ControlPlaneKeys); err != nil {
		return nil, fmt.Errorf("registration response: %w", err)
	}
	if len(resp.ControlPlaneKeys) == 0 {
		return nil, errors.New("registration response carried no control-plane keys")
	}
	id := &Identity{
		Version:          1,
		Kind:             opts.Kind.Name,
		ID:               resp.ID,
		WorkspaceID:      resp.WorkspaceID,
		ControlPlaneURL:  strings.TrimRight(cfg.ControlPlane.URL, "/"),
		Protocol:         resp.Protocol,
		PublicKey:        protocol.B64Encode(pub),
		PrivateKey:       protocol.B64Encode(priv.Seed()),
		ControlPlaneKeys: resp.ControlPlaneKeys,
		PollIntervalSec:  resp.PollIntervalSec,
		RegisteredAt:     time.Now().UTC(),
	}
	if err := SaveIdentity(cfg.StateDir, id); err != nil {
		return nil, fmt.Errorf("registered as %s but could not save the identity (the token is now consumed; request a new one): %w", resp.ID, err)
	}
	// A new identity supersedes any local revocation of the old one.
	clearRevokedMarker(cfg.StateDir)
	return id, nil
}
