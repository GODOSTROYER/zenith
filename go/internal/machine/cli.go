package machine

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/version"
)

const binaryName = "zenithd"

// Main is the zenithd command line. Exit codes: 0 clean stop, 1 runtime
// error, 2 usage or configuration error, 3 revoked by the control plane, 4
// protocol version no longer accepted.
func Main(args []string, stdout, stderr io.Writer, getenv func(string) string) int {
	if getenv == nil {
		getenv = os.Getenv
	}
	if len(args) > 0 && args[0] == "package-helper" {
		return packageHelperMain(args[1:], stdout, stderr)
	}
	if len(args) > 0 && args[0] == "file-write-versions" {
		return fileWriteVersions(args[1:], stdout, stderr)
	}
	if len(args) > 0 && args[0] == "file-upload-versions" {
		return fileUploadVersions(args[1:], stdout, stderr)
	}
	if len(args) > 0 && args[0] == "service-configure-versions" {
		return serviceConfigureVersions(args[1:], stdout, stderr)
	}
	p, err := agent.ParseArgs(binaryName, args, stderr)
	if err != nil {
		if agent.IsHelp(err) {
			return agent.ExitOK
		}
		return agent.ExitUsage
	}
	path := agent.ResolveConfigPath(binaryName, p.Config, getenv)
	switch p.Command {
	case agent.CmdVersion:
		fmt.Fprintf(stdout, "%s %s go=%s %s/%s protocol=%s\n", binaryName, version.String(), runtime.Version(), runtime.GOOS, runtime.GOARCH, protocol.MachineProtocol)
		return agent.ExitOK
	case agent.CmdRegister:
		cfg, err := LoadConfig(path, getenv)
		if err != nil {
			return agent.Fatal(stderr, binaryName, err)
		}
		ctx, stop := agent.SignalContext()
		defer stop()
		return agent.RegisterCommand(ctx, stdout, stderr, binaryName, &cfg.Common, agent.MachineKind, p, getenv, version.Version, capabilitiesOf(cfg))
	case agent.CmdUpdate:
		cfg, err := LoadConfig(path, getenv)
		if err != nil {
			return agent.Fatal(stderr, binaryName, err)
		}
		ctx, stop := agent.SignalContext()
		defer stop()
		return agent.UpdateCommand(ctx, stdout, stderr, binaryName, &cfg.Common, agent.MachineKind, p, version.Version)
	case agent.CmdCheck:
		cfg, err := LoadConfig(path, getenv)
		if err != nil {
			return agent.Fatal(stderr, binaryName, err)
		}
		src := path
		if src == "" {
			src = "(defaults and environment)"
		}
		fmt.Fprintf(stdout, "config ok: %s\ncontrol plane: %s\nstate dir: %s\nenabled operations: %s\nexec enabled: %v\ncontainers enabled: %v\n",
			src, cfg.ControlPlane.URL, cfg.StateDir, strings.Join(capabilitiesOf(cfg), ", "), cfg.Exec.Enabled, cfg.Containers.Enabled)
		return agent.ExitOK
	}
	cfg, err := LoadConfig(path, getenv)
	if err != nil {
		return agent.Fatal(stderr, binaryName, err)
	}
	log := agent.NewLogger(cfg.Log, stderr)
	// The packaged binary is also the launcher: when a verified release is
	// active it execs it, and it reverts an unhealthy one (see agent/update).
	if code, handled := agent.MaybeLaunch(&cfg.Common, os.Args, stderr); handled {
		return code
	}
	ctx, stop := agent.SignalContext()
	defer stop()
	return Run(ctx, cfg, path, stderr, getenv, log, Deps{})
}

func capabilitiesOf(cfg *Config) []string {
	out := ops.Supported(cfg.Config)
	// Before identity construction, availability can only remove package support.
	if cfg.PackageInstall.Enabled {
		r, err := packageHelperRoundTrip(context.Background(), packageWireRequest{Kind: "availability"})
		if err != nil || !r.Ready || r.Result != nil || len(r.Profiles) != len(cfg.PackageInstall.Profiles) || !packageProfilesMatch(r.Profiles, cfg.PackageInstall.Profiles) {
			for i, op := range out {
				if op == ops.OpPackageInstall {
					out = append(out[:i], out[i+1:]...)
					break
				}
			}
		}
	}
	return out
}

// Run starts zenithd with an already loaded config and returns the exit code.
func Run(ctx context.Context, cfg *Config, configPath string, stderr io.Writer, getenv func(string) string, log *slog.Logger, deps Deps) int {
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		fmt.Fprintf(stderr, "%s: cannot create the state directory: %v\n", binaryName, err)
		return agent.ExitError
	}
	id, err := agent.EnsureIdentity(ctx, stderr, binaryName, &cfg.Common, agent.MachineKind, getenv, version.Version, capabilitiesOf(cfg))
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binaryName, err)
		return agent.ExitError
	}
	keys, err := protocol.NewKeySet(id.ControlPlaneKeys)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binaryName, err)
		return agent.ExitError
	}
	replay, err := protocol.OpenFileReplayCache(filepath.Join(cfg.StateDir, "replay.jsonl"), deps.Now)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binaryName, err)
		return agent.ExitError
	}
	defer replay.Close()
	audit, err := OpenAudit(cfg.Audit.Path)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binaryName, err)
		return agent.ExitError
	}
	defer audit.Close()
	if deps.ConfigFile == "" {
		deps.ConfigFile = configPath
	}
	if deps.Version == "" {
		deps.Version = version.Version
	}
	ex, err := NewExecutor(cfg, id, keys, replay, audit, log, deps)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binaryName, err)
		return agent.ExitUsage
	}
	a, err := agent.New(agent.Options{Kind: agent.MachineKind, Config: &cfg.Common, Identity: id, Keys: keys, Processor: ex, Version: version.Version, Logger: log, Now: deps.Now, HeartbeatEvery: deps.HeartbeatEvery})
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binaryName, err)
		return agent.ExitError
	}
	return a.Run(ctx)
}

