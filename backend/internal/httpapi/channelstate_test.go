package httpapi

import (
	"testing"
	"time"
)

func channelByID(t *testing.T, e *env, tok, teamID, chID string) map[string]any {
	t.Helper()
	for _, c := range items(e.must(200, "GET", "/api/v1/teams/"+teamID+"/channels", tok, nil)) {
		if c["id"] == chID {
			return c
		}
	}
	t.Fatalf("channel %s not in list", chID)
	return nil
}

func num(v any) int64 { f, _ := v.(float64); return int64(f) }

func TestUnreadCountsAndMarkRead(t *testing.T) {
	e := newEnv(t)
	a, b := e.newUser(), e.newUser()
	tm := e.newTeam(a)
	m1 := e.send(a.Token, tm.GeneralID, map[string]any{"content": "before B joined"})
	bMember := e.addMember(a, tm, b)

	// history before joining counts as read
	c := channelByID(t, e, b.Token, tm.ID, tm.GeneralID)
	if num(c["unread_count"]) != 0 || c["has_unread_mention"] != false || c["pinned"] != false || num(c["last_read_seq"]) < num(m1["seq"]) {
		t.Fatalf("fresh member state: %v", c)
	}
	if _, ok := c["pinned_at"]; !ok {
		t.Fatal("pinned_at missing")
	}
	m2 := e.send(a.Token, tm.GeneralID, map[string]any{"content": "hello"})
	m3 := e.send(a.Token, tm.GeneralID, map[string]any{"content": "<@" + bMember + "> look"})
	c = channelByID(t, e, b.Token, tm.ID, tm.GeneralID)
	if num(c["unread_count"]) != 2 || c["has_unread_mention"] != true {
		t.Fatalf("B unread: %v", c)
	}
	// own messages are never unread; sending advanced A's read position
	c = channelByID(t, e, a.Token, tm.ID, tm.GeneralID)
	if num(c["unread_count"]) != 0 || num(c["last_read_seq"]) != num(m3["seq"]) {
		t.Fatalf("A state: %v", c)
	}
	// single channel GET carries the same state
	g := e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID, b.Token, nil)
	if num(g["unread_count"]) != 2 {
		t.Fatalf("get channel: %v", g)
	}
	// summary
	sum := items(e.must(200, "GET", "/api/v1/me/unread", b.Token, nil))
	if len(sum) != 1 || sum[0]["channel_id"] != tm.GeneralID || sum[0]["team_id"] != tm.ID || num(sum[0]["unread_count"]) != 2 {
		t.Fatalf("me/unread: %v", sum)
	}

	ws := e.dialWS(b.Token)
	other := e.dialWS(a.Token)
	r := e.must(200, "POST", "/api/v1/channels/"+tm.GeneralID+"/read", b.Token, map[string]any{"seq": m2["seq"]})
	if num(r["last_read_seq"]) != num(m2["seq"]) || num(r["unread_count"]) != 1 || r["has_unread_mention"] != true || r["channel_id"] != tm.GeneralID {
		t.Fatalf("read to m2: %v", r)
	}
	ev := ws.waitFor("channel.read", 2*time.Second)
	if ev == nil || ev["team_id"] != tm.ID {
		t.Fatalf("channel.read event: %v", ev)
	}
	if d := ev["data"].(map[string]any); num(d["unread_count"]) != 1 || num(d["last_read_seq"]) != num(m2["seq"]) {
		t.Fatalf("channel.read data: %v", d)
	}
	if x := other.waitFor("channel.read", 200*time.Millisecond); x != nil {
		t.Fatalf("channel.read leaked to another user: %v", x)
	}
	// never moves backwards
	r = e.must(200, "POST", "/api/v1/channels/"+tm.GeneralID+"/read", b.Token, map[string]any{"seq": m1["seq"]})
	if num(r["last_read_seq"]) != num(m2["seq"]) {
		t.Fatalf("read moved back: %v", r)
	}
	// no body = mark everything read; a too-large seq is clamped to the channel's newest
	r = e.must(200, "POST", "/api/v1/channels/"+tm.GeneralID+"/read", b.Token, nil)
	if num(r["last_read_seq"]) != num(m3["seq"]) || num(r["unread_count"]) != 0 || r["has_unread_mention"] != false {
		t.Fatalf("read all: %v", r)
	}
	r = e.must(200, "POST", "/api/v1/channels/"+tm.GeneralID+"/read", b.Token, map[string]any{"seq": 1 << 50})
	if num(r["last_read_seq"]) != num(m3["seq"]) {
		t.Fatalf("clamp: %v", r)
	}
	if rr := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/read", b.Token, map[string]any{"seq": -1}); rr.Status != 400 {
		t.Fatalf("negative seq: %d", rr.Status)
	}
	if len(items(e.must(200, "GET", "/api/v1/me/unread", b.Token, nil))) != 0 {
		t.Fatal("summary should be empty")
	}

	// deleted messages are not unread
	m4 := e.send(a.Token, tm.GeneralID, map[string]any{"content": "<@" + bMember + "> oops"})
	e.must(204, "DELETE", "/api/v1/messages/"+m4["id"].(string), a.Token, nil)
	c = channelByID(t, e, b.Token, tm.ID, tm.GeneralID)
	if num(c["unread_count"]) != 0 || c["has_unread_mention"] != false {
		t.Fatalf("deleted counted: %v", c)
	}

	// B replying marks the channel read for B and syncs B's other connections
	e.send(a.Token, tm.GeneralID, map[string]any{"content": "q?"})
	e.send(b.Token, tm.GeneralID, map[string]any{"content": "a!"})
	if ev := ws.waitFor("channel.read", 2*time.Second); ev == nil || num(ev["data"].(map[string]any)["unread_count"]) != 0 {
		t.Fatalf("send should sync read: %v", ev)
	}
	if c := channelByID(t, e, a.Token, tm.ID, tm.GeneralID); num(c["unread_count"]) != 1 {
		t.Fatalf("A should see B's message unread: %v", c)
	}

	// a channel created after joining starts fully unread
	ch := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", a.Token, map[string]any{"name": "later"})
	e.send(a.Token, ch["id"].(string), map[string]any{"content": "x"})
	if c := channelByID(t, e, b.Token, tm.ID, ch["id"].(string)); num(c["unread_count"]) != 1 {
		t.Fatalf("new channel: %v", c)
	}
	// channel.created (team-wide) must not carry personal fields
	if _, ok := ch["unread_count"]; ok {
		t.Fatalf("create response has user state: %v", ch)
	}

	// bots see no per-user fields; bots cannot mark read
	bt, _ := e.newBot(a, tm, nil)
	bc := items(e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/channels", bt.Token, nil))[0]
	if _, ok := bc["unread_count"]; ok {
		t.Fatalf("bot got unread fields: %v", bc)
	}
	if rr := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/read", bt.Token, nil); rr.Status != 403 {
		t.Fatalf("bot read: %d", rr.Status)
	}
	// outsiders get 404
	if rr := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/read", e.newUser().Token, nil); rr.Status != 404 {
		t.Fatalf("outsider read: %d", rr.Status)
	}
}

