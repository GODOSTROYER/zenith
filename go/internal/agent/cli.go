package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// NewLogger builds the process logger from LogConfig. Job payloads, grants,
// tokens and credentials are never passed to it.
func NewLogger(c LogConfig, w io.Writer) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(c.Level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	if strings.EqualFold(c.Format, "text") {
		return slog.New(slog.NewTextHandler(w, opts))
	}
	return slog.New(slog.NewJSONHandler(w, opts))
}

// SignalContext is cancelled on SIGINT or SIGTERM (graceful shutdown).
func SignalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

// ReadToken resolves the registration token. Precedence: tokenFile flag,
// token flag, ZENITH_REGISTRATION_TOKEN, then the configured tokenFile. The
// second return value is true when the token came from a command-line flag
// (visible in the process list), so the caller can warn.
func ReadToken(flagToken, flagTokenFile string, cfg *Common, getenv func(string) string) (token string, fromFlag bool, err error) {
	read := func(path string) (string, error) {
		st, err := os.Stat(path)
		if err != nil {
			return "", fmt.Errorf("registration token file: %w", err)
		}
		if st.Size() > 4096 {
			return "", errors.New("registration token file is unexpectedly large")
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("registration token file: %w", err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	switch {
	case flagTokenFile != "":
		t, err := read(flagTokenFile)
		return t, false, err
	case flagToken != "":
		return strings.TrimSpace(flagToken), true, nil
	case getenv("ZENITH_REGISTRATION_TOKEN") != "":
		return strings.TrimSpace(getenv("ZENITH_REGISTRATION_TOKEN")), false, nil
	case cfg != nil && cfg.Registration.TokenFile != "":
		t, err := read(cfg.Registration.TokenFile)
		return t, false, err
	}
	return "", false, nil
}
