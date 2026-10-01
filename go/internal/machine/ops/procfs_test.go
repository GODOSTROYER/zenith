package ops_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

// fixtureProc builds a small /proc tree.
func fixtureProc(t *testing.T) (procRoot, osRelease string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "proc")
	w := func(rel, content string) { writeFile(t, filepath.Join(root, rel), content) }
	w("meminfo", "MemTotal:       16384000 kB\nMemFree:         1024000 kB\nMemAvailable:    8192000 kB\nBuffers:          100000 kB\nCached:          2000000 kB\nSwapTotal:       2048000 kB\nSwapFree:        2000000 kB\nHugePages_Total:       0\n")
	w("loadavg", "0.52 0.41 0.30 2/345 12345\n")
	w("uptime", "12345.67 54321.00\n")
	w("sys/kernel/osrelease", "6.8.0-test\n")
	w("sys/fs/file-nr", "1024\t0\t9223372036854775807\n")
	w("stat", "cpu  1000 10 500 8000 100 0 20 0 0 0\ncpu0 500 5 250 4000 50 0 10 0 0 0\nintr 1\n")
	w("mounts", "sysfs /sys sysfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /mnt/data\\040disk xfs rw 0 0\ntmpfs /run tmpfs rw 0 0\nproc /proc proc rw 0 0\noverlay /var/lib/docker/overlay2/x/merged overlay rw 0 0\n/dev/sda1 / ext4 rw 0 0\n")
	w("net/dev", "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo:     1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0\n  eth0: 987654321  654321    2    3    0     0          0         0 123456789  123456    4    5    0     0       0          0\n")
	// pid 1: a normal process; pid 42: a name with spaces and parentheses; pid 99: vanishes (no stat)
	w("1/stat", "1 (systemd) S 0 1 1 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 100 1000000 500 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n")
	w("1/status", "Name:\tsystemd\nUid:\t0\t0\t0\t0\nVmRSS:\t   9000 kB\nThreads:\t1\n")
	w("42/stat", "42 (my (weird) name) R 1 42 42 0 -1 4194304 10 0 0 0 7 3 0 0 20 0 4 0 5000 2000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n")
	w("42/status", "Name:\tmy (weird) name\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t  50000 kB\nThreads:\t4\n")
	w("self/stat", "not a pid directory entry\n")
	w("99/status", "Name:\tgone\n")
	if err := os.Symlink("/usr/sbin/nginx (deleted)", filepath.Join(root, "42", "exe")); err != nil && runtime.GOOS != "windows" {
		t.Fatal(err)
	}
	w("42/cmdline", "my\x00--password=hunter2\x00")
	osr := filepath.Join(t.TempDir(), "os-release")
	writeFile(t, osr, "NAME=\"Ubuntu\"\nVERSION_ID=\"26.04\"\nID=ubuntu\nPRETTY_NAME=\"Ubuntu 26.04 LTS\"\nHOME_URL=\"https://x\"\n")
	return root, osr
}

func TestMachineInspectParsesProcFixture(t *testing.T) {
	proc, osr := fixtureProc(t)
	e := &ops.Env{ProcRoot: proc, OSRelease: osr, Version: "9.9.9"}
	res := runOp(t, e, ops.OpInspect, map[string]any{})
	d := res.Data
	if !res.OK || d["kernel"] != "6.8.0-test" || d["uptimeSec"] != int64(12345) {
		t.Fatalf("%v", d)
	}
	osInfo := d["os"].(map[string]string)
	if osInfo["id"] != "ubuntu" || osInfo["version"] != "26.04" || osInfo["pretty"] != "Ubuntu 26.04 LTS" || len(osInfo) != 3 {
		t.Fatalf("%v", osInfo)
	}
	load := d["load"].([]float64)
	if load[0] != 0.52 || load[2] != 0.30 {
		t.Fatal(load)
	}
	mem := d["memory"].(map[string]any)
	if mem["totalKb"] != int64(16384000) || mem["availableKb"] != int64(8192000) || mem["swapFreeKb"] != int64(2000000) {
		t.Fatalf("%v", mem)
	}
	if _, ok := d["disks"]; !ok {
		t.Fatal("disks key missing")
	}
	if _, err := prep(t, e, ops.OpInspect, map[string]any{"verbose": true}); err == nil {
		t.Fatal("inspect takes no arguments")
	}
}

