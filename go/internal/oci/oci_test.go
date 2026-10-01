package oci

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

type signingVector struct {
	PrivateKey, PublicKey, KeyID, Date, Host string
	Cases                                    []struct{ Method, URI, BodyB64, Canonical, SignedHeaders, Signature string }
}

func vector(t *testing.T) (signingVector, *rsa.PrivateKey) {
	t.Helper()
	data, err := os.ReadFile("testdata/signing-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v signingVector
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	key, err := privateKey([]byte(v.PrivateKey), nil)
	if err != nil {
		t.Fatal(err)
	}
	return v, key
}

func TestSignerIndependentNodeVector(t *testing.T) {
	v, key := vector(t)
	now, err := http.ParseTime(v.Date)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		t.Run(c.Method, func(t *testing.T) {
			body, _ := base64.StdEncoding.DecodeString(c.BodyB64)
			request, err := http.NewRequest(c.Method, "https://"+v.Host+c.URI, bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if err := Sign(request, body, v.KeyID, key, now); err != nil {
				t.Fatal(err)
			}
			auth := request.Header.Get("Authorization")
			if !strings.Contains(auth, `signature="`+c.Signature+`"`) || !strings.Contains(auth, `headers="`+c.SignedHeaders+`"`) {
				t.Fatal("signature differs from independent Node crypto vector")
			}
			signature, _ := base64.StdEncoding.DecodeString(c.Signature)
			hash := sha256.Sum256([]byte(c.Canonical))
			if rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, hash[:], signature) != nil {
				t.Fatal("signature verification failed")
			}
			if (c.Method == "POST" || c.Method == "PUT") && request.ContentLength != int64(len(body)) {
				t.Fatal("wrong byte content length")
			}
		})
	}
}

func TestSignerRefusesMissingKeyAndHeaderInjection(t *testing.T) {
	_, key := vector(t)
	request, _ := http.NewRequest("GET", "https://iaas.us-ashburn-1.oraclecloud.com/20160918/subnets", nil)
	for _, id := range []string{"", "ST$test\"injection", "ST$test\nheader", "ST$test\\escape", strings.Repeat("x", 32769)} {
		if Sign(request, nil, id, key, time.Now()) == nil {
			t.Fatal("accepted invalid keyId")
		}
	}
	if Sign(request, nil, "test", nil, time.Now()) == nil {
		t.Fatal("accepted nil key")
	}
	if Sign(nil, nil, "test", key, time.Now()) == nil {
		t.Fatal("accepted nil request")
	}
}

func TestGoldenAllowlistEveryRule(t *testing.T) {
	if len(rules) != 10 || len(services) != 18 || len(rules["infrastructure.observe"]) != 52 || len(rules["topology.read"]) != 50 || len(rules["incident.investigate"]) != 52 || len(rules["logs.read"]) != 1 || len(rules["metrics.read"]) != 1 || len(rules["deployment.deploy"]) != 5 {
		t.Fatalf("unexpected contract sizes: %d %d %d", len(rules), len(services), len(rules["infrastructure.observe"]))
	}
	for capability, entries := range rules {
		for _, rule := range entries {
			path := "/" + rule.Pattern
			if version := services[rule.Service].Version; version != "" {
				path = "/" + version + path
			}
			concrete := strings.ReplaceAll(path, "{}", "fixture")
			template, allowed := Match(capability, rule.Service, rule.Method, concrete)
			if !allowed || template != path {
				t.Fatalf("rule mismatch for %s %s", capability, path)
			}
			for _, bad := range []string{concrete + "/extra/extra", concrete + "/", strings.Replace(concrete, "/", "//", 1)} {
				if _, ok := Match(capability, rule.Service, rule.Method, bad); ok {
					t.Fatal("accepted a nonmatching path")
				}
			}
			if _, ok := Match(capability, rule.Service, "DELETE", concrete); ok {
				t.Fatal("allowed DELETE")
			}
		}
	}
	for _, path := range []string{"/20190301/secretbundles/fixture", "/n/ns/b/bucket/o/object", "/20160918/subnets/x/actions/changeCompartment"} {
		for cap := range rules {
			for service := range services {
				if _, ok := Match(cap, service, "GET", path); ok {
					t.Fatal("allowed forbidden data path")
				}
			}
		}
	}
	if _, ok := Match("unknown", "core", "GET", "/20160918/subnets"); ok {
		t.Fatal("unknown capability allowed")
	}
}

