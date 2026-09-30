package ops

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// This file parses /proc and friends. Parsing is pure Go over a configurable
// root, so the parsers are unit-tested with fixture trees on any host; only the
// disk-usage syscall (disk_linux.go) is platform specific.

func init() {
	register(Operation{Name: OpInspect, Prepare: prepareInspect})
	register(Operation{Name: OpProcessList, Prepare: prepareProcessList})
	register(Operation{Name: OpMetrics, Prepare: prepareMetrics})
}

func readSmall(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for int64(len(buf)) < max {
		n, err := f.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			break
		}
	}
	return buf, nil
}

func (e *Env) requireProc() error {
	if _, err := os.Stat(filepath.Join(e.procRoot(), "meminfo")); err != nil {
		return unsupportedf("%s is not available (needs Linux /proc)", e.procRoot())
	}
	return nil
}

/* ------------------------------ machine.inspect ---------------------------- */

func prepareInspect(e *Env, req *Request) (Runnable, error) {
	var a struct{}
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	return func(ctx context.Context) (Result, error) {
		if err := e.requireProc(); err != nil {
			return Result{}, err
		}
		root := e.procRoot()
		data := map[string]any{
			"arch":           runtime.GOARCH,
			"cpuCount":       runtime.NumCPU(),
			"zenithdVersion": e.version(),
		}
		if h, err := os.Hostname(); err == nil {
			data["hostname"] = h
		}
		if b, err := readSmall(e.osRelease(), 16<<10); err == nil {
			data["os"] = parseOSRelease(b)
		}
		if b, err := readSmall(filepath.Join(root, "sys/kernel/osrelease"), 256); err == nil {
			data["kernel"] = strings.TrimSpace(string(b))
		}
		if b, err := readSmall(filepath.Join(root, "uptime"), 256); err == nil {
			if up, err := parseUptime(b); err == nil {
				data["uptimeSec"] = up
			}
		}
		if b, err := readSmall(filepath.Join(root, "loadavg"), 256); err == nil {
			if l, err := parseLoadavg(b); err == nil {
				data["loadAvg"] = l
			}
		}
		if b, err := readSmall(filepath.Join(root, "meminfo"), 64<<10); err == nil {
			data["memory"] = memoryInfo(parseMeminfo(b))
		}
		data["disks"] = e.disks()
		return Result{OK: true, Data: data}, nil
	}, nil
}

func parseOSRelease(b []byte) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			out["id"] = v
		case "NAME":
			out["name"] = v
		case "VERSION_ID":
			out["versionId"] = v
		case "PRETTY_NAME":
			out["prettyName"] = v
		}
	}
	return out
}

func parseUptime(b []byte) (float64, error) {
	f := strings.Fields(string(b))
	if len(f) < 1 {
		return 0, fmt.Errorf("bad uptime")
	}
	return strconv.ParseFloat(f[0], 64)
}