func TestInspectOnAHostWithoutProcIsAFailedResultNotACrash(t *testing.T) {
	e := &ops.Env{ProcRoot: filepath.Join(t.TempDir(), "nope")}
	run, err := prep(t, e, ops.OpInspect, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = run(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "unsupported_platform") {
		t.Fatalf("%v", err)
	}
}

func TestInspectBoundsStringsAndOmitsInvalidMeasurements(t *testing.T) {
	proc, osr := fixtureProc(t)
	writeFile(t, osr, "ID="+strings.Repeat("i", 100)+"\nVERSION_ID="+strings.Repeat("v", 100)+"\nPRETTY_NAME="+strings.Repeat("p", 300)+"\n")
	writeFile(t, filepath.Join(proc, "sys/kernel/osrelease"), strings.Repeat("k", 300))
	writeFile(t, filepath.Join(proc, "meminfo"), "MemTotal: -1 kB\nMemAvailable: 9223372036854775807 kB\n")
	for _, invalid := range []string{"NaN", "Inf", "-1", "9223372036854775808"} {
		writeFile(t, filepath.Join(proc, "uptime"), invalid+" 0\n")
		writeFile(t, filepath.Join(proc, "loadavg"), "NaN -1 Inf 0/0 0\n")
		d := runOp(t, &ops.Env{ProcRoot: proc, OSRelease: osr}, ops.OpInspect, map[string]any{}).Data
		if _, ok := d["uptimeSec"]; ok {
			t.Fatalf("invalid uptime %s must be absent: %v", invalid, d)
		}
		if _, ok := d["load"]; ok || len(d["memory"].(map[string]any)) != 0 {
			t.Fatalf("invalid measurements must be absent: %v", d)
		}
		osInfo := d["os"].(map[string]string)
		if len(d["kernel"].(string)) != 128 || len(osInfo["id"]) != 64 || len(osInfo["version"]) != 64 || len(osInfo["pretty"]) != 200 {
			t.Fatalf("strings must respect the TS result bounds: %v", d)
		}
	}
}

func TestProcessListOmitsUnreadStatusInsteadOfGuessingRootAndZeroRSS(t *testing.T) {
	proc, _ := fixtureProc(t)
	if err := os.Remove(filepath.Join(proc, "1/status")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(proc, "42/status"), "Uid: invalid\nVmRSS: -100 kB\n")
	list := runOp(t, &ops.Env{ProcRoot: proc}, ops.OpProcessList, map[string]any{}).Data["processes"].([]map[string]any)
	if len(list) != 2 {
		t.Fatalf("process identity is still known: %v", list)
	}
	for _, p := range list {
		if _, ok := p["user"]; ok {
			t.Fatalf("unread UID must be absent: %v", p)
		}
		if _, ok := p["rssKb"]; ok {
			t.Fatalf("unread RSS must be absent: %v", p)
		}
	}
}

func TestProcessListParsesStatAndOmitsCommandLines(t *testing.T) {
	proc, _ := fixtureProc(t)
	e := &ops.Env{ProcRoot: proc}
	res := runOp(t, e, ops.OpProcessList, map[string]any{"sortBy": "memory"})
	list := res.Data["processes"].([]map[string]any)
	if len(list) != 2 {
		t.Fatalf("pid 99 has no stat and must be skipped, 'self' is not a pid: %v", res.Data)
	}
	if list[0]["pid"] != 42 || list[0]["command"] != "my (weird) name" || list[0]["rssKb"] != int64(50000) || list[0]["user"] != "1000" || list[0]["ppid"] != 1 {
		t.Fatalf("sorted by memory; parenthesised comm handled: %v", list[0])
	}
	if list[1]["pid"] != 1 || list[1]["command"] != "systemd" {
		t.Fatalf("%v", list[1])
	}
	for _, p := range list {
		for _, v := range p {
			if s, ok := v.(string); ok && strings.Contains(s, "hunter2") {
				t.Fatal("command lines must not be reported")
			}
		}
	}
	res = runOp(t, e, ops.OpProcessList, map[string]any{"limit": 1, "sortBy": "cpu"})
	if l := res.Data["processes"].([]map[string]any); len(l) != 1 || l[0]["pid"] != 1 || res.Data["truncated"] != true {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpProcessList, map[string]any{"sortBy": "cpu"})
	if res.Data["processes"].([]map[string]any)[0]["pid"] != 1 {
		t.Fatal("cpu sort")
	}
	for _, args := range []map[string]any{{"limit": 0, "sortBy": "x"}, {"limit": 5000}, {"limit": -1}, {"sortBy": "name; id"}} {
		if _, err := prep(t, e, ops.OpProcessList, args); err == nil {
			t.Errorf("%v must be rejected", args)
		}
	}
}

func TestSystemMetricsFromFixture(t *testing.T) {
	proc, _ := fixtureProc(t)
	e := &ops.Env{ProcRoot: proc}
	res := runOp(t, e, ops.OpMetrics, map[string]any{})
	d := res.Data
	if _, ok := d["cpuUsagePct"]; ok {
		t.Fatal("unchanged sample has no measurable CPU usage")
	}
	network := d["network"].(map[string]any)
	if network["rxBytes"] != uint64(987655321) || network["txBytes"] != uint64(123457789) {
		t.Fatalf("%v", network)
	}
	if d["openFiles"] != int64(1024) {
		t.Fatalf("%v", d)
	}
	if d["uptimeSec"] != int64(12345) || d["memory"].(map[string]any)["totalKb"] != int64(16384000) {
		t.Fatalf("%v", d)
	}
}

func TestDisksComeFromRealFilesystemsOnly(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("statfs is Linux only")
	}
	proc, osr := fixtureProc(t)
	// point the mount table at real mounts so statfs succeeds
	writeFile(t, filepath.Join(proc, "mounts"), "tmpfs /run tmpfs rw 0 0\n"+realMountLine(t)+"sysfs /sys sysfs rw 0 0\n")
	e := &ops.Env{ProcRoot: proc, OSRelease: osr}
	res := runOp(t, e, ops.OpInspect, map[string]any{})
	disks := res.Data["disks"].([]map[string]any)
	if len(disks) != 1 {
		t.Fatalf("pseudo filesystems must be skipped: %v", disks)
	}
	total, free, used := disks[0]["sizeKb"].(uint64), disks[0]["availKb"].(uint64), disks[0]["usedKb"].(uint64)
	if total == 0 || free > total || used > total || used+free > total+1 {
		t.Fatalf("%v", disks[0])
	}
}

