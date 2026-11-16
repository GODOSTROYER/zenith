package protocol

import (
	"encoding/json"
	"fmt"
	"time"
)

// JobEnvelope is the signed payload of a runner job (`zenith-job+jwt`).
// Unknown members are tolerated here (the envelope as a whole is signed);
// the kind-specific `payload` is decoded strictly by each job kind.
type JobEnvelope struct {
	Protocol       string          `json:"protocol"`
	JTI            string          `json:"jti"`
	RunnerID       string          `json:"runnerId"`
	WorkspaceID    string          `json:"workspaceId"`
	OperationID    string          `json:"operationId"`
	Capability     string          `json:"capability"`
	Kind           string          `json:"kind"`
	Payload        json.RawMessage `json:"payload"`
	Grant          string          `json:"grant"`
	IAT            int64           `json:"iat"`
	EXP            int64           `json:"exp"`
	TimeoutSec     int             `json:"timeoutSec"`
	MaxOutputBytes int64           `json:"maxOutputBytes"`
}

// MachineEnvelope is the signed payload of a zenithd request
// (`zenith-machine+jwt`).
type MachineEnvelope struct {
	Protocol       string          `json:"protocol"`
	JTI            string          `json:"jti"`
	MachineID      string          `json:"machineId"`
	WorkspaceID    string          `json:"workspaceId"`
	OperationID    string          `json:"operationId"`
	Operation      string          `json:"operation"`
	Args           json.RawMessage `json:"args"`
	Grant          string          `json:"grant"`
	IAT            int64           `json:"iat"`
	EXP            int64           `json:"exp"`
	TimeoutSec     int             `json:"timeoutSec"`
	MaxOutputBytes int64           `json:"maxOutputBytes"`
}

// GrantClaims mirrors CapabilityGrantClaims in src/lib/controlplane/types.ts.
type GrantClaims struct {
	JTI         string         `json:"jti"`
	ISS         string         `json:"iss"`
	AUD         string         `json:"aud"`
	SUB         string         `json:"sub"`
	IAT         int64          `json:"iat"`
	EXP         int64          `json:"exp"`
	CAP         string         `json:"cap"`
	OP          string         `json:"op"`
	Digest      string         `json:"digest"`
	WS          string         `json:"ws"`
	Proj        string         `json:"proj,omitempty"`
	Env         string         `json:"env,omitempty"`
	Res         string         `json:"res,omitempty"`
	Fence       *int64         `json:"fence,omitempty"`
	Constraints map[string]any `json:"constraints,omitempty"`
}

// GrantExpect is what a verifier requires of a grant.
type GrantExpect struct {
	Audience    string // "runner:<id>" or "machine:<id>"
	Capability  string
	Operation   string // operation id the envelope names
	WorkspaceID string
}

// VerifyGrant verifies an embedded capability grant: pinned-key signature,
// typ, exp/iat with skew, aud, cap, op and workspace.
func VerifyGrant(token string, keys *KeySet, want GrantExpect, now time.Time) (*GrantClaims, error) {
	if token == "" {
		return nil, Errorf(CodeGrantInvalid, "the job carries no capability grant")
	}
	_, payload, err := VerifyCompact(token, keys, TypGrant)
	if err != nil {
		return nil, Errorf(CodeGrantInvalid, "grant: %s", err.Error())
	}
	var g GrantClaims
	if err := json.Unmarshal(payload, &g); err != nil {
		return nil, Errorf(CodeGrantInvalid, "grant claims are not valid JSON")
	}
	if g.JTI == "" || g.CAP == "" || g.OP == "" || g.AUD == "" || g.WS == "" {
		return nil, Errorf(CodeGrantInvalid, "grant is missing required claims")
	}
	if err := checkTimes(g.IAT, g.EXP, now); err != nil {
		return nil, Errorf(CodeGrantInvalid, "grant: %s", err.Error())
	}
	if g.AUD != want.Audience {
		return nil, Errorf(CodeGrantAudience, "grant audience is not this agent")
	}
	if g.CAP != want.Capability {
		return nil, Errorf(CodeGrantCapability, "grant capability %q does not match %q", g.CAP, want.Capability)
	}
	if g.OP != want.Operation {
		return nil, Errorf(CodeGrantOperation, "grant operation does not match the job's operation")
	}
	if want.WorkspaceID != "" && g.WS != want.WorkspaceID {
		return nil, Errorf(CodeGrantWorkspace, "grant workspace does not match this agent's workspace")
	}
	return &g, nil
}

// checkTimes applies the +/-60 s skew to an iat/exp pair.
func checkTimes(iat, exp int64, now time.Time) error {
	if iat <= 0 || exp <= 0 || exp < iat {
		return &Error{Code: CodeInvalidClaims, Msg: "iat/exp are missing or inconsistent"}
	}
	n := now.Unix()
	skew := int64(Skew / time.Second)
	if iat > n+skew {
		return &Error{Code: CodeNotYetValid, Msg: "issued in the future beyond the allowed skew"}
	}
	if n > exp+skew {
		return &Error{Code: CodeExpired, Msg: "expired"}
	}
	return nil
}

// VerifiedJob is a runner job that passed every protocol check.
type VerifiedJob struct {
	Envelope JobEnvelope
	Grant    GrantClaims
}

// VerifiedMachine is a zenithd request that passed every protocol check.
type VerifiedMachine struct {
	Envelope MachineEnvelope
	Grant    GrantClaims
}

// Self identifies the verifying agent.
type Self struct {
	ID          string
	WorkspaceID string
}

