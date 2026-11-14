package httpapi

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAuthFlow(t *testing.T) {
	e := newEnv(t)
	u := e.newUser()

	r := e.do("POST", "/api/v1/auth/register", "", map[string]any{"username": strings.ToUpper(u.Username), "password": "password123"})
	if r.Status != 409 || r.errCode() != "conflict" {
		t.Fatalf("duplicate username: %d %s", r.Status, r.Body)
	}
	if r := e.do("POST", "/api/v1/auth/register", "", map[string]any{"username": "ab", "password": "password123"}); r.Status != 400 {
		t.Fatalf("short username: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/auth/register", "", map[string]any{"username": "goodname1", "password": "short"}); r.Status != 400 {
		t.Fatalf("short password: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/auth/login", "", map[string]any{"username": u.Username, "password": "wrong-password"}); r.Status != 401 {
		t.Fatalf("wrong password: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/auth/login", "", map[string]any{"username": "nobody-here", "password": "wrong-password"}); r.Status != 401 {
		t.Fatalf("unknown user: %d", r.Status)
	}
	login := e.must(200, "POST", "/api/v1/auth/login", "", map[string]any{"username": u.Username, "password": "password123"})
	tok := login["token"].(string)
	if !strings.HasPrefix(tok, "tas_") {
		t.Fatalf("session token prefix: %q", tok[:4])
	}
	// GET /me returns the User object itself
	me := e.must(200, "GET", "/api/v1/me", tok, nil)
	if me["id"] != u.ID || me["username"] != u.Username || me["user"] != nil {
		t.Fatalf("me: %v", me)
	}
	if _, ok := me["avatar_url"]; !ok {
		t.Fatal("me.avatar_url missing")
	}
	if r := e.do("GET", "/api/v1/me", "", nil); r.Status != 401 || r.errCode() != "unauthorized" {
		t.Fatalf("no token: %d %s", r.Status, r.Body)
	}
	if r := e.do("GET", "/api/v1/me", "tas_bogus", nil); r.Status != 401 {
		t.Fatalf("bogus token: %d", r.Status)
	}
	if r := e.do("GET", "/api/v1/me", "tab_bogus", nil); r.Status != 401 {
		t.Fatalf("bogus bot token: %d", r.Status)
	}
	m := e.must(200, "PATCH", "/api/v1/me", tok, map[string]any{"display_name": "  Alice  "})
	if m["display_name"] != "Alice" {
		t.Fatalf("patch me: %v", m)
	}
	e.must(204, "POST", "/api/v1/auth/logout", tok, nil)
	if r := e.do("GET", "/api/v1/me", tok, nil); r.Status != 401 {
		t.Fatalf("after logout: %d", r.Status)
	}
	// request id + error envelope
	r = e.do("GET", "/api/v1/nope", "", nil)
	if r.Status != 404 || r.Header.Get("X-Request-Id") == "" || r.JSON()["request_id"] == "" {
		t.Fatalf("404 envelope: %d %s", r.Status, r.Body)
	}
}

func TestBotTokenScope(t *testing.T) {
	e := newEnv(t)
	owner := e.newUser()
	tm := e.newTeam(owner)
	b, _ := e.newBot(owner, tm, nil)
	if !strings.HasPrefix(b.Token, "tab_") {
		t.Fatal("bot token prefix")
	}
	if r := e.do("POST", "/api/v1/teams", b.Token, map[string]any{"name": "x"}); r.Status != 403 {
		t.Fatalf("bot create team: %d", r.Status)
	}
	if r := e.do("GET", "/api/v1/me", b.Token, nil); r.Status != 403 {
		t.Fatalf("bot /me: %d", r.Status)
	}
	if r := e.do("GET", "/api/v1/bots/me", owner.Token, nil); r.Status != 403 {
		t.Fatalf("user /bots/me: %d", r.Status)
	}
	me := e.must(200, "GET", "/api/v1/bots/me", b.Token, nil)
	if me["bot"].(map[string]any)["id"] != b.ID || me["team"].(map[string]any)["id"] != tm.ID {
		t.Fatalf("bots/me: %v", me)
	}
	e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/channels", b.Token, nil)
	e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members", b.Token, nil)
	// other team invisible to bot
	other := e.newTeam(owner)
	if r := e.do("GET", "/api/v1/teams/"+other.ID+"/channels", b.Token, nil); r.Status != 404 {
		t.Fatalf("bot other team: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/channels/"+other.GeneralID+"/messages", b.Token, map[string]any{"content": "hi"}); r.Status != 404 {
		t.Fatalf("bot post other team: %d", r.Status)
	}
	// rotate token invalidates old
	rot := e.must(200, "POST", "/api/v1/bots/"+b.ID+"/token/rotate", owner.Token, nil)
	if r := e.do("GET", "/api/v1/bots/me", b.Token, nil); r.Status != 401 {
		t.Fatalf("old token after rotate: %d", r.Status)
	}
	e.must(200, "GET", "/api/v1/bots/me", rot["token"].(string), nil)
	// delete bot -> token dead, removed from members
	e.must(204, "DELETE", "/api/v1/bots/"+b.ID, owner.Token, nil)
	if r := e.do("GET", "/api/v1/bots/me", rot["token"].(string), nil); r.Status != 401 {
		t.Fatalf("deleted bot token: %d", r.Status)
	}
	ms := items(e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members?type=bot", owner.Token, nil))
	if len(ms) != 0 {
		t.Fatalf("deleted bot still listed: %v", ms)
	}
}

func TestTeamsChannelsMembers(t *testing.T) {
	e := newEnv(t)
	owner, alice, eve := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)

	lt := e.must(200, "GET", "/api/v1/teams", owner.Token, nil)
	if lt["has_more"] != false || lt["next_cursor"] != nil || len(items(lt)) != 1 {
		t.Fatalf("list teams envelope: %v", lt)
	}
	lc := e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/channels", owner.Token, nil)
	if lc["has_more"] != false || lc["next_cursor"] != nil || items(lc)[0]["name"] != "general" || items(lc)[0]["is_default"] != true {
		t.Fatalf("channels: %v", lc)
	}
	// non-member gets 404
	if r := e.do("GET", "/api/v1/teams/"+tm.ID, eve.Token, nil); r.Status != 404 {
		t.Fatalf("non-member team: %d", r.Status)
	}
	if r := e.do("GET", "/api/v1/channels/"+tm.GeneralID+"/messages", eve.Token, nil); r.Status != 404 {
		t.Fatalf("non-member messages: %d", r.Status)
	}
	aliceMember := e.addMember(owner, tm, alice)
	if r := e.do("POST", "/api/v1/teams/"+tm.ID+"/members", owner.Token, map[string]any{"username": alice.Username}); r.Status != 409 {
		t.Fatalf("dup member: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/teams/"+tm.ID+"/members", alice.Token, map[string]any{"username": eve.Username}); r.Status != 403 {
		t.Fatalf("member adds member: %d", r.Status)
	}
	e.newBot(owner, tm, nil)

	// members pagination
	p1 := e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members?limit=2", owner.Token, nil)
	if len(items(p1)) != 2 || p1["has_more"] != true || p1["next_cursor"] == nil {
		t.Fatalf("members page1: %v", p1)
	}
	p2 := e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members?limit=2&cursor="+p1["next_cursor"].(string), owner.Token, nil)
	if len(items(p2)) != 1 || p2["has_more"] != false || p2["next_cursor"] != nil {
		t.Fatalf("members page2: %v", p2)
	}
	bots := items(e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members?type=bot", owner.Token, nil))
	if len(bots) != 1 || bots[0]["type"] != "bot" || bots[0]["role"] != "bot" {
		t.Fatalf("bot members: %v", bots)
	}
	for _, k := range []string{"avatar_url", "avatar_shape", "avatar_color", "display_name", "username"} {
		if _, ok := bots[0][k]; !ok {
			t.Fatalf("member missing %s", k)
		}
	}

	// channels
	ch := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", alice.Token, map[string]any{"name": "backend", "topic": "go"})
	if r := e.do("POST", "/api/v1/teams/"+tm.ID+"/channels", alice.Token, map[string]any{"name": "BACKEND"}); r.Status != 409 {
		t.Fatalf("dup channel: %d", r.Status)
	}
	e.must(200, "PATCH", "/api/v1/channels/"+ch["id"].(string), alice.Token, map[string]any{"topic": "golang"})
	if r := e.do("DELETE", "/api/v1/channels/"+tm.GeneralID, owner.Token, nil); r.Status != 403 {
		t.Fatalf("delete default: %d", r.Status)
	}
	if r := e.do("DELETE", "/api/v1/channels/"+ch["id"].(string), alice.Token, nil); r.Status != 403 {
		t.Fatalf("member delete channel: %d", r.Status)
	}
	e.must(204, "DELETE", "/api/v1/channels/"+ch["id"].(string), owner.Token, nil)

	// roles
	e.must(200, "PATCH", "/api/v1/teams/"+tm.ID+"/members/"+aliceMember, owner.Token, map[string]any{"role": "admin"})
	e.must(200, "PATCH", "/api/v1/teams/"+tm.ID, alice.Token, map[string]any{"name": "Renamed"})
	if r := e.do("PATCH", "/api/v1/teams/"+tm.ID+"/members/"+tm.MemberID, alice.Token, map[string]any{"role": "member"}); r.Status != 403 {
		t.Fatalf("demote owner: %d", r.Status)
	}
	if r := e.do("DELETE", "/api/v1/teams/"+tm.ID, alice.Token, nil); r.Status != 403 {
		t.Fatalf("admin deletes team: %d", r.Status)
	}
	// leave
	e.must(204, "DELETE", "/api/v1/teams/"+tm.ID+"/members/"+aliceMember, alice.Token, nil)
	if r := e.do("GET", "/api/v1/teams/"+tm.ID, alice.Token, nil); r.Status != 404 {
		t.Fatalf("after leave: %d", r.Status)
	}
	e.must(204, "DELETE", "/api/v1/teams/"+tm.ID, owner.Token, nil)
	if r := e.do("GET", "/api/v1/teams/"+tm.ID, owner.Token, nil); r.Status != 404 {
		t.Fatalf("deleted team: %d", r.Status)
	}
}

func TestMessagesMentionsAndPaging(t *testing.T) {
	e := newEnv(t)
	owner, alice := e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	aliceMember := e.addMember(owner, tm, alice)
	b, _ := e.newBot(owner, tm, nil)
	outsider := e.newUser()
	otherTeam := e.newTeam(outsider)

	content := fmt.Sprintf("<@%s> hi <@%s> and <@%s> <@%s> <@00000000-0000-0000-0000-000000000000> <@%s>",
		strings.ToUpper(aliceMember), b.MemberID, aliceMember, otherTeam.MemberID, b.MemberID)
	m := e.send(owner.Token, tm.GeneralID, map[string]any{"content": content})
	mens, _ := m["mentions"].([]any)
	if len(mens) != 2 {
		t.Fatalf("mentions: %v", mens)
	}
	if mens[0].(map[string]any)["member_id"] != aliceMember || mens[0].(map[string]any)["type"] != "user" ||
		mens[1].(map[string]any)["member_id"] != b.MemberID || mens[1].(map[string]any)["type"] != "bot" {
		t.Fatalf("mention order/type: %v", mens)
	}
	if m["content"] != content || m["trigger_depth"].(float64) != 0 {
		t.Fatalf("message: %v", m)
	}
	sender := m["sender"].(map[string]any)
	for _, k := range []string{"member_id", "type", "display_name", "avatar_url", "avatar_shape", "avatar_color"} {
		if _, ok := sender[k]; !ok {
			t.Fatalf("sender missing %s: %v", k, sender)
		}
	}
	if sender["member_id"] != tm.MemberID || sender["type"] != "user" {
		t.Fatalf("sender: %v", sender)
	}

	// validation
	if r := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/messages", owner.Token, map[string]any{"content": "   "}); r.Status != 400 {
		t.Fatalf("empty: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/messages", owner.Token, map[string]any{"content": strings.Repeat("x", 8001)}); r.Status != 400 {
		t.Fatalf("too long: %d", r.Status)
	}

	// client_msg_id idempotency
	cm := "c-0193aaaa-1111-7000-8000-000000000001"
	m1 := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "once", "client_msg_id": cm})
	r := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/messages", owner.Token, map[string]any{"content": "once again", "client_msg_id": cm})
	if r.Status != 200 || r.JSON()["id"] != m1["id"] || r.JSON()["content"] != "once" {
		t.Fatalf("idempotent resend: %d %s", r.Status, r.Body)
	}
	// different sender, same id -> new message
	m2 := e.send(alice.Token, tm.GeneralID, map[string]any{"content": "alice", "client_msg_id": cm})
	if m2["id"] == m1["id"] {
		t.Fatal("client_msg_id must be per sender")
	}
	// other channel -> new message
	ch2 := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", owner.Token, map[string]any{"name": "two"})
	m3 := e.send(owner.Token, ch2["id"].(string), map[string]any{"content": "x", "client_msg_id": cm})
	if m3["id"] == m1["id"] {
		t.Fatal("client_msg_id must be per channel")
	}
	// older than 24h -> not deduplicated
	testPool.Exec(t.Context(), `UPDATE messages SET created_at = now() - interval '25 hours' WHERE id=$1`, m1["id"])
	m4 := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "later", "client_msg_id": cm})
	if m4["id"] == m1["id"] {
		t.Fatal("client_msg_id dedupe window must be 24h")
	}
	for _, bad := range []string{"", "has space", "ümlaut", strings.Repeat("a", 65)} {
		if r := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/messages", owner.Token, map[string]any{"content": "x", "client_msg_id": bad}); r.Status != 400 {
			t.Fatalf("client_msg_id %q: %d", bad, r.Status)
		}
	}

	// reply_to must be same channel
	if r := e.do("POST", "/api/v1/channels/"+ch2["id"].(string)+"/messages", owner.Token, map[string]any{"content": "x", "reply_to": m1["id"]}); r.Status != 400 {
		t.Fatalf("cross-channel reply: %d", r.Status)
	}

	// paging on a fresh channel
	pc := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", owner.Token, map[string]any{"name": "paging"})["id"].(string)
	var seqs []float64
	for i := 0; i < 5; i++ {
		seqs = append(seqs, e.send(owner.Token, pc, map[string]any{"content": fmt.Sprint(i)})["seq"].(float64))
	}
	asc := func(it []map[string]any) bool {
		for i := 1; i < len(it); i++ {
			if it[i-1]["seq"].(float64) >= it[i]["seq"].(float64) {
				return false
			}
		}
		return true
	}
	latest := e.must(200, "GET", "/api/v1/channels/"+pc+"/messages?limit=2", owner.Token, nil)
	li := items(latest)
	if len(li) != 2 || !asc(li) || li[1]["seq"] != seqs[4] || latest["has_more"] != true || latest["next_cursor"] != fmt.Sprint(int64(seqs[3])) {
		t.Fatalf("latest page: %v", latest)
	}
	older := e.must(200, "GET", "/api/v1/channels/"+pc+"/messages?limit=2&before="+latest["next_cursor"].(string), owner.Token, nil)
	oi := items(older)
	if len(oi) != 2 || !asc(oi) || oi[0]["seq"] != seqs[1] || older["next_cursor"] != fmt.Sprint(int64(seqs[1])) || older["has_more"] != true {
		t.Fatalf("older page: %v", older)
	}
	oldest := e.must(200, "GET", "/api/v1/channels/"+pc+"/messages?limit=2&before="+older["next_cursor"].(string), owner.Token, nil)
	if len(items(oldest)) != 1 || oldest["has_more"] != false {
		t.Fatalf("oldest page: %v", oldest)
	}
	after := e.must(200, "GET", "/api/v1/channels/"+pc+"/messages?limit=3&after="+fmt.Sprint(int64(seqs[0])), owner.Token, nil)
	ai := items(after)
	if len(ai) != 3 || !asc(ai) || ai[0]["seq"] != seqs[1] || after["next_cursor"] != fmt.Sprint(int64(seqs[3])) || after["has_more"] != true {
		t.Fatalf("after page: %v", after)
	}
	if r := e.do("GET", "/api/v1/channels/"+pc+"/messages?before=1&after=2", owner.Token, nil); r.Status != 400 {
		t.Fatalf("before+after: %d", r.Status)
	}

	// edit / delete
	msgID := li[1]["id"].(string)
	if r := e.do("PATCH", "/api/v1/messages/"+msgID, alice.Token, map[string]any{"content": "hack"}); r.Status != 403 {
		t.Fatalf("edit others: %d", r.Status)
	}
	ed := e.must(200, "PATCH", "/api/v1/messages/"+msgID, owner.Token, map[string]any{"content": "edited <@" + aliceMember + ">"})
	if ed["edited_at"] == nil || len(ed["mentions"].([]any)) != 1 {
		t.Fatalf("edit: %v", ed)
	}
	e.must(204, "DELETE", "/api/v1/messages/"+msgID, owner.Token, nil)
	del := e.must(200, "GET", "/api/v1/messages/"+msgID, alice.Token, nil)
	if del["deleted"] != true || del["content"] != "" {
		t.Fatalf("deleted: %v", del)
	}
}

func TestUploadsAndAttachments(t *testing.T) {
	e := newEnv(t)
	owner, alice, outsider := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	e.addMember(owner, tm, alice)
	up := "/api/v1/teams/" + tm.ID + "/attachments"

	img := pngBytes(4, 3)
	a := e.must(201, "POST", up, owner.Token, multipartFile("file", "../../evil\"name.png", img, nil))
	if a["kind"] != "image" || a["mime_type"] != "image/png" || a["width"].(float64) != 4 || a["height"].(float64) != 3 ||
		a["size_bytes"].(float64) != float64(len(img)) || a["expires_at"] == nil {
		t.Fatalf("upload: %v", a)
	}
	if strings.ContainsAny(a["file_name"].(string), "/\\\"") {
		t.Fatalf("file name not sanitized: %v", a["file_name"])
	}
	// type sniffing: text with .png extension rejected
	r := e.do("POST", up, owner.Token, multipartFile("file", "fake.png", []byte("hello, I am text"), nil))
	if r.Status != 415 || r.errCode() != "unsupported_media_type" {
		t.Fatalf("text upload: %d %s", r.Status, r.Body)
	}
	// size limit (MaxImageBytes = 1 MiB in tests)
	big := append(pngBytes(2, 2), bytes.Repeat([]byte{0}, 1<<20)...)
	if r := e.do("POST", up, owner.Token, multipartFile("file", "big.png", big, nil)); r.Status != 413 {
		t.Fatalf("too large: %d", r.Status)
	}
	// mp4 by ftyp
	mp4 := append([]byte{0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 2, 0}, bytes.Repeat([]byte{1}, 64)...)
	v := e.must(201, "POST", up, owner.Token, multipartFile("file", "v.mp4", mp4, nil))
	if v["kind"] != "video" || v["mime_type"] != "video/mp4" {
		t.Fatalf("video: %v", v)
	}
	if r := e.do("POST", up, outsider.Token, multipartFile("file", "a.png", img, nil)); r.Status != 404 {
		t.Fatalf("outsider upload: %d", r.Status)
	}
	if r := e.do("POST", up, owner.Token, map[string]any{"x": 1}); r.Status != 415 {
		t.Fatalf("json upload: %d", r.Status)
	}

	// signed URL download
	get := func(path, tok string) (int, []byte, http.Header) {
		req, _ := http.NewRequest("GET", e.ts.URL+path, nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, b, res.Header
	}
	code, body, hdr := get(a["url"].(string), "")
	if code != 200 || !bytes.Equal(body, img) || hdr.Get("X-Content-Type-Options") != "nosniff" || hdr.Get("Content-Type") != "image/png" {
		t.Fatalf("signed download: %d", code)
	}
	if code, _, _ := get(a["url"].(string)+"x", ""); code != 401 {
		t.Fatalf("tampered sig: %d", code)
	}
	plain := "/api/v1/attachments/" + a["id"].(string) + "/content"
	if code, _, _ := get(plain, ""); code != 401 {
		t.Fatalf("no auth: %d", code)
	}
	if code, _, _ := get(plain, alice.Token); code != 200 {
		t.Fatalf("bearer download: %d", code)
	}
	if code, _, _ := get(plain, outsider.Token); code != 404 {
		t.Fatalf("outsider download: %d", code)
	}

	// attach to message; alice cannot reuse owner's attachment
	if r := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/messages", alice.Token, map[string]any{"attachment_ids": []string{a["id"].(string)}}); r.Status != 400 {
		t.Fatalf("foreign attachment: %d", r.Status)
	}
	m := e.send(owner.Token, tm.GeneralID, map[string]any{"attachment_ids": []string{a["id"].(string), v["id"].(string)}})
	if len(m["attachments"].([]any)) != 2 {
		t.Fatalf("message attachments: %v", m)
	}
	if r := e.do("POST", "/api/v1/channels/"+tm.GeneralID+"/messages", owner.Token, map[string]any{"attachment_ids": []string{a["id"].(string)}}); r.Status != 400 {
		t.Fatalf("reused attachment: %d", r.Status)
	}

	// refresh URLs
	one := e.must(200, "GET", "/api/v1/attachments/"+a["id"].(string), alice.Token, nil)
	if one["url"] == nil || one["expires_at"] == nil || one["id"] != a["id"] {
		t.Fatalf("get attachment: %v", one)
	}
	if r := e.do("GET", "/api/v1/attachments/"+a["id"].(string), outsider.Token, nil); r.Status != 404 {
		t.Fatalf("outsider get attachment: %d", r.Status)
	}
	missingID := "0193aaaa-1111-7000-8000-000000000009"
	batch := e.must(200, "POST", "/api/v1/attachments/urls", alice.Token, map[string]any{"ids": []string{v["id"].(string), a["id"].(string), missingID}})
	bi := items(batch)
	if len(bi) != 2 || bi[0]["id"] != v["id"] || len(batch["missing"].([]any)) != 1 {
		t.Fatalf("batch urls: %v", batch)
	}
	tooMany := make([]string, 101)
	for i := range tooMany {
		tooMany[i] = missingID
	}
	if r := e.do("POST", "/api/v1/attachments/urls", alice.Token, map[string]any{"ids": tooMany}); r.Status != 400 {
		t.Fatalf("too many ids: %d", r.Status)
	}
}
