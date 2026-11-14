package httpapi

import (
	"testing"
	"time"
)

// Behaviours documented in api.md §1/§3/§5.1/§10 (confirmed from code).

func TestChannelRenameDeleteRules(t *testing.T) {
	e := newEnv(t)
	owner, admin, alice, bob := e.newUser(), e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	adminMember := e.addMember(owner, tm, admin)
	e.must(200, "PATCH", "/api/v1/teams/"+tm.ID+"/members/"+adminMember, owner.Token, map[string]any{"role": "admin"})
	e.addMember(owner, tm, alice)
	e.addMember(owner, tm, bob)
	ws := e.dialWS(bob.Token)

	// default channel: rename allowed, delete forbidden even for owner
	g := e.must(200, "PATCH", "/api/v1/channels/"+tm.GeneralID, admin.Token, map[string]any{"name": "  大厅 #1  "})
	if g["name"] != "大厅 #1" || g["is_default"] != true {
		t.Fatalf("rename default: %v", g)
	}
	if r := e.do("DELETE", "/api/v1/channels/"+tm.GeneralID, owner.Token, nil); r.Status != 403 {
		t.Fatalf("delete default: %d", r.Status)
	}
	// alice creates a channel: she may rename it but not delete it
	c := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", alice.Token, map[string]any{"name": "alice-room"})
	cid := c["id"].(string)
	e.must(200, "PATCH", "/api/v1/channels/"+cid, alice.Token, map[string]any{"name": "Alice Room"})
	if r := e.do("DELETE", "/api/v1/channels/"+cid, alice.Token, nil); r.Status != 403 {
		t.Fatalf("creator delete: %d", r.Status)
	}
	// other plain members cannot rename it
	if r := e.do("PATCH", "/api/v1/channels/"+cid, bob.Token, map[string]any{"name": "x"}); r.Status != 403 {
		t.Fatalf("member rename: %d", r.Status)
	}
	// case-insensitive uniqueness, trimmed length 1–64
	r := e.do("PATCH", "/api/v1/channels/"+cid, alice.Token, map[string]any{"name": " 大厅 #1 "})
	if r.Status != 409 || r.errCode() != "conflict" {
		t.Fatalf("dup name: %d %s", r.Status, r.Body)
	}
	if d, _ := r.JSON()["error"].(map[string]any)["details"].(map[string]any); d["field"] != "name" {
		t.Fatalf("dup field: %s", r.Body)
	}
	if r := e.do("POST", "/api/v1/teams/"+tm.ID+"/channels", bob.Token, map[string]any{"name": "ALICE room"}); r.Status != 409 {
		t.Fatalf("dup create: %d", r.Status)
	}
	for _, n := range []string{"   ", string(make([]rune, 0)), "a\tb", string([]rune(repeatRune('x', 65)))} {
		if r := e.do("PATCH", "/api/v1/channels/"+cid, alice.Token, map[string]any{"name": n}); r.Status != 400 {
			t.Fatalf("name %q: %d", n, r.Status)
		}
	}
	e.must(200, "PATCH", "/api/v1/channels/"+cid, alice.Token, map[string]any{"name": repeatRune('名', 64)})

	// message + attachment in the channel, then admin deletes it
	att := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/attachments", alice.Token, multipartFile("file", "a.png", pngBytes(2, 2), nil))
	msg := e.send(alice.Token, cid, map[string]any{"content": "hi", "attachment_ids": []string{att["id"].(string)}})
	e.must(204, "DELETE", "/api/v1/channels/"+cid, admin.Token, nil)
	if ev := ws.waitFor("channel.deleted", 2*time.Second); ev == nil || ev["data"].(map[string]any)["id"] != cid {
		t.Fatalf("channel.deleted: %v", ev)
	}
	// soft delete: rows stay, but everything is 404 / hidden
	var n int
	testPool.QueryRow(t.Context(), `SELECT count(*) FROM messages WHERE channel_id=$1`, cid).Scan(&n)
	if n != 1 {
		t.Fatalf("messages kept: %d", n)
	}
	for _, p := range []string{"/api/v1/channels/" + cid, "/api/v1/channels/" + cid + "/messages", "/api/v1/messages/" + msg["id"].(string),
		"/api/v1/attachments/" + att["id"].(string), "/api/v1/attachments/" + att["id"].(string) + "/content"} {
		if r := e.do("GET", p, alice.Token, nil); r.Status != 404 {
			t.Fatalf("after delete %s: %d", p, r.Status)
		}
	}
	if code := e.do("GET", att["url"].(string), "", nil).Status; code != 404 {
		t.Fatalf("signed url after channel delete: %d", code)
	}
	b := e.must(200, "POST", "/api/v1/attachments/urls", alice.Token, map[string]any{"ids": []string{att["id"].(string)}})
	if len(b["missing"].([]any)) != 1 {
		t.Fatalf("urls after delete: %v", b)
	}
	// the name is free again
	e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", bob.Token, map[string]any{"name": repeatRune('名', 64)})
}

func repeatRune(r rune, n int) string {
	out := make([]rune, n)
	for i := range out {
		out[i] = r
	}
	return string(out)
}

