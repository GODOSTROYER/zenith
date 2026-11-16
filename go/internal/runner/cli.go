package runner

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
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/version"
)

const binaryName = "zenith-runner"

// Main is the zenith-runner command line. It returns the process exit code:
// 0 clean stop, 1 runtime error, 2 usage or configuration error, 3 the
// control plane revoked this runner, 4 the protocol version is no longer
// accepted.
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
	switch p.Command {
	case agent.CmdVersion:
		fmt.Fprintf(stdout, "%s %s go=%s %s/%s protocol=%s\n", binaryName, version.String(), runtime.Version(), runtime.GOOS, runtime.GOARCH, protocol.RunnerProtocol)
		return agent.ExitOK
	case agent.CmdRegister:
		cfg, err := LoadConfigForRegister(agent.ResolveConfigPath(binaryName, p.Config, getenv), getenv)
		if err != nil {
			return agent.Fatal(stderr, binaryName, err)
		}
		ctx, stop := agent.SignalContext()
		defer stop()
		return agent.RegisterCommand(ctx, stdout, stderr, binaryName, &cfg.Common, agent.RunnerKind, p, getenv, version.Version, cfg.EnabledKinds())
	case agent.CmdCheck:
		return check(p, stdout, stderr, getenv)
	case agent.CmdUpdate:
		cfg, err := LoadConfigForRegister(agent.ResolveConfigPath(binaryName, p.Config, getenv), getenv)
		if err != nil {
			return agent.Fatal(stderr, binaryName, err)
		}
		ctx, stop := agent.SignalContext()
		defer stop()
		return agent.UpdateCommand(ctx, stdout, stderr, binaryName, &cfg.Common, agent.RunnerKind, p, version.Version)
	default:
		return run(p, stderr, getenv)
	}
}

func check(p agent.ParsedArgs, stdout, stderr io.Writer, getenv func(string) string) int {
	path := agent.ResolveConfigPath(binaryName, p.Config, getenv)
	cfg, err := LoadConfig(path, getenv)
	if err != nil {
		return agent.Fatal(stderr, binaryName, err)
	}
	log := agent.NewLogger(agent.LogConfig{Level: "warn", Format: "text"}, stderr)
	dummy := &agent.Identity{ID: "run_check", WorkspaceID: "ws_check"}
	ex, err := NewExecutor(cfg, dummy, mustKeys(), protocol.NewMemoryReplayCache(nil), log, Deps{Getenv: getenv})
	if err != nil {
		return agent.Fatal(stderr, binaryName, err)
	}
	src := path
	if src == "" {
		src = "(defaults and environment)"
	}
	fmt.Fprintf(stdout, "config ok: %s\ncontrol plane: %s\nstate dir: %s\nenabled job kinds: %s\n", src, cfg.ControlPlane.URL, cfg.StateDir, strings.Join(ex.Capabilities(), ", "))
	return agent.ExitOK
}

func mustKeys() *protocol.KeySet {
	ks, _ := protocol.NewKeySet(nil)
	return ks
}

func run(p agent.ParsedArgs, stderr io.Writer, getenv func(string) string) int {
	cfg, err := LoadConfig(agent.ResolveConfigPath(binaryName, p.Config, getenv), getenv)
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
	return Run(ctx, cfg, stderr, getenv, log, Deps{Getenv: getenv})
}

// Run starts the agent with an already loaded config until ctx ends, the
// runner is revoked, or a terminal error occurs. It returns the exit code.
func Run(ctx context.Context, cfg *Config, stderr io.Writer, getenv func(string) string, log *slog.Logger, deps Deps) int {
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		fmt.Fprintf(stderr, "%s: cannot create the state directory: %v\n", binaryName, err)
		return agent.ExitError
	}
	id, err := agent.EnsureIdentity(ctx, stderr, binaryName, &cfg.Common, agent.RunnerKind, getenv, version.Version, cfg.EnabledKinds())
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
	ex, err := NewExecutor(cfg, id, keys, replay, log, deps)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binaryName, err)
		return agent.ExitUsage
	}
	a, err := agent.New(agent.Options{Kind: agent.RunnerKind, Config: &cfg.Common, Identity: id, Keys: keys, Processor: ex, Version: version.Version, Logger: log, Now: deps.Now, HeartbeatEvery: deps.HeartbeatEvery})
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binaryName, err)
		return agent.ExitError
	}
	return a.Run(ctx)
}
