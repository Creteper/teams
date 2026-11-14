package httpapi

import (
	"sync"
	"testing"
	"time"

	"github.com/creteper/teams/backend/internal/config"
)

// Bot tokens: 120 requests/minute per bot for GETs and message PATCH/DELETE;
// sending has its own limit; user sessions are not affected.
func TestBotAPIRateLimit(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.BotAPIRatePerMinute = 120 })
	var mu sync.Mutex
	now := time.Unix(1_800_000_000, 0)
	e.srv.limiter.SetClock(func() time.Time { mu.Lock(); defer mu.Unlock(); return now })
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }

	owner := e.newUser()
	tm := e.newTeam(owner)
	b, _ := e.newBot(owner, tm, nil)
	b2, _ := e.newBot(owner, tm, nil)
	list := "/api/v1/channels/" + tm.GeneralID + "/messages"

	// sending does not consume the quota
	var mine []string
	for i := 0; i < 5; i++ {
		mine = append(mine, e.send(b.Token, tm.GeneralID, map[string]any{"content": "hi"})["id"].(string))
	}
	// 120 counted requests: GETs + one edit + one delete
	e.must(200, "PATCH", "/api/v1/messages/"+mine[0], b.Token, map[string]any{"content": "edited"})
	e.must(204, "DELETE", "/api/v1/messages/"+mine[1], b.Token, nil)
	e.must(200, "GET", "/api/v1/bots/me", b.Token, nil)
	e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members", b.Token, nil)
	for i := 0; i < 116; i++ {
		e.must(200, "GET", list, b.Token, nil)
	}
	// 121st → 429 with Retry-After and the standard error body
	r := e.do("GET", "/api/v1/messages/"+mine[2], b.Token, nil)
	if r.Status != 429 || r.errCode() != "rate_limited" || r.Header.Get("Retry-After") != "60" {
		t.Fatalf("121st: %d %q %s", r.Status, r.Header.Get("Retry-After"), r.Body)
	}
	for _, m := range []string{"PATCH", "DELETE"} {
		if r := e.do(m, "/api/v1/messages/"+mine[2], b.Token, map[string]any{"content": "x"}); r.Status != 429 {
			t.Fatalf("%s over quota: %d", m, r.Status)
		}
	}
	// sending still works; other bots and user sessions are unaffected
	e.send(b.Token, tm.GeneralID, map[string]any{"content": "still can send"})
	e.must(200, "GET", list, b2.Token, nil)
	for i := 0; i < 150; i++ {
		e.must(200, "GET", list, owner.Token, nil)
	}
	// Retry-After counts down (rounded up), then the window frees up
	advance(30*time.Second + 500*time.Millisecond)
	if r := e.do("GET", list, b.Token, nil); r.Status != 429 || r.Header.Get("Retry-After") != "30" {
		t.Fatalf("half window: %d %q", r.Status, r.Header.Get("Retry-After"))
	}
	advance(30 * time.Second)
	e.must(200, "GET", list, b.Token, nil)
}
