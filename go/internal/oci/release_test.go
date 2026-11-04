// Release boundary contracts only. No OCI tenancy/network is exercised here.
package oci

import "testing"

func TestReleaseWriteBelongsOnlyToDeploy(t *testing.T) {
	for capability := range rules {
		_, allowed := Match(capability, "containerinstances", "POST", "/20210415/containerInstances")
		if allowed != (capability == "deployment.deploy") {
			t.Fatalf("unexpected migration create permission for %s", capability)
		}
		for _, path := range []string{"/20210415/containerInstances/id", "/20210415/containers/id"} {
			if _, allowed := Match(capability, "containerinstances", "PUT", path); allowed {
				t.Fatal("allowed unsupported OCI image update")
			}
		}
	}
}

func TestReleaseCreateChecksEveryResourcePointer(t *testing.T) {
	compartment := "ocid1.compartment.oc1..synthetic"
	subnet := "ocid1.subnet.oc1.iad.synthetic"
	nsg := "ocid1.networksecuritygroup.oc1.iad.synthetic"
	secret := "ocid1.vaultsecret.oc1.iad.synthetic"
	body := []byte(`{"compartmentId":"` + compartment + `","vnics":[{"subnetId":"` + subnet + `","nsgIds":["` + nsg + `"]}],"containers":[{"environmentVariables":{"ZENITH_SECRET_OCID_PASSWORD":"` + secret + `"}}]}`)
	request := Request{Service: "containerinstances", Region: "us-ashburn-1", Method: "POST", Path: "/20210415/containerInstances"}
	bindings := map[string]string{subnet: compartment, nsg: compartment, secret: compartment}
	if err := BindCompartments(request, body, []string{compartment}, bindings, request.Path); err != nil {
		t.Fatal("refused fully bound migration")
	}
	for _, pointer := range []string{subnet, nsg, secret} {
		delete(bindings, pointer)
		if BindCompartments(request, body, []string{compartment}, bindings, request.Path) == nil {
			t.Fatal("accepted unbound migration resource pointer")
		}
		bindings[pointer] = compartment
	}
}

func TestReleaseNewIDsRemainUnbound(t *testing.T) {
	compartment := "ocid1.compartment.oc1..synthetic"
	request := Request{Service: "containerinstances", Region: "us-ashburn-1", Method: "GET", Path: "/20210415/containers/ocid1.computecontainer.oc1.iad.newid"}
	if BindCompartments(request, nil, []string{compartment}, map[string]string{}, "/20210415/containers/{}") == nil {
		t.Fatal("new ID was authorized without trusted local metadata")
	}
}
