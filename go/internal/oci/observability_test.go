package oci

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestObserveReadQueries(t *testing.T) {
	for _, r := range []Request{
		{Service: "loggingsearch", Method: "POST", Path: "/20190909/search"},
		{Service: "monitoring", Method: "POST", Path: "/20180401/metrics/actions/summarizeMetricsData"},
	} {
		t.Run(r.Service, func(t *testing.T) {
			for _, capability := range []string{"infrastructure.observe", "incident.investigate", "logs.read", "metrics.read", "topology.read", "firewall.inspect", "service.restart", "database.snapshot", "secret.write", "infrastructure.apply", "unknown"} {
				want := capability == "infrastructure.observe" || capability == "incident.investigate" ||
					(capability == "logs.read" && r.Service == "loggingsearch") || (capability == "metrics.read" && r.Service == "monitoring")
				if template, ok := Match(capability, r.Service, r.Method, r.Path); ok != want || (ok && template != r.Path) {
					t.Fatal("read query capability split or audit template is incorrect")
				}
			}
			for _, method := range []string{"GET", "HEAD", "PUT", "DELETE"} {
				if _, ok := Match("infrastructure.observe", r.Service, method, r.Path); ok {
					t.Fatal("wrong query method allowed")
				}
			}
			for _, path := range []string{r.Path + "/extra", r.Path + "/", "/20000101/" + strings.SplitN(r.Path, "/", 3)[2]} {
				if _, ok := Match("infrastructure.observe", r.Service, r.Method, path); ok {
					t.Fatal("wrong query path allowed")
				}
			}
			want := "logging.us-ashburn-1.oci.oraclecloud.com"
			if r.Service == "monitoring" {
				want = "telemetry.us-ashburn-1.oraclecloud.com"
			}
			if host, err := ResolveHost(r.Service, "us-ashburn-1", ""); err != nil || host != want {
				t.Fatal("wrong read endpoint")
			}
			if _, err := ResolveHost(r.Service, "us-ashburn-1", "attacker.oraclecloud.com"); err == nil {
				t.Fatal("caller chose a read endpoint")
			}
		})
	}
}

