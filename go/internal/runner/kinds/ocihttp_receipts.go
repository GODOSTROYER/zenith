package kinds

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/oci"
)

// Receipts are runner-owned durable execution evidence, never tags or job assertions.
// The journal is append-only; this feature makes no retention/pruning decision.
type ociReceipt struct {
	Scope            string `json:"scope"`
	Region           string `json:"region"`
	Compartment      string `json:"compartment"`
	BodyDigest       string `json:"bodyDigest"`
	RetryTokenDigest string `json:"retryTokenDigest"`
	CreateJob        string `json:"createJob"`
	InstanceID       string `json:"instanceId,omitempty"`
	ContainerID      string `json:"containerId,omitempty"`
	ImageDigest      string `json:"imageDigest,omitempty"`
	CommandDigest    string `json:"commandDigest,omitempty"`
	ArgumentsDigest  string `json:"argumentsDigest,omitempty"`
	ExitCode         *int   `json:"exitCode,omitempty"`
	Cleanup          string `json:"cleanup,omitempty"`
	// Work-request ids are OCI-side receipts of accepted asynchronous work. They
	// are recorded from the provider's own response header, never from a caller,
	// and let a replacement runner that inherits this journal re-read progress
	// instead of re-executing. An absent id never implies the work did not run.
	CreateWorkRequest string `json:"createWorkRequest,omitempty"`
	DeleteWorkRequest string `json:"deleteWorkRequest,omitempty"`
}

const ociWorkRequestPrefix = "/20210415/workRequests/"

// ociWorkRequestID accepts only a syntactically valid OCID from the response
// header; anything else is treated as "no receipt id", never as a failure.
func ociWorkRequestID(header http.Header) string {
	value := strings.TrimSpace(header.Get("opc-work-request-id"))
	if !oci.OCID(value) {
		return ""
	}
	return value
}

func (k *OCI) bindWorkRequests(r ociReceipt) {
	for _, compartment := range k.cfg.AllowedCompartments {
		if r.Compartment != compartment {
			continue
		}
		for _, id := range []string{r.CreateWorkRequest, r.DeleteWorkRequest} {
			if id != "" {
				k.cfg.ResourceCompartments[id] = compartment
			}
		}
	}
}

func ociDigest(value []byte) string   { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
func ociValueDigest(value any) string { data, _ := json.Marshal(value); return ociDigest(data) }
func ociScope(workspace, operation, key string) string {
	return ociValueDigest([]string{workspace, operation, key})
}
func ociTypedID(value any, kind string) string {
	s, _ := value.(string)
	if !oci.OCID(s) || !strings.HasPrefix(s, "ocid1."+kind+".") {
		return ""
	}
	return s
}

var receiptDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (k *OCI) loadReceipts() error {
	if k.cfg.AuditPath == "" {
		return nil
	}
	f, err := os.Open(k.cfg.AuditPath + ".oci-receipts")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("oci.http receipt journal is unavailable")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("oci.http receipt journal permissions are invalid")
	}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var r ociReceipt
		data := scanner.Bytes()
		_, validJSON := oci.DecodeJSON(data)
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		err := dec.Decode(&r)
		if validJSON != nil {
			return errors.New("oci.http receipt journal is invalid")
		}
		if err != nil || !receiptDigest.MatchString(r.Scope) || r.CreateJob == "" || !oci.RegionID(r.Region) || !oci.OCID(r.Compartment) || !receiptDigest.MatchString(r.BodyDigest) || !receiptDigest.MatchString(r.RetryTokenDigest) || !receiptDigest.MatchString(r.ImageDigest) || !receiptDigest.MatchString(r.CommandDigest) || !receiptDigest.MatchString(r.ArgumentsDigest) || (r.Cleanup != "" && r.Cleanup != "pending" && r.Cleanup != "unknown" && r.Cleanup != "requested") ||
			(r.InstanceID != "" && (ociTypedID(r.InstanceID, "computecontainerinstance") == "" || ociTypedID(r.ContainerID, "computecontainer") == "")) ||
			(r.ExitCode != nil && (r.InstanceID == "" || *r.ExitCode < 0 || *r.ExitCode > 255)) ||
			(r.CreateWorkRequest != "" && (!oci.OCID(r.CreateWorkRequest) || r.InstanceID == "")) || (r.DeleteWorkRequest != "" && (!oci.OCID(r.DeleteWorkRequest) || r.ExitCode == nil)) {
			return errors.New("oci.http receipt journal is invalid")
		}
		if previous, exists := k.receipts[r.Scope]; exists && (previous.Region != r.Region || previous.Compartment != r.Compartment || previous.BodyDigest != r.BodyDigest || previous.RetryTokenDigest != r.RetryTokenDigest || previous.CreateJob != r.CreateJob || previous.ImageDigest != r.ImageDigest || previous.CommandDigest != r.CommandDigest || previous.ArgumentsDigest != r.ArgumentsDigest || (previous.InstanceID != "" && (previous.InstanceID != r.InstanceID || previous.ContainerID != r.ContainerID)) || (previous.ExitCode != nil && (r.ExitCode == nil || *previous.ExitCode != *r.ExitCode)) ||
			(previous.CreateWorkRequest != "" && previous.CreateWorkRequest != r.CreateWorkRequest) || (previous.DeleteWorkRequest != "" && previous.DeleteWorkRequest != r.DeleteWorkRequest)) {
			return errors.New("oci.http receipt journal conflicts")
		}
		for scope, previous := range k.receipts {
			if scope != r.Scope && r.InstanceID != "" && (previous.InstanceID == r.InstanceID || previous.ContainerID == r.ContainerID) {
				return errors.New("oci.http receipt journal reuses a resource")
			}
		}
		for _, compartment := range k.cfg.AllowedCompartments {
			if r.Compartment == compartment && r.InstanceID != "" {
				k.cfg.ResourceCompartments[r.InstanceID] = compartment
				k.cfg.ResourceCompartments[r.ContainerID] = compartment
			}
		}
		k.bindWorkRequests(r)
		k.receipts[r.Scope] = r
	}
	if scanner.Err() != nil {
		return errors.New("oci.http receipt journal is unreadable")
	}
	return nil
}

