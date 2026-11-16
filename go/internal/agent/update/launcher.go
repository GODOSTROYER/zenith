package update

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// EnvActiveSlot is set by the launcher on the release it execs. A process that
// sees it is already the active release and must not launch again.
const EnvActiveSlot = "ZENITH_RELEASE_SLOT"

// LaunchOptions configure the launcher decision.
type LaunchOptions struct {
	StateDir string
	// Self is this process's executable path (the packaged baseline).
	Self string
	// Args is os.Args (Args[0] is replaced with the slot path on exec).
	Args     []string
	Environ  []string
	Now      func() time.Time
	MaxBoots int
	// Logf receives launcher decisions (stderr in production).
	Logf func(format string, args ...any)
}

// Plan is the launcher's decision.
type Plan struct {
	// ExecPath is the slot binary to exec; empty means run in this process.
	ExecPath   string
	SlotSHA    string
	RolledBack bool
	Reason     string
}

// Decide chooses which binary should run. It increments the pending boot
// counter, rolls back an unhealthy or looping pending release, and refuses to
// exec a slot whose file no longer matches its recorded digest (tampering or
// disk corruption): that is also a rollback, never a "run it anyway".
func Decide(o LaunchOptions) (Plan, error) {
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.MaxBoots <= 0 {
		o.MaxBoots = DefaultMaxBoots
	}
	for _, e := range o.Environ {
		if strings.HasPrefix(e, EnvActiveSlot+"=") {
			return Plan{}, nil
		}
	}
	store := NewStore(o.StateDir)
	if !store.Exists() {
		return Plan{}, nil
	}
	var plan Plan
	_, err := store.Update(func(st *State) error {
		now := o.Now().UTC()
		if st.Pending != nil {
			switch {
			case !now.Before(st.Pending.Deadline):
				o.Logf("release %s did not become healthy before its deadline; rolling back", st.Pending.Version)
				plan.RolledBack = rollbackState(st, now, "health deadline passed before the release committed")
			case st.Pending.Boots >= o.MaxBoots:
				o.Logf("release %s restarted %d times without becoming healthy; rolling back", st.Pending.Version, st.Pending.Boots)
				plan.RolledBack = rollbackState(st, now, "release restarted repeatedly without becoming healthy")
			default:
				st.Pending.Boots++
			}
		}
		// Verify the slot that will run; fall back at most once.
		for attempt := 0; attempt < 2; attempt++ {
			if st.Active == nil {
				return nil // baseline
			}
			if err := verifySlot(*st.Active); err != nil {
				o.Logf("active release %s is unusable (%v); rolling back", st.Active.Version, err)
				if !rollbackState(st, now, "active release failed verification: "+err.Error()) {
					return nil
				}
				plan.RolledBack = true
				continue
			}
			plan.ExecPath = st.Active.Path
			plan.SlotSHA = st.Active.SHA256
			return nil
		}
		st.Active, st.Pending = nil, nil // both slots unusable: baseline
		return nil
	})
	if err != nil {
		return Plan{}, err
	}
	if plan.RolledBack {
		plan.Reason = "rolled back"
	}
	return plan, nil
}

func verifySlot(s Slot) error {
	if s.Path == "" || !filepath.IsAbs(s.Path) {
		return errors.New("slot path is not absolute")
	}
	info, err := os.Stat(s.Path)
	if err != nil {
		return fmt.Errorf("binary is missing: %w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("slot is not a regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o022 != 0 {
		return errors.New("slot is group or world writable")
	}
	f, err := os.Open(s.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != s.SHA256 {
		return errors.New("binary digest differs from the verified digest")
	}
	return nil
}

// Launch applies the plan: it execs the active release (never returns on
// success, except on Windows where the child's exit code is returned) or
// reports handled=false so the caller runs in-process.
func Launch(o LaunchOptions) (code int, handled bool, err error) {
	plan, err := Decide(o)
	if err != nil {
		// A broken state file must not strand the agent: run the baseline.
		if o.Logf != nil {
			o.Logf("update state unreadable (%v); running the packaged binary", err)
		}
		return 0, false, nil
	}
	if plan.ExecPath == "" || filepath.Clean(plan.ExecPath) == filepath.Clean(o.Self) {
		return 0, false, nil
	}
	args := append([]string{plan.ExecPath}, o.Args[1:]...)
	env := append(append([]string(nil), o.Environ...), EnvActiveSlot+"="+plan.SlotSHA)
	code, err = execReplace(plan.ExecPath, args, env)
	if err != nil {
		// exec failed (corrupt binary, wrong arch): record a rollback and run
		// the baseline now; the next start uses the restored slot.
		store := NewStore(o.StateDir)
		_, _ = store.Update(func(st *State) error {
			rollbackState(st, time.Now().UTC(), "release could not be executed: "+err.Error())
			return nil
		})
		return 0, false, nil
	}
	return code, true, nil
}