func TestLoggingCompartmentScopes(t *testing.T) {
	compartment := "ocid1.compartment.oc1..fixture"
	foreign := "ocid1.compartment.oc1..foreign"
	group := "ocid1.loggroup.oc1.iad.fixture"
	log := "ocid1.log.oc1.iad.fixture"
	bindings := map[string]string{group: compartment, log: compartment}
	r := Request{Service: "loggingsearch", Region: "us-ashburn-1", Method: "POST", Path: "/20190909/search"}
	for _, scope := range []string{compartment, compartment + "/" + group, compartment + "/" + group + "/" + log} {
		for _, suffix := range []string{"", " | sort by datetime desc"} {
			t.Run("allowed/"+scope+suffix, func(t *testing.T) {
				body := []byte(`{"searchQuery":"search \"` + scope + `\"` + suffix + `","timeStart":"2026-10-01T00:00:00Z","timeEnd":"2026-10-01T00:01:00Z","isReturnFieldInfo":false}`)
				if err := BindCompartments(r, body, []string{compartment}, bindings, r.Path); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
	body := []byte(`{"searchQuery":"search \"` + compartment + `\""}`)
	r.Query = [][2]string{{"limit", "10"}, {"page", "synthetic-page"}}
	if err := BindCompartments(r, body, []string{compartment}, bindings, r.Path); err != nil {
		t.Fatal("search pagination refused")
	}
	r.Query = nil
	for name, body := range map[string]string{
		"foreign": `{"searchQuery":"search \"` + foreign + `\""}`,
		"missing": `{}`, "empty": `{"searchQuery":""}`, "not-string": `{"searchQuery":42}`,
		"wrong-case": `{"SearchQuery":"search \"` + compartment + `\""}`,
		"not-object": `[]`, "invalid-json": `{`,
		"duplicate":               `{"searchQuery":"search \"` + compartment + `\"","searchQuery":"search \"` + foreign + `\""}`,
		"unquoted":                `{"searchQuery":"search ` + compartment + `"}`,
		"escaped-scope":           `{"searchQuery":"search \"` + strings.ReplaceAll(compartment, ".", "%2e") + `\""}`,
		"wildcard":                `{"searchQuery":"search \"*\""}`,
		"tenancy":                 `{"searchQuery":"search \"ocid1.tenancy.oc1..fixture\""}`,
		"named-group":             `{"searchQuery":"search \"` + compartment + `/my-group\""}`,
		"too-many-segments":       `{"searchQuery":"search \"` + compartment + `/` + group + `/` + log + `/extra\""}`,
		"wrong-kind":              `{"searchQuery":"search \"` + compartment + `/` + log + `\""}`,
		"additional-scope":        `{"searchQuery":"search \"` + compartment + `\", \"` + foreign + `\""}`,
		"pipeline":                `{"searchQuery":"search \"` + compartment + `\" | where level = 'ERROR'"}`,
		"comment":                 `{"searchQuery":"/*ignored*/ search \"` + compartment + `\""}`,
		"control":                 `{"searchQuery":"search \"` + compartment + `\"\n"}`,
		"foreign-nested-selector": `{"searchQuery":"search \"` + compartment + `\"","nested":{"compartmentId":"` + foreign + `"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := BindCompartments(r, []byte(body), []string{compartment}, bindings, r.Path); err != ErrCompartment {
				t.Fatal("unsafe search scope accepted or error leaked external text")
			}
		})
	}
	for name, localBindings := range map[string]map[string]string{
		"unbound-group":             nil,
		"unbound-log":               {group: compartment},
		"foreign-group":             {group: foreign, log: compartment},
		"conflicting-allowed-group": {group: foreign, log: compartment},
		"foreign-log":               {group: compartment, log: foreign},
	} {
		for _, suffix := range []string{"", " | sort by datetime desc"} {
			t.Run(name+suffix, func(t *testing.T) {
				body := []byte(`{"searchQuery":"search \"` + compartment + `/` + group + `/` + log + `\"` + suffix + `"}`)
				allowed := []string{compartment}
				if name == "conflicting-allowed-group" {
					allowed = append(allowed, foreign)
				}
				if BindCompartments(r, body, allowed, localBindings, r.Path) != ErrCompartment {
					t.Fatal("log resource binding was ignored")
				}
			})
		}
	}
}

func TestLoggingFixedSuffix(t *testing.T) {
	compartment := "ocid1.compartment.oc1..fixture"
	foreign := "ocid1.compartment.oc1..foreign"
	group := "ocid1.loggroup.oc1.iad.fixture"
	r := Request{Service: "loggingsearch", Method: "POST", Path: "/20190909/search"}
	base := `search "` + compartment + `/` + group + `"`
	for name, query := range map[string]string{
		"extra-pipe":                base + " | sort by datetime desc | where level = 'ERROR'",
		"repeated-suffix":           base + " | sort by datetime desc | sort by datetime desc",
		"different-sort":            base + " | sort by datetime asc",
		"different-field":           base + " | sort by time desc",
		"trailing-text":             base + " | sort by datetime desc ignored",
		"trailing-space":            base + " | sort by datetime desc ",
		"double-space-before-pipe":  base + "  | sort by datetime desc",
		"double-space-after-pipe":   base + " |  sort by datetime desc",
		"double-space-before-by":    base + " | sort  by datetime desc",
		"double-space-before-field": base + " | sort by  datetime desc",
		"double-space-before-desc":  base + " | sort by datetime  desc",
		"double-space-after-search": strings.Replace(base, "search ", "search  ", 1) + " | sort by datetime desc",
		"leading-space":             " " + base + " | sort by datetime desc",
		"uppercase-sort":            base + " | SORT by datetime desc",
		"tab":                       base + "\t| sort by datetime desc",
		"newline":                   base + " | sort by datetime desc\n",
		"foreign-compartment":       `search "` + foreign + `/` + group + `" | sort by datetime desc`,
		"forged-compartment-body":   base + " | sort by datetime desc",
	} {
		t.Run(name, func(t *testing.T) {
			obj := map[string]any{"searchQuery": query}
			if name == "forged-compartment-body" {
				obj["compartmentId"] = foreign
			}
			body, err := json.Marshal(obj)
			if err != nil {
				t.Fatal(err)
			}
			if BindCompartments(r, body, []string{compartment}, map[string]string{group: compartment}, r.Path) != ErrCompartment {
				t.Fatal("unsafe suffix or compartment assertion accepted")
			}
		})
	}
}

func TestMonitoringRequiresURLCompartment(t *testing.T) {
	compartment := "ocid1.compartment.oc1..fixture"
	foreign := "ocid1.compartment.oc1..foreign"
	instance := "ocid1.instance.oc1.iad.fixture"
	bindings := map[string]string{instance: compartment}
	r := Request{Service: "monitoring", Region: "us-ashburn-1", Method: "POST", Path: "/20180401/metrics/actions/summarizeMetricsData"}
	body := []byte(`{"namespace":"oci_computeagent","query":"CpuUtilization[1m]{resourceId = \"` + instance + `\"}.mean()","resolution":"1m","startTime":"2026-10-01T00:00:00Z","endTime":"2026-10-01T00:01:00Z"}`)
	for _, subtree := range []bool{false, true} {
		r.Query = [][2]string{{"compartmentId", compartment}}
		if subtree {
			r.Query = append(r.Query, [2]string{"compartmentIdInSubtree", "false"})
		}
		if err := BindCompartments(r, body, []string{compartment}, bindings, r.Path); err != nil {
			t.Fatal("scoped monitoring query refused")
		}
	}
	for name, query := range map[string][][2]string{
		"missing": nil, "foreign": {{"compartmentId", foreign}},
		"duplicate":                  {{"compartmentId", compartment}, {"compartmentId", foreign}},
		"case-variant":               {{"CompartmentId", compartment}},
		"subtree":                    {{"compartmentId", compartment}, {"compartmentIdInSubtree", "true"}},
		"case-variant-subtree":       {{"compartmentId", compartment}, {"CompartmentIdInSubtree", "true"}},
		"case-variant-false-subtree": {{"compartmentId", compartment}, {"CompartmentIdInSubtree", "false"}},
		"duplicate-subtree":          {{"compartmentId", compartment}, {"compartmentIdInSubtree", "false"}, {"compartmentIdInSubtree", "false"}},
		"extra-selector":             {{"compartmentId", compartment}, {"resourceGroup", "another"}},
	} {
		t.Run(name, func(t *testing.T) {
			r.Query = query
			if BindCompartments(r, body, []string{compartment}, bindings, r.Path) != ErrCompartment {
				t.Fatal("invalid URL selector accepted")
			}
			assertedBody := []byte(`{"compartmentId":"` + compartment + `","namespace":"oci_computeagent","query":"CpuUtilization[1m].mean()"}`)
			if BindCompartments(r, assertedBody, []string{compartment}, bindings, r.Path) != ErrCompartment {
				t.Fatal("body compartment asserted ownership of an unscoped metrics query")
			}
		})
	}
}

func TestLoggingScopeCannotBeAssertedByQueryCompartment(t *testing.T) {
	allowed := "ocid1.compartment.oc1..fixture"
	foreign := "ocid1.compartment.oc1..foreign"
	r := Request{Service: "loggingsearch", Region: "us-ashburn-1", Method: "POST", Path: "/20190909/search", Query: [][2]string{{"compartmentId", allowed}}}
	body := []byte(`{"searchQuery":"search \"` + foreign + `\""}`)
	if BindCompartments(r, body, []string{allowed}, nil, r.Path) == nil {
		t.Fatal("query compartment asserted ownership of a foreign Logging Search scope")
	}
}
