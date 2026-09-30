package runner

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/awsauth"
	"github.com/GODOSTROYER/zenith/go/internal/netguard"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/runner/kinds"
)

// Deps are injectable collaborators; the zero value is production behavior.
type Deps struct {
	Now      func() time.Time
	Getenv   func(string) string
	Resolver netguard.Resolver // probes (tests inject a fake to simulate DNS rebinding)
	AWSCreds awsauth.Provider
	AWSHTTP  *http.Client
	// HeartbeatEvery overrides the configured heartbeat period (tests).
	HeartbeatEvery time.Duration
}

// Executor is the runner's agent.Processor: it verifies dispatched jobs and
// runs them through the enabled kinds.
type Executor struct {
	cfg      *Config
	verifier *protocol.Verifier
	self     protocol.Self
	kinds    map[string]kinds.Kind
	log      *slog.Logger
	now      func() time.Time
}

// NewExecutor builds the executor and every enabled kind. Configuration
// mistakes (a bad allowlist entry, a missing tofu binary) fail here, at
// startup, not at the first job.
func NewExecutor(cfg *Config, id *agent.Identity, keys *protocol.KeySet, replay protocol.ReplayCache, log *slog.Logger, deps Deps) (*Executor, error) {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	e := &Executor{
		cfg:      cfg,
		verifier: &protocol.Verifier{Keys: keys, Now: deps.Now, Replay: replay},
		self:     protocol.Self{ID: id.ID, WorkspaceID: id.WorkspaceID},
		kinds:    map[string]kinds.Kind{},
		log:      log,
		now:      deps.Now,
	}
	if k := cfg.Kinds.TofuRun; k != nil && k.IsOn() {
		t, err := kinds.NewTofu(*k, cfg.StateDir, kinds.TofuDeps{Getenv: deps.Getenv, Now: deps.Now})
		if err != nil {
			return nil, err
		}
		e.kinds[kinds.KindTofuRun] = t
	}
	if k := cfg.Kinds.AWSHTTP; k != nil && k.IsOn() {
		a, err := kinds.NewAWS(*k, kinds.AWSDeps{Creds: deps.AWSCreds, Client: deps.AWSHTTP, Now: deps.Now, Getenv: deps.Getenv})
		if err != nil {
			return nil, err
		}
		log.Info("aws.http enabled", "credentialSource", a.CredentialSource())
		e.kinds[kinds.KindAWSHTTP] = a
	}
	if k := cfg.Kinds.K8sHTTP; k != nil && k.IsOn() {
		s, err := kinds.NewK8s(*k, deps.Getenv)
		if err != nil {
			return nil, err
		}
		e.kinds[kinds.KindK8sHTTP] = s
	}
	if cfg.Kinds.ProbeHTTP.IsOn() || cfg.Kinds.ProbeTCP.IsOn() || cfg.Kinds.ProbeDNS.IsOn() {
		p, err := kinds.NewProbes(cfg.Probes, deps.Resolver)
		if err != nil {
			return nil, err
		}
		if cfg.Kinds.ProbeHTTP.IsOn() {
			e.kinds[kinds.KindProbeHTTP] = p.HTTP()
		}
		if cfg.Kinds.ProbeTCP.IsOn() {
			e.kinds[kinds.KindProbeTCP] = p.TCP()
		}
		if cfg.Kinds.ProbeDNS.IsOn() {
			e.kinds[kinds.KindProbeDNS] = p.DNS()
		}
	}
	if len(e.kinds) == 0 {
		return nil, errors.New("no job kind is enabled")
	}
	return e, nil
}