// Verifier bundles the pinned keys, the clock and the replay cache.
type Verifier struct {
	Keys   *KeySet
	Now    func() time.Time
	Replay ReplayCache
}

func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

// VerifyJob runs the runner verification sequence from spec section 4:
// signature, typ, runnerId, iat/exp, jti replay, precheck (kind enabled in
// local config), then the embedded grant. The payload schema and
// kind-specific allowlists are checked by the kind afterwards.
func (v *Verifier) VerifyJob(token string, self Self, precheck func(*JobEnvelope) error) (*VerifiedJob, error) {
	_, payload, err := VerifyCompact(token, v.Keys, TypJob)
	if err != nil {
		return nil, err
	}
	var env JobEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil, Errorf(CodeMalformed, "job payload is not valid JSON")
	}
	if env.Protocol != RunnerProtocol {
		return nil, Errorf(CodeBadProtocol, "protocol must be %s", RunnerProtocol)
	}
	if !ValidID(env.JTI) {
		return nil, Errorf(CodeInvalidClaims, "jti is missing or malformed")
	}
	if env.RunnerID != self.ID {
		return nil, Errorf(CodeWrongTarget, "job is addressed to a different runner")
	}
	if self.WorkspaceID != "" && env.WorkspaceID != self.WorkspaceID {
		return nil, Errorf(CodeWrongTarget, "job belongs to a different workspace")
	}
	if env.OperationID == "" || env.Capability == "" || env.Kind == "" {
		return nil, Errorf(CodeInvalidClaims, "operationId, capability and kind are required")
	}
	if env.TimeoutSec < 0 || env.MaxOutputBytes < 0 {
		return nil, Errorf(CodeInvalidClaims, "timeoutSec and maxOutputBytes must not be negative")
	}
	now := v.now()
	if err := checkTimes(env.IAT, env.EXP, now); err != nil {
		return nil, err
	}
	if err := v.markSeen("job:"+env.JTI, env.EXP, now); err != nil {
		return nil, err
	}
	if precheck != nil {
		if err := precheck(&env); err != nil {
			return nil, err
		}
	}
	grant, err := VerifyGrant(env.Grant, v.Keys, GrantExpect{
		Audience:    "runner:" + self.ID,
		Capability:  env.Capability,
		Operation:   env.OperationID,
		WorkspaceID: env.WorkspaceID,
	}, now)
	if err != nil {
		return nil, err
	}
	return &VerifiedJob{Envelope: env, Grant: *grant}, nil
}

// VerifyMachine runs the equivalent sequence for a zenithd request. The grant
// capability must equal the operation name (the machine operation names are
// themselves catalog capabilities).
func (v *Verifier) VerifyMachine(token string, self Self, precheck func(*MachineEnvelope) error) (*VerifiedMachine, error) {
	_, payload, err := VerifyCompact(token, v.Keys, TypMachine)
	if err != nil {
		return nil, err
	}
	var env MachineEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil, Errorf(CodeMalformed, "request payload is not valid JSON")
	}
	if env.Protocol != MachineProtocol {
		return nil, Errorf(CodeBadProtocol, "protocol must be %s", MachineProtocol)
	}
	if !ValidID(env.JTI) {
		return nil, Errorf(CodeInvalidClaims, "jti is missing or malformed")
	}
	if env.MachineID != self.ID {
		return nil, Errorf(CodeWrongTarget, "request is addressed to a different machine")
	}
	if self.WorkspaceID != "" && env.WorkspaceID != self.WorkspaceID {
		return nil, Errorf(CodeWrongTarget, "request belongs to a different workspace")
	}
	if env.OperationID == "" || env.Operation == "" {
		return nil, Errorf(CodeInvalidClaims, "operationId and operation are required")
	}
	if env.TimeoutSec < 0 || env.MaxOutputBytes < 0 {
		return nil, Errorf(CodeInvalidClaims, "timeoutSec and maxOutputBytes must not be negative")
	}
	now := v.now()
	if err := checkTimes(env.IAT, env.EXP, now); err != nil {
		return nil, err
	}
	if err := v.markSeen("mreq:"+env.JTI, env.EXP, now); err != nil {
		return nil, err
	}
	if precheck != nil {
		if err := precheck(&env); err != nil {
			return nil, err
		}
	}
	grant, err := VerifyGrant(env.Grant, v.Keys, GrantExpect{
		Audience:    "machine:" + self.ID,
		Capability:  env.Operation,
		Operation:   env.OperationID,
		WorkspaceID: env.WorkspaceID,
	}, now)
	if err != nil {
		return nil, err
	}
	return &VerifiedMachine{Envelope: env, Grant: *grant}, nil
}

// markSeen records the id in the replay cache, failing closed if the cache
// cannot persist it. Retention is at least 24 h past the later of now and exp.
func (v *Verifier) markSeen(key string, exp int64, now time.Time) error {
	if v.Replay == nil {
		return Errorf(CodeReplayUnavailable, "no replay cache configured")
	}
	until := now
	if e := time.Unix(exp, 0); e.After(until) {
		until = e
	}
	until = until.Add(ReplayRetention)
	fresh, err := v.Replay.MarkSeen(key, until)
	if err != nil {
		return Errorf(CodeReplayUnavailable, "replay cache: %v", err)
	}
	if !fresh {
		return Errorf(CodeReplay, "this id was already accepted")
	}
	return nil
}

// String implements fmt.Stringer without leaking the grant or payload.
func (e JobEnvelope) String() string {
	return fmt.Sprintf("job{%s kind=%s cap=%s op=%s}", e.JTI, e.Kind, e.Capability, e.OperationID)
}
