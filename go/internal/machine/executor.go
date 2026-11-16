package machine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/netguard"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// Deps are injectable collaborators; the zero value is production behavior.
type Deps struct {
	Now        func() time.Time
	Resolver   netguard.Resolver
	Runner     ops.CmdRunner
	Docker     *ops.Docker
	ProcRoot   string
	OSRelease  string
	ConfigFile string
	Version    string
	// HeartbeatEvery overrides the configured heartbeat period (tests).
	HeartbeatEvery time.Duration
}

// Executor is zenithd's agent.Processor.
type Executor struct {
	cfg      *Config
	env      *ops.Env
	verifier *protocol.Verifier
	self     protocol.Self
	audit    *AuditLog
	log      *slog.Logger
	now      func() time.Time
	enabled  map[string]bool
}

// NewExecutor builds the executor. audit is required: zenithd never runs an
// operation it cannot record.
func NewExecutor(cfg *Config, id *agent.Identity, keys *protocol.KeySet, replay protocol.ReplayCache, audit *AuditLog, log *slog.Logger, deps Deps) (*Executor, error) {
	if audit == nil {
		return nil, errors.New("an audit log is required")
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Docker == nil && cfg.Containers.Enabled {
		deps.Docker = ops.NewDocker(cfg.Containers.Socket)
	}
	e := &Executor{
		cfg:      cfg,
		verifier: &protocol.Verifier{Keys: keys, Now: deps.Now, Replay: replay},
		self:     protocol.Self{ID: id.ID, WorkspaceID: id.WorkspaceID},
		audit:    audit,
		log:      log,
		now:      deps.Now,
		enabled:  map[string]bool{},
		env: &ops.Env{
			Cfg: cfg.Config, AuditFile: cfg.Audit.Path, StateDir: cfg.StateDir, ConfigFile: deps.ConfigFile, ProcRoot: deps.ProcRoot, OSRelease: deps.OSRelease,
			Now: deps.Now, Resolver: deps.Resolver, Runner: deps.Runner, Docker: deps.Docker, Version: deps.Version,
		},
	}
	for _, op := range ops.Supported(cfg.Config) {
		e.enabled[op] = true
	}
	return e, nil
}

// Capabilities implements agent.Processor: the operations enabled locally.
func (e *Executor) Capabilities() []string {
	out := ops.Supported(e.cfg.Config)
	if !e.packageAvailable(context.Background()) {
		for i, op := range out {
			if op == ops.OpPackageInstall {
				out = append(out[:i], out[i+1:]...)
				break
			}
		}
	}
	return out
}

// Verify implements agent.Processor.
func (e *Executor) Verify(_ context.Context, token string) (agent.Job, *agent.Rejection) {
	hintJTI := protocol.UnverifiedJTI(token)
	vm, err := e.verifier.VerifyMachine(token, e.self, func(env *protocol.MachineEnvelope) error {
		if ops.Unsupported[env.Operation] || !ops.Known(env.Operation) {
			return protocol.Errorf(protocol.CodeUnsupportedOp, "%s is not implemented by zenithd", clip(env.Operation, 40))
		}
		if !e.enabled[env.Operation] {
			return protocol.Errorf(protocol.CodeDisabledByConfig, "operation %q is not enabled on this machine", clip(env.Operation, 40))
		}
		return nil
	})
	if err != nil {
		code := protocol.CodeOf(err)
		e.auditReject(hintJTI, "", nil, code, protocol.MessageOf(err), false)
		rej := &agent.Rejection{ID: hintJTI, Code: code, Message: protocol.MessageOf(err)}
		if code == protocol.CodeReplay {
			rej.ID = "" // never race the original delivery's real result
		}
		return nil, rej
	}
	env := vm.Envelope

	if env.Operation == ops.OpFileWrite || env.Operation == ops.OpFileUpload || env.Operation == ops.OpServiceConfigure {
		if vm.Grant.Res == "" {
			e.auditReject(env.JTI, env.Operation, env.Args, protocol.CodeConstraint, env.Operation+" requires a resource scoped grant", true)
			return nil, &agent.Rejection{ID: env.JTI, Code: protocol.CodeConstraint, Message: env.Operation + " requires a resource scoped grant"}
		}
		var constraintErr error
		if env.Operation == ops.OpServiceConfigure {
			constraintErr = ops.ValidateServiceConfigureConstraints(env.Args, vm.Grant.Constraints)
		} else if env.Operation == ops.OpFileUpload {
			constraintErr = ops.ValidateFileUploadConstraints(env.Args, vm.Grant.Constraints)
		} else {
			constraintErr = ops.ValidateFileWriteConstraints(env.Args, vm.Grant.Constraints)
		}
		if err := constraintErr; err != nil {
			e.auditReject(env.JTI, env.Operation, env.Args, protocol.CodeOf(err), protocol.MessageOf(err), true)
			return nil, &agent.Rejection{ID: env.JTI, Code: protocol.CodeOf(err), Message: protocol.MessageOf(err)}
		}
	}
	timeout, maxOut, err := e.limits(&env, &vm.Grant)
	if err != nil {
		e.auditReject(env.JTI, env.Operation, env.Args, protocol.CodeOf(err), protocol.MessageOf(err), true)
		return nil, &agent.Rejection{ID: env.JTI, Code: protocol.CodeOf(err), Message: protocol.MessageOf(err)}
	}
	if (env.Operation == ops.OpFileWrite || env.Operation == ops.OpFileUpload || env.Operation == ops.OpServiceConfigure) && maxOut < 2048 {
		e.auditReject(env.JTI, env.Operation, env.Args, protocol.CodeConstraint, env.Operation+" requires a 2048-byte metadata result budget", true)
		return nil, &agent.Rejection{ID: env.JTI, Code: protocol.CodeConstraint, Message: env.Operation + " requires a 2048-byte metadata result budget"}
	}
	var run ops.Runnable
	if env.Operation == ops.OpPackageInstall {
		run, err = e.preparePackageInstallJob(token, vm, timeout, maxOut)
	} else {
		run, err = e.env.Prepare(env.Operation, &ops.Request{JTI: env.JTI, Args: env.Args, Timeout: timeout, MaxOutputBytes: maxOut})
	}
	if err != nil {
		code := protocol.CodeOf(err)
		if code == protocol.CodeInternal {
			code = protocol.CodeInvalidPayload
		}
		e.auditReject(env.JTI, env.Operation, env.Args, code, protocol.MessageOf(err), true)
		return nil, &agent.Rejection{ID: env.JTI, Code: code, Message: protocol.MessageOf(err)}
	}
	entry := AuditEntry{
		TS: e.now().UTC().Format(time.RFC3339Nano), Phase: "start", RequestID: env.JTI, Operation: env.Operation, Verified: true,
		GrantJTI: vm.Grant.JTI, OperationID: env.OperationID, Outcome: "started", ArgsSHA256: sha(env.Args), Target: auditTarget(env.Operation, env.Args),
	}
	if err := e.audit.Append(entry); err != nil {
		e.log.Error("audit log is not writable; refusing to run the operation", "err", err)
		return nil, &agent.Rejection{ID: env.JTI, Code: protocol.CodeInternal, Message: "audit_unavailable: the local audit log could not be written, so the operation was not run"}
	}
	return &job{e: e, id: env.JTI, op: env.Operation, grantJTI: vm.Grant.JTI, opID: env.OperationID, argsSHA: entry.ArgsSHA256, run: run, timeout: timeout}, nil
}

func (e *Executor) auditReject(jti, op string, args json.RawMessage, code, reason string, verified bool) {
	entry := AuditEntry{
		TS: e.now().UTC().Format(time.RFC3339Nano), Phase: "rejected", RequestID: jti, Operation: clip(op, 60), Verified: verified,
		Outcome: "rejected", Reason: redact.String(clip(code+": "+reason, 300)),
	}
	if len(args) > 0 {
		entry.ArgsSHA256 = sha(args)
		entry.Target = auditTarget(op, args)
	}
	if err := e.audit.Append(entry); err != nil {
		e.log.Error("could not write an audit entry for a rejected request", "err", err)
	}
}

// limits clamps the timeout and output size like the runner does.
func (e *Executor) limits(env *protocol.MachineEnvelope, g *protocol.GrantClaims) (time.Duration, int64, error) {
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
			n, ok := v.(float64)
			if !ok || n < 1 {
				return 0, 0, protocol.Errorf(protocol.CodeConstraint, "constraint maxTimeoutSec must be a number >= 1")
			}
			timeoutSec = min(timeoutSec, int(n))
		case "pathPrefixes":
			if env.Operation == ops.OpFileWrite || env.Operation == ops.OpFileUpload {
				continue
			}
			if e.cfg.RejectUnknownConstraints {
				return 0, 0, protocol.Errorf(protocol.CodeConstraint, "the grant carries constraint %q, which this machine cannot enforce", clip(k, 40))
			}
		case "maxOutputBytes":
			n, ok := v.(float64)
			if !ok || n < 1 {
				return 0, 0, protocol.Errorf(protocol.CodeConstraint, "constraint maxOutputBytes must be a number >= 1")
			}
			maxOut = min(maxOut, int64(n))
		default:
			if e.cfg.RejectUnknownConstraints {
				return 0, 0, protocol.Errorf(protocol.CodeConstraint, "the grant carries constraint %q, which this machine cannot enforce", clip(k, 40))
			}
		}
	}
	return time.Duration(timeoutSec) * time.Second, maxOut, nil
}