func TestParseRequestRefusals(t *testing.T) {
	baseline := map[string]any{"service": "core", "region": "us-ashburn-1", "method": "GET", "path": "/20160918/subnets", "query": [][2]string{{"compartmentId", "ocid1.compartment.oc1..fixture"}}, "headers": map[string]string{}}
	cases := map[string]any{
		"service": map[string]any{"service": "toString"}, "region": map[string]any{"region": "../metadata"}, "delete": map[string]any{"method": "DELETE"},
		"unknown": map[string]any{"sealedBodyB64": "synthetic"}, "null": map[string]any{"headers": nil}, "tuple": map[string]any{"query": [][]string{{"a", "b", "c"}}},
		"unsorted": map[string]any{"query": [][2]string{{"z", "1"}, {"a", "2"}}}, "query-control": map[string]any{"query": [][2]string{{"a", "\n"}}},
		"query-bound": map[string]any{"query": [][2]string{{"a", strings.Repeat("x", 2049)}}}, "get-body": map[string]any{"bodyB64": "e30="},
		"host": map[string]any{"endpointHost": "a.oraclecloud.com"}, "duplicate-header": map[string]any{"headers": map[string]string{"opc-request-id": "a", "Opc-Request-Id": "b"}},
	}
	for _, name := range []string{"Authorization", "Host", "Date", "x-date", "x-content-sha256", "Content-Length", "Content-Type", "Signature", "Cookie", "Proxy-Foo", "User-Agent"} {
		cases["header-"+name] = map[string]any{"headers": map[string]string{name: "synthetic"}}
	}
	for _, path := range []string{"/", "/a//b", "/a/..", "/a/%2e%2e", "/a/%2F", "/a/%5c", "/a/%00", "/a/%ff", "/a?query", "/a#fragment", "/a\\b", "/a b", "/café", "/" + strings.Repeat("x", 2048)} {
		cases["path-"+path] = map[string]any{"path": path}
	}
	for name, patch := range cases {
		t.Run(name, func(t *testing.T) {
			pl := map[string]any{}
			for key, value := range baseline {
				pl[key] = value
			}
			for key, value := range patch.(map[string]any) {
				pl[key] = value
			}
			raw, _ := json.Marshal(pl)
			if _, _, err := ParseRequest(raw, MaxRequestBytes); err == nil {
				t.Fatal("accepted invalid payload")
			}
		})
	}
	for _, raw := range []string{`{"service":"core","service":"vault"}`, `{} {}`, `[]`, `null`} {
		if _, _, err := ParseRequest([]byte(raw), MaxRequestBytes); err == nil {
			t.Fatal("accepted duplicate/trailing/nonobject payload")
		}
	}
}

func TestBodyBoundsAndCanonicalBase64(t *testing.T) {
	pl := Request{Service: "postgresql", Region: "us-ashburn-1", Method: "POST", Path: "/20220915/backups", Query: [][2]string{}, Headers: map[string]string{}}
	for _, size := range []int{MaxRequestBytes, MaxRequestBytes + 1} {
		body := []byte(`"` + strings.Repeat("x", size-2) + `"`)
		encoded := base64.StdEncoding.EncodeToString(body)
		pl.BodyB64 = &encoded
		raw, _ := json.Marshal(pl)
		_, decoded, err := ParseRequest(raw, MaxRequestBytes)
		if (err == nil) != (size == MaxRequestBytes) || (err == nil && len(decoded) != size) {
			t.Fatal("wrong decoded byte limit")
		}
	}
	for _, encoded := range []string{"e31=", "e30", "e30=\n", "/w==", base64.StdEncoding.EncodeToString([]byte(`{"compartmentId":"a","compartmentId":"b"}`))} {
		pl.BodyB64 = &encoded
		raw, _ := json.Marshal(pl)
		if _, _, err := ParseRequest(raw, MaxRequestBytes); err == nil {
			t.Fatal("accepted noncanonical base64, invalid UTF-8 or duplicate JSON")
		}
	}
}

