package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/creteper/teams/backend/internal/config"
)

func imageServer(t *testing.T) (*httptest.Server, *atomic.Int32) {
	var hits atomic.Int32
	img := pngBytes(8, 8)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/a.png":
			w.Write(img)
		case "/b.png":
			w.Write(pngBytes(9, 9))
		case "/text":
			w.Write([]byte("not an image at all"))
		case "/big":
			w.Write(append(pngBytes(2, 2), make([]byte, 300<<10)...))
		case "/redirect":
			http.Redirect(w, r, "/a.png", http.StatusFound)
		case "/slow":
			time.Sleep(3 * time.Second)
			w.Write(img)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)
	return ts, &hits
}

func TestUserAvatarAndTeamIcon(t *testing.T) {
	e := newEnv(t)
	owner, alice := e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	e.addMember(owner, tm, alice)
	ws := e.dialWS(alice.Token)

	me := e.must(200, "PUT", "/api/v1/me/avatar", owner.Token, multipartFile("file", "me.png", pngBytes(5, 5), nil))
	url, _ := me["avatar_url"].(string)
	if !strings.HasPrefix(url, "/api/v1/avatars/") {
		t.Fatalf("avatar_url: %v", me)
	}
	ev := ws.waitFor("member.updated", 2*time.Second)
	if ev == nil || ev["team_id"] != tm.ID || ev["data"].(map[string]any)["avatar_url"] != url {
		t.Fatalf("member.updated for avatar: %v", ev)
	}
	r := e.do("GET", url, "", nil)
	if r.Status != 200 || r.Header.Get("Content-Type") != "image/png" || !strings.Contains(r.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("public avatar: %d %v", r.Status, r.Header)
	}
	if r := e.do("PUT", "/api/v1/me/avatar", owner.Token, multipartFile("file", "x.png", []byte("text"), nil)); r.Status != 415 {
		t.Fatalf("bad avatar type: %d", r.Status)
	}
	me = e.must(200, "DELETE", "/api/v1/me/avatar", owner.Token, nil)
	if me["avatar_url"] != nil {
		t.Fatal("avatar not cleared")
	}

	if r := e.do("PUT", "/api/v1/teams/"+tm.ID+"/icon", alice.Token, multipartFile("file", "i.png", pngBytes(3, 3), nil)); r.Status != 403 {
		t.Fatalf("member sets icon: %d", r.Status)
	}
	tv := e.must(200, "PUT", "/api/v1/teams/"+tm.ID+"/icon", owner.Token, multipartFile("file", "i.png", pngBytes(3, 3), nil))
	if tv["icon_url"] == nil {
		t.Fatalf("icon_url: %v", tv)
	}
	if ev := ws.waitFor("team.updated", 2*time.Second); ev == nil || ev["data"].(map[string]any)["icon_url"] != tv["icon_url"] {
		t.Fatalf("team.updated: %v", ev)
	}
	lt := items(e.must(200, "GET", "/api/v1/teams", alice.Token, nil))
	if lt[0]["icon_url"] != tv["icon_url"] {
		t.Fatal("icon_url not in team list")
	}
}

