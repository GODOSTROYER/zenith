package machine

import (
	"context"
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
	ctx, stop := agent.SignalContext()
	defer stop()
	return Run(ctx, cfg, path, stderr, getenv, log, Deps{})
}

func capabilitiesOf(cfg *Config) []string { return ops.Supported(cfg.Config) }

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
