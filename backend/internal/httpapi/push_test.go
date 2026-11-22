package httpapi

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/creteper/teams/backend/internal/config"
)

// browserSub simulates a browser PushSubscription (ECDH key + auth secret).
type browserSub struct {
	priv     *ecdh.PrivateKey
	auth     []byte
	endpoint string
}

func newBrowserSub(t *testing.T, endpoint string) *browserSub {
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	a := make([]byte, 16)
	rand.Read(a)
	return &browserSub{priv: priv, auth: a, endpoint: endpoint}
}

func (b *browserSub) json() map[string]any {
	return map[string]any{"endpoint": b.endpoint, "expirationTime": nil, "keys": map[string]any{
		"p256dh": base64.RawURLEncoding.EncodeToString(b.priv.PublicKey().Bytes()),
		"auth":   base64.RawURLEncoding.EncodeToString(b.auth),
	}}
}

// decrypt reverses RFC 8291 aes128gcm (single record) like a browser would.
func (b *browserSub) decrypt(t *testing.T, body []byte) map[string]any {
	t.Helper()
	salt, idlen := body[:16], int(body[20])
	_ = binary.BigEndian.Uint32(body[16:20])
	keyid, ct := body[21:21+idlen], body[21+idlen:]
	asPub, err := ecdh.P256().NewPublicKey(keyid)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := b.priv.ECDH(asPub)
	if err != nil {
		t.Fatal(err)
	}
	info := append([]byte("WebPush: info\x00"), b.priv.PublicKey().Bytes()...)
	info = append(info, keyid...)
	ikm, _ := hkdf.Key(sha256.New, shared, b.auth, string(info), 32)
	cek, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	blk, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(blk)
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	i := len(pt) - 1
	for i >= 0 && pt[i] == 0 {
		i--
	}
	if i < 0 || pt[i] != 2 {
		t.Fatal("bad padding delimiter")
	}
	var m map[string]any
	if err := json.Unmarshal(pt[:i], &m); err != nil {
		t.Fatalf("payload json: %v %q", err, pt[:i])
	}
	return m
}

func withVAPID(t *testing.T) func(*config.Config) {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	return func(c *config.Config) {
		c.VAPIDPublicKey, c.VAPIDPrivateKey, c.VAPIDSubject = pub, priv, "mailto:ops@example.com"
	}
}

func subCount(t *testing.T, endpoint string) int {
	var n int
	testPool.QueryRow(t.Context(), `SELECT count(*) FROM push_subscriptions WHERE endpoint=$1`, endpoint).Scan(&n)
	return n
}

