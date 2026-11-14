package httpapi

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/creteper/teams/backend/internal/config"
)

func TestWebSocketEvents(t *testing.T) {
	e := newEnv(t)
	owner, alice, bob := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	e.addMember(owner, tm, alice)
	wsA := e.dialWS(alice.Token)
	wsO := e.dialWS(owner.Token)

	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "hello"})
	ev := wsA.waitFor("message.created", 2*time.Second)
	if ev == nil || ev["team_id"] != tm.ID || ev["data"].(map[string]any)["content"] != "hello" || ev["id"] == nil || ev["ts"] == nil {
		t.Fatalf("message.created: %v", ev)
	}
	wsA.send(map[string]string{"type": "ping"})
	pong := wsA.waitFor("pong", 2*time.Second)
	if pong == nil {
		t.Fatal("no pong")
	}
	if _, has := pong["team_id"]; has {
		t.Fatalf("pong must not carry team_id: %v", pong)
	}
	wsA.send(map[string]string{"type": "bogus"})
	if er := wsA.waitFor("error", 2*time.Second); er == nil || er["team_id"] != nil {
		t.Fatalf("error frame: %v", er)
	}

	// bob joins: bob gets team.joined (and is subscribed), others get member.joined
	wsB := e.dialWS(bob.Token)
	bobMember := e.addMember(owner, tm, bob)
	tj := wsB.waitFor("team.joined", 2*time.Second)
	if tj == nil || tj["team_id"] != tm.ID || tj["data"].(map[string]any)["my_member_id"] != bobMember || tj["data"].(map[string]any)["name"] == nil {
		t.Fatalf("team.joined: %v", tj)
	}
	if mj := wsO.waitFor("member.joined", 2*time.Second); mj == nil || mj["data"].(map[string]any)["id"] != bobMember {
		t.Fatalf("member.joined: %v", mj)
	}
	if mj := wsB.waitFor("member.joined", 200*time.Millisecond); mj != nil {
		t.Fatalf("bob must not get member.joined about himself: %v", mj)
	}
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "welcome"})
	if ev := wsB.waitFor("message.created", 2*time.Second); ev == nil {
		t.Fatal("bob not subscribed after join")
	}
	// bob removed: bob gets team.removed and is unsubscribed; others get member.left
	e.must(204, "DELETE", "/api/v1/teams/"+tm.ID+"/members/"+bobMember, owner.Token, nil)
	if tr := wsB.waitFor("team.removed", 2*time.Second); tr == nil || tr["team_id"] != tm.ID {
		t.Fatalf("team.removed: %v", tr)
	}
	if ml := wsA.waitFor("member.left", 2*time.Second); ml == nil || ml["data"].(map[string]any)["member_id"] != bobMember {
		t.Fatalf("member.left: %v", ml)
	}
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "secret"})
	if ev := wsB.waitFor("message.created", 300*time.Millisecond); ev != nil {
		t.Fatalf("removed user still receives: %v", ev)
	}
	// channel events
	e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", owner.Token, map[string]any{"name": "news"})
	if ev := wsA.waitFor("channel.created", 2*time.Second); ev == nil || ev["team_id"] != tm.ID {
		t.Fatalf("channel.created: %v", ev)
	}
	// creating a team sends team.joined to creator's connections
	e.must(201, "POST", "/api/v1/teams", alice.Token, map[string]any{"name": "Mine"})
	if ev := wsA.waitFor("team.joined", 2*time.Second); ev == nil {
		t.Fatal("creator team.joined")
	}

	// bot token over WS via Authorization header
	b, _ := e.newBot(owner, tm, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	bc, _, err := websocket.Dial(ctx, e.wsURL(), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + b.Token}}})
	if err != nil {
		t.Fatal(err)
	}
	_, data, err := bc.Read(ctx)
	if err != nil || !contains(data, `"type":"ready"`) {
		t.Fatalf("bot ready: %s %v", data, err)
	}
	bc.CloseNow()
}