func TestBotAvatarSyncAndStyle(t *testing.T) {
	e := newEnv(t)
	img, hits := imageServer(t)
	owner, alice := e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	e.addMember(owner, tm, alice)
	ws := e.dialWS(alice.Token)

	b, created := e.newBot(owner, tm, map[string]any{"avatar_url": img.URL + "/a.png", "avatar_shape": "  Rounded-Square ", "avatar_color": "#FFAA00"})
	cb := created["bot"].(map[string]any)
	if cb["avatar_url"] == nil || cb["avatar_source_url"] != img.URL+"/a.png" || created["warnings"] != nil {
		t.Fatalf("create bot avatar: %v", created)
	}
	if cb["avatar_shape"] != "Rounded-Square" || cb["avatar_color"] != "#FFAA00" {
		t.Fatalf("style must be stored verbatim (trimmed): %v", cb)
	}
	if ev := ws.waitFor("member.joined", 2*time.Second); ev == nil || ev["data"].(map[string]any)["type"] != "bot" {
		t.Fatalf("member.joined for bot: %v", ev)
	}
	firstAvatar := cb["avatar_url"]

	// idempotent re-sync: same URL + same bytes -> no change, no event
	n := hits.Load()
	r := e.must(200, "PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_url": img.URL + "/a.png"})
	if r["bot"].(map[string]any)["avatar_url"] != firstAvatar || hits.Load() != n+1 {
		t.Fatalf("resync changed avatar: %v", r)
	}
	if ev := ws.waitFor("member.updated", 300*time.Millisecond); ev != nil {
		t.Fatalf("unexpected member.updated on no-op sync: %v", ev)
	}
	// new URL via redirect -> new avatar + event with style fields
	r = e.must(200, "PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_url": img.URL + "/b.png", "display_name": "Grok", "avatar_shape": "Circle", "avatar_color": "Teal 500"})
	nb := r["bot"].(map[string]any)
	if nb["avatar_url"] == firstAvatar || nb["display_name"] != "Grok" || nb["avatar_shape"] != "Circle" || nb["avatar_color"] != "Teal 500" {
		t.Fatalf("patch bots/me: %v", r)
	}
	if r["member"].(map[string]any)["avatar_shape"] != "Circle" {
		t.Fatalf("member in response: %v", r["member"])
	}
	ev := ws.waitFor("member.updated", 2*time.Second)
	if ev == nil {
		t.Fatal("no member.updated")
	}
	d := ev["data"].(map[string]any)
	if d["type"] != "bot" || d["avatar_url"] != nb["avatar_url"] || d["avatar_shape"] != "Circle" || d["avatar_color"] != "Teal 500" || ev["team_id"] != tm.ID {
		t.Fatalf("member.updated payload: %v", ev)
	}
	e.must(200, "PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_url": img.URL + "/redirect"})

	// style: empty/null -> null; too long / control chars rejected
	r = e.must(200, "PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_shape": "   ", "avatar_color": nil})
	if r["bot"].(map[string]any)["avatar_shape"] != nil || r["bot"].(map[string]any)["avatar_color"] != nil {
		t.Fatalf("style null: %v", r)
	}
	if rr := e.do("PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_shape": strings.Repeat("é", 65)}); rr.Status != 400 {
		t.Fatalf("long shape: %d", rr.Status)
	}
	if rr := e.do("PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_color": "red\u0007"}); rr.Status != 400 {
		t.Fatalf("control char: %d", rr.Status)
	}
	e.must(200, "PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_shape": strings.Repeat("é", 64)})

	// bot cannot change protected fields
	if rr := e.do("PATCH", "/api/v1/bots/me", b.Token, map[string]any{"name": "other"}); rr.Status != 400 {
		t.Fatalf("bot rename: %d", rr.Status)
	}
	// multipart upload incl. fields
	r = e.must(200, "PATCH", "/api/v1/bots/me", b.Token, multipartFile("avatar", "g.png", pngBytes(6, 6), map[string]string{"display_name": "Grok MP", "avatar_color": " Blue "}))
	if r["bot"].(map[string]any)["display_name"] != "Grok MP" || r["bot"].(map[string]any)["avatar_color"] != "Blue" || r["bot"].(map[string]any)["avatar_source_url"] != nil {
		t.Fatalf("multipart patch: %v", r)
	}
	if rr := e.do("PATCH", "/api/v1/bots/me", b.Token, multipartFile("avatar", "g.png", pngBytes(6, 6), map[string]string{"avatar_url": img.URL + "/a.png"})); rr.Status != 400 {
		t.Fatalf("both avatar_url and file: %d", rr.Status)
	}
	e.must(200, "PUT", "/api/v1/bots/me/avatar", b.Token, multipartFile("file", "g.png", pngBytes(7, 7), nil))
	// fetch failures
	for path, reason := range map[string]string{"/text": "unsupported_type", "/big": "too_large", "/missing": "http_404"} {
		rr := e.do("PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_url": img.URL + path})
		if rr.Status != 422 || rr.errCode() != "avatar_fetch_failed" || rr.JSON()["error"].(map[string]any)["details"].(map[string]any)["reason"] != reason {
			t.Fatalf("%s: %d %s", path, rr.Status, rr.Body)
		}
	}
	if rr := e.do("PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_url": "ftp://example.com/a.png"}); rr.Status != 422 {
		t.Fatalf("ftp: %d", rr.Status)
	}
	// admin path
	e.must(200, "PATCH", "/api/v1/bots/"+b.ID, owner.Token, map[string]any{"avatar_url": img.URL + "/a.png", "avatar_shape": "Hex"})
	if rr := e.do("PATCH", "/api/v1/bots/"+b.ID, alice.Token, map[string]any{"display_name": "x"}); rr.Status != 403 {
		t.Fatalf("member patch bot: %d", rr.Status)
	}
	got := e.must(200, "GET", "/api/v1/bots/"+b.ID, alice.Token, nil)
	if got["avatar_shape"] != "Hex" || got["webhook"] != nil {
		t.Fatalf("get bot: %v", got)
	}
	e.must(200, "DELETE", "/api/v1/bots/me/avatar", b.Token, nil)
}

func TestSSRFProtection(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.AllowInsecureLocal = false })
	img, hits := imageServer(t)
	owner := e.newUser()
	tm := e.newTeam(owner)

	_, created := e.newBot(owner, tm, map[string]any{"avatar_url": img.URL + "/a.png"})
	if created["warnings"] == nil || created["bot"].(map[string]any)["avatar_url"] != nil {
		t.Fatalf("expected avatar warning: %v", created)
	}
	b, _ := e.newBot(owner, tm, nil)
	for _, u := range []string{img.URL + "/a.png", "http://localhost:1/a.png", "http://10.0.0.1/a.png", "http://169.254.169.254/latest", "http://[::1]/a.png", "http://192.168.1.1/x"} {
		rr := e.do("PATCH", "/api/v1/bots/me", b.Token, map[string]any{"avatar_url": u})
		if rr.Status != 422 || rr.JSON()["error"].(map[string]any)["details"].(map[string]any)["reason"] != "blocked_address" {
			t.Fatalf("%s: %d %s", u, rr.Status, rr.Body)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("private image server was contacted %d times", hits.Load())
	}
	for _, u := range []string{"http://example.com/hook", "https://127.0.0.1/hook", "https://10.1.2.3/hook", "https://localhost/hook"} {
		rr := e.do("PUT", "/api/v1/bots/"+b.ID+"/webhook", owner.Token, map[string]any{"url": u})
		if rr.Status != 400 {
			t.Fatalf("webhook %s: %d %s", u, rr.Status, rr.Body)
		}
	}
	// DNS name that resolves to loopback is blocked at dial time
	rc := newReceiver(t, nil)
	testPool.Exec(t.Context(), `INSERT INTO bot_webhooks(bot_id, url, signing_secret_enc) VALUES($1,$2,$3)`,
		b.ID, strings.Replace(rc.ts.URL, "127.0.0.1", "localhost.", 1), e.srv.box.Seal([]byte("whsec_x")))
	res := e.must(200, "POST", "/api/v1/bots/"+b.ID+"/webhook/test", owner.Token, nil)
	if res["ok"] != false || res["result"] != "blocked_address" || rc.count() != 0 {
		t.Fatalf("dial-time block: %v", res)
	}
}