// file-write-versions reads local config metadata only. It does not read source
// contents, start the agent, install anything, or silently rewrite versions.
func fileWriteVersions(args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 || args[0] != "--config" || !filepath.IsAbs(args[1]) {
		fmt.Fprintln(stderr, "usage: zenithd file-write-versions --config /absolute/local/config.yaml")
		return agent.ExitUsage
	}
	var cfg Config
	if err := agent.LoadFile(args[1], &cfg); err != nil {
		fmt.Fprintln(stderr, "zenithd: could not read strict local profile metadata")
		return agent.ExitUsage
	}
	if len(cfg.FileWrite.Profiles) < 1 || len(cfg.FileWrite.Profiles) > 64 {
		fmt.Fprintln(stderr, "zenithd: configure bounded local profiles before computing versions")
		return agent.ExitUsage
	}
	type item struct {
		Path           string `json:"path"`
		ContentRef     string `json:"contentRef"`
		ContentVersion string `json:"contentVersion"`
	}
	out := make([]item, 0, len(cfg.FileWrite.Profiles))
	for _, p := range cfg.FileWrite.Profiles {
		version, err := ops.FileWriteProfileVersion(cfg.FileWrite, p)
		if err != nil {
			fmt.Fprintln(stderr, "zenithd: invalid canonical local profile semantics")
			return agent.ExitUsage
		}
		out = append(out, item{p.Path, p.ContentRef, version})
	}
	if json.NewEncoder(stdout).Encode(out) != nil {
		return agent.ExitError
	}
	return agent.ExitOK
}

// file-upload-versions reads local config metadata only. It does not read source
// contents, start the agent, install anything, or silently rewrite versions.
func fileUploadVersions(args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 || args[0] != "--config" || !filepath.IsAbs(args[1]) {
		fmt.Fprintln(stderr, "usage: zenithd file-upload-versions --config /absolute/local/config.yaml")
		return agent.ExitUsage
	}
	var cfg Config
	if err := agent.LoadFile(args[1], &cfg); err != nil {
		fmt.Fprintln(stderr, "zenithd: could not read strict local profile metadata")
		return agent.ExitUsage
	}
	if len(cfg.FileUpload.Profiles) < 1 || len(cfg.FileUpload.Profiles) > 64 {
		fmt.Fprintln(stderr, "zenithd: configure bounded local profiles before computing versions")
		return agent.ExitUsage
	}
	type item struct {
		Path          string `json:"path"`
		SourceRef     string `json:"sourceRef"`
		SourceVersion string `json:"sourceVersion"`
	}
	out := make([]item, 0, len(cfg.FileUpload.Profiles))
	for _, p := range cfg.FileUpload.Profiles {
		version, err := ops.FileUploadProfileVersion(cfg.FileUpload, p)
		if err != nil {
			fmt.Fprintln(stderr, "zenithd: invalid canonical local profile semantics")
			return agent.ExitUsage
		}
		out = append(out, item{p.Path, p.SourceRef, version})
	}
	if json.NewEncoder(stdout).Encode(out) != nil {
		return agent.ExitError
	}
	return agent.ExitOK
}

// service-configure-versions reads local config metadata only. It does not read source
// contents, contact systemd, start the agent, or silently rewrite versions.
func serviceConfigureVersions(args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 || args[0] != "--config" || !filepath.IsAbs(args[1]) {
		fmt.Fprintln(stderr, "usage: zenithd service-configure-versions --config /absolute/local/config.yaml")
		return agent.ExitUsage
	}
	var cfg Config
	if err := agent.LoadFile(args[1], &cfg); err != nil {
		fmt.Fprintln(stderr, "zenithd: could not read strict local profile metadata")
		return agent.ExitUsage
	}
	if len(cfg.ServiceConfigure.Profiles) < 1 || len(cfg.ServiceConfigure.Profiles) > 64 {
		fmt.Fprintln(stderr, "zenithd: configure bounded local profiles before computing versions")
		return agent.ExitUsage
	}
	type item struct {
		Unit           string `json:"unit"`
		ProfileRef     string `json:"profileRef"`
		ProfileVersion string `json:"profileVersion"`
	}
	out := make([]item, 0, len(cfg.ServiceConfigure.Profiles))
	for _, p := range cfg.ServiceConfigure.Profiles {
		version, err := ops.ServiceConfigureProfileVersion(cfg.ServiceConfigure, p)
		if err != nil {
			fmt.Fprintln(stderr, "zenithd: invalid canonical local profile semantics")
			return agent.ExitUsage
		}
		out = append(out, item{p.Unit, p.ProfileRef, version})
	}
	if json.NewEncoder(stdout).Encode(out) != nil {
		return agent.ExitError
	}
	return agent.ExitOK
}