type job struct {
	e        *Executor
	id       string
	op       string
	grantJTI string
	opID     string
	argsSHA  string
	run      ops.Runnable
	timeout  time.Duration
}

func (j *job) ID() string { return j.id }

// Run implements agent.Job.
func (j *job) Run(ctx context.Context, _ agent.LogSink) agent.ResultBody {
	started := j.e.now().UTC()
	rctx, cancel := context.WithTimeout(ctx, j.timeout)
	defer cancel()
	res, err := j.run(rctx)

	body := agent.ResultBody{StartedAt: started.Format(time.RFC3339Nano)}
	switch {
	case j.op == ops.OpPackageInstall && (rctx.Err() != nil || ctx.Err() != nil):
		body.Status, body.Error = agent.StatusFailed, "package.install cancelled: effect unknown"
		uncertain := ops.PackageInstallFailure("unknown", "")
		if res.Data != nil {
			if ref, ok := res.Data["transactionRef"].(string); ok {
				uncertain.Data["transactionRef"] = ref
			}
		}
		body.Result = j.resultBody(uncertain)
	case err != nil && (errors.Is(rctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded)):
		body.Status, body.Error = agent.StatusTimedOut, fmt.Sprintf("the operation exceeded its %s timeout", j.timeout)
		body.Result = j.resultBody(ops.Failure("timeout", body.Error))
	case err != nil && ctx.Err() != nil:
		body.Status, body.Error = agent.StatusFailed, "the operation was cancelled because zenithd is stopping"
		body.Result = j.resultBody(ops.Failure("cancelled", body.Error))
	case err != nil:
		code := protocol.CodeOf(err)
		msg := redact.String(clip(err.Error(), 400))
		switch code {
		case protocol.CodeNotAllowed, protocol.CodeDisabledByConfig, protocol.CodeGuardDenied, protocol.CodeInvalidPayload:
			body.Status, body.Error = agent.StatusRejected, msg
		default:
			body.Status, body.Error = agent.StatusFailed, msg
		}
		body.Result = j.resultBody(ops.FailureFromError(err))
	case res.Err != "":
		body.Status, body.Error = agent.StatusFailed, redact.String(clip(res.Err, 400))
		body.Result = j.resultBody(res)
	default:
		body.Status = agent.StatusSucceeded
		if !res.OK {
			body.Status = agent.StatusFailed
		}
		body.Result = j.resultBody(res)
	}
	if res.Output != nil && res.Output.ExitCode != nil {
		body.ExitCode = res.Output.ExitCode
	}
	finished := j.e.now().UTC()
	body.FinishedAt = finished.Format(time.RFC3339Nano)

	raw, _ := json.Marshal(body.Result)
	entry := AuditEntry{
		TS: finished.Format(time.RFC3339Nano), Phase: "end", RequestID: j.id, Operation: j.op, Verified: true, GrantJTI: j.grantJTI, OperationID: j.opID,
		Outcome: body.Status, ArgsSHA256: j.argsSHA, DurationMs: finished.Sub(started).Milliseconds(),
	}
	if body.Result != nil {
		entry.OutputSHA, entry.OutputBytes = sha(raw), len(raw)
	}
	if body.Error != "" {
		entry.Reason = clip(body.Error, 200)
	}
	if (j.op == ops.OpFileWrite || j.op == ops.OpFileUpload || j.op == ops.OpPackageInstall || j.op == ops.OpServiceConfigure) && res.Data != nil {
		entry.Extra = map[string]string{}
		for _, key := range []string{"phase", "effect", "postcondition", "backupRef", "transactionRef"} {
			if value, ok := res.Data[key].(string); ok {
				entry.Extra[key] = value
			}
		}
	}
	if aerr := j.e.audit.Append(entry); aerr != nil {
		j.e.log.Error("could not write the audit entry for a finished operation", "request", j.id, "err", aerr)
		if (j.op == ops.OpFileWrite || j.op == ops.OpFileUpload || j.op == ops.OpPackageInstall || j.op == ops.OpServiceConfigure) && res.OK {
			// The files may be durably committed, but completion custody is incomplete.
			// Keep the private intent/backup receipt and forbid a success/replay claim.
			uncertain := map[string]any{"error": "mutation_uncertain", "phase": "audit", "effect": "unknown", "postcondition": "unverified"}
			for _, key := range []string{"backupRef", "transactionRef"} {
				if value, ok := res.Data[key].(string); ok {
					uncertain[key] = value
				}
			}
			body.Status = agent.StatusFailed
			body.Error = j.op + " audit: unknown"
			body.Result = j.resultBody(ops.Result{Data: uncertain})
		}
	}
	return body
}

