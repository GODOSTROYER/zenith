// Command zenith-release signs and verifies release manifests for the Zenith
// agents (see docs/platform/RUNNER-UPDATES.md). It runs on the release
// machine, never on an agent host: the signing key stays offline.
//
//	zenith-release keygen  --kid ID --private-out FILE
//	zenith-release sign    --key FILE --kid ID --component zenithd|zenith-runner --channel stable
//	                       --version 1.2.3 --seq N --base-url https://dl.example.com/zenithd --dist DIR
//	                       [--valid-days 30] [--allow-downgrade] [--out FILE]
//	zenith-release verify  --manifest FILE --kid ID --public-key B64URL [--component ..] [--channel ..]
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
	baseURL := fs.String("base-url", "", "URL prefix the artifacts are published under")
	dist := fs.String("dist", "dist", "build output directory holding <os>-<arch>/<component>")
	days := fs.Int("valid-days", 30, "days the manifest stays valid (1-90)")
	downgrade := fs.Bool("allow-downgrade", false, "mark this as a deliberate signed rollback release")
	outFile := fs.String("out", "", "write the envelope here instead of stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *keyFile == "" || *kid == "" || *component == "" || *version == "" || *baseURL == "" || *seq < 1 {
		return fmt.Errorf("--key --kid --component --version --seq and --base-url are required")
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
		m.Artifacts = append(m.Artifacts, release.Artifact{
			OS: goos, Arch: goarch,
			URL:    strings.TrimRight(*baseURL, "/") + "/" + *version + "/" + dir + "/" + *component,
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
	if err := fs.Parse(args); err != nil {
		return err
	}
	raw, err := os.ReadFile(*file)
	if err != nil {
		return err
	}
	m, err := release.Verify(raw, []protocol.KeyEntry{{Kid: *kid, PublicKey: *pub}}, time.Now())
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "ok: %s %s channel=%s seq=%d expires=%s artifacts=%d\n", m.Component, m.Version, m.Channel, m.Seq, m.ExpiresAt, len(m.Artifacts))
	return nil
}
