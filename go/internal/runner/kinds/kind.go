// Package kinds implements the runner job kinds of
// docs/platform/RUNNER-PROTOCOL.md section 4: tofu.run, aws.http, k8s.http,
// probe.http, probe.tcp and probe.dns.
//
// Every kind splits work in two: Prepare validates the payload schema and the
// local allowlists synchronously (a failure is reported to the control plane
// as a `rejected` result and nothing has run), and the returned Runnable
// executes with a deadline and returns an Outcome.
package kinds

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// Kind names.
const (
	KindTofuRun   = "tofu.run"
	KindAWSHTTP   = "aws.http"
	KindK8sHTTP   = "k8s.http"
	KindProbeHTTP = "probe.http"
	KindProbeTCP  = "probe.tcp"
	KindProbeDNS  = "probe.dns"
)

// AllKinds lists every kind in a stable order.
var AllKinds = []string{KindTofuRun, KindAWSHTTP, KindK8sHTTP, KindProbeHTTP, KindProbeTCP, KindProbeDNS}

// Request is one verified job handed to a kind.
type Request struct {
	JTI         string
	OperationID string
	WorkspaceID string
	Capability  string
	Payload     json.RawMessage
	// Timeout and MaxOutputBytes are already clamped to the local limits and
	// to any grant constraints.
	Timeout        time.Duration
	MaxOutputBytes int64
}

// Outcome is what a kind reports; the executor adds timestamps.
type Outcome struct {
	Status   string // agent.StatusSucceeded | StatusFailed | StatusTimedOut
	ExitCode *int
	Result   any
	Error    string
}

// Runnable is a validated, ready-to-execute job.
type Runnable func(ctx context.Context, logs agent.LogSink) Outcome

// Kind is one job kind.
type Kind interface {
	Name() string
	// Prepare validates req. It returns a *protocol.Error to reject the job.
	Prepare(req *Request) (Runnable, error)
}

// decodeStrict decodes a payload rejecting unknown members and trailing data.
func decodeStrict(raw json.RawMessage, dst any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return protocol.Errorf(protocol.CodeInvalidPayload, "the job has no payload")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return protocol.Errorf(protocol.CodeInvalidPayload, "payload does not match the schema: %v", err)
	}
	if dec.More() {
		return protocol.Errorf(protocol.CodeInvalidPayload, "trailing data after the payload")
	}
	return nil
}

func invalid(format string, args ...any) error {
	return protocol.Errorf(protocol.CodeInvalidPayload, format, args...)
}

func notAllowed(format string, args ...any) error {
	return protocol.Errorf(protocol.CodeNotAllowed, format, args...)
}

func intPtr(n int) *int { return &n }

func failed(format string, args ...any) Outcome {
	return Outcome{Status: agent.StatusFailed, Error: fmt.Sprintf(format, args...)}
}

// ctxOutcome maps a finished context to an outcome, or reports false when
// the context is still live.
func ctxOutcome(ctx context.Context) (Outcome, bool) {
	switch ctx.Err() {
	case nil:
		return Outcome{}, false
	case context.DeadlineExceeded:
		return Outcome{Status: agent.StatusTimedOut, Error: "the job exceeded its timeout"}, true
	default:
		return Outcome{Status: agent.StatusFailed, Error: "the job was cancelled because the agent is stopping"}, true
	}
}
