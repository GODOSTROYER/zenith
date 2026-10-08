#!/bin/sh
# Executed as zenithd by PID 1 inside the actual service sandbox.
set -eu
test "$(id -u)" -ne 0
test "$(awk '/^CapEff:/ {print $2}' /proc/self/status)" = 0000000000000000
test "$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status)" = 1
relative=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
test -n "$relative"
group="/sys/fs/cgroup$relative"
test -f "$group/cgroup.controllers"
child="$group/mach04-check"
mkdir "$child"
cleanup() {
  printf '%s\n' '-cpu -memory -pids' > "$group/cgroup.subtree_control"
  printf '%s\n' "$$" > "$group/cgroup.procs"
  rmdir "$child"
}
trap cleanup EXIT HUP INT TERM
printf '%s\n' "$$" > "$child/cgroup.procs"
printf '%s\n' '+cpu +memory +pids' > "$group/cgroup.subtree_control"
printf '%s\n' 67108864 > "$child/memory.max"
printf '%s\n' 16 > "$child/pids.max"
printf '%s\n' '10000 100000' > "$child/cpu.max"
test "$(cat "$child/memory.max")" = 67108864
test "$(cat "$child/pids.max")" = 16
test "$(cat "$child/cpu.max")" = '10000 100000'
printf '%s\n' 'unprivileged cgroup delegation verified' > "$ZENITH_STATE_DIR/delegation-proof"