func TestWebSocketAuthAndOrigin(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, e.wsURL(), nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"auth","token":"tas_bad"}`))
	_, data, _ := c.Read(ctx)
	if !contains(data, `"unauthorized"`) {
		t.Fatalf("expected unauthorized frame: %s", data)
	}
	_, _, err = c.Read(ctx)
	if websocket.CloseStatus(err) != 4401 {
		t.Fatalf("close code: %v", err)
	}
	// disallowed origin
	_, res, err := websocket.Dial(ctx, e.wsURL(), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://evil.example"}}})
	if err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("bad origin accepted: %v", err)
	}
	// allowed origin (5190)
	u := e.newUser()
	ok, _, err := websocket.Dial(ctx, e.wsURL(), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://localhost:5190"}}})
	if err != nil {
		t.Fatalf("allowed origin rejected: %v", err)
	}
	ok.Write(ctx, websocket.MessageText, []byte(`{"type":"auth","token":"`+u.Token+`"}`))
	_, data, err = ok.Read(ctx)
	if err != nil || !contains(data, `"ready"`) {
		t.Fatalf("ready: %s", data)
	}
	ok.CloseNow()
	// CORS preflight
	req, _ := http.NewRequest("OPTIONS", e.ts.URL+"/api/v1/teams", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5190")
	res2, _ := http.DefaultClient.Do(req)
	if res2.StatusCode != 204 || res2.Header.Get("Access-Control-Allow-Origin") != "http://127.0.0.1:5190" {
		t.Fatalf("CORS: %d %v", res2.StatusCode, res2.Header)
	}
}

func TestInvites(t *testing.T) {
	e := newEnv(t)
	owner, alice, bob := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	base := "/api/v1/teams/" + tm.ID + "/invites"

	inv := e.must(201, "POST", base, owner.Token, map[string]any{})
	code := inv["code"].(string)
	if len(code) != 10 || inv["url_path"] != "/invite/"+code || inv["expires_at"] != nil || inv["max_uses"] != nil || inv["uses"].(float64) != 0 || inv["created_by"] != tm.MemberID {
		t.Fatalf("invite: %v", inv)
	}
	for _, body := range []map[string]any{{"expires_in_seconds": 59}, {"expires_in_seconds": 2592001}, {"max_uses": 0}, {"max_uses": 1001}} {
		if r := e.do("POST", base, owner.Token, body); r.Status != 400 {
			t.Fatalf("validation %v: %d", body, r.Status)
		}
	}
	// preview without login
	pv := e.must(200, "GET", "/api/v1/invites/"+code, "", nil)
	if pv["valid"] != true || pv["team"].(map[string]any)["member_count"].(float64) != 1 || pv["reason"] != nil {
		t.Fatalf("preview: %v", pv)
	}
	if r := e.do("GET", "/api/v1/invites/ZZZZZZZZZZ", "", nil); r.Status != 404 || r.errCode() != "invite_not_found" {
		t.Fatalf("unknown code: %d %s", r.Status, r.Body)
	}
	// accept + WS fan-out
	wsO := e.dialWS(owner.Token)
	wsA := e.dialWS(alice.Token)
	acc := e.must(200, "POST", "/api/v1/invites/"+code+"/accept", alice.Token, nil)
	if acc["already_member"] != false || acc["team"].(map[string]any)["id"] != tm.ID || acc["member"].(map[string]any)["type"] != "user" {
		t.Fatalf("accept: %v", acc)
	}
	if ev := wsA.waitFor("team.joined", 2*time.Second); ev == nil || ev["team_id"] != tm.ID {
		t.Fatalf("team.joined: %v", ev)
	}
	if ev := wsO.waitFor("member.joined", 2*time.Second); ev == nil {
		t.Fatal("member.joined")
	}
	again := e.must(200, "POST", "/api/v1/invites/"+code+"/accept", alice.Token, nil)
	if again["already_member"] != true {
		t.Fatalf("already member: %v", again)
	}
	// members cannot manage invites; bots cannot accept
	if r := e.do("POST", base, alice.Token, map[string]any{}); r.Status != 403 {
		t.Fatalf("member creates invite: %d", r.Status)
	}
	if r := e.do("GET", base, alice.Token, nil); r.Status != 403 {
		t.Fatalf("member lists invites: %d", r.Status)
	}
	b, _ := e.newBot(owner, tm, nil)
	if r := e.do("POST", "/api/v1/invites/"+code+"/accept", b.Token, nil); r.Status != 403 {
		t.Fatalf("bot accepts: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/invites/"+code+"/accept", "", nil); r.Status != 401 {
		t.Fatalf("anon accepts: %d", r.Status)
	}
	var uses int
	testPool.QueryRow(t.Context(), `SELECT uses FROM team_invites WHERE code=$1`, code).Scan(&uses)
	if uses != 1 {
		t.Fatalf("uses = %d, want 1", uses)
	}

	// revoke (idempotent)
	e.must(204, "DELETE", base+"/"+inv["id"].(string), owner.Token, nil)
	e.must(204, "DELETE", base+"/"+inv["id"].(string), owner.Token, nil)
	pv = e.must(200, "GET", "/api/v1/invites/"+code, "", nil)
	if pv["valid"] != false || pv["reason"] != "revoked" {
		t.Fatalf("revoked preview: %v", pv)
	}
	if r := e.do("POST", "/api/v1/invites/"+code+"/accept", bob.Token, nil); r.Status != 410 || r.errCode() != "invite_revoked" {
		t.Fatalf("revoked accept: %d %s", r.Status, r.Body)
	}
	// expired
	exp := e.must(201, "POST", base, owner.Token, map[string]any{"expires_in_seconds": 60})
	testPool.Exec(t.Context(), `UPDATE team_invites SET expires_at = now() - interval '1 second' WHERE id=$1`, exp["id"])
	if r := e.do("POST", "/api/v1/invites/"+exp["code"].(string)+"/accept", bob.Token, nil); r.Status != 410 || r.errCode() != "invite_expired" {
		t.Fatalf("expired accept: %d %s", r.Status, r.Body)
	}
	if pv := e.must(200, "GET", "/api/v1/invites/"+exp["code"].(string), "", nil); pv["reason"] != "expired" {
		t.Fatalf("expired preview: %v", pv)
	}
	// exhausted
	one := e.must(201, "POST", base, owner.Token, map[string]any{"max_uses": 1})
	e.must(200, "POST", "/api/v1/invites/"+one["code"].(string)+"/accept", bob.Token, nil)
	carol := e.newUser()
	if r := e.do("POST", "/api/v1/invites/"+one["code"].(string)+"/accept", carol.Token, nil); r.Status != 410 || r.errCode() != "invite_exhausted" {
		t.Fatalf("exhausted accept: %d %s", r.Status, r.Body)
	}
	// list includes invalid invites, paginated
	l := e.must(200, "GET", base+"?limit=2", owner.Token, nil)
	if len(items(l)) != 2 || l["has_more"] != true {
		t.Fatalf("list page1: %v", l)
	}
	l2 := e.must(200, "GET", base+"?limit=2&cursor="+l["next_cursor"].(string), owner.Token, nil)
	if len(items(l2)) != 1 || l2["has_more"] != false {
		t.Fatalf("list page2: %v", l2)
	}
	if r := e.do("DELETE", base+"/0193aaaa-1111-7000-8000-00000000000f", owner.Token, nil); r.Status != 404 {
		t.Fatalf("revoke unknown: %d", r.Status)
	}
}

func TestInviteConcurrentMaxUses(t *testing.T) {
	e := newEnv(t)
	owner := e.newUser()
	tm := e.newTeam(owner)
	inv := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/invites", owner.Token, map[string]any{"max_uses": 3})
	code := inv["code"].(string)
	users := make([]user, 12)
	for i := range users {
		users[i] = e.newUser()
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	errs := map[string]int{}
	start := make(chan struct{})
	for _, u := range users {
		wg.Add(1)
		go func(u user) {
			defer wg.Done()
			<-start
			r := e.do("POST", "/api/v1/invites/"+code+"/accept", u.Token, nil)
			mu.Lock()
			codes[r.Status]++
			if r.Status != 200 {
				errs[r.errCode()]++
			}
			mu.Unlock()
		}(u)
	}
	close(start)
	wg.Wait()
	if codes[200] != 3 || codes[410] != 9 || errs["invite_exhausted"] != 9 {
		t.Fatalf("concurrent accept: %v %v", codes, errs)
	}
	var uses, members int
	testPool.QueryRow(t.Context(), `SELECT uses FROM team_invites WHERE code=$1`, code).Scan(&uses)
	testPool.QueryRow(t.Context(), `SELECT count(*) FROM team_members WHERE team_id=$1 AND left_at IS NULL`, tm.ID).Scan(&members)
	if uses != 3 || members != 4 {
		t.Fatalf("uses=%d members=%d", uses, members)
	}
}

func TestInvitePreviewRateLimit(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.InvitePreviewRatePerMinute = 2 })
	owner := e.newUser()
	tm := e.newTeam(owner)
	inv := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/invites", owner.Token, map[string]any{})
	e.must(200, "GET", "/api/v1/invites/"+inv["code"].(string), "", nil)
	e.must(200, "GET", "/api/v1/invites/"+inv["code"].(string), "", nil)
	r := e.do("GET", "/api/v1/invites/"+inv["code"].(string), "", nil)
	if r.Status != 429 || r.Header.Get("Retry-After") == "" || r.errCode() != "rate_limited" {
		t.Fatalf("preview rate limit: %d %s", r.Status, r.Body)
	}
}
