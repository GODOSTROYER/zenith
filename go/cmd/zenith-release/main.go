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
	"os"

	"github.com/GODOSTROYER/zenith/go/internal/release"
)

func main() { os.Exit(release.Run(os.Args[1:], os.Stdout, os.Stderr)) }
