package agent

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// Command names shared by both binaries.
const (
	CmdRun      = "run"
	CmdRegister = "register"
	CmdVersion  = "version"
	CmdCheck    = "check"
)

// ParsedArgs is the result of parsing a command line.
type ParsedArgs struct {
	Command   string
	Config    string
	URL       string
	Token     string
	TokenFile string
	Name      string
	Force     bool
}

// ParseArgs parses "[--config path] <run|register|check|version> [flags]"; a
// missing command means run. --config may appear before or after the command.
func ParseArgs(binary string, args []string, stderr io.Writer) (ParsedArgs, error) {
	var p ParsedArgs
	fs := flag.NewFlagSet(binary, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&p.Config, "config", "", "path to the config file (JSON or YAML); default $ZENITH_CONFIG or /etc/"+binary+"/config.yaml")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: %s [--config FILE] <command> [flags]\n\nCommands:\n  run        run the agent (default)\n  register   register with the control plane (--token-file FILE | --token TOKEN) [--url URL] [--name NAME] [--force]\n  check      validate the config and print what is enabled\n  version    print the version\n\n", binary)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return p, err
	}
	rest := fs.Args()
	p.Command = CmdRun
	if len(rest) > 0 {
		p.Command, rest = rest[0], rest[1:]
	}
	sub := flag.NewFlagSet(binary+" "+p.Command, flag.ContinueOnError)
	sub.SetOutput(stderr)
	sub.StringVar(&p.Config, "config", p.Config, "path to the config file")
	switch p.Command {
	case CmdRegister:
		sub.StringVar(&p.URL, "url", "", "control plane URL (overrides controlPlane.url)")
		sub.StringVar(&p.Token, "token", "", "registration token (visible in the process list; prefer --token-file or ZENITH_REGISTRATION_TOKEN)")
		sub.StringVar(&p.TokenFile, "token-file", "", "file containing the registration token")
		sub.StringVar(&p.Name, "name", "", "agent name (overrides name)")
		sub.BoolVar(&p.Force, "force", false, "replace an existing identity")
	case CmdRun, CmdCheck, CmdVersion:
	default:
		return p, fmt.Errorf("unknown command %q", p.Command)
	}
	if err := sub.Parse(rest); err != nil {
		return p, err
	}
	if sub.NArg() > 0 {
		return p, fmt.Errorf("unexpected argument %q", sub.Arg(0))
	}
	return p, nil
}

// ResolveConfigPath picks the config file: --config, $ZENITH_CONFIG, then the
// first existing /etc/<binary>/config.{yaml,yml,json}; "" means none (defaults
// and environment only).
func ResolveConfigPath(binary, flagValue string, getenv func(string) string) string {
	if flagValue != "" {
		return flagValue
	}
	if v := getenv("ZENITH_CONFIG"); v != "" {
		return v
	}
	for _, ext := range []string{"yaml", "yml", "json"} {
		p := "/etc/" + binary + "/config." + ext
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// IsHelp reports whether err came from -h/--help.
func IsHelp(err error) bool { return errors.Is(err, flag.ErrHelp) }

// Fatal prints an error and returns the usage/config exit code.
func Fatal(stderr io.Writer, binary string, err error) int {
	fmt.Fprintf(stderr, "%s: %s\n", binary, strings.TrimSpace(err.Error()))
	return ExitUsage
}

// RegisterCommand runs a registration and prints the outcome. It never prints
// the token or the identity key.
func RegisterCommand(ctx context.Context, stdout, stderr io.Writer, binary string, cfg *Common, kind Kind, p ParsedArgs, getenv func(string) string, version string, capabilities []string) int {
	if p.URL != "" {
		cfg.ControlPlane.URL = p.URL
	}
	if p.Name != "" {
		cfg.Name = p.Name
	}
	if err := cfg.Validate(); err != nil {
		return Fatal(stderr, binary, err)
	}
	token, fromFlag, err := ReadToken(p.Token, p.TokenFile, cfg, getenv)
	if err != nil {
		return Fatal(stderr, binary, err)
	}
	if token == "" {
		return Fatal(stderr, binary, errors.New("a registration token is required: --token-file FILE, --token TOKEN or $ZENITH_REGISTRATION_TOKEN"))
	}
	if fromFlag {
		fmt.Fprintln(stderr, binary+": warning: --token is visible in the process list; prefer --token-file or ZENITH_REGISTRATION_TOKEN")
	}
	id, err := Register(ctx, cfg, RegisterOptions{Kind: kind, Token: token, Version: version, Capabilities: capabilities, UserAgent: "zenith-" + kind.Name + "/" + version, Force: p.Force})
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", binary, err)
		return ExitError
	}
	fmt.Fprintf(stdout, "registered %s %s in workspace %s\nidentity saved to %s/%s (mode 0600); the private key never leaves this host\n", kind.Name, id.ID, id.WorkspaceID, cfg.StateDir, IdentityFileName)
	return ExitOK
}

// EnsureIdentity loads the identity, auto-registering from a token when there
// is none and one is available (ZENITH_REGISTRATION_TOKEN or the configured
// token file). Registration tokens are single use, so a container that loses
// its state directory cannot re-register on its own: keep stateDir on a volume.
func EnsureIdentity(ctx context.Context, stderr io.Writer, binary string, cfg *Common, kind Kind, getenv func(string) string, version string, capabilities []string) (*Identity, error) {
	id, err := LoadIdentity(cfg.StateDir, kind)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, ErrNoIdentity) {
		return nil, err
	}
	token, _, terr := ReadToken("", "", cfg, getenv)
	if terr != nil {
		return nil, terr
	}
	if token == "" {
		return nil, fmt.Errorf("not registered: create a registration token in Zenith and run `%s register --token-file FILE` (or set ZENITH_REGISTRATION_TOKEN for first start)", binary)
	}
	fmt.Fprintf(stderr, "%s: no identity in %s; registering with the control plane\n", binary, cfg.StateDir)
	return Register(ctx, cfg, RegisterOptions{Kind: kind, Token: token, Version: version, Capabilities: capabilities, UserAgent: "zenith-" + kind.Name + "/" + version})
}
