// Command zenith-release signs and verifies release manifests for the Zenith
// agents (see docs/platform/RUNNER-UPDATES.md). It runs on the release
// machine, never on an agent host: the signing key stays offline.
//
//	zenith-release keygen  --kid ID --private-out FILE
//	zenith-release sign    --key FILE --kid ID --component zenithd|zenith-runner --channel stable
//	                       --version 1.2.3 --seq N --dist DIR
//	                       (--base-url https://dl.example.com/v1.2.3 | --repository owner/repo --tag v1.2.3)
//	                       [--stage-dir DIR] [--valid-days 30] [--allow-downgrade] [--out FILE]
//	zenith-release verify  --manifest FILE (--kid ID --public-key B64URL | --keys FILE.json)
//	                       [--component ..] [--channel ..] [--assets DIR]
//
// Artifact URLs are <base>/<component>-<os>-<arch> (flat asset names, see release.AssetName).
// verify --assets DIR also requires every artifact URL to end in the canonical flat asset name and DIR to hold that
// file with the signed size and sha256.
// --stage-dir copies each binary there under that name with a .sha256 file next to it.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/release"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: zenith-release keygen|sign|verify [flags]")
		return 2
	}
	var err error
	switch args[0] {
	case "keygen":
		err = keygen(args[1:], stdout)
	case "sign":
		err = sign(args[1:], stdout)
	case "verify":
		err = verify(args[1:], stdout)
	default:
		err = fmt.Errorf("unknown command %q", args[0])
	}
	if err != nil {
		fmt.Fprintf(stderr, "zenith-release: %v\n", err)
		return 1
	}
	return 0
}

func keygen(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("keygen", flag.ContinueOnError)
	kid := fs.String("kid", "", "key id")
	out := fs.String("private-out", "", "file to write the private seed to (mode 0600)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *kid == "" || *out == "" {
		return fmt.Errorf("--kid and --private-out are required")
	}
	if _, err := os.Stat(*out); err == nil {
		return fmt.Errorf("%s already exists; refusing to overwrite a signing key", *out)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, []byte(protocol.B64Encode(priv.Seed())+"\n"), 0o600); err != nil {
		return err
	}
	// Prints only the PUBLIC entry, ready for the agent's update.publicKeys.
	return json.NewEncoder(stdout).Encode(protocol.KeyEntry{Kid: *kid, PublicKey: protocol.B64Encode(pub)})
}

