package kinds

import "testing"

func TestReadOnlyPostExemptsOnlyTheTwoQueryEndpoints(t *testing.T) {
	cases := []struct {
		service, template string
		want              bool
	}{
		{"loggingsearch", "/20190909/search", true},
		{"monitoring", "/20180401/metrics/actions/summarizeMetricsData", true},
		{"monitoring", "/20180401/metrics", false},
		{"loggingsearch", "/20190909/search/extra", false},
		{"core", "/20160918/instances", false},
		{"vaults", "/20180608/secrets", false},
	}
	for _, c := range cases {
		if got := readOnlyPost(c.service, c.template); got != c.want {
			t.Errorf("readOnlyPost(%q, %q) = %v, want %v", c.service, c.template, got, c.want)
		}
	}
}