func TestUnreadCap(t *testing.T) {
	e := newEnv(t)
	a, b := e.newUser(), e.newUser()
	tm := e.newTeam(a)
	var mid string
	e.addMember(a, tm, b)
	testPool.QueryRow(t.Context(), `SELECT id FROM team_members WHERE team_id=$1 AND role='owner'`, tm.ID).Scan(&mid)
	if _, err := testPool.Exec(t.Context(), `INSERT INTO messages(id, team_id, channel_id, sender_member_id, content)
		SELECT gen_random_uuid(), $1, $2, $3, 'bulk' FROM generate_series(1, $4)`, tm.ID, tm.GeneralID, mid, unreadCap+5); err != nil {
		t.Fatal(err)
	}
	if c := channelByID(t, e, b.Token, tm.ID, tm.GeneralID); num(c["unread_count"]) != unreadCap {
		t.Fatalf("cap: %v", c["unread_count"])
	}
}

func TestChannelPin(t *testing.T) {
	e := newEnv(t)
	a, b := e.newUser(), e.newUser()
	tm := e.newTeam(a)
	e.addMember(a, tm, b)
	ws := e.dialWS(b.Token)
	p := e.must(200, "PUT", "/api/v1/channels/"+tm.GeneralID+"/pin", b.Token, nil)
	if p["pinned"] != true || p["pinned_at"] == nil || p["channel_id"] != tm.GeneralID {
		t.Fatalf("pin: %v", p)
	}
	ev := ws.waitFor("channel.pinned", 2*time.Second)
	if ev == nil || ev["data"].(map[string]any)["pinned"] != true {
		t.Fatalf("channel.pinned: %v", ev)
	}
	// idempotent: same pinned_at, no second event
	p2 := e.must(200, "PUT", "/api/v1/channels/"+tm.GeneralID+"/pin", b.Token, nil)
	if p2["pinned_at"] != p["pinned_at"] {
		t.Fatalf("re-pin changed time: %v %v", p, p2)
	}
	if x := ws.waitFor("channel.pinned", 200*time.Millisecond); x != nil {
		t.Fatalf("duplicate pin event: %v", x)
	}
	// per user
	if c := channelByID(t, e, b.Token, tm.ID, tm.GeneralID); c["pinned"] != true || c["pinned_at"] != p["pinned_at"] {
		t.Fatalf("B list: %v", c)
	}
	if c := channelByID(t, e, a.Token, tm.ID, tm.GeneralID); c["pinned"] != false || c["pinned_at"] != nil {
		t.Fatalf("A list: %v", c)
	}
	// pin row must not disturb unread (join default still applies)
	if c := channelByID(t, e, b.Token, tm.ID, tm.GeneralID); num(c["unread_count"]) != 0 {
		t.Fatalf("pin changed unread: %v", c)
	}
	u := e.must(200, "DELETE", "/api/v1/channels/"+tm.GeneralID+"/pin", b.Token, nil)
	if u["pinned"] != false || u["pinned_at"] != nil {
		t.Fatalf("unpin: %v", u)
	}
	if ev := ws.waitFor("channel.pinned", 2*time.Second); ev == nil || ev["data"].(map[string]any)["pinned"] != false {
		t.Fatalf("unpin event: %v", ev)
	}
	e.must(200, "DELETE", "/api/v1/channels/"+tm.GeneralID+"/pin", b.Token, nil)
	if r := e.do("PUT", "/api/v1/channels/"+tm.GeneralID+"/pin", e.newUser().Token, nil); r.Status != 404 {
		t.Fatalf("outsider pin: %d", r.Status)
	}
	bt, _ := e.newBot(a, tm, nil)
	if r := e.do("PUT", "/api/v1/channels/"+tm.GeneralID+"/pin", bt.Token, nil); r.Status != 403 {
		t.Fatalf("bot pin: %d", r.Status)
	}
}