func readKey(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, err := protocol.B64Decode(strings.TrimSpace(string(raw)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("%s is not a base64url Ed25519 seed", path)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func sign(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("sign", flag.ContinueOnError)
	keyFile := fs.String("key", "", "private seed file")
	kid := fs.String("kid", "", "key id")
	component := fs.String("component", "", "zenithd or zenith-runner")
	channel := fs.String("channel", "stable", "release channel")
	version := fs.String("version", "", "release version (semantic)")
	seq := fs.Int64("seq", 0, "monotonic manifest sequence (must exceed every earlier release)")
	baseURL := fs.String("base-url", "", "URL prefix the flat artifact assets are published under")
	repository := fs.String("repository", "", "owner/repo: with --tag, use the GitHub release download prefix as the base URL")
	tag := fs.String("tag", "", "release tag (with --repository)")
	stageDir := fs.String("stage-dir", "", "copy each binary here under its flat asset name, with a .sha256 file")
	dist := fs.String("dist", "dist", "build output directory holding <os>-<arch>/<component>")
	days := fs.Int("valid-days", 30, "days the manifest stays valid (1-90)")
	downgrade := fs.Bool("allow-downgrade", false, "mark this as a deliberate signed rollback release")
	outFile := fs.String("out", "", "write the envelope here instead of stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *keyFile == "" || *kid == "" || *component == "" || *version == "" || *seq < 1 {
		return fmt.Errorf("--key --kid --component --version and --seq are required")
	}
	base := *baseURL
	switch {
	case base != "" && (*repository != "" || *tag != ""):
		return fmt.Errorf("--base-url cannot be combined with --repository/--tag")
	case base == "":
		if *repository == "" || *tag == "" {
			return fmt.Errorf("either --base-url or both --repository and --tag are required")
		}
		var err error
		if base, err = release.GitHubReleaseBase(*repository, *tag); err != nil {
			return err
		}
	}
	if *days < 1 || *days > 90 {
		return fmt.Errorf("--valid-days must be between 1 and 90")
	}
	priv, err := readKey(*keyFile)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	m := release.Manifest{
		Channel: *channel, Component: *component, Version: *version, Seq: *seq, AllowDowngrade: *downgrade,
		IssuedAt:  now.Format(time.RFC3339),
		ExpiresAt: now.Add(time.Duration(*days) * 24 * time.Hour).Format(time.RFC3339),
	}
	platforms, err := filepath.Glob(filepath.Join(*dist, "*", *component))
	if err != nil || len(platforms) == 0 {
		return fmt.Errorf("no %s binaries found under %s/<os>-<arch>/", *component, *dist)
	}
	for _, p := range platforms {
		dir := filepath.Base(filepath.Dir(p))
		goos, goarch, ok := strings.Cut(dir, "-")
		if !ok {
			continue
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(raw)
		if *stageDir != "" {
			asset := release.AssetName(*component, goos, goarch)
			if err := os.MkdirAll(*stageDir, 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(filepath.Join(*stageDir, asset), raw, 0o755); err != nil {
				return err
			}
			line := hex.EncodeToString(sum[:]) + "  " + asset + "\n"
			if err := os.WriteFile(filepath.Join(*stageDir, asset+".sha256"), []byte(line), 0o644); err != nil {
				return err
			}
		}
		m.Artifacts = append(m.Artifacts, release.Artifact{
			OS: goos, Arch: goarch,
			URL:    release.ArtifactURL(base, *component, goos, goarch),
			SHA256: hex.EncodeToString(sum[:]), Size: int64(len(raw)),
		})
	}
	env, err := release.Sign(priv, *kid, m)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(env, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if *outFile != "" {
		return os.WriteFile(*outFile, data, 0o644)
	}
	_, err = stdout.Write(data)
	return err
}

func verify(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	file := fs.String("manifest", "", "envelope file")
	kid := fs.String("kid", "", "key id")
	pub := fs.String("public-key", "", "base64url Ed25519 public key")
	keysFile := fs.String("keys", "", "JSON file holding an array of pinned {kid, publicKey} entries (instead of --kid/--public-key)")
	component := fs.String("component", "", "require the manifest to be for this component")
	channel := fs.String("channel", "", "require the manifest to be for this channel")
	assets := fs.String("assets", "", "directory of release assets: every artifact must be there under its flat name with the signed size and sha256")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *file == "" {
		return fmt.Errorf("--manifest is required")
	}
	var pinned []protocol.KeyEntry
	switch {
	case *keysFile != "" && (*kid != "" || *pub != ""):
		return fmt.Errorf("--keys cannot be combined with --kid/--public-key")
	case *keysFile != "":
		data, err := os.ReadFile(*keysFile)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(data, &pinned); err != nil || len(pinned) == 0 {
			return fmt.Errorf("%s is not a non-empty JSON array of {kid, publicKey}", *keysFile)
		}
	case *kid != "" && *pub != "":
		pinned = []protocol.KeyEntry{{Kid: *kid, PublicKey: *pub}}
	default:
		return fmt.Errorf("pass --keys FILE or both --kid and --public-key")
	}
	raw, err := os.ReadFile(*file)
	if err != nil {
		return err
	}
	m, err := release.Verify(raw, pinned, time.Now())
	if err != nil {
		return err
	}
	if *component != "" && m.Component != *component {
		return fmt.Errorf("manifest is for component %q, expected %q", m.Component, *component)
	}
	if *channel != "" && m.Channel != *channel {
		return fmt.Errorf("manifest is for channel %q, expected %q", m.Channel, *channel)
	}
	if *assets != "" {
		if err := checkAssets(m, *assets); err != nil {
			return err
		}
	}
	fmt.Fprintf(stdout, "ok: %s %s channel=%s seq=%d expires=%s artifacts=%d\n", m.Component, m.Version, m.Channel, m.Seq, m.ExpiresAt, len(m.Artifacts))
	return nil
}

// checkAssets requires each artifact URL to end in the canonical flat asset name for its platform and the file of
// that name in dir to have the signed size and sha256.
func checkAssets(m *release.Manifest, dir string) error {
	for _, a := range m.Artifacts {
		name := release.AssetName(m.Component, a.OS, a.Arch)
		if !strings.HasSuffix(a.URL, "/"+name) {
			return fmt.Errorf("artifact url %s does not end in the asset name %s", a.URL, name)
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("asset %s is not staged: %w", name, err)
		}
		sum := sha256.Sum256(raw)
		if int64(len(raw)) != a.Size || hex.EncodeToString(sum[:]) != a.SHA256 {
			return fmt.Errorf("asset %s does not match the signed size and sha256", name)
		}
	}
	return nil
}
