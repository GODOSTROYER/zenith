package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent/update"
)

// MaybeLaunch is called by `run` before the agent starts. When a verified
// release is active it execs that binary and never returns (handled stays
// false only when this process should run itself). On Windows the child's exit
// code is returned with handled true.
func MaybeLaunch(cfg *Common, args []string, stderr io.Writer) (code int, handled bool) {
	if cfg.StateDir == "" {
		return 0, false
	}
	self, err := os.Executable()
	if err != nil {
		return 0, false
	}
	code, handled, _ = update.Launch(update.LaunchOptions{
		StateDir: cfg.StateDir,
		Self:     self,
		Args:     args,
		Environ:  os.Environ(),
		MaxBoots: cfg.Update.MaxBoots,
		Logf: func(format string, a ...any) {
			fmt.Fprintf(stderr, "launcher: "+format+"\n", a...)
		},
	})
	return code, handled
}

// UpdateCommand implements `<binary> update status|check|rollback`.
func UpdateCommand(ctx context.Context, stdout, stderr io.Writer, binary string, cfg *Common, kind Kind, p ParsedArgs, version string) int {
	if cfg.StateDir == "" {
		return Fatal(stderr, binary, fmt.Errorf("stateDir is required"))
	}
	if err := cfg.Validate(); err != nil {
		return Fatal(stderr, binary, err)
	}
	m := update.NewManager(cfg.StateDir, ComponentOf(kind), version, cfg.Update.Settings(), update.ManagerOptions{})
	switch p.Action {
	case "status":
		st, err := m.Store().Load()
		if err != nil {
			return Fatal(stderr, binary, err)
		}
		out := struct {
			Status  update.Status  `json:"status"`
			History []update.Event `json:"history"`
		}{update.StatusOf(st, m.Settings().Channel, version), st.History}
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(out); err != nil {
			return ExitError
		}
		return ExitOK
	case "check":
		if !cfg.Update.Enabled {
			return Fatal(stderr, binary, fmt.Errorf("update.enabled is false in the config"))
		}
		cctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
		defer cancel()
		out, err := m.CheckAndStage(cctx)
		if err != nil {
			fmt.Fprintf(stderr, "%s: update check failed: %v\n", binary, err)
			return ExitError
		}
		switch {
		case out.Staged:
			fmt.Fprintf(stdout, "release %s verified and activated; restart the service to run it (it rolls back automatically if it does not become healthy)\n", out.Version)
		case out.Reason != "":
			fmt.Fprintf(stdout, "no update applied: %s\n", out.Reason)
		default:
			fmt.Fprintln(stdout, "no update applied")
		}
		return ExitOK
	default: // rollback
		changed, err := m.Rollback("manual rollback requested by an operator")
		if err != nil {
			return Fatal(stderr, binary, err)
		}
		if !changed {
			fmt.Fprintln(stdout, "already running the packaged binary; nothing to roll back")
			return ExitOK
		}
		fmt.Fprintln(stdout, "rolled back; restart the service to run the previous version")
		return ExitOK
	}
}
