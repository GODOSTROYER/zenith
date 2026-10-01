package oci

import "strings"

// bindLoggingSearch accepts one quoted OCID scope with optional log-group/log
// OCIDs and only the reader's fixed newest-first suffix. No whitespace is normalized.
// Scope is inside searchQuery, not compartmentId.
// More complex query language is deliberately refused rather than guessed at;
// this boundary is not a Logging Query Language interpreter. No live verification.
func bindLoggingSearch(r Request, body []byte, allowed map[string]bool, bindings map[string]string) error {
	for _, pair := range r.Query {
		if pair[0] != "limit" && pair[0] != "page" {
			return ErrCompartment
		}
	}
	value, err := DecodeJSON(body)
	obj, ok := value.(map[string]any)
	if err != nil || !ok {
		return ErrCompartment
	}
	query, ok := obj["searchQuery"].(string)
	if !ok || control(query) {
		return ErrCompartment
	}
	query = strings.TrimSuffix(query, " | sort by datetime desc")
	if !strings.HasPrefix(query, "search \"") {
		return ErrCompartment
	}
	scope := strings.TrimPrefix(query, "search ")
	if len(scope) < 2 || scope[0] != '"' || scope[len(scope)-1] != '"' {
		return ErrCompartment
	}
	parts := strings.Split(scope[1:len(scope)-1], "/")
	if len(parts) < 1 || len(parts) > 3 || !OCID(parts[0]) || !strings.HasPrefix(parts[0], "ocid1.compartment.") || !allowed[parts[0]] {
		return ErrCompartment
	}
	for i, id := range parts[1:] {
		kind := "ocid1.loggroup."
		if i == 1 {
			kind = "ocid1.log."
		}
		if !OCID(id) || !strings.HasPrefix(id, kind) || bindings[id] != parts[0] {
			return ErrCompartment
		}
	}
	return nil
}
