package kinds_test

import (
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/oci"
	"github.com/GODOSTROYER/zenith/go/internal/runner"
	"github.com/GODOSTROYER/zenith/go/internal/runner/kinds"
)

func TestOCIRegistrationUsesLocalConfigLabels(t *testing.T) {
	cfg := runner.Config{}
	cfg.ControlPlane.URL = "https://zenith.example.com"
	cfg.ApplyDefaults(t.TempDir())
	cfg.Limits = runner.LimitsConfig{DefaultTimeoutSec: 1, MaxTimeoutSec: 60, DefaultOutputBytes: 1024, MaxOutputBytes: 1 << 20}
	cfg.Kinds.OCIHTTP = &kinds.OCIConfig{Enabled: true, Auth: oci.ResourcePrincipal, Region: "us-ashburn-1", Tenancy: "ocid1.tenancy.oc1..fixture", AllowedCompartments: []string{"ocid1.compartment.oc1..fixture"}}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if cfg.Labels["oci.auth"] != oci.ResourcePrincipal || cfg.Labels["oci.region"] != "us-ashburn-1" || cfg.Labels["oci.tenancy"] != cfg.Kinds.OCIHTTP.Tenancy || cfg.Kinds.OCIHTTP.AuditPath == "" {
		t.Fatal("missing local labels/audit default")
	}
	if enabled := cfg.EnabledKinds(); len(enabled) != 1 || enabled[0] != kinds.KindOCIHTTP {
		t.Fatal("OCI kind not advertised")
	}
	cfg.Labels["oci.tenancy"] = "ocid1.tenancy.oc1..foreign"
	if err := cfg.Validate(); err == nil {
		t.Fatal("conflicting tenancy label accepted")
	}
	cfg.Kinds.OCIHTTP.Enabled = false
	if len(cfg.EnabledKinds()) != 0 {
		t.Fatal("disabled OCI kind advertised")
	}
}
