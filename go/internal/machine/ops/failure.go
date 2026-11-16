package ops

import (
	"context"
	"errors"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// Failure carries the stable MachineFailureCode from src/lib/machines/results.ts.
// Reasons are bounded and redacted before either the wire or audit sees them.
func Failure(code, reason string) Result {
	reason = redact.String(clip(reason, 400))
	return Result{Data: map[string]any{"error": code, "reason": reason}, Err: reason}
}

// FailureFromError converts execution errors, including late local guard denials.
func FailureFromError(err error) Result {
	code := "command_failed"
	msg := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		code = "timeout"
	case errors.Is(err, context.Canceled):
		code = "cancelled"
	case protocol.CodeOf(err) == protocol.CodeInvalidPayload:
		code = "invalid_parameters"
	case protocol.CodeOf(err) == protocol.CodeNotAllowed || protocol.CodeOf(err) == protocol.CodeGuardDenied || protocol.CodeOf(err) == protocol.CodeDisabledByConfig:
		code = "refused"
	case strings.HasPrefix(msg, "unsupported_platform"), strings.Contains(msg, "_unavailable:"):
		code = "unavailable"
	case strings.HasPrefix(msg, "container_not_found"), strings.HasPrefix(msg, "file_not_found"), strings.HasPrefix(msg, "cwd_not_found"):
		code = "not_found"
	case strings.HasPrefix(msg, "output_limit:"):
		code = "output_limit"
	}
	return Failure(code, msg)
}