// Called with runtimeMu held. Persistence precedes publishing trusted state.
func (k *OCI) saveReceipt(r ociReceipt) (saveErr error) {
	defer func() {
		if saveErr != nil {
			k.receiptBroken = true
		}
	}()
	if k.cfg.AuditPath == "" {
		return errors.New("durable OCI receipt journal requires auditPath")
	}
	f, err := os.OpenFile(k.cfg.AuditPath+".oci-receipts", os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		f.Close()
		return errors.New("invalid receipt journal permissions")
	}
	err = json.NewEncoder(f).Encode(r)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	dir, err := os.Open(filepath.Dir(k.cfg.AuditPath))
	if err != nil {
		return err
	}
	err = dir.Sync()
	dir.Close()
	if err != nil {
		return err
	}
	k.receipts[r.Scope] = r
	return nil
}

func (k *OCI) receiptResponse(r ociReceipt, exists bool) Outcome {
	state := "absent"
	if exists {
		state = "unknown"
		if r.InstanceID != "" {
			state = "running"
		}
		if r.ExitCode != nil {
			state = "completed"
		}
	}
	value := map[string]any{"state": state}
	if r.InstanceID != "" {
		value["instanceId"] = r.InstanceID
	}
	if r.ExitCode != nil {
		value["exitCode"] = *r.ExitCode
		value["cleanup"] = r.Cleanup
	}
	if r.CreateWorkRequest != "" {
		value["createWorkRequest"] = r.CreateWorkRequest
	}
	if r.DeleteWorkRequest != "" {
		value["deleteWorkRequest"] = r.DeleteWorkRequest
	}
	data, _ := json.Marshal(value)
	return ociJSONOutcome(200, data)
}

func (k *OCI) migrationBefore(req *Request, pl oci.Request, body []byte) (*ociReceipt, *Outcome) {
	if pl.MigrationKey == "" {
		return nil, nil
	}
	if k.receiptBroken || k.cfg.AuditPath == "" {
		out := failed("oci_receipt_failed: durable journal unavailable")
		return nil, &out
	}
	scope := ociScope(req.WorkspaceID, req.OperationID, pl.MigrationKey)
	r, exists := k.receipts[scope]
	if exists && r.Region != pl.Region {
		out := failed("oci_migration_identity_unknown: region mismatch")
		return nil, &out
	}
	if pl.Method == "GET" && pl.Path == "/20210415/containerInstances" {
		if len(pl.Query) != 1 || pl.Query[0][0] != "compartmentId" || (exists && pl.Query[0][1] != r.Compartment) {
			out := failed("oci_migration_identity_unknown: compartment mismatch")
			return nil, &out
		}
		out := k.receiptResponse(r, exists)
		return nil, &out
	}
	if pl.Method == "POST" {
		if exists {
			out := failed("oci_migration_identity_unknown: execution already has a durable intent; query its receipt")
			return nil, &out
		}
		objValue, err := oci.DecodeJSON(body)
		obj, ok := objValue.(map[string]any)
		containers, _ := obj["containers"].([]any)
		if err != nil || !ok || obj["containerRestartPolicy"] != "NEVER" || len(containers) != 1 {
			out := failed("oci_migration_identity_unknown: unsupported launch")
			return nil, &out
		}
		c, ok := containers[0].(map[string]any)
		image, _ := c["imageUrl"].(string)
		command, commandOK := c["command"].([]any)
		arguments, argumentsOK := c["arguments"].([]any)
		compartment, _ := obj["compartmentId"].(string)
		if !ok || image == "" || !commandOK || len(command) == 0 || !argumentsOK || len(arguments) != 0 {
			out := failed("oci_migration_identity_unknown: unsupported container")
			return nil, &out
		}
		r = ociReceipt{Scope: scope, Region: pl.Region, Compartment: compartment, CreateJob: req.JTI, BodyDigest: ociDigest(body), RetryTokenDigest: ociValueDigest(pl.Headers), ImageDigest: ociValueDigest(image), CommandDigest: ociValueDigest(command), ArgumentsDigest: ociValueDigest(arguments)}
		if k.saveReceipt(r) != nil {
			out := failed("oci_receipt_failed: create intent could not be persisted")
			return nil, &out
		}
		return &r, nil
	}
	if !exists || r.InstanceID == "" || (pl.Method == "DELETE" && (r.ExitCode == nil || pl.Path != "/20210415/containerInstances/"+r.InstanceID)) ||
		(pl.Method == "GET" && pl.Path != "/20210415/containerInstances/"+r.InstanceID && pl.Path != "/20210415/containers/"+r.ContainerID &&
			(r.CreateWorkRequest == "" || pl.Path != ociWorkRequestPrefix+r.CreateWorkRequest) && (r.DeleteWorkRequest == "" || pl.Path != ociWorkRequestPrefix+r.DeleteWorkRequest)) {
		out := failed("oci_migration_identity_unknown: no owned creation receipt")
		return nil, &out
	}
	if pl.Method == "DELETE" && r.Cleanup == "requested" {
		out := ociJSONOutcome(204, nil)
		return nil, &out
	}
	if pl.Method == "DELETE" {
		r.Cleanup = "unknown"
		if k.saveReceipt(r) != nil {
			out := failed("oci_receipt_failed: cleanup intent could not be persisted")
			return nil, &out
		}
	}
	return &r, nil
}

