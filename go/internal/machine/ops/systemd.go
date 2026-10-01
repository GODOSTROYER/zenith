package ops

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

func init() {
	register(Operation{Name: OpServiceStatus, Prepare: prepareServiceStatus})
	register(Operation{Name: OpServiceRestart, Prepare: prepareServiceRestart})
	register(Operation{Name: OpLogs, Prepare: prepareSystemLogs})
}

// unitRe is the unit-name rule from the protocol spec. On top of it a name
// must not start with '-': systemctl and journalctl would read it as an
// option, so the regexp alone is not a sufficient guard for argv use.
var unitRe = regexp.MustCompile(`^[A-Za-z0-9@._:-]{1,128}\.(service|socket|timer)$`)

// ValidUnit reports whether name is an acceptable unit name.
func ValidUnit(name string) bool { return unitRe.MatchString(name) && name[0] != '-' }

func checkUnit(name string) error {
	if !ValidUnit(name) {
		return invalid("unit must match ^[A-Za-z0-9@._:-]{1,128}\\.(service|socket|timer)$ and not start with '-'")
	}
	return nil
}

var restartPatternRe = regexp.MustCompile(`^[A-Za-z0-9@._:*-]{1,128}$`)

// ValidateRestartPatterns checks services.restartAllow at startup.
func ValidateRestartPatterns(patterns []string) error {
	for _, p := range patterns {
		if !restartPatternRe.MatchString(p) || p[0] == '-' || !(strings.HasSuffix(p, ".service") || strings.HasSuffix(p, ".socket") || strings.HasSuffix(p, ".timer")) {
			return fmt.Errorf("services.restartAllow entry %q must be a unit name (letters, digits, @ . _ : -) ending in .service, .socket or .timer, optionally with * wildcards", clip(p, 60))
		}
	}
	return nil
}

// globMatch matches s against a pattern where '*' matches any run of
// characters (including none). Units contain no '/', so this is enough.
func globMatch(pattern, s string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	for _, mid := range parts[1 : len(parts)-1] {
		i := strings.Index(s, mid)
		if i < 0 {
			return false
		}
		s = s[i+len(mid):]
	}
	return strings.HasSuffix(s, parts[len(parts)-1])
}

func restartAllowed(patterns []string, unit string) bool {
	for _, p := range patterns {
		if globMatch(p, unit) {
			return true
		}
	}
	return false
}

/* ------------------------------- service.status ---------------------------- */

var statusProps = []string{
	"Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID", "ExecMainStatus",
	"Result", "NRestarts", "ActiveEnterTimestamp", "InactiveEnterTimestamp", "FragmentPath", "MemoryCurrent", "TasksCurrent",
}

type unitArgs struct {
	Unit string `json:"unit"`
}

func prepareServiceStatus(e *Env, req *Request) (Runnable, error) {
	var a unitArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if err := checkUnit(a.Unit); err != nil {
		return nil, err
	}
	return func(ctx context.Context) (Result, error) {
		st, err := e.unitStatus(ctx, a.Unit)
		if err != nil {
			return Result{}, err
		}
		return Result{OK: true, Data: st}, nil
	}, nil
}

// unitStatus runs `systemctl show` with a fixed property list. The unit name
// is passed after "--", so even a name that looked like an option could not be
// taken as one (and ValidUnit already refuses a leading '-').
func (e *Env) unitStatus(ctx context.Context, unit string) (map[string]any, error) {
	res, err := e.runner().Run(ctx, CmdSpec{
		Path:      e.systemctl(),
		Args:      []string{"show", "--no-pager", "--property=" + strings.Join(statusProps, ","), "--", unit},
		Env:       SafeEnv(),
		MaxStdout: 64 << 10, MaxStderr: 8 << 10,
	})
	if err != nil {
		return nil, fmt.Errorf("systemctl_unavailable: %s", redact.String(clip(err.Error(), 200)))
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("systemctl_failed: exit %d: %s", res.ExitCode, redact.String(clip(strings.TrimSpace(string(res.Stderr)), 300)))
	}
	return parseShow(unit, string(res.Stdout)), nil
}

// parseShow turns `systemctl show` key=value output into a typed map.
func parseShow(unit, out string) map[string]any {
	kv := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			kv[k] = strings.TrimSpace(v)
		}
	}
	num := func(k string) (int64, bool) {
		v := kv[k]
		if v == "" || v == "[not set]" {
			return 0, false
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 { // Includes systemd's unsigned "unset" sentinel.
			return 0, false
		}
		return n, true
	}
	d := map[string]any{"unit": unit, "loadState": clip(kv["LoadState"], 64), "activeState": clip(kv["ActiveState"], 64)}
	for _, k := range []struct{ prop, key string }{{"SubState", "subState"}, {"UnitFileState", "unitFileState"}, {"Result", "result"}, {"ActiveEnterTimestamp", "since"}} {
		if v := kv[k.prop]; v != "" {
			d[k.key] = clip(v, 64)
		}
	}
	if n, ok := num("MainPID"); ok {
		d["mainPid"] = n
	}
	if n, ok := num("ExecMainStatus"); ok {
		d["execMainStatus"] = n
	}
	if n, ok := num("NRestarts"); ok {
		d["restarts"] = n
	}
	return d
}

/* ---------------------------- machine.service.restart ---------------------- */