func TestChannelMessagePush(t *testing.T) {
	e := newEnv(t, withVAPID(t))
	a, b, c := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(a)
	bMember := e.addMember(a, tm, b)
	e.addMember(a, tm, c)
	bt, _ := e.newBot(a, tm, nil)

	k := e.must(200, "GET", "/api/v1/push/vapid-public-key", b.Token, nil)
	if k["enabled"] != true || k["public_key"] != e.cfg.VAPIDPublicKey {
		t.Fatalf("vapid key: %v", k)
	}
	rcA, rcB := newReceiver(t, func(int) int { return 201 }), newReceiver(t, func(int) int { return 201 })
	subA, subB := newBrowserSub(t, rcA.ts.URL+"/push/a"), newBrowserSub(t, rcB.ts.URL+"/push/b")
	e.must(201, "POST", "/api/v1/push/subscriptions", a.Token, subA.json())
	sv := e.must(201, "POST", "/api/v1/push/subscriptions", b.Token, subB.json())
	if sv["endpoint"] != subB.endpoint || sv["id"] == nil {
		t.Fatalf("subscription: %v", sv)
	}
	// re-subscribing the same endpoint is an upsert
	e.must(200, "POST", "/api/v1/push/subscriptions", b.Token, subB.json())

	rcC := newReceiver(t, func(int) int { return 201 })
	subC := newBrowserSub(t, rcC.ts.URL+"/push/c")
	e.must(201, "POST", "/api/v1/push/subscriptions", c.Token, subC.json())
	other := e.newTeam(a)
	e.send(a.Token, other.GeneralID, map[string]any{"content": "another team"})
	e.srv.push.wg.Wait()
	if rcA.count()+rcB.count()+rcC.count() != 0 {
		t.Fatal("message crossed team boundary or notified its own sender")
	}
	long := strings.Repeat("长", 150)
	m := e.send(a.Token, tm.GeneralID, map[string]any{"content": "<@" + bMember + "> <@" + bt.MemberID + "> " + long})
	e.srv.push.wg.Wait()
	if rcB.count() != 1 || rcA.count() != 0 {
		t.Fatalf("pushes: b=%d a=%d", rcB.count(), rcA.count())
	}
	req := rcB.get(0)
	if req.Header.Get("TTL") == "" || !strings.HasPrefix(req.Header.Get("Authorization"), "vapid t=") ||
		req.Header.Get("Content-Encoding") != "aes128gcm" || req.Header.Get("Urgency") != "high" {
		t.Fatalf("push headers: %v", req.Header)
	}
	p := subB.decrypt(t, req.Body)
	team, ch, snd, msg := p["team"].(map[string]any), p["channel"].(map[string]any), p["sender"].(map[string]any), p["message"].(map[string]any)
	wantURL := "/teams/" + tm.ID + "/channels/" + tm.GeneralID + "?msg=" + url.QueryEscape(m["id"].(string))
	if p["type"] != "mention" || team["id"] != tm.ID || team["name"] != "Team" || ch["id"] != tm.GeneralID || ch["name"] != "general" ||
		snd["display_name"] != "User "+a.Username || msg["id"] != m["id"] || num(msg["seq"]) != num(m["seq"]) || p["url"] != wantURL {
		t.Fatalf("payload: %v", p)
	}
	ex := msg["excerpt"].(string)
	if !strings.HasPrefix(ex, "@User "+b.Username+" @Bot ") || !strings.HasSuffix(ex, "…") || len([]rune(ex)) != pushExcerptRunes+1 {
		t.Fatalf("excerpt: %q", ex)
	}

	if rcC.count() != 1 || subC.decrypt(t, rcC.get(0).Body)["type"] != "message" {
		t.Fatal("unmentioned teammate should receive an ordinary channel notification")
	}
	e.must(204, "DELETE", "/api/v1/teams/"+tm.ID+"/members/me", c.Token, nil)
	// Other active members receive each new message once, including self-mentions by the sender.
	m2 := e.send(a.Token, tm.GeneralID, map[string]any{"content": "<@" + tm.MemberID + "> note to self"})
	e.send(a.Token, tm.GeneralID, map[string]any{"content": "plain"})
	e.must(200, "PATCH", "/api/v1/messages/"+m2["id"].(string), a.Token, map[string]any{"content": "<@" + bMember + "> edited"})
	e.srv.push.wg.Wait()
	if rcA.count() != 0 || rcB.count() != 3 || rcC.count() != 1 {
		t.Fatalf("unexpected pushes: a=%d b=%d", rcA.count(), rcB.count())
	}
	// a bot mentioning a user does push; bots themselves are never push targets
	e.send(bt.Token, tm.GeneralID, map[string]any{"content": "<@" + bMember + "> done"})
	e.srv.push.wg.Wait()
	if rcB.count() != 4 || rcA.count() != 1 || rcC.count() != 1 {
		t.Fatalf("bot->user push: %d", rcB.count())
	}

	// delete: only your own
	e.must(204, "DELETE", "/api/v1/push/subscriptions?endpoint="+url.QueryEscape(subB.endpoint), c.Token, nil)
	if subCount(t, subB.endpoint) != 1 {
		t.Fatal("another user deleted B's subscription")
	}
	e.must(204, "DELETE", "/api/v1/push/subscriptions", b.Token, map[string]any{"endpoint": subB.endpoint})
	if subCount(t, subB.endpoint) != 0 {
		t.Fatal("B's subscription not deleted")
	}
	if r := e.do("DELETE", "/api/v1/push/subscriptions", b.Token, nil); r.Status != 400 {
		t.Fatalf("delete without endpoint: %d", r.Status)
	}
	// logout removes the session's subscriptions
	if subCount(t, subA.endpoint) != 1 {
		t.Fatal("A's subscription missing")
	}
	e.must(204, "POST", "/api/v1/auth/logout", a.Token, nil)
	if subCount(t, subA.endpoint) != 0 {
		t.Fatal("logout should remove subscription")
	}
}