func (k *OCI) migrationAfter(pl oci.Request, body, data []byte, header http.Header, status int, truncated bool, receipt *ociReceipt) error {
	if status < 200 || status >= 300 || truncated {
		return nil
	}
	if pl.Service != "containerinstances" {
		return nil
	}
	if pl.Method == "DELETE" && receipt != nil {
		receipt.Cleanup = "requested"
		if id := ociWorkRequestID(header); id != "" && receipt.DeleteWorkRequest == "" {
			receipt.DeleteWorkRequest = id
		}
		if err := k.saveReceipt(*receipt); err != nil {
			return err
		}
		k.bindWorkRequests(*receipt)
		return nil
	}
	value, err := oci.DecodeJSON(data)
	obj, ok := value.(map[string]any)
	if pl.Method == "POST" && pl.Path == "/20210415/containerInstances" {
		sourceValue, sourceErr := oci.DecodeJSON(body)
		source, sourceOK := sourceValue.(map[string]any)
		compartment, _ := source["compartmentId"].(string)
		refs, _ := obj["containers"].([]any)
		iid := ociTypedID(obj["id"], "computecontainerinstance")
		if err != nil || !ok || sourceErr != nil || !sourceOK || iid == "" || compartment == "" || obj["compartmentId"] != compartment || len(refs) != 1 || (receipt != nil && obj["containerRestartPolicy"] != "NEVER") {
			return errors.New("untrusted OCI create response")
		}
		ref, _ := refs[0].(map[string]any)
		cid := ociTypedID(ref["containerId"], "computecontainer")
		if cid == "" || k.cfg.ResourceCompartments[iid] != "" || k.cfg.ResourceCompartments[cid] != "" {
			return errors.New("ambiguous OCI create response")
		}
		if receipt != nil {
			receipt.InstanceID = iid
			receipt.ContainerID = cid
			receipt.CreateWorkRequest = ociWorkRequestID(header)
			if k.saveReceipt(*receipt) != nil {
				return errors.New("receipt persistence failed")
			}
			k.bindWorkRequests(*receipt)
		}
		k.cfg.ResourceCompartments[iid] = compartment
		k.cfg.ResourceCompartments[cid] = compartment
	}
	if receipt != nil && pl.Method == "GET" && pl.Path == "/20210415/containers/"+receipt.ContainerID {
		if err != nil || !ok || obj["id"] != receipt.ContainerID || obj["containerInstanceId"] != receipt.InstanceID || obj["compartmentId"] != receipt.Compartment || ociValueDigest(obj["imageUrl"]) != receipt.ImageDigest || ociValueDigest(obj["command"]) != receipt.CommandDigest || ociValueDigest(obj["arguments"]) != receipt.ArgumentsDigest {
			return errors.New("untrusted OCI container response")
		}
		if obj["lifecycleState"] == "INACTIVE" {
			number, ok := obj["exitCode"].(json.Number)
			exit, err := number.Int64()
			if !ok || err != nil || exit < 0 || exit > 255 {
				return errors.New("unknown OCI terminal exit")
			}
			if receipt.ExitCode != nil && *receipt.ExitCode != int(exit) {
				return errors.New("conflicting OCI terminal exit")
			}
			receipt.ExitCode = intPtr(int(exit))
			if receipt.Cleanup == "" {
				receipt.Cleanup = "pending"
			}
			return k.saveReceipt(*receipt)
		}
	}
	return nil
}