func (j *job) resultBody(r ops.Result) map[string]any {
	if j.op == ops.OpExec || j.op == ops.OpContainerExec {
		if r.Data == nil {
			r.Data = map[string]any{}
		}
		if r.Output == nil {
			r.Output = &ops.Output{}
		}
		r.Data["exitCode"] = r.Output.ExitCode
	}
	m := map[string]any{"ok": r.OK, "operation": j.op, "data": r.Data}
	if r.Data == nil {
		m["data"] = map[string]any{}
	}
	if r.Output != nil {
		m["output"] = r.Output
	}
	return m
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// auditTarget summarizes what an operation is aimed at, from its raw args.
// File paths are recorded (never their contents); exec argv is recorded in
// full with credential values redacted for auditing an escape hatch.
var secretArgFlag = regexp.MustCompile(`(?i)^--?[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)[A-Za-z0-9_.-]*$`)

func auditTarget(op string, raw json.RawMessage) map[string]any {
	var a struct {
		Unit      string   `json:"unit"`
		Path      string   `json:"path"`
		Container string   `json:"container"`
		Host      string   `json:"host"`
		Port      int      `json:"port"`
		Name      string   `json:"name"`
		Argv      []string `json:"argv"`
	}
	if json.Unmarshal(raw, &a) != nil {
		return nil
	}
	t := map[string]any{}
	set := func(k, v string) {
		if v != "" {
			t[k] = redact.String(clip(v, 300))
		}
	}
	set("unit", a.Unit)
	set("path", a.Path)
	set("container", a.Container)
	set("host", a.Host)
	set("name", a.Name)
	if a.Port != 0 {
		t["port"] = a.Port
	}
	if (op == ops.OpExec || op == ops.OpContainerExec) && len(a.Argv) > 0 {
		argv := make([]string, 0, len(a.Argv))
		for i, s := range a.Argv {
			if i >= 64 {
				break
			}
			if i > 0 && secretArgFlag.MatchString(a.Argv[i-1]) {
				argv = append(argv, "[REDACTED]")
			} else {
				argv = append(argv, redact.String(clip(s, 512)))
			}
		}
		t["argv"] = argv
	}
	if len(t) == 0 {
		return nil
	}
	return t
}
