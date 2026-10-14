package release_test

import (
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/release"
)

func TestFlatAssetNamesAndArtifactURL(t *testing.T) {
	if got := release.AssetName("zenith-runner", "linux", "amd64"); got != "zenith-runner-linux-amd64" {
		t.Fatalf("asset name %q", got)
	}
	if got := release.ManifestAssetName("zenithd"); got != "updater-zenithd.json" {
		t.Fatalf("manifest asset name %q", got)
	}
	for _, base := range []string{"https://dl.example.com/v1.2.3", "https://dl.example.com/v1.2.3/"} {
		got := release.ArtifactURL(base, "zenithd", "linux", "arm64")
		if got != "https://dl.example.com/v1.2.3/zenithd-linux-arm64" {
			t.Fatalf("url %q", got)
		}
		if err := release.ValidateArtifactURL(got); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGitHubReleaseBase(t *testing.T) {
	got, err := release.GitHubReleaseBase("GODOSTROYER/zenith", "v1.0.0")
	if err != nil || got != "https://github.com/GODOSTROYER/zenith/releases/download/v1.0.0" {
		t.Fatalf("got %q %v", got, err)
	}
	for _, bad := range [][2]string{{"", "v1"}, {"onlyowner", "v1"}, {"a/b/c", "v1"}, {"a/b", ""}, {"a/b", "v1/../x"}, {"a/b c", "v1"}, {"a/b", "v1?x"}} {
		if _, err := release.GitHubReleaseBase(bad[0], bad[1]); err == nil {
			t.Fatalf("%v must be refused", bad)
		}
	}
}
