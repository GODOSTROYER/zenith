package protocol

import (
	"errors"
	"fmt"
)

// Error codes reported back to the control plane in a `rejected` result.
// They are stable machine identifiers; the message is for humans and never
// contains secret material.
const (
	CodeMalformed         = "malformed_token"
	CodeUnsupportedAlg    = "unsupported_alg"
	CodeUnknownKey        = "unknown_key"
	CodeBadType           = "bad_typ"
	CodeBadSignature      = "invalid_signature"
	CodeBadProtocol       = "unsupported_protocol"
	CodeWrongTarget       = "wrong_target"
	CodeExpired           = "expired"
	CodeNotYetValid       = "not_yet_valid"
	CodeReplay            = "replay"
	CodeReplayUnavailable = "replay_cache_unavailable"
	CodeInvalidClaims     = "invalid_claims"
	CodeGrantInvalid      = "grant_invalid"
	CodeGrantAudience     = "grant_wrong_audience"
	CodeGrantCapability   = "grant_wrong_capability"
	CodeGrantOperation    = "grant_wrong_operation"
	CodeGrantWorkspace    = "grant_wrong_workspace"
	CodeKindDisabled      = "kind_disabled"
	CodeInvalidPayload    = "invalid_payload"
	CodeNotAllowed        = "not_allowed"
	CodeConstraint        = "constraint_unsupported"
	CodeInternal          = "internal_error"
	CodeUnsupportedOp     = "unsupported_operation"
	CodeDisabledByConfig  = "disabled_by_config"
	CodeGuardDenied       = "guard_denied"
)

// Error is a verification or validation failure with a stable code.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string {
	if e.Msg == "" {
		return e.Code
	}
	return e.Code + ": " + e.Msg
}

// Errorf builds an *Error.
func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// CodeOf returns the code of err if it is (or wraps) an *Error, else
// CodeInternal.
func CodeOf(err error) string {
	var pe *Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	return CodeInternal
}
