package oci

import (
	"encoding/json"
	"strings"
	"testing"
)

// Synthetic bodies match the TS reader's exact shape; no live Monitoring calls.
func metricBody(t *testing.T, metric, interval, instance string, patch map[string]any) []byte {
	t.Helper()
	obj := map[string]any{
		"namespace":  "oci_computeagent",
		"query":      metric + "[" + interval + `]{resourceId = "` + instance + `"}.mean()`,
		"resolution": interval,
		"startTime":  "2026-10-01T00:00:00.000Z",
		"endTime":    "2026-10-01T00:01:00.000Z",
	}
	for key, value := range patch {
		obj[key] = value
	}
	body, err := json.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestMonitoringComputeQuery(t *testing.T) {
	compartment := "ocid1.compartment.oc1..fixture"
	instance := "ocid1.instance.oc1.iad.fixture"
	r := Request{Service: "monitoring", Method: "POST", Path: "/20180401/metrics/actions/summarizeMetricsData", Query: [][2]string{{"compartmentId", compartment}, {"compartmentIdInSubtree", "false"}}}
	bindings := map[string]string{instance: compartment}
	for _, metric := range []string{"CpuUtilization", "MemoryUtilization"} {
		for _, interval := range []string{"1m", "5m", "1h", "1d"} {
			t.Run(metric+"/"+interval, func(t *testing.T) {
				if err := BindCompartments(r, metricBody(t, metric, interval, instance, nil), []string{compartment}, bindings, r.Path); err != nil {
					t.Fatal("reader compute query refused")
				}
			})
		}
	}
}

func TestMonitoringResourceBinding(t *testing.T) {
	compartment := "ocid1.compartment.oc1..fixture"
	foreign := "ocid1.compartment.oc1..foreign"
	instance := "ocid1.instance.oc1.iad.fixture"
	foreignInstance := "ocid1.instance.oc1.iad.foreign"
	r := Request{Service: "monitoring", Method: "POST", Path: "/20180401/metrics/actions/summarizeMetricsData", Query: [][2]string{{"compartmentId", compartment}}}
	for name, localBindings := range map[string]map[string]string{
		"unbound":                     nil,
		"empty-binding":               {instance: ""},
		"foreign-compartment":         {instance: foreign},
		"foreign-resource":            {instance: compartment, foreignInstance: foreign},
		"another-allowed-compartment": {instance: foreign},
	} {
		t.Run(name, func(t *testing.T) {
			allowed := []string{compartment}
			resourceID := instance
			if name == "foreign-resource" {
				resourceID = foreignInstance
			}
			if name == "another-allowed-compartment" {
				allowed = append(allowed, foreign)
			}
			if BindCompartments(r, metricBody(t, "CpuUtilization", "1m", resourceID, nil), allowed, localBindings, r.Path) != ErrCompartment {
				t.Fatal("resource ownership was inferred from URL instead of local binding")
			}
		})
	}
}

func TestMonitoringQueryRefusals(t *testing.T) {
	compartment := "ocid1.compartment.oc1..fixture"
	instance := "ocid1.instance.oc1.iad.fixture"
	r := Request{Service: "monitoring", Method: "POST", Path: "/20180401/metrics/actions/summarizeMetricsData", Query: [][2]string{{"compartmentId", compartment}}}
	bindings := map[string]string{instance: compartment}
	query := `CpuUtilization[1m]{resourceId = "` + instance + `"}.mean()`
	for name, patch := range map[string]map[string]any{
		"namespace":            {"namespace": "oci_other"},
		"namespace-type":       {"namespace": 42},
		"namespace-null":       {"namespace": nil},
		"metric":               {"query": strings.Replace(query, "CpuUtilization", "DiskUtilization", 1)},
		"metric-case":          {"query": strings.Replace(query, "CpuUtilization", "cpuUtilization", 1)},
		"aggregation":          {"query": strings.Replace(query, ".mean()", ".sum()", 1)},
		"extra-dimension":      {"query": strings.Replace(query, `"}`, `", host = "another"}`, 1)},
		"dimension-case":       {"query": strings.Replace(query, "resourceId", "resourceID", 1)},
		"missing-resource":     {"query": "CpuUtilization[1m].mean()"},
		"resource-kind":        {"query": strings.Replace(query, "ocid1.instance.", "ocid1.compartment.", 1)},
		"resource-shape":       {"query": strings.Replace(query, instance, "ocid1.instance.oc1.iad.short", 1)},
		"resource-wildcard":    {"query": strings.Replace(query, instance, "*", 1)},
		"encoded-resource":     {"query": strings.ReplaceAll(query, ".", "%2e")},
		"unsupported-interval": {"query": strings.Replace(query, "[1m]", "[2m]", 1), "resolution": "2m"},
		"resolution-mismatch":  {"resolution": "5m"},
		"resolution-type":      {"resolution": 60},
		"resolution-null":      {"resolution": nil},
		"query-type":           {"query": 42},
		"query-null":           {"query": nil},
		"leading-space":        {"query": " " + query},
		"trailing-text":        {"query": query + " ignored"},
		"double-space":         {"query": strings.Replace(query, " = ", "  = ", 1)},
		"quote-injection":      {"query": strings.Replace(query, instance, instance+`" || resourceId = "another`, 1)},
		"brace-injection":      {"query": strings.Replace(query, instance, instance+`"}.mean() || CpuUtilization[1m]{resourceId = "`+instance, 1)},
		"or-injection":         {"query": query + " || " + query},
		"newline-injection":    {"query": query + "\n"},
		"extra-field":          {"resourceGroup": "another"},
		"extra-selector":       {"compartmentId": compartment},
		"extra-nested-field":   {"dimensions": map[string]any{"resourceId": instance}},
		"invalid-start":        {"startTime": "invalid"},
		"end-type":             {"endTime": 42},
		"reversed-range":       {"endTime": "2026-09-30T00:00:00Z"},
		"empty-range":          {"endTime": "2026-10-01T00:00:00Z"},
	} {
		t.Run(name, func(t *testing.T) {
			if BindCompartments(r, metricBody(t, "CpuUtilization", "1m", instance, patch), []string{compartment}, bindings, r.Path) != ErrCompartment {
				t.Fatal("unsafe monitoring body accepted or error leaked external text")
			}
		})
	}
	validBody := metricBody(t, "CpuUtilization", "1m", instance, nil)
	for name, body := range map[string][]byte{
		"missing-body":       nil,
		"empty-object":       []byte(`{}`),
		"array":              []byte(`[]`),
		"invalid-json":       []byte(`{`),
		"missing-resolution": []byte(strings.Replace(string(validBody), `"resolution":"1m",`, "", 1)),
		"duplicate-query":    []byte(strings.Replace(string(validBody), `"namespace":`, `"query":"CpuUtilization[1m].mean()","namespace":`, 1)),
		"trailing-document":  append(append([]byte{}, validBody...), []byte(`{}`)...),
	} {
		t.Run(name, func(t *testing.T) {
			if BindCompartments(r, body, []string{compartment}, bindings, r.Path) != ErrCompartment {
				t.Fatal("malformed monitoring body accepted")
			}
		})
	}
}
