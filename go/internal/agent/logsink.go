package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// LogSink receives the log lines of one running job. Implementations are
// safe for concurrent use. Lines are redacted for credential patterns before
// they leave the agent.
type LogSink interface {
	// Line records one line. stream is "stdout", "stderr" or "info".
	Line(stream, line string)
}

// DiscardSink drops every line (used when a kind produces no log stream).
type DiscardSink struct{}

// Line implements LogSink.
func (DiscardSink) Line(string, string) {}

const (
	maxLogLine     = 8 << 10  // longer lines are truncated
	maxLogBatch    = 60 << 10 // POST body stays under the 64 KiB spec limit
	maxLogPerJob   = 4 << 20  // total log bytes streamed per job
	logFlushPeriod = 2 * time.Second
)

// LogLine is one entry of the logs endpoint payload.
type LogLine struct {
	TS     string `json:"ts"`
	Stream string `json:"stream"`
	Line   string `json:"line"`
}

type logBatch struct {
	Seq   int       `json:"seq"`
	Lines []LogLine `json:"lines"`
}

// logStreamer batches redacted lines and POSTs them best-effort to
// .../jobs/{jti}/logs. A failed post drops that batch (logs are advisory; the
// authoritative output is in the result), it never fails the job.
type logStreamer struct {
	post func(ctx context.Context, b logBatch) error
	log  *slog.Logger
	now  func() time.Time

	mu      sync.Mutex
	red     redact.Lines
	pending []LogLine
	size    int
	sent    int64
	limited bool
	seq     int
	wake    chan struct{}
	stop    chan struct{}
	done    chan struct{}
	warned  bool
}

func newLogStreamer(post func(context.Context, logBatch) error, log *slog.Logger, now func() time.Time) *logStreamer {
	if now == nil {
		now = time.Now
	}
	s := &logStreamer{post: post, log: log, now: now, wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
	go s.run()
	return s
}

// Line implements LogSink.
func (s *logStreamer) Line(stream, line string) {
	if stream != "stdout" && stream != "stderr" && stream != "info" {
		stream = "info"
	}
	if len(line) > maxLogLine {
		line = line[:maxLogLine] + " ...[truncated]"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.limited {
		return
	}
	line = s.red.Line(line)
	if s.sent+int64(s.size)+int64(len(line)) > maxLogPerJob {
		s.limited = true
		line = "[log limit reached; further output is only in the job result]"
		stream = "info"
	}
	s.pending = append(s.pending, LogLine{TS: s.now().UTC().Format(time.RFC3339Nano), Stream: stream, Line: line})
	s.size += len(line) + 64
	if s.size >= maxLogBatch/2 {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
}

func (s *logStreamer) run() {
	defer close(s.done)
	t := time.NewTicker(logFlushPeriod)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.flush()
		case <-s.wake:
			s.flush()
		case <-s.stop:
			s.flush()
			return
		}
	}
}

// Close flushes and stops the streamer.
func (s *logStreamer) Close() {
	close(s.stop)
	<-s.done
}

func (s *logStreamer) flush() {
	s.mu.Lock()
	lines := s.pending
	s.pending = nil
	s.sent += int64(s.size)
	s.size = 0
	s.mu.Unlock()
	for len(lines) > 0 {
		n, sz := 0, 0
		for n < len(lines) && (n == 0 || sz+len(lines[n].Line)+64 <= maxLogBatch) {
			sz += len(lines[n].Line) + 64
			n++
		}
		batch := lines[:n]
		lines = lines[n:]
		s.mu.Lock()
		s.seq++
		seq := s.seq
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := s.post(ctx, logBatch{Seq: seq, Lines: batch})
		cancel()
		if err != nil && !s.warned {
			s.warned = true
			s.log.Warn("log stream post failed; further failures are not logged", "err", err)
		}
	}
}

// logsPath builds the logs endpoint for a job.
func logsPath(kind Kind, agentID, jti string) string {
	return protocol.APIPrefix + "/" + kind.Collection + "/" + agentID + "/jobs/" + jti + "/logs"
}

// resultPath builds the result endpoint for a job.
func resultPath(kind Kind, agentID, jti string) string {
	return protocol.APIPrefix + "/" + kind.Collection + "/" + agentID + "/jobs/" + jti + "/result"
}

func (a *Agent) postLogs(ctx context.Context, jti string, b logBatch) error {
	_, err := a.client.Do(ctx, http.MethodPost, logsPath(a.opts.Kind, a.opts.Identity.ID, jti), b, nil, 10*time.Second, 64<<10)
	return err
}

// encodedSize is used to keep result bodies under MaxResultBytes.
func encodedSize(v any) (int, []byte) {
	b, err := json.Marshal(v)
	if err != nil {
		return -1, nil
	}
	return len(b), b
}
