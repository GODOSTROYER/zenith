package machine

import (
	"encoding/json"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

func TestPackageHelperClosedWireRejectsDuplicatesAndOpaqueFields(t *testing.T) {
	for _, raw := range []string{`{"kind":"availability","kind":"install"}`, `{"kind":"availability","argv":["/bin/sh"]}`, `{"kind":"availability"} {}`, `{"kind":"availability","token":{},"path":"/tmp"}`} {
		var request packageWireRequest
		if strictPackageJSON([]byte(raw), &request) == nil {
			t.Fatal("opaque helper request accepted")
		}
	}
	var request packageWireRequest
	if strictPackageJSON([]byte(`{"kind":"availability"}`), &request) != nil || request.Kind != "availability" {
		t.Fatal("closed metadata request refused")
	}
}
func TestPackageHelperConfigurationCannotUseDecodedPrivilegeProof(t *testing.T) {
	if packageHelperConfigValid(packageHelperConfig{MachineID: "mac_fixture", WorkspaceID: "ws_fixture", DaemonUID: 0, PackageInstall: ops.PackageInstallConfig{Enabled: true}}) {
		t.Fatal("unbounded privileged configuration accepted")
	}
	var c packageHelperConfig
	if strictPackageJSON([]byte(`{"machineId":"mac_fixture","workspaceId":"ws_fixture","daemonUid":1000,"proof":true}`), &c) == nil {
		t.Fatal("caller authority marker accepted")
	}
}
func TestPackageFailureMetadataHasNoOutputOrSourceData(t *testing.T) {
	r := ops.PackageInstallFailure("unknown", "pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	raw, e := json.Marshal(r)
	if e != nil {
		t.Fatal(e)
	}
	var decoded map[string]any
	if json.Unmarshal(raw, &decoded) != nil {
		t.Fatal("invalid metadata")
	}
	if decoded["output"] != nil || decoded["err"] != nil || decoded["data"].(map[string]any)["transactionRef"] != "pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatal("uncertain intent custody lost")
	}
}

func TestPackageHelperAdvertisementRequiresExactLocalProfileSet(t *testing.T) {
	local := []ops.PackageInstallProfile{{ProfileRef: "bundle", ProfileVersion: "version-a"}}
	if !packageProfilesMatch([]packageProfileMetadata{{Ref: "bundle", Version: "version-a"}}, local) {
		t.Fatal("same pinned metadata refused")
	}
	for _, remote := range [][]packageProfileMetadata{nil, {{Ref: "bundle", Version: "version-b"}}, {{Ref: "foreign", Version: "version-a"}}, {{Ref: "bundle", Version: "version-a"}, {Ref: "bundle", Version: "version-a"}}} {
		if packageProfilesMatch(remote, local) {
			t.Fatal("missing/foreign/changed/duplicate helper metadata advertised installation")
		}
	}
}
