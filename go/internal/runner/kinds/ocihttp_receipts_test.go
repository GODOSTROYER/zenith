package kinds

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
)

const receiptInstance = "ocid1.computecontainerinstance.oc1.iad.created"
const receiptContainer = "ocid1.computecontainer.oc1.iad.created"
const receiptKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func receiptPayload(method, path string) map[string]any {
	p := map[string]any{"service": "containerinstances", "region": ociRegion, "method": method, "path": path, "query": [][2]string{}, "headers": map[string]string{}, "migrationKey": receiptKey}
	if method == "POST" {
		data, _ := json.Marshal(map[string]any{"compartmentId": ociCompartment, "containerRestartPolicy": "NEVER", "containers": []any{map[string]any{"imageUrl": "image@sha256:digest", "command": []string{"migrate"}, "arguments": []string{}}}})
		p["bodyB64"] = base64.StdEncoding.EncodeToString(data)
		p["headers"] = map[string]string{"opc-retry-token": "stable-retry"}
	}
	if method == "GET" && path == "/20210415/containerInstances" {
		p["query"] = [][2]string{{"compartmentId", ociCompartment}}
	}
	return p
}
func receiptJob(t *testing.T, p map[string]any) *Request {
	r := ociJob(t, "deployment.deploy", p)
	r.WorkspaceID = "workspace"
	r.OperationID = "operation"
	return r
}
func receiptRun(t *testing.T, k *OCI, p map[string]any) Outcome {
	t.Helper()
	run, err := k.Prepare(receiptJob(t, p))
	if err != nil {
		t.Fatal(err)
	}
	return run(context.Background(), nil)
}
func receiptWorld(t *testing.T) (*OCI, *int, *int, *map[string]any) {
	t.Helper()
	cfg := ociConfig()
	cfg.AuditPath = filepath.Join(t.TempDir(), "audit")
	deps := ociDeps(t)
	creates, deletes := 0, 0
	terminal := map[string]any{"id": receiptContainer, "containerInstanceId": receiptInstance, "compartmentId": ociCompartment, "imageUrl": "image@sha256:digest", "command": []string{"migrate"}, "arguments": []string{}, "lifecycleState": "INACTIVE", "exitCode": 0}
	deps.Client = &http.Client{Transport: ociTransportFunc(func(r *http.Request) (*http.Response, error) {
		var body any
		switch r.Method {
		case "POST":
			creates++
			body = map[string]any{"id": receiptInstance, "compartmentId": ociCompartment, "containerRestartPolicy": "NEVER", "containers": []any{map[string]any{"containerId": receiptContainer}}}
		case "DELETE":
			deletes++
			return &http.Response{StatusCode: 204, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
		default:
			if strings.Contains(r.URL.Path, "/containers/") {
				body = terminal
			} else {
				body = map[string]any{"id": receiptInstance, "compartmentId": ociCompartment}
			}
		}
		data, _ := json.Marshal(body)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}
	k, err := NewOCI(cfg, deps)
	if err != nil {
		t.Fatal(err)
	}
	return k, &creates, &deletes, &terminal
}
func receiptDecode(t *testing.T, out Outcome) map[string]any {
	t.Helper()
	data, _ := base64.StdEncoding.DecodeString(out.Result.(map[string]any)["bodyB64"].(string))
	var value map[string]any
	if json.Unmarshal(data, &value) != nil {
		t.Fatal("bad receipt")
	}
	return value
}

func TestOCICreatedMigrationBindingsAndReceiptCleanup(t *testing.T) {
	for _, exit := range []int{0, 7} {
		t.Run(string(rune('0'+exit)), func(t *testing.T) {
			k, creates, deletes, terminal := receiptWorld(t)
			(*terminal)["exitCode"] = exit
			if receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances")).Status != agent.StatusSucceeded {
				t.Fatal("creation failed")
			}
			for _, path := range []string{"/20210415/containerInstances/" + receiptInstance, "/20210415/containers/" + receiptContainer} {
				p := receiptPayload("GET", path)
				if receiptRun(t, k, p).Status != agent.StatusSucceeded {
					t.Fatal("created resource was not pollable")
				}
			}
			p := receiptPayload("DELETE", "/20210415/containerInstances/"+receiptInstance)
			for _, field := range []string{"workspace", "operation", "key", "resource", "capability", "missing-job"} {
				wrong := receiptJob(t, p)
				switch field {
				case "workspace":
					wrong.WorkspaceID = "other"
				case "operation":
					wrong.OperationID = "other"
				case "key":
					q := receiptPayload("DELETE", "/20210415/containerInstances/"+receiptInstance)
					q["migrationKey"] = strings.Repeat("b", 48)
					wrong = receiptJob(t, q)
				case "resource":
					wrong = receiptJob(t, receiptPayload("DELETE", "/20210415/containerInstances/"+ociResource))
				case "capability":
					wrong.Capability = "infrastructure.observe"
				case "missing-job":
					wrong.JTI = ""
				}
				if _, err := k.Prepare(wrong); err == nil {
					t.Fatalf("accepted foreign %s", field)
				}
			}
			run, err := k.Prepare(receiptJob(t, p))
			if err != nil {
				t.Fatal(err)
			}
			var wg sync.WaitGroup
			for range 12 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if run(context.Background(), nil).Status != agent.StatusSucceeded {
						t.Error("cleanup failed")
					}
				}()
			}
			wg.Wait()
			if *creates != 1 || *deletes != 1 {
				t.Fatalf("calls %d creates, %d deletes", *creates, *deletes)
			}
			restarted, err := NewOCI(k.cfg, k.deps)
			if err != nil {
				t.Fatal(err)
			}
			value := receiptDecode(t, receiptRun(t, restarted, receiptPayload("GET", "/20210415/containerInstances")))
			if value["state"] != "completed" || value["exitCode"] != float64(exit) || value["cleanup"] != "requested" {
				t.Fatalf("lost durable completion: %v", value)
			}
			if receiptRun(t, restarted, receiptPayload("POST", "/20210415/containerInstances")).Status != agent.StatusFailed || *creates != 1 {
				t.Fatal("re-launched completed migration")
			}
		})
	}
}
func TestOCIMigrationReceiptUnknownNeverRelaunches(t *testing.T) {
	k, creates, _, _ := receiptWorld(t)
	k.deps.Client.Transport = ociTransportFunc(func(*http.Request) (*http.Response, error) { *creates++; return nil, errors.New("lost response") })
	if receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances")).Status != agent.StatusFailed {
		t.Fatal("lost response succeeded")
	}
	value := receiptDecode(t, receiptRun(t, k, receiptPayload("GET", "/20210415/containerInstances")))
	if value["state"] != "unknown" {
		t.Fatal("fabricated execution")
	}
	if receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances")).Status != agent.StatusFailed || *creates != 1 {
		t.Fatal("re-launched unresolved intent")
	}
	restarted, err := NewOCI(k.cfg, k.deps)
	if err != nil {
		t.Fatal(err)
	}
	if receiptDecode(t, receiptRun(t, restarted, receiptPayload("GET", "/20210415/containerInstances")))["state"] != "unknown" {
		t.Fatal("restart lost unresolved intent")
	}
}
func TestOCIMigrationReceiptRejectsUntrustedResponses(t *testing.T) {
	for _, which := range []string{"foreign-compartment", "wrong-kind", "missing-container", "duplicate-id", "truncated"} {
		t.Run(which, func(t *testing.T) {
			k, _, _, _ := receiptWorld(t)
			obj := map[string]any{"id": receiptInstance, "compartmentId": ociCompartment, "containerRestartPolicy": "NEVER", "containers": []any{map[string]any{"containerId": receiptContainer}}}
			switch which {
			case "foreign-compartment":
				obj["compartmentId"] = "ocid1.compartment.oc1..foreign"
			case "wrong-kind":
				obj["id"] = ociResource
			case "missing-container":
				delete(obj, "containers")
			case "duplicate-id":
				k.cfg.ResourceCompartments[receiptInstance] = ociCompartment
			case "truncated":
				k.cfg.MaxResponseBytes = 10
			}
			k.deps.Client.Transport = ociTransportFunc(func(*http.Request) (*http.Response, error) {
				data, _ := json.Marshal(obj)
				return &http.Response{StatusCode: 202, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
			})
			out := receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances"))
			if which != "truncated" && out.Status != agent.StatusFailed {
				t.Fatal("untrusted create succeeded")
			}
			if k.receipts[ociScope("workspace", "operation", receiptKey)].InstanceID != "" {
				t.Fatal("untrusted response bound an ID")
			}
			if _, err := k.Prepare(receiptJob(t, receiptPayload("DELETE", "/20210415/containerInstances/"+receiptInstance))); err == nil {
				t.Fatal("untrusted response authorized DELETE")
			}
		})
	}
}
func TestOCIMigrationReceiptNoTerminalNoDelete(t *testing.T) {
	for _, which := range []string{"running", "bad-exit", "foreign-parent", "command", "image", "cleanup-failed"} {
		t.Run(which, func(t *testing.T) {
			k, _, deletes, terminal := receiptWorld(t)
			receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances"))
			switch which {
			case "running":
				(*terminal)["lifecycleState"] = "ACTIVE"
			case "bad-exit":
				(*terminal)["exitCode"] = 256
			case "foreign-parent":
				(*terminal)["containerInstanceId"] = ociResource
			case "command":
				(*terminal)["command"] = []string{"other"}
			case "image":
				(*terminal)["imageUrl"] = "other"
			}
			receiptRun(t, k, receiptPayload("GET", "/20210415/containers/"+receiptContainer))
			if which != "cleanup-failed" {
				if _, err := k.Prepare(receiptJob(t, receiptPayload("DELETE", "/20210415/containerInstances/"+receiptInstance))); err == nil {
					t.Fatal("unproven terminal authorized delete")
				}
				return
			}
			k.deps.Client.Transport = ociTransportFunc(func(*http.Request) (*http.Response, error) { *deletes++; return nil, errors.New("failed cleanup") })
			receiptRun(t, k, receiptPayload("DELETE", "/20210415/containerInstances/"+receiptInstance))
			value := receiptDecode(t, receiptRun(t, k, receiptPayload("GET", "/20210415/containerInstances")))
			if value["state"] != "completed" || value["cleanup"] != "unknown" {
				t.Fatalf("lost outcome %v", value)
			}
		})
	}
}

func TestOCIMigrationReceiptPreparedIdentityAndExecutionRecheck(t *testing.T) {
	k, _, deletes, _ := receiptWorld(t)
	receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances"))
	receiptRun(t, k, receiptPayload("GET", "/20210415/containers/"+receiptContainer))
	job := receiptJob(t, receiptPayload("DELETE", "/20210415/containerInstances/"+receiptInstance))
	run, err := k.Prepare(job)
	if err != nil {
		t.Fatal(err)
	}
	job.WorkspaceID = "foreign"
	job.OperationID = "foreign"
	job.JTI = "foreign"
	if run(context.Background(), nil).Status != agent.StatusSucceeded || *deletes != 1 {
		t.Fatal("mutable caller changed signed identity snapshot")
	}
	k2, _, deletes2, _ := receiptWorld(t)
	receiptRun(t, k2, receiptPayload("POST", "/20210415/containerInstances"))
	receiptRun(t, k2, receiptPayload("GET", "/20210415/containers/"+receiptContainer))
	run, err = k2.Prepare(receiptJob(t, receiptPayload("DELETE", "/20210415/containerInstances/"+receiptInstance)))
	if err != nil {
		t.Fatal(err)
	}
	delete(k2.receipts, ociScope("workspace", "operation", receiptKey))
	if run(context.Background(), nil).Status != agent.StatusFailed || *deletes2 != 0 {
		t.Fatal("prepared cleanup skipped execution ownership check")
	}
}

func TestOCIMigrationReceiptTimeoutKeepsUnknownIntent(t *testing.T) {
	k, creates, deletes, _ := receiptWorld(t)
	k.deps.Client.Transport = ociTransportFunc(func(r *http.Request) (*http.Response, error) {
		*creates++
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	run, err := k.Prepare(receiptJob(t, receiptPayload("POST", "/20210415/containerInstances")))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if run(ctx, nil).Status != agent.StatusTimedOut {
		t.Fatal("timed out creation succeeded")
	}
	if receiptDecode(t, receiptRun(t, k, receiptPayload("GET", "/20210415/containerInstances")))["state"] != "unknown" {
		t.Fatal("timed out create intent was lost")
	}
	if *deletes != 0 || *creates > 1 {
		t.Fatal("unknown intent changed remote execution")
	}
}

func TestOCIMigrationReceiptCancelledWaitCannotMutate(t *testing.T) {
	k, creates, _, _ := receiptWorld(t)
	run, err := k.Prepare(receiptJob(t, receiptPayload("POST", "/20210415/containerInstances")))
	if err != nil {
		t.Fatal(err)
	}
	k.runtimeMu.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Outcome, 1)
	go func() { done <- run(ctx, nil) }()
	cancel()
	k.runtimeMu.Unlock()
	if (<-done).Status == agent.StatusSucceeded || *creates != 0 || len(k.receipts) != 0 {
		t.Fatal("cancelled lock waiter mutated receipt or sent request")
	}
}

func TestOCIMigrationReceiptJournalFailsClosed(t *testing.T) {
	for _, which := range []string{"truncated", "duplicate-key", "unsafe-mode", "conflict", "persist-failed"} {
		t.Run(which, func(t *testing.T) {
			k, creates, _, _ := receiptWorld(t)
			if which == "persist-failed" {
				k.cfg.AuditPath = filepath.Join(t.TempDir(), "absent", "audit")
				if receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances")).Status != agent.StatusFailed || *creates != 0 {
					t.Fatal("unpersisted intent sent POST")
				}
				return
			}
			receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances"))
			path := k.cfg.AuditPath + ".oci-receipts"
			switch which {
			case "truncated":
				if err := os.WriteFile(path, []byte(`{"scope":`), 0600); err != nil {
					t.Fatal(err)
				}
			case "duplicate-key":
				if err := os.WriteFile(path, []byte(`{"scope":"first","scope":"second"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "unsafe-mode":
				if err := os.Chmod(path, 0644); err != nil {
					t.Fatal(err)
				}
			case "conflict":
				r := k.receipts[ociScope("workspace", "operation", receiptKey)]
				r.BodyDigest = strings.Repeat("b", 64)
				if k.saveReceipt(r) != nil {
					t.Fatal("fixture journal write failed")
				}
			}
			if _, err := NewOCI(k.cfg, k.deps); err == nil {
				t.Fatal("invalid journal was trusted")
			}
		})
	}
}

const receiptCreateWR = "ocid1.containerinstanceworkrequest.oc1.iad.createwr1"
const receiptDeleteWR = "ocid1.containerinstanceworkrequest.oc1.iad.deletewr1"

// receiptWorkRequestWorld answers like receiptWorld but also returns OCI's
// opc-work-request-id header on create and delete, and serves work-request reads.
func receiptWorkRequestWorld(t *testing.T) (*OCI, *int, *int) {
	t.Helper()
	k, creates, deletes, _ := receiptWorld(t)
	inner := k.deps.Client.Transport
	k.deps.Client.Transport = ociTransportFunc(func(r *http.Request) (*http.Response, error) {
		response, err := inner.RoundTrip(r)
		if err != nil || response == nil {
			return response, err
		}
		switch {
		case r.Method == "POST":
			response.Header.Set("opc-work-request-id", receiptCreateWR)
		case r.Method == "DELETE":
			response.Header.Set("opc-work-request-id", receiptDeleteWR)
		case strings.Contains(r.URL.Path, "/workRequests/"):
			data, _ := json.Marshal(map[string]any{"id": strings.TrimPrefix(r.URL.Path, ociWorkRequestPrefix), "status": "SUCCEEDED"})
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
		}
		return response, nil
	})
	return k, creates, deletes
}

func TestOCIMigrationReceiptRecordsWorkRequestIDsAndAnswersOnlyOwnedReads(t *testing.T) {
	k, creates, _ := receiptWorkRequestWorld(t)
	if receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances")).Status != agent.StatusSucceeded {
		t.Fatal("creation failed")
	}
	value := receiptDecode(t, receiptRun(t, k, receiptPayload("GET", "/20210415/containerInstances")))
	if value["state"] != "running" || value["createWorkRequest"] != receiptCreateWR {
		t.Fatalf("work request receipt not exposed: %v", value)
	}
	if receiptRun(t, k, receiptPayload("GET", ociWorkRequestPrefix+receiptCreateWR)).Status != agent.StatusSucceeded {
		t.Fatal("owned work request was not readable")
	}
	for _, foreign := range []string{"ocid1.containerinstanceworkrequest.oc1.iad.foreign1", receiptDeleteWR} {
		if _, err := k.Prepare(receiptJob(t, receiptPayload("GET", ociWorkRequestPrefix+foreign))); err == nil {
			if run, _ := k.Prepare(receiptJob(t, receiptPayload("GET", ociWorkRequestPrefix+foreign))); run != nil && run(context.Background(), nil).Status == agent.StatusSucceeded {
				t.Fatalf("read a work request this execution does not own: %s", foreign)
			}
		}
	}
	if *creates != 1 {
		t.Fatal("work request reads re-executed the launch")
	}
}

func TestOCIMigrationReceiptDeleteWorkRequestIsRecorded(t *testing.T) {
	k, _, deletes := receiptWorkRequestWorld(t)
	receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances"))
	receiptRun(t, k, receiptPayload("GET", "/20210415/containers/"+receiptContainer))
	if receiptRun(t, k, receiptPayload("DELETE", "/20210415/containerInstances/"+receiptInstance)).Status != agent.StatusSucceeded || *deletes != 1 {
		t.Fatal("cleanup failed")
	}
	value := receiptDecode(t, receiptRun(t, k, receiptPayload("GET", "/20210415/containerInstances")))
	if value["cleanup"] != "requested" || value["deleteWorkRequest"] != receiptDeleteWR || value["createWorkRequest"] != receiptCreateWR {
		t.Fatalf("delete work request not recorded: %v", value)
	}
	if receiptRun(t, k, receiptPayload("GET", ociWorkRequestPrefix+receiptDeleteWR)).Status != agent.StatusSucceeded {
		t.Fatal("delete work request was not readable")
	}
}

// A replacement runner process inheriting the durable journal (new process, new
// local bindings) resumes reading the predecessor's in-flight work request and
// can neither re-launch nor read a request it has no receipt for.
func TestOCIReplacementRunnerResumesWorkRequestReadsWithoutReexecution(t *testing.T) {
	k, creates, _ := receiptWorkRequestWorld(t)
	receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances"))
	cfg := ociConfig()
	cfg.AuditPath = k.cfg.AuditPath
	replacement, err := NewOCI(cfg, k.deps)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ResourceCompartments[receiptCreateWR] != "" {
		t.Fatal("fixture leaked a predecessor binding")
	}
	value := receiptDecode(t, receiptRun(t, replacement, receiptPayload("GET", "/20210415/containerInstances")))
	if value["state"] != "running" || value["createWorkRequest"] != receiptCreateWR || value["instanceId"] != receiptInstance {
		t.Fatalf("replacement lost the receipt: %v", value)
	}
	if receiptRun(t, replacement, receiptPayload("GET", ociWorkRequestPrefix+receiptCreateWR)).Status != agent.StatusSucceeded {
		t.Fatal("replacement could not resume reading the in-flight work request")
	}
	if receiptRun(t, replacement, receiptPayload("POST", "/20210415/containerInstances")).Status != agent.StatusFailed || *creates != 1 {
		t.Fatal("replacement re-executed the launch")
	}
	// A runner without the journal has no receipt and no binding: it cannot read the id.
	blank, err := NewOCI(func() OCIConfig { c := ociConfig(); c.AuditPath = filepath.Join(t.TempDir(), "audit"); return c }(), k.deps)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := blank.Prepare(receiptJob(t, receiptPayload("GET", ociWorkRequestPrefix+receiptCreateWR))); err == nil {
		t.Fatal("a runner without the journal could read an unowned work request")
	}
}

func TestOCIMigrationReceiptWorkRequestJournalValidation(t *testing.T) {
	k, _, _ := receiptWorkRequestWorld(t)
	receiptRun(t, k, receiptPayload("POST", "/20210415/containerInstances"))
	r := k.receipts[ociScope("workspace", "operation", receiptKey)]
	r.CreateWorkRequest = "ocid1.containerinstanceworkrequest.oc1.iad.changed1"
	if k.saveReceipt(r) != nil {
		t.Fatal("fixture journal write failed")
	}
	if _, err := NewOCI(k.cfg, k.deps); err == nil {
		t.Fatal("a changed work request id was trusted")
	}
}
