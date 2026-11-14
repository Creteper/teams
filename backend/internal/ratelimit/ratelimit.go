// Package ratelimit is a small in-memory sliding-window limiter.
package ratelimit

import (
	"math"
	"sync"
	"time"
)

type Limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
	now  func() time.Time
	ops  int
}

func New() *Limiter { return &Limiter{hits: map[string][]time.Time{}, now: time.Now} }

// Allow records a hit for key and reports whether it is within limit per
// window. When rejected it returns the seconds until a slot frees up.
// limit <= 0 always allows.
func (l *Limiter) Allow(key string, limit int, window time.Duration) (bool, int) {
	if limit <= 0 {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cut := now.Add(-window)
	h := l.hits[key]
	i := 0
	for i < len(h) && !h[i].After(cut) {
		i++
	}
	h = h[i:]
	if len(h) >= limit {
		l.hits[key] = h
		wait := h[0].Add(window).Sub(now)
		return false, int(math.Max(1, math.Ceil(wait.Seconds())))
	}
	l.hits[key] = append(h, now)
	l.ops++
	if l.ops%1000 == 0 {
		l.gc(now)
	}
	return true, 0
}

func (l *Limiter) gc(now time.Time) {
	for k, h := range l.hits {
		if len(h) == 0 || now.Sub(h[len(h)-1]) > time.Hour {
			delete(l.hits, k)
		}
	}
}
