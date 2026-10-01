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
	if !res.OK || d["kernel"] != "6.8.0-test" || d["uptimeSec"] != 12345.67 || d["zenithdVersion"] != "9.9.9" {
		t.Fatalf("%v", d)
	}
	osInfo := d["os"].(map[string]string)
	if osInfo["id"] != "ubuntu" || osInfo["versionId"] != "26.04" || osInfo["prettyName"] != "Ubuntu 26.04 LTS" || len(osInfo) != 4 {
		t.Fatalf("%v", osInfo)
	}
	load := d["loadAvg"].([]float64)
	if load[0] != 0.52 || load[2] != 0.30 {
		t.Fatal(load)
	}
	mem := d["memory"].(map[string]any)
	if mem["totalBytes"] != int64(16384000)*1024 || mem["availableBytes"] != int64(8192000)*1024 || mem["swapFreeBytes"] != int64(2000000)*1024 {
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

func TestProcessListParsesStatAndOmitsCommandLines(t *testing.T) {
	proc, _ := fixtureProc(t)
	e := &ops.Env{ProcRoot: proc}
	res := runOp(t, e, ops.OpProcessList, map[string]any{})
	list := res.Data["processes"].([]map[string]any)
	if res.Data["count"] != 2 || len(list) != 2 {
		t.Fatalf("pid 99 has no stat and must be skipped, 'self' is not a pid: %v", res.Data)
	}
	if list[0]["pid"] != 42 || list[0]["name"] != "my (weird) name" || list[0]["rssBytes"] != int64(50000*1024) || list[0]["uid"] != 1000 || list[0]["threads"] != 4 || list[0]["state"] != "R" || list[0]["ppid"] != 1 || list[0]["cpuTicks"] != uint64(10) {
		t.Fatalf("sorted by rss, parenthesised comm handled: %v", list[0])
	}
	if list[0]["exe"] != "/usr/sbin/nginx" {
		t.Fatalf("exe: %v", list[0]["exe"])
	}
	if list[1]["pid"] != 1 || list[1]["cpuTicks"] != uint64(200) || list[1]["startTicks"] != uint64(100) {
		t.Fatalf("%v", list[1])
	}
	for _, p := range list {
		for _, v := range p {
			if s, ok := v.(string); ok && strings.Contains(s, "hunter2") {
				t.Fatal("command lines must not be reported")
			}
		}
	}
	if res.Data["argvOmitted"] != true {
		t.Fatal("the result must say arguments are omitted")
	}
	res = runOp(t, e, ops.OpProcessList, map[string]any{"limit": 1, "sortBy": "pid"})
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
	cpu := d["cpu"].(map[string]any)
	if cpu["usagePercent"] != 0.0 { // the fixture does not change between samples
		t.Fatalf("%v", cpu)
	}
	net := d["network"].([]map[string]any)
	if len(net) != 2 || net[1]["interface"] != "eth0" || net[1]["rxBytes"] != uint64(987654321) || net[1]["txErrors"] != uint64(4) || net[1]["rxDropped"] != uint64(3) {
		t.Fatalf("%v", net)
	}
	fds := d["fileDescriptors"].(map[string]any)
	if fds["allocated"] != int64(1024) {
		t.Fatalf("%v", fds)
	}
	if d["uptimeSec"] != 12345.67 || d["memory"].(map[string]any)["freeBytes"] != int64(1024000)*1024 {
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
	if len(disks) != 1 || disks[0]["fsType"] == "tmpfs" {
		t.Fatalf("pseudo filesystems must be skipped: %v", disks)
	}
	total, free, used := disks[0]["totalBytes"].(uint64), disks[0]["freeBytes"].(uint64), disks[0]["usedBytes"].(uint64)
	if total == 0 || free > total || used != total-free {
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
	if res.Data["kernel"] == "" || res.Data["uptimeSec"].(float64) <= 0 || res.Data["memory"].(map[string]any)["totalBytes"].(int64) <= 0 {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpProcessList, map[string]any{"limit": 5})
	if res.Data["count"].(int) < 1 {
		t.Fatalf("%v", res.Data)
	}
	self := os.Getpid()
	all := runOp(t, e, ops.OpProcessList, map[string]any{"limit": 1000, "sortBy": "pid"})
	found := false
	for _, p := range all.Data["processes"].([]map[string]any) {
		if p["pid"] == self {
			found = true
			if p["rssBytes"].(int64) <= 0 {
				t.Fatalf("own rss: %v", p)
			}
		}
	}
	if !found && !all.Data["truncated"].(bool) {
		t.Fatal("the test process itself must be listed")
	}
	m := runOp(t, e, ops.OpMetrics, map[string]any{})
	if _, ok := m.Data["cpu"].(map[string]any)["usagePercent"].(float64); !ok {
		t.Fatalf("%v", m.Data)
	}
}