func parseLoadavg(b []byte) ([]float64, error) {
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return nil, fmt.Errorf("bad loadavg")
	}
	out := make([]float64, 3)
	for i := 0; i < 3; i++ {
		v, err := strconv.ParseFloat(f[i], 64)
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

// parseMeminfo returns values in bytes (the kernel reports kB).
func parseMeminfo(b []byte) map[string]int64 {
	out := map[string]int64{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 1 && strings.EqualFold(f[1], "kB") {
			n *= 1024
		}
		out[name] = n
	}
	return out
}

func memoryInfo(m map[string]int64) map[string]any {
	avail, ok := m["MemAvailable"]
	if !ok { // very old kernels
		avail = m["MemFree"] + m["Buffers"] + m["Cached"]
	}
	return map[string]any{
		"totalBytes":     m["MemTotal"],
		"availableBytes": avail,
		"freeBytes":      m["MemFree"],
		"swapTotalBytes": m["SwapTotal"],
		"swapFreeBytes":  m["SwapFree"],
	}
}

/* -------------------------------- process.list ----------------------------- */

type processArgs struct {
	Limit  int    `json:"limit"`
	SortBy string `json:"sortBy"`
}

func prepareProcessList(e *Env, req *Request) (Runnable, error) {
	var a processArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if a.Limit == 0 {
		a.Limit = 100
	}
	if a.Limit < 1 || a.Limit > 1000 {
		return nil, invalid("limit must be between 1 and 1000")
	}
	switch a.SortBy {
	case "", "rss", "cpu", "pid":
	default:
		return nil, invalid("sortBy must be rss, cpu or pid")
	}
	return func(ctx context.Context) (Result, error) {
		if err := e.requireProc(); err != nil {
			return Result{}, err
		}
		procs, err := scanProcesses(ctx, e.procRoot())
		if err != nil {
			return Result{}, err
		}
		sortProcesses(procs, a.SortBy)
		total := len(procs)
		truncated := false
		if len(procs) > a.Limit {
			procs, truncated = procs[:a.Limit], true
		}
		list := make([]map[string]any, len(procs))
		for i, p := range procs {
			m := map[string]any{"pid": p.PID, "ppid": p.PPID, "name": p.Name, "state": p.State, "uid": p.UID, "rssBytes": p.RSS, "cpuTicks": p.CPUTicks, "startTicks": p.StartTicks, "threads": p.Threads}
			if p.Exe != "" {
				m["exe"] = p.Exe
			}
			list[i] = m
		}
		return Result{OK: true, Data: map[string]any{
			"count": total, "returned": len(list), "truncated": truncated,
			"clockTicksPerSec": 100, // USER_HZ is 100 on every supported Linux platform
			"processes":        list,
			// Command lines are deliberately not reported: arguments routinely
			// carry passwords and tokens.
			"argvOmitted": true,
		}}, nil
	}, nil
}

type procInfo struct {
	PID, PPID  int
	Name       string
	State      string
	UID        int
	RSS        int64
	CPUTicks   uint64
	StartTicks uint64
	Threads    int
	Exe        string
}

func sortProcesses(p []procInfo, by string) {
	switch by {
	case "cpu":
		sort.SliceStable(p, func(i, j int) bool { return p[i].CPUTicks > p[j].CPUTicks })
	case "pid":
		sort.SliceStable(p, func(i, j int) bool { return p[i].PID < p[j].PID })
	default:
		sort.SliceStable(p, func(i, j int) bool { return p[i].RSS > p[j].RSS })
	}
}

func scanProcesses(ctx context.Context, root string) ([]procInfo, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []procInfo
	for _, e := range entries {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 || !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		stat, err := readSmall(filepath.Join(dir, "stat"), 8192)
		if err != nil {
			continue // the process exited while scanning
		}
		p, ok := parseProcStat(stat)
		if !ok {
			continue
		}
		p.PID = pid
		if st, err := readSmall(filepath.Join(dir, "status"), 16384); err == nil {
			parseProcStatus(st, &p)
		}
		if exe, err := os.Readlink(filepath.Join(dir, "exe")); err == nil {
			p.Exe = strings.TrimSuffix(exe, " (deleted)")
		}
		out = append(out, p)
	}
	return out, nil
}

// parseProcStat parses /proc/<pid>/stat. The command name is in parentheses
// and may itself contain spaces and parentheses, so the LAST ')' ends it.
func parseProcStat(b []byte) (procInfo, bool) {
	s := string(b)
	l, r := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if l < 0 || r < l {
		return procInfo{}, false
	}
	p := procInfo{Name: clip(s[l+1:r], 64)}
	f := strings.Fields(s[r+1:])
	// f[0]=state f[1]=ppid ... f[11]=utime f[12]=stime ... f[19]=starttime (0-based after ')')
	if len(f) < 20 {
		return procInfo{}, false
	}
	p.State = f[0]
	p.PPID, _ = strconv.Atoi(f[1])
	ut, _ := strconv.ParseUint(f[11], 10, 64)
	st, _ := strconv.ParseUint(f[12], 10, 64)
	p.CPUTicks = ut + st
	p.StartTicks, _ = strconv.ParseUint(f[19], 10, 64)
	return p, true
}

func parseProcStatus(b []byte, p *procInfo) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		switch k {
		case "Uid":
			p.UID, _ = strconv.Atoi(f[0])
		case "VmRSS":
			n, _ := strconv.ParseInt(f[0], 10, 64)
			p.RSS = n * 1024
		case "Threads":
			p.Threads, _ = strconv.Atoi(f[0])
		}
	}
}

/* ------------------------------- system.metrics ---------------------------- */