func prepareServiceRestart(e *Env, req *Request) (Runnable, error) {
	var a unitArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if err := checkUnit(a.Unit); err != nil {
		return nil, err
	}
	if len(e.Cfg.Services.RestartAllow) == 0 {
		return nil, disabled("no unit may be restarted: services.restartAllow is empty on this machine")
	}
	if !restartAllowed(e.Cfg.Services.RestartAllow, a.Unit) {
		return nil, notAllowed("unit %q is not in services.restartAllow on this machine", a.Unit)
	}
	return func(ctx context.Context) (Result, error) {
		before, err := e.unitStatus(ctx, a.Unit)
		if err != nil {
			return Result{}, err
		}
		if before["loadState"] == "not-found" || before["loadState"] == "" {
			return Failure("not_found", "unit_not_found: "+a.Unit), nil
		}
		res, err := e.runner().Run(ctx, CmdSpec{
			Path: e.systemctl(), Args: []string{"restart", "--no-pager", "--", a.Unit}, Env: SafeEnv(),
			MaxStdout: 8 << 10, MaxStderr: 8 << 10,
		})
		if err != nil {
			return Result{}, fmt.Errorf("systemctl_unavailable: %s", redact.String(clip(err.Error(), 200)))
		}
		// Re-read state with a fresh deadline: the restart may have used most of the job's.
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		after, aerr := e.unitStatus(sctx, a.Unit)
		if res.ExitCode != 0 {
			return Failure("command_failed", fmt.Sprintf("restart_failed: systemctl exited %d: %s", res.ExitCode, redact.String(clip(string(res.Stderr), 500)))), nil
		}
		if aerr != nil {
			return Result{}, aerr
		}
		data := map[string]any{"unit": a.Unit, "restarted": true, "activeState": after["activeState"]}
		for _, k := range []string{"subState", "mainPid"} {
			if v, ok := after[k]; ok {
				data[k] = v
			}
		}
		return Result{OK: true, Data: data}, nil
	}, nil
}

/* --------------------------------- system.logs ----------------------------- */

var relTimeRe = regexp.MustCompile(`^([1-9][0-9]{0,5})([smhd])$`)

type logsArgs struct {
	Unit  string `json:"unit"`
	Since string `json:"since"`
	Lines int    `json:"lines"`
}

// relativeSince is the normalized TS wire duration: positive, at most 7d.
func relativeSince(s string) (time.Duration, error) {
	m := relTimeRe.FindStringSubmatch(s)
	if m == nil {
		return 0, invalid("since must be a relative duration like 15m or 2d, at most 7d")
	}
	n, _ := strconv.Atoi(m[1])
	d := time.Duration(n) * map[string]time.Duration{"s": time.Second, "m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}[m[2]]
	if d <= 0 || d > 7*24*time.Hour {
		return 0, invalid("since must be positive and at most 7d")
	}
	return d, nil
}

func journalTime(s string, now time.Time) (string, error) {
	d, err := relativeSince(s)
	if err != nil {
		return "", err
	}
	return now.Add(-d).UTC().Format("2006-01-02 15:04:05") + " UTC", nil
}

func prepareSystemLogs(e *Env, req *Request) (Runnable, error) {
	var a logsArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if a.Unit != "" {
		if err := checkUnit(a.Unit); err != nil {
			return nil, err
		}
	}
	if a.Lines == 0 {
		a.Lines = 200
	}
	if a.Lines < 1 || a.Lines > 5000 {
		return nil, invalid("lines must be between 1 and 5000")
	}
	args := []string{"--no-pager", "--quiet", "--utc", "--output=short-iso", "--lines=" + strconv.Itoa(a.Lines)}
	if a.Unit != "" {
		args = append(args, "--unit="+a.Unit)
	}
	if a.Since == "" {
		a.Since = "1h"
	}
	now := e.now()
	if a.Since != "" {
		s, err := journalTime(a.Since, now)
		if err != nil {
			return nil, err
		}
		args = append(args, "--since="+s)
	}
	limit := req.MaxOutputBytes
	return func(ctx context.Context) (Result, error) {
		res, err := e.runner().Run(ctx, CmdSpec{
			Path: e.journalctl(), Args: args, Env: SafeEnv(),
			MaxStdout: limit*2 + 4096, MaxStderr: 8 << 10, // read a bit more than we return so truncation is detected
		})
		if err != nil {
			return Result{}, fmt.Errorf("journalctl_unavailable: %s", redact.String(clip(err.Error(), 200)))
		}
		if res.ExitCode != 0 {
			return Result{}, fmt.Errorf("journalctl_failed: exit %d: %s", res.ExitCode, redact.String(clip(strings.TrimSpace(string(res.Stderr)), 300)))
		}
		text, count, truncated := redactedTail(string(res.Stdout), limit)
		truncated = truncated || res.StdoutTrunc
		data := map[string]any{"lines": count, "truncated": truncated, "content": text}
		if a.Unit != "" {
			data["unit"] = a.Unit
		}
		return Result{OK: true, Data: data}, nil
	}, nil
}

// redactedTail redacts every line and keeps the newest lines that fit in
// limit bytes.
func redactedTail(s string, limit int64) (text string, lines int, truncated bool) {
	raw := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(raw) == 1 && raw[0] == "" {
		return "", 0, false
	}
	var lr redact.Lines
	red := make([]string, len(raw))
	for i, l := range raw {
		red[i] = lr.Line(strings.ToValidUTF8(l, "?"))
	}
	var size int64
	start := len(red)
	for start > 0 {
		n := int64(len(red[start-1])) + 1
		if size+n > limit {
			truncated = true
			break
		}
		size += n
		start--
	}
	kept := red[start:]
	return strings.Join(kept, "\n"), len(kept), truncated
}