func TestPushGoneSubscriptionRemoved(t *testing.T) {
	e := newEnv(t, withVAPID(t))
	a, b := e.newUser(), e.newUser()
	tm := e.newTeam(a)
	bMember := e.addMember(a, tm, b)
	rc := newReceiver(t, func(int) int { return 410 })
	rc404 := newReceiver(t, func(int) int { return 404 })
	rc500 := newReceiver(t, func(int) int { return 500 })
	s1, s2, s3 := newBrowserSub(t, rc.ts.URL+"/x"), newBrowserSub(t, rc404.ts.URL+"/y"), newBrowserSub(t, rc500.ts.URL+"/z")
	for _, s := range []*browserSub{s1, s2, s3} {
		e.must(201, "POST", "/api/v1/push/subscriptions", b.Token, s.json())
	}
	e.send(a.Token, tm.GeneralID, map[string]any{"content": "<@" + bMember + "> hi"})
	e.srv.push.wg.Wait()
	if rc.count() != 1 || rc404.count() != 1 || rc500.count() != 1 {
		t.Fatalf("not sent: %d %d %d", rc.count(), rc404.count(), rc500.count())
	}
	if subCount(t, s1.endpoint) != 0 || subCount(t, s2.endpoint) != 0 {
		t.Fatal("410/404 subscription should be deleted")
	}
	if subCount(t, s3.endpoint) != 1 {
		t.Fatal("500 must keep the subscription")
	}
	var lastErr string
	testPool.QueryRow(t.Context(), `SELECT COALESCE(last_error,'') FROM push_subscriptions WHERE endpoint=$1`, s3.endpoint).Scan(&lastErr)
	if lastErr != "http_500" {
		t.Fatalf("last_error: %q", lastErr)
	}
}

func TestPushDisabledAndValidation(t *testing.T) {
	e := newEnv(t)
	u := e.newUser()
	k := e.must(200, "GET", "/api/v1/push/vapid-public-key", u.Token, nil)
	if k["enabled"] != false || k["public_key"] != nil {
		t.Fatalf("disabled key: %v", k)
	}
	s := newBrowserSub(t, "https://push.example.com/abc")
	if r := e.do("POST", "/api/v1/push/subscriptions", u.Token, s.json()); r.Status != 503 || r.errCode() != "push_disabled" {
		t.Fatalf("disabled subscribe: %d %s", r.Status, r.Body)
	}

	// production-like: https required, private hosts rejected
	e2 := newEnv(t, withVAPID(t), func(c *config.Config) { c.AllowInsecureLocal = false })
	u2 := e2.newUser()
	for _, ep := range []string{"http://push.example.com/a", "https://127.0.0.1/a", "https://localhost/a", "ftp://x/a", ""} {
		bs := newBrowserSub(t, ep)
		if r := e2.do("POST", "/api/v1/push/subscriptions", u2.Token, bs.json()); r.Status != 400 {
			t.Fatalf("endpoint %q: %d", ep, r.Status)
		}
	}
	bad := newBrowserSub(t, "https://push.example.com/b").json()
	bad["keys"].(map[string]any)["auth"] = "short"
	if r := e2.do("POST", "/api/v1/push/subscriptions", u2.Token, bad); r.Status != 400 {
		t.Fatalf("bad auth key: %d", r.Status)
	}
	bad = newBrowserSub(t, "https://push.example.com/c").json()
	bad["keys"].(map[string]any)["p256dh"] = base64.RawURLEncoding.EncodeToString(make([]byte, 65))
	if r := e2.do("POST", "/api/v1/push/subscriptions", u2.Token, bad); r.Status != 400 {
		t.Fatalf("bad p256dh: %d", r.Status)
	}
	e2.must(201, "POST", "/api/v1/push/subscriptions", u2.Token, newBrowserSub(t, "https://push.example.com/ok/"+newID()).json())
	// bots cannot subscribe
	tm := e2.newTeam(u2)
	bt, _ := e2.newBot(u2, tm, nil)
	if r := e2.do("POST", "/api/v1/push/subscriptions", bt.Token, newBrowserSub(t, "https://push.example.com/bot/"+newID()).json()); r.Status != 403 {
		t.Fatalf("bot subscribe: %d", r.Status)
	}
}

func TestPushSubscriptionCap(t *testing.T) {
	e := newEnv(t, withVAPID(t))
	u := e.newUser()
	for i := 0; i < maxPushSubsUser+3; i++ {
		e.must(201, "POST", "/api/v1/push/subscriptions", u.Token, newBrowserSub(t, "https://push.example.com/cap/"+newID()).json())
	}
	var n int
	testPool.QueryRow(t.Context(), `SELECT count(*) FROM push_subscriptions WHERE user_id=$1`, u.ID).Scan(&n)
	if n != maxPushSubsUser {
		t.Fatalf("cap: %d", n)
	}
}

func TestExcerpt(t *testing.T) {
	m := &messageView{Content: "a\n\n  b", Mentions: nil}
	if got := excerpt(m, 100); got != "a b" {
		t.Fatalf("%q", got)
	}
	m = &messageView{Content: "", Attachments: []attachmentView{{ID: "x"}}}
	if got := excerpt(m, 100); got != "[附件]" {
		t.Fatalf("%q", got)
	}
	m = &messageView{Content: strings.Repeat("é", 5)}
	if got := excerpt(m, 3); got != "ééé…" {
		t.Fatalf("%q", got)
	}
}