func prepareMetrics(e *Env, req *Request) (Runnable, error) {
	var a struct{}
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	return func(ctx context.Context) (Result, error) {
		if err := e.requireProc(); err != nil {
			return Result{}, err
		}
		root := e.procRoot()
		data := map[string]any{"cpuCount": runtime.NumCPU()}
		if b, err := readSmall(filepath.Join(root, "stat"), 64<<10); err == nil {
			if c1, ok := parseCPUStat(b); ok {
				select {
				case <-time.After(250 * time.Millisecond):
				case <-ctx.Done():
					return Result{}, ctx.Err()
				}
				if b2, err := readSmall(filepath.Join(root, "stat"), 64<<10); err == nil {
					if c2, ok := parseCPUStat(b2); ok {
						data["cpu"] = cpuUsage(c1, c2)
					}
				}
			}
		}
		if b, err := readSmall(filepath.Join(root, "loadavg"), 256); err == nil {
			if l, err := parseLoadavg(b); err == nil {
				data["loadAvg"] = l
			}
		}
		if b, err := readSmall(filepath.Join(root, "uptime"), 256); err == nil {
			if up, err := parseUptime(b); err == nil {
				data["uptimeSec"] = up
			}
		}
		if b, err := readSmall(filepath.Join(root, "meminfo"), 64<<10); err == nil {
			data["memory"] = memoryInfo(parseMeminfo(b))
		}
		if b, err := readSmall(filepath.Join(root, "net/dev"), 64<<10); err == nil {
			data["network"] = parseNetDev(b)
		}
		if b, err := readSmall(filepath.Join(root, "sys/fs/file-nr"), 256); err == nil {
			if f := strings.Fields(string(b)); len(f) >= 3 {
				alloc, _ := strconv.ParseInt(f[0], 10, 64)
				maxFD, _ := strconv.ParseInt(f[2], 10, 64)
				data["fileDescriptors"] = map[string]any{"allocated": alloc, "max": maxFD}
			}
		}
		data["disks"] = e.disks()
		return Result{OK: true, Data: data}, nil
	}, nil
}

type cpuTimes struct{ idle, total uint64 }

// parseCPUStat reads the aggregate "cpu " line of /proc/stat.
func parseCPUStat(b []byte) (cpuTimes, bool) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		f := strings.Fields(line)[1:]
		var vals []uint64
		for _, x := range f {
			n, err := strconv.ParseUint(x, 10, 64)
			if err != nil {
				return cpuTimes{}, false
			}
			vals = append(vals, n)
		}
		if len(vals) < 5 {
			return cpuTimes{}, false
		}
		var total uint64
		// user nice system idle iowait irq softirq steal (guest is already in user)
		for i, v := range vals {
			if i >= 8 {
				break
			}
			total += v
		}
		idle := vals[3] + vals[4]
		return cpuTimes{idle: idle, total: total}, true
	}
	return cpuTimes{}, false
}

func cpuUsage(a, b cpuTimes) map[string]any {
	dTotal := float64(b.total) - float64(a.total)
	dIdle := float64(b.idle) - float64(a.idle)
	pct := 0.0
	if dTotal > 0 {
		pct = (dTotal - dIdle) / dTotal * 100
	}
	return map[string]any{"usagePercent": round1(pct), "sampleMs": 250}
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }

func parseNetDev(b []byte) []map[string]any {
	var out []map[string]any
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 16 {
			continue
		}
		n := func(i int) uint64 { v, _ := strconv.ParseUint(f[i], 10, 64); return v }
		out = append(out, map[string]any{
			"interface": strings.TrimSpace(name),
			"rxBytes":   n(0), "rxPackets": n(1), "rxErrors": n(2), "rxDropped": n(3),
			"txBytes": n(8), "txPackets": n(9), "txErrors": n(10), "txDropped": n(11),
		})
		if len(out) >= 64 {
			break
		}
	}
	return out
}

/* ---------------------------------- disks ---------------------------------- */

// realFS are the filesystem types reported as disks.
var realFS = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true, "vfat": true, "f2fs": true, "jfs": true, "ntfs": true, "ntfs3": true, "fuseblk": true, "overlay": true, "reiserfs": true, "exfat": true}

type mountInfo struct{ Device, Mount, FSType string }

func parseMounts(b []byte) []mountInfo {
	var out []mountInfo
	seen := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 || !realFS[f[2]] {
			continue
		}
		mount := unescapeMount(f[1])
		key := f[0] + "\x00" + mount
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, mountInfo{Device: f[0], Mount: mount, FSType: f[2]})
		if len(out) >= 32 {
			break
		}
	}
	return out
}

// unescapeMount decodes the octal escapes /proc/mounts uses (\040 = space).
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// disks reports capacity per real mount; failures for one mount are skipped.
func (e *Env) disks() []map[string]any {
	b, err := readSmall(filepath.Join(e.procRoot(), "mounts"), 256<<10)
	if err != nil {
		return []map[string]any{}
	}
	out := []map[string]any{}
	for _, m := range parseMounts(b) {
		total, free, ok := statfsBytes(m.Mount)
		if !ok {
			continue
		}
		out = append(out, map[string]any{
			"mount": m.Mount, "device": m.Device, "fsType": m.FSType,
			"totalBytes": total, "freeBytes": free, "usedBytes": total - free,
		})
	}
	return out
}