// Capabilities implements agent.Processor.
func (e *Executor) Capabilities() []string {
	out := make([]string, 0, len(e.kinds))
	for k := range e.kinds {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Verify implements agent.Processor.
func (e *Executor) Verify(_ context.Context, token string) (agent.Job, *agent.Rejection) {
	jti := protocol.UnverifiedJTI(token)
	vj, err := e.verifier.VerifyJob(token, e.self, func(env *protocol.JobEnvelope) error {
		if _, ok := e.kinds[env.Kind]; !ok {
			return protocol.Errorf(protocol.CodeKindDisabled, "kind %q is not enabled on this runner", clipKind(env.Kind))
		}
		return nil
	})
	if err != nil {
		code := protocol.CodeOf(err)
		rej := &agent.Rejection{ID: jti, Code: code, Message: protocol.MessageOf(err)}
		if code == protocol.CodeReplay {
			// The original delivery is running or already settled; a second
			// "rejected" result could win the control plane's first-writer race
			// against the real one.
			rej.ID = ""
		}
		return nil, rej
	}
	env := vj.Envelope

	timeout, maxOut, err := e.limits(&vj.Envelope, &vj.Grant)
	if err != nil {
		return nil, &agent.Rejection{ID: env.JTI, Code: protocol.CodeOf(err), Message: protocol.MessageOf(err)}
	}
	kind := e.kinds[env.Kind]
	run, err := kind.Prepare(&kinds.Request{
		JTI: env.JTI, OperationID: env.OperationID, WorkspaceID: env.WorkspaceID, Capability: env.Capability,
		Payload: env.Payload, Timeout: timeout, MaxOutputBytes: maxOut,
	})
	if err != nil {
		code := protocol.CodeOf(err)
		if code == protocol.CodeInternal {
			code = protocol.CodeInvalidPayload
		}
		return nil, &agent.Rejection{ID: env.JTI, Code: code, Message: protocol.MessageOf(err)}
	}
	return &job{id: env.JTI, kind: env.Kind, run: run, timeout: timeout, now: e.now}, nil
}

// limits clamps the requested timeout and output size to local limits and to
// the grant's enforceable constraints.
func (e *Executor) limits(env *protocol.JobEnvelope, g *protocol.GrantClaims) (time.Duration, int64, error) {
	l := e.cfg.Limits
	timeoutSec := env.TimeoutSec
	if timeoutSec <= 0 {
		timeoutSec = l.DefaultTimeoutSec
	}
	timeoutSec = min(timeoutSec, l.MaxTimeoutSec)
	maxOut := env.MaxOutputBytes
	if maxOut <= 0 {
		maxOut = l.DefaultOutputBytes
	}
	maxOut = min(maxOut, l.MaxOutputBytes)
	for k, v := range g.Constraints {
		switch k {
		case "maxTimeoutSec":
			if n, ok := v.(float64); ok && n >= 1 {
				timeoutSec = min(timeoutSec, int(n))
			} else {
				return 0, 0, protocol.Errorf(protocol.CodeConstraint, "constraint maxTimeoutSec must be a number >= 1")
			}
		case "maxOutputBytes":
			if n, ok := v.(float64); ok && n >= 1 {
				maxOut = min(maxOut, int64(n))
			} else {
				return 0, 0, protocol.Errorf(protocol.CodeConstraint, "constraint maxOutputBytes must be a number >= 1")
			}
		default:
			if e.cfg.RejectUnknownConstraints {
				return 0, 0, protocol.Errorf(protocol.CodeConstraint, "the grant carries constraint %q, which this runner cannot enforce", clipKind(k))
			}
		}
	}
	return time.Duration(timeoutSec) * time.Second, maxOut, nil
}

func clipKind(s string) string {
	if len(s) > 40 {
		return s[:40]
	}
	return s
}

type job struct {
	id      string
	kind    string
	run     kinds.Runnable
	timeout time.Duration
	now     func() time.Time
}

func (j *job) ID() string { return j.id }

// Run implements agent.Job.
func (j *job) Run(ctx context.Context, logs agent.LogSink) agent.ResultBody {
	started := j.now().UTC()
	rctx, cancel := context.WithTimeout(ctx, j.timeout)
	defer cancel()
	o := j.run(rctx, logs)
	if o.Status == "" {
		o.Status = agent.StatusFailed
		o.Error = "internal_error: the job kind returned no status"
	}
	if o.Status == agent.StatusFailed && errors.Is(rctx.Err(), context.DeadlineExceeded) {
		o.Status = agent.StatusTimedOut
		if o.Error == "" {
			o.Error = fmt.Sprintf("the job exceeded its %s timeout", j.timeout)
		}
	}
	return agent.ResultBody{
		Status:     o.Status,
		StartedAt:  started.Format(time.RFC3339Nano),
		FinishedAt: j.now().UTC().Format(time.RFC3339Nano),
		ExitCode:   o.ExitCode,
		Result:     o.Result,
		Error:      o.Error,
	}
}
