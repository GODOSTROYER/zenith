package oci

import (
	"errors"
	"net/url"
	"strings"
)

var ErrCompartment = errors.New("OCI compartment binding is absent or outside the local allowlist")

// BindCompartments checks all explicit compartment IDs and resource references.
// A resource OCID does NOT contain its compartment. ResourceBindings is trusted
// local configuration, never a query/body assertion supplied by the caller.
// Non-OCID resources use service:region:<encoded primary resource path> keys.
func BindCompartments(r Request, body []byte, allowed []string, bindings map[string]string, template string) error {
	permitted := map[string]bool{}
	for _, c := range allowed {
		permitted[c] = true
	}
	bound := false
	compartment := func(c string) error {
		if !permitted[c] {
			return ErrCompartment
		}
		bound = true
		return nil
	}
	resource := func(id string) error {
		if strings.HasPrefix(id, "ocid1.compartment.") || strings.HasPrefix(id, "ocid1.tenancy.") {
			return compartment(id)
		}
		c := bindings[id]
		if c == "" {
			return ErrCompartment
		}
		return compartment(c)
	}
	seenCompartment := false
	for _, pair := range r.Query {
		if strings.EqualFold(pair[0], "compartmentId") {
			if pair[0] != "compartmentId" || seenCompartment {
				return ErrCompartment
			}
			seenCompartment = true
			if err := compartment(pair[1]); err != nil {
				return err
			}
		} else if strings.HasPrefix(pair[1], "ocid1.") {
			if !OCID(pair[1]) {
				return ErrCompartment
			}
			if err := resource(pair[1]); err != nil {
				return err
			}
		}
		if pair[0] == "compartmentIdInSubtree" && pair[1] != "false" {
			return ErrCompartment
		}
	}
	// Monitoring takes its authoritative compartment selector in the URL, not
	// the JSON body. A body assertion must never authorize an unscoped query.
	if r.Service == "monitoring" {
		if !seenCompartment {
			return ErrCompartment
		}
		for _, pair := range r.Query {
			if strings.EqualFold(pair[0], "compartmentIdInSubtree") && (pair[0] != "compartmentIdInSubtree" || pair[1] != "false") {
				return ErrCompartment
			}
		}
		if bindMonitoring(r, body, permitted, bindings) != nil {
			return ErrCompartment
		}
	}
	if r.Service == "loggingsearch" {
		if bindLoggingSearch(r, body, permitted, bindings) != nil {
			return ErrCompartment
		}
		bound = true
	}
	// Checking decoded segments prevents percent-encoding an unbound OCID.
	pathParts, want := strings.Split(r.Path, "/"), strings.Split(template, "/")
	firstResource := -1
	for i, part := range pathParts {
		decoded, _ := url.PathUnescape(part)
		if strings.HasPrefix(decoded, "ocid1.") {
			if !OCID(decoded) {
				return ErrCompartment
			}
			if err := resource(decoded); err != nil {
				return err
			}
		}
		if i < len(want) && want[i] == "{}" && firstResource == -1 {
			firstResource = i
		}
	}
	if r.Service == "objectstorage" {
		switch len(pathParts) {
		case 2: // /n is tenancy namespace metadata, never object data.
			return nil
		case 4: // /n/{namespace}/b still requires an explicit compartment.
			if !seenCompartment {
				return ErrCompartment
			}
		default:
			if err := compartment(bindings[r.Service+":"+r.Region+":"+r.Path]); err != nil {
				return err
			}
		}
	} else if firstResource >= 0 {
		id, _ := url.PathUnescape(pathParts[firstResource])
		if !strings.HasPrefix(id, "ocid1.") {
			root := strings.Join(pathParts[:firstResource+1], "/")
			if err := compartment(bindings[r.Service+":"+r.Region+":"+root]); err != nil {
				return err
			}
		}
	}
	if len(body) > 0 {
		value, err := DecodeJSON(body)
		if err != nil {
			return ErrCompartment
		}
		var walk func(any) error
		walk = func(v any) error {
			switch x := v.(type) {
			case map[string]any:
				for key, value := range x {
					if strings.EqualFold(key, "compartmentId") {
						c, ok := value.(string)
						if !ok || key != "compartmentId" {
							return ErrCompartment
						}
						if err := compartment(c); err != nil {
							return err
						}
					} else if err := walk(value); err != nil {
						return err
					}
				}
			case []any:
				for _, value := range x {
					if err := walk(value); err != nil {
						return err
					}
				}
			case string:
				if strings.HasPrefix(x, "ocid1.") {
					if !OCID(x) {
						return ErrCompartment
					}
					return resource(x)
				}
			}
			return nil
		}
		if err := walk(value); err != nil {
			return err
		}
		if r.Method == "POST" && r.Service == "postgresql" {
			obj, ok := value.(map[string]any)
			if !ok {
				return ErrCompartment
			}
			id, ok := obj["dbSystemId"].(string)
			if !ok || !strings.HasPrefix(id, "ocid1.") || resource(id) != nil {
				return ErrCompartment
			}
		}
	}
	if !bound {
		return ErrCompartment
	}
	return nil
}