func TestMyAvatarRules(t *testing.T) {
	e := newEnv(t)
	u, other := e.newUser(), e.newUser()
	tm := e.newTeam(other)
	mid := e.addMember(other, tm, u)
	ws := e.dialWS(other.Token)

	// DELETE without an avatar: 200, no event
	me := e.must(200, "DELETE", "/api/v1/me/avatar", u.Token, nil)
	if me["avatar_url"] != nil {
		t.Fatalf("delete none: %v", me)
	}
	if ev := ws.waitFor("member.updated", 200*time.Millisecond); ev != nil {
		t.Fatalf("event on no-op delete: %v", ev)
	}
	// wrong field name → 400 (field=file); JSON → 415; text → 415; >4096 px → 400 (rejected, not scaled)
	if r := e.do("PUT", "/api/v1/me/avatar", u.Token, multipartFile("avatar", "a.png", pngBytes(2, 2), nil)); r.Status != 400 {
		t.Fatalf("wrong field: %d", r.Status)
	}
	if r := e.do("PUT", "/api/v1/me/avatar", u.Token, map[string]any{"file": "x"}); r.Status != 415 {
		t.Fatalf("json: %d", r.Status)
	}
	if r := e.do("PUT", "/api/v1/me/avatar", u.Token, multipartFile("file", "a.png", []byte("not an image at all"), nil)); r.Status != 415 {
		t.Fatalf("text: %d", r.Status)
	}
	if r := e.do("PUT", "/api/v1/me/avatar", u.Token, multipartFile("file", "w.png", pngBytes(4097, 1), nil)); r.Status != 400 || r.errCode() != "validation_failed" {
		t.Fatalf("too wide: %d %s", r.Status, r.Body)
	}
	big := make([]byte, e.cfg.MaxAvatarBytes+10)
	copy(big, pngBytes(2, 2))
	if r := e.do("PUT", "/api/v1/me/avatar", u.Token, multipartFile("file", "b.png", big, nil)); r.Status != 413 {
		t.Fatalf("too big: %d", r.Status)
	}
	// success → 200 User + member.updated to teammates
	me = e.must(200, "PUT", "/api/v1/me/avatar", u.Token, multipartFile("file", "a.png", pngBytes(4096, 1), nil))
	if me["avatar_url"] == nil {
		t.Fatalf("put: %v", me)
	}
	ev := ws.waitFor("member.updated", 2*time.Second)
	if ev == nil || ev["data"].(map[string]any)["id"] != mid || ev["data"].(map[string]any)["avatar_url"] != me["avatar_url"] {
		t.Fatalf("member.updated: %v", ev)
	}
	e.must(200, "DELETE", "/api/v1/me/avatar", u.Token, nil)
	if ev := ws.waitFor("member.updated", 2*time.Second); ev == nil || ev["data"].(map[string]any)["avatar_url"] != nil {
		t.Fatalf("member.updated on delete: %v", ev)
	}
}

func TestMemberRoleRules(t *testing.T) {
	e := newEnv(t)
	owner, a1, a2, m := e.newUser(), e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	a1M, a2M, mM := e.addMember(owner, tm, a1), e.addMember(owner, tm, a2), e.addMember(owner, tm, m)
	bt, _ := e.newBot(owner, tm, nil)
	path := func(id string) string { return "/api/v1/teams/" + tm.ID + "/members/" + id }
	ws := e.dialWS(a2.Token)

	// owner promotes; 200 Member; everyone (including the target) gets member.updated
	got := e.must(200, "PATCH", path(a2M), owner.Token, map[string]any{"role": "admin"})
	if got["id"] != a2M || got["role"] != "admin" || got["type"] != "user" {
		t.Fatalf("promote: %v", got)
	}
	if ev := ws.waitFor("member.updated", 2*time.Second); ev == nil || ev["data"].(map[string]any)["role"] != "admin" {
		t.Fatalf("target event: %v", ev)
	}
	// same role again: 200, no second event
	e.must(200, "PATCH", path(a2M), owner.Token, map[string]any{"role": "admin"})
	if ev := ws.waitFor("member.updated", 300*time.Millisecond); ev != nil {
		t.Fatalf("event on unchanged role: %v", ev)
	}
	// admin may promote members and demote other admins, and demote itself
	e.must(200, "PATCH", path(a1M), a2.Token, map[string]any{"role": "admin"})
	e.must(200, "PATCH", path(a2M), a1.Token, map[string]any{"role": "member"})
	e.must(200, "PATCH", path(a2M), owner.Token, map[string]any{"role": "admin"})
	e.must(200, "PATCH", path(a2M), a2.Token, map[string]any{"role": "member"})
	// owner / bot targets → 403 (also owner on itself)
	for _, tc := range []struct{ tok, target string }{{owner.Token, tm.MemberID}, {a1.Token, tm.MemberID}, {owner.Token, bt.MemberID}} {
		r := e.do("PATCH", path(tc.target), tc.tok, map[string]any{"role": "member"})
		if r.Status != 403 || r.errCode() != "forbidden" {
			t.Fatalf("owner/bot target: %d %s", r.Status, r.Body)
		}
	}
	// invalid role → 400 field=role; owner is not a settable role
	for _, role := range []string{"owner", "bot", "", "Admin"} {
		r := e.do("PATCH", path(mM), owner.Token, map[string]any{"role": role})
		if r.Status != 400 || r.errCode() != "validation_failed" {
			t.Fatalf("role %q: %d", role, r.Status)
		}
		if d, _ := r.JSON()["error"].(map[string]any)["details"].(map[string]any); d["field"] != "role" {
			t.Fatalf("role field: %s", r.Body)
		}
	}
	// unknown member → 404; plain member caller → 403; outsider → 404
	if r := e.do("PATCH", path(newID()), owner.Token, map[string]any{"role": "admin"}); r.Status != 404 {
		t.Fatalf("missing: %d", r.Status)
	}
	if r := e.do("PATCH", path(a2M), m.Token, map[string]any{"role": "admin"}); r.Status != 403 {
		t.Fatalf("member caller: %d", r.Status)
	}
	if r := e.do("PATCH", path(mM), e.newUser().Token, map[string]any{"role": "admin"}); r.Status != 404 {
		t.Fatalf("outsider: %d", r.Status)
	}
}