// realMountLine picks one real mounted filesystem from the host's table.
func realMountLine(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("/proc/mounts")
	if err != nil {
		t.Skip("no /proc/mounts")
	}
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		if len(f) >= 3 && (f[2] == "ext4" || f[2] == "xfs" || f[2] == "btrfs" || f[2] == "overlay") && !strings.Contains(f[1], `\`) {
			return l + "\n"
		}
	}
	t.Skip("no ext4/xfs/btrfs/overlay mount on this host")
	return ""
}

func TestProcfsAgainstTheRealHost(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("needs Linux /proc")
	}
	e := &ops.Env{}
	res := runOp(t, e, ops.OpInspect, map[string]any{})
	if res.Data["kernel"] == "" || res.Data["uptimeSec"].(int64) <= 0 || res.Data["memory"].(map[string]any)["totalKb"].(int64) <= 0 {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpProcessList, map[string]any{"limit": 5})
	if len(res.Data["processes"].([]map[string]any)) < 1 {
		t.Fatalf("%v", res.Data)
	}
	self := os.Getpid()
	all := runOp(t, e, ops.OpProcessList, map[string]any{"limit": 500, "sortBy": "cpu"})
	found := false
	for _, p := range all.Data["processes"].([]map[string]any) {
		if p["pid"] == self {
			found = true
			if p["rssKb"].(int64) <= 0 {
				t.Fatalf("own rss: %v", p)
			}
		}
	}
	if !found && !all.Data["truncated"].(bool) {
		t.Fatal("the test process itself must be listed")
	}
	m := runOp(t, e, ops.OpMetrics, map[string]any{})
	if _, ok := m.Data["cpuUsagePct"].(float64); !ok {
		t.Fatalf("%v", m.Data)
	}
}
