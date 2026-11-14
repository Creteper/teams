package ratelimit

import (
	"testing"
	"time"
)

func TestAllow(t *testing.T) {
	l := New()
	now := time.Unix(1000, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		if ok, _ := l.Allow("k", 3, time.Minute); !ok {
			t.Fatal("should allow")
		}
	}
	ok, wait := l.Allow("k", 3, time.Minute)
	if ok || wait != 60 {
		t.Fatalf("ok=%v wait=%d", ok, wait)
	}
	if ok, _ := l.Allow("other", 3, time.Minute); !ok {
		t.Fatal("keys independent")
	}
	now = now.Add(61 * time.Second)
	if ok, _ := l.Allow("k", 3, time.Minute); !ok {
		t.Fatal("window should slide")
	}
	if ok, _ := l.Allow("k", 0, time.Minute); !ok {
		t.Fatal("limit 0 disables")
	}
}
