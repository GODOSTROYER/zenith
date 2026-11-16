package oci

import (
	"regexp"
	"time"
)

// Only the compute-agent query emitted by the TS reader is supported. The
// embedded OCID must match a trusted local binding to the exact URL compartment,
// even when several compartments are allowed. MQL is never interpreted here.
// These are offline contract guards; no live OCI tenancy has been exercised.
var computeMetricQuery = regexp.MustCompile(`^(CpuUtilization|MemoryUtilization)\[(1m|5m|1h|1d)\]\{resourceId = "(ocid1\.instance\.[a-z0-9]+\.[a-z0-9-]*\.[A-Za-z0-9]{6,120})"\}\.mean\(\)$`)

func bindMonitoring(r Request, body []byte, allowed map[string]bool, bindings map[string]string) error {
	compartment := ""
	seen := map[string]bool{}
	for _, pair := range r.Query {
		if seen[pair[0]] {
			return ErrCompartment
		}
		seen[pair[0]] = true
		switch pair[0] {
		case "compartmentId":
			compartment = pair[1]
		case "compartmentIdInSubtree":
			if pair[1] != "false" {
				return ErrCompartment
			}
		default:
			return ErrCompartment
		}
	}
	if !OCID(compartment) || !allowed[compartment] {
		return ErrCompartment
	}
	value, err := DecodeJSON(body)
	obj, ok := value.(map[string]any)
	if err != nil || !ok || len(obj) != 5 {
		return ErrCompartment
	}
	for key := range obj {
		switch key {
		case "namespace", "query", "resolution", "startTime", "endTime":
		default:
			return ErrCompartment
		}
	}
	if namespace, ok := obj["namespace"].(string); !ok || namespace != "oci_computeagent" {
		return ErrCompartment
	}
	query, ok := obj["query"].(string)
	if !ok || control(query) {
		return ErrCompartment
	}
	parts := computeMetricQuery.FindStringSubmatch(query)
	if parts == nil || !OCID(parts[3]) || bindings[parts[3]] != compartment {
		return ErrCompartment
	}
	if resolution, ok := obj["resolution"].(string); !ok || resolution != parts[2] {
		return ErrCompartment
	}
	start, startOK := obj["startTime"].(string)
	end, endOK := obj["endTime"].(string)
	startTime, startErr := time.Parse(time.RFC3339Nano, start)
	endTime, endErr := time.Parse(time.RFC3339Nano, end)
	if !startOK || !endOK || startErr != nil || endErr != nil || !endTime.After(startTime) {
		return ErrCompartment
	}
	return nil
}