func TestMemberProfile(t *testing.T) {
	e := newEnv(t)
	a, b := e.newUser(), e.newUser()
	tm := e.newTeam(a)
	bMember := e.addMember(a, tm, b)
	bt, _ := e.newBot(a, tm, map[string]any{"description": "总结讨论的 bot"})

	m := e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members/"+bMember, a.Token, nil)
	if m["id"] != bMember || m["username"] != b.Username || m["display_name"] != "User "+b.Username || m["role"] != "member" ||
		m["type"] != "user" || m["joined_at"] == nil || m["description"] != nil {
		t.Fatalf("user profile: %v", m)
	}
	if _, ok := m["avatar_url"]; !ok {
		t.Fatal("avatar_url missing")
	}
	bm := e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members/"+bt.MemberID, b.Token, nil)
	if bm["type"] != "bot" || bm["description"] != "总结讨论的 bot" || bm["role"] != "bot" {
		t.Fatalf("bot profile: %v", bm)
	}
	// bot tokens may read profiles in their own team
	e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members/"+bMember, bt.Token, nil)
	// member list carries description too
	for _, x := range items(e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members", a.Token, nil)) {
		if x["id"] == bt.MemberID && x["description"] != "总结讨论的 bot" {
			t.Fatalf("list description: %v", x)
		}
	}
	// other team / outsider / bad id → 404
	other := e.newTeam(e.newUser())
	if r := e.do("GET", "/api/v1/teams/"+tm.ID+"/members/"+other.MemberID, a.Token, nil); r.Status != 404 {
		t.Fatalf("cross-team: %d", r.Status)
	}
	if r := e.do("GET", "/api/v1/teams/"+tm.ID+"/members/"+bMember, e.newUser().Token, nil); r.Status != 404 {
		t.Fatalf("outsider: %d", r.Status)
	}
	if r := e.do("GET", "/api/v1/teams/"+tm.ID+"/members/nope", a.Token, nil); r.Status != 404 {
		t.Fatalf("bad id: %d", r.Status)
	}
	// former members stay viewable (old messages), flagged deleted
	e.must(204, "DELETE", "/api/v1/teams/"+tm.ID+"/members/me", b.Token, nil)
	if m := e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members/"+bMember, a.Token, nil); m["deleted"] != true {
		t.Fatalf("left member: %v", m)
	}
}
