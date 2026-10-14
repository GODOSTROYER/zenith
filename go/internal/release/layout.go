package release

import (
	"fmt"
	"strings"
)

// Canonical update layout (docs/platform/RUNNER-UPDATES.md).
//
// Every published file is a FLAT asset, because GitHub release assets cannot contain a slash:
//
//	binary            <component>-<os>-<arch>           zenith-runner-linux-amd64
//	binary checksum   <component>-<os>-<arch>.sha256    "<hex>  <asset name>"
//	signed manifest   updater-<component>.json          updater-zenith-runner.json
//
// A manifest artifact URL is <base>/<asset> where base is, by default,
// https://github.com/<owner>/<repo>/releases/download/<tag>, or <operator mirror>/<tag> when the
// operator hosts the files themselves.

// AssetName is the flat asset name of one component binary.
func AssetName(component, goos, goarch string) string {
	return component + "-" + goos + "-" + goarch
}

// ManifestAssetName is the flat asset name of a component's signed updater manifest.
func ManifestAssetName(component string) string {
	return "updater-" + component + ".json"
}

// ArtifactURL joins a base URL (no trailing slash needed) and the flat asset name.
func ArtifactURL(base, component, goos, goarch string) string {
	return strings.TrimRight(base, "/") + "/" + AssetName(component, goos, goarch)
}

// GitHubReleaseBase is the default download prefix for a tag of a GitHub repository ("owner/repo").
func GitHubReleaseBase(repository, tag string) (string, error) {
	owner, repo, ok := strings.Cut(repository, "/")
	if !ok || owner == "" || repo == "" || strings.ContainsAny(repository, " \t\n?#") || strings.Count(repository, "/") != 1 {
		return "", fmt.Errorf("repository %q is not owner/repo", repository)
	}
	if tag == "" || strings.ContainsAny(tag, "/ \t\n?#") {
		return "", fmt.Errorf("tag %q is not usable in a URL", tag)
	}
	return "https://github.com/" + repository + "/releases/download/" + tag, nil
}
