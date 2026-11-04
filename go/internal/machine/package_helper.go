package machine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

const packageHelperConfigPath = "/etc/zenithd/package-install.json"
const packageHelperSocket = "/run/zenithd-package-install/install.sock"
const packageHelperState = "/var/lib/zenithd-package-install"
const packageWireLimit = 96 << 10

type packageHelperConfig struct {
	MachineID      string                   `json:"machineId"`
	WorkspaceID    string                   `json:"workspaceId"`
	DaemonUID      uint32                   `json:"daemonUid"`
	Keys           []protocol.KeyEntry      `json:"controlPlaneKeys"`
	PackageInstall ops.PackageInstallConfig `json:"packageInstall"`
	// Root configuration separately pins all retained daemon file custody. These
	// fields do not grant write/upload permission to this helper.
	FileWrite  ops.FileWriteConfig  `json:"fileWrite"`
	FileUpload ops.FileUploadConfig `json:"fileUpload"`
}

type packageWireRequest struct {
	Kind  string `json:"kind"`
	Token string `json:"token,omitempty"`
}
type packageProfileMetadata struct {
	Ref     string `json:"profileRef"`
	Version string `json:"profileVersion"`
}
type packageWireResponse struct {
	Ready       bool                     `json:"ready"`
	MachineID   string                   `json:"machineId"`
	WorkspaceID string                   `json:"workspaceId"`
	Profiles    []packageProfileMetadata `json:"profiles,omitempty"`
	Result      *ops.Result              `json:"result,omitempty"`
}

func packageHelperConfigValid(c packageHelperConfig) bool {
	if !protocol.ValidID(c.MachineID) || !protocol.ValidID(c.WorkspaceID) || c.DaemonUID == 0 || len(c.Keys) < 1 || len(c.Keys) > 16 || !c.PackageInstall.Enabled || ops.ValidatePackageInstallConfig(c.PackageInstall) != nil {
		return false
	}
	keys, err := protocol.NewKeySet(c.Keys)
	if err != nil || keys.Len() != len(c.Keys) {
		return false
	}
	return ops.ValidatePackageInstallIsolation(ops.Config{PackageInstall: c.PackageInstall, FileWrite: c.FileWrite, FileUpload: c.FileUpload}) == nil
}

// Duplicate members at any level are refused before decoding into closed types.
func strictPackageJSON(raw []byte, dst any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	var walk func() error
	walk = func() error {
		t, e := d.Token()
		if e != nil {
			return e
		}
		del, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		if del == '{' {
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				s, ok := k.(string)
				if e != nil || !ok || seen[s] {
					return errors.New("invalid object")
				}
				seen[s] = true
				if e = walk(); e != nil {
					return e
				}
			}
		} else if del == '[' {
			for d.More() {
				if e := walk(); e != nil {
					return e
				}
			}
		} else {
			return errors.New("invalid delimiter")
		}
		_, e = d.Token()
		return e
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing value")
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	return d.Decode(dst)
}

func packageMetadata(c packageHelperConfig) []packageProfileMetadata {
	out := make([]packageProfileMetadata, 0, len(c.PackageInstall.Profiles))
	for _, p := range c.PackageInstall.Profiles {
		out = append(out, packageProfileMetadata{p.ProfileRef, p.ProfileVersion})
	}
	return out
}

func packageProfilesMatch(remote []packageProfileMetadata, local []ops.PackageInstallProfile) bool {
	if len(remote) != len(local) {
		return false
	}
	seen := map[string]bool{}
	for _, p := range remote {
		if seen[p.Ref] {
			return false
		}
		seen[p.Ref] = true
		found := false
		for _, l := range local {
			if l.ProfileRef == p.Ref && l.ProfileVersion == p.Version {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func packageHelperMain(args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 || args[0] != "--config" || args[1] != packageHelperConfigPath {
		fmt.Fprintln(stderr, "usage: zenithd package-helper --config /etc/zenithd/package-install.json")
		return agent.ExitUsage
	}
	ctx, stop := agent.SignalContext()
	defer stop()
	if runPackageHelper(ctx) != nil {
		fmt.Fprintln(stderr, "zenithd: package helper unavailable; no reconciliation or replay was attempted")
		return agent.ExitError
	}
	return agent.ExitOK
}

// A closed private route keeps authenticated token custody out of ops.Env and
// all caller-configurable runner ports. The root independently verifies it.
func (e *Executor) preparePackageInstallJob(token string, vm *protocol.VerifiedMachine, timeout time.Duration, maxOut int64) (ops.Runnable, error) {
	if vm.Envelope.Operation != ops.OpPackageInstall || vm.Grant.Res == "" || maxOut < 2048 || ops.ValidatePackageInstallConstraints(vm.Envelope.Args, vm.Grant.Constraints) != nil {
		return nil, protocol.Errorf(protocol.CodeConstraint, "package.install requires an exact resource grant and metadata budget")
	}
	a, err := ops.ParsePackageInstallArgs(vm.Envelope.Args)
	if err != nil {
		return nil, err
	}
	if !e.packageAvailable(context.Background()) {
		return nil, protocol.Errorf(protocol.CodeDisabledByConfig, "package.install root helper or pinned profile is unavailable")
	}
	matched := false
	for _, p := range e.cfg.PackageInstall.Profiles {
		if p.ProfileRef == a.ProfileRef && p.ProfileVersion == a.ProfileVersion {
			matched = true
		}
	}
	if !matched {
		return nil, protocol.Errorf(protocol.CodeNotAllowed, "package.install profile is not locally authorized")
	}
	return func(ctx context.Context) (ops.Result, error) {
		if !e.packageAvailable(ctx) {
			return ops.PackageInstallFailure("none", ""), nil
		}
		reply, err := packageHelperRoundTrip(ctx, packageWireRequest{Kind: "install", Token: token})
		if err != nil || reply.Result == nil || reply.MachineID != e.self.ID || reply.WorkspaceID != e.self.WorkspaceID {
			return ops.PackageInstallFailure("unknown", ""), nil
		}
		return *reply.Result, nil
	}, nil
}

func (e *Executor) packageAvailable(ctx context.Context) bool {
	if !e.cfg.PackageInstall.Enabled || ops.ValidatePackageInstallIsolation(e.cfg.Config) != nil || ops.ValidatePackageInstallConfig(e.cfg.PackageInstall) != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	r, err := packageHelperRoundTrip(ctx, packageWireRequest{Kind: "availability"})
	if err != nil || !r.Ready || r.Result != nil || r.MachineID != e.self.ID || r.WorkspaceID != e.self.WorkspaceID || len(r.Profiles) != len(e.cfg.PackageInstall.Profiles) {
		return false
	}
	return packageProfilesMatch(r.Profiles, e.cfg.PackageInstall.Profiles)
}
