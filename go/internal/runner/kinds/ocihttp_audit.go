package kinds

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

type OCIAudit struct {
	JobID        string `json:"jobId"`
	Capability   string `json:"capability"`
	Service      string `json:"service"`
	Method       string `json:"method"`
	PathTemplate string `json:"pathTemplate"`
	Status       int    `json:"status"`
	RequestID    string `json:"opc-request-id,omitempty"`
	Sealed       bool   `json:"sealed"`
	Outcome      string `json:"outcome"`
}

func newOCIAudit(path string) func(OCIAudit) error {
	var mu sync.Mutex
	return func(record OCIAudit) error {
		mu.Lock()
		defer mu.Unlock()
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
		if err != nil {
			return err
		}
		err = json.NewEncoder(file).Encode(record)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		return closeErr
	}
}

func ociWait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func ociRetryDelay(value string, attempt int, now time.Time) time.Duration {
	// Invalid or excessive values cannot overflow a duration. A long Retry-After
	// is honored by waiting for the job context to expire, never by retrying early.
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds >= 0 {
		return time.Duration(min(seconds, 86400)) * time.Second
	}
	if date, err := http.ParseTime(value); err == nil && date.After(now) {
		return min(date.Sub(now), 24*time.Hour)
	}
	return (time.Duration(1<<attempt)*200 + time.Duration(rand.IntN(200))) * time.Millisecond
}
