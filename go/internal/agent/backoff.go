package agent

import (
	"math/rand/v2"
	"sync"
	"time"
)

// Backoff produces exponentially growing, jittered delays (1 s -> 60 s by
// default). Jitter keeps a fleet of agents from reconnecting in lockstep
// after a control-plane restart.
type Backoff struct {
	Min, Max time.Duration
	// Rand returns a float in [0,1); nil uses math/rand/v2.
	Rand func() float64

	mu sync.Mutex
	n  int
}

// NewBackoff returns the spec backoff: 1 s doubling to 60 s.
func NewBackoff() *Backoff { return &Backoff{Min: time.Second, Max: 60 * time.Second} }

// Next returns the next delay: half of the exponential step plus a random
// half ("equal jitter"), so it is always within [step/2, step].
func (b *Backoff) Next() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	step := b.Min << uint(min(b.n, 20))
	if step <= 0 || step > b.Max {
		step = b.Max
	}
	b.n++
	r := rand.Float64
	if b.Rand != nil {
		r = b.Rand
	}
	return step/2 + time.Duration(r()*float64(step/2))
}

// Reset is called after a success.
func (b *Backoff) Reset() {
	b.mu.Lock()
	b.n = 0
	b.mu.Unlock()
}