func TestQueryOrderAndEndpointResolution(t *testing.T) {
	query := [][2]string{{"a", "a b"}, {"a", "+"}, {"z", "/"}}
	if got := QueryString(query); got != "a=a%20b&a=%2B&z=%2F" {
		t.Fatal(got)
	}
	for service, entry := range services {
		endpoint := ""
		want := strings.ReplaceAll(entry.Host, "{region}", "us-ashburn-1")
		if service == "queue-data" {
			endpoint = "cell.queue.messaging.us-ashburn-1.oci.oraclecloud.com"
			want = endpoint
		}
		host, err := ResolveHost(service, "us-ashburn-1", endpoint)
		if err != nil || host != want || !OracleHost(host) {
			t.Fatal("endpoint mismatch")
		}
	}
	for _, host := range []string{"oraclecloud.com", "a.oraclecloud.com.attacker.com", "a..oraclecloud.com", "a.oraclecloud.com:443", "169.254.169.254", "https://a.oraclecloud.com", "a.oraclecloud.com/"} {
		if _, err := ResolveHost("queue-data", "us-ashburn-1", host); err == nil {
			t.Fatal("allowed invalid queue endpoint")
		}
	}
}

func TestCompartmentBindingsCannotBeAssertedByCaller(t *testing.T) {
	compartment := "ocid1.compartment.oc1..fixture"
	foreign := "ocid1.compartment.oc1..foreign"
	resource := "ocid1.subnet.oc1.iad.fixture"
	template := "/20160918/subnets/{}"
	pl := Request{Service: "core", Region: "us-ashburn-1", Method: "GET", Path: "/20160918/subnets/" + resource, Query: [][2]string{{"compartmentId", compartment}}}
	if BindCompartments(pl, nil, []string{compartment}, nil, template) == nil {
		t.Fatal("query compartment asserted ownership of an unbound resource")
	}
	bindings := map[string]string{resource: compartment}
	if err := BindCompartments(pl, nil, []string{compartment}, bindings, template); err != nil {
		t.Fatal(err)
	}
	pl.Query = [][2]string{{"compartmentId", compartment}, {"compartmentId", foreign}}
	if BindCompartments(pl, nil, []string{compartment}, bindings, template) == nil {
		t.Fatal("duplicate compartments allowed")
	}
	pl.Query = nil
	bindings[resource] = foreign
	if BindCompartments(pl, nil, []string{compartment}, bindings, template) == nil {
		t.Fatal("foreign resource allowed")
	}
	bindings[resource] = compartment
	pl.Path = "/20160918/subnets/" + strings.ReplaceAll(resource, ".", "%2e")
	if err := BindCompartments(pl, nil, []string{compartment}, bindings, template); err != nil {
		t.Fatal("encoded OCID binding failed")
	}
	pl.Path = "/20160918/subnets"
	if BindCompartments(pl, nil, []string{compartment}, bindings, "/20160918/subnets") == nil {
		t.Fatal("unscoped collection allowed")
	}
	for _, body := range []string{`{"nested":{"compartmentId":"` + foreign + `"}}`, `{"compartmentId":null}`, `{"CompartmentId":"` + compartment + `"}`} {
		if BindCompartments(pl, []byte(body), []string{compartment}, bindings, "/20160918/subnets") == nil {
			t.Fatal("foreign/malformed nested compartment allowed")
		}
	}
}

func TestNamedResourceAndSnapshotBindings(t *testing.T) {
	compartment := "ocid1.compartment.oc1..fixture"
	pl := Request{Service: "objectstorage", Region: "us-ashburn-1", Method: "GET", Path: "/n/ns/b/bucket", Query: [][2]string{{"compartmentId", compartment}}}
	template := "/n/{}/b/{}"
	if BindCompartments(pl, nil, []string{compartment}, nil, template) == nil {
		t.Fatal("unbound named bucket allowed")
	}
	bindings := map[string]string{"objectstorage:us-ashburn-1:/n/ns/b/bucket": compartment}
	if err := BindCompartments(pl, nil, []string{compartment}, bindings, template); err != nil {
		t.Fatal(err)
	}
	pl.Path = "/n/ns/b"
	pl.Query = nil
	if BindCompartments(pl, nil, []string{compartment}, nil, "/n/{}/b") == nil {
		t.Fatal("unscoped bucket list")
	}
	pl.Path = "/n"
	if err := BindCompartments(pl, nil, []string{compartment}, nil, "/n"); err != nil {
		t.Fatal("namespace metadata refused")
	}
	pl = Request{Service: "postgresql", Region: "us-ashburn-1", Method: "POST", Path: "/20220915/backups"}
	id := "ocid1.dbsystem.oc1.iad.fixture"
	body := []byte(`{"dbSystemId":"` + id + `"}`)
	if BindCompartments(pl, body, []string{compartment}, nil, "/20220915/backups") == nil {
		t.Fatal("unbound database snapshot")
	}
	if err := BindCompartments(pl, body, []string{compartment}, map[string]string{id: compartment}, "/20220915/backups"); err != nil {
		t.Fatal(err)
	}
}
