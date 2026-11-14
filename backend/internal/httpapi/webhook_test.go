package httpapi

import (
	"encoding/json"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/creteper/teams/backend/internal/config"
	"github.com/creteper/teams/backend/internal/webhook"
)

func (e *env) configureWebhook(owner user, b bot, url string, extra map[string]any) map[string]any {
	e.t.Helper()
	body := map[string]any{"url": url}
	for k, v := range extra {
		body[k] = v
	}
	return e.must(200, "PUT", "/api/v1/bots/"+b.ID+"/webhook", owner.Token, body)
}

func deliveries(t *testing.T, botID string) []map[string]any {
	rows, err := testPool.Query(t.Context(), `SELECT status, attempts, COALESCE(last_error,''), message_id::text FROM webhook_deliveries WHERE bot_id=$1 AND event='message.mention' ORDER BY created_at`, botID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var s, le, mid string
		var a int
		rows.Scan(&s, &a, &le, &mid)
		out = append(out, map[string]any{"status": s, "attempts": a, "last_error": le, "message_id": mid})
	}
	return out
}

func TestWebhookDeliveryAndSignature(t *testing.T) {
	e := newEnv(t)
	rc := newReceiver(t, nil)
	owner := e.newUser()
	tm := e.newTeam(owner)
	b, _ := e.newBot(owner, tm, map[string]any{"avatar_shape": "Circle", "avatar_color": "#123"})

	wh := e.configureWebhook(owner, b, rc.ts.URL+"/hook", map[string]any{"secret_header_name": "X-Webhook-Secret", "secret_header_value": "s3cr3t-value"})
	signing, _ := wh["signing_secret"].(string)
	if signing == "" || wh["secret_header_set"] != true || wh["secret_header_name"] != "X-Webhook-Secret" || wh["secret_header_value"] != nil {
		t.Fatalf("webhook config: %v", wh)
	}
	// update without value keeps secret; signing secret not re-shown
	wh2 := e.configureWebhook(owner, b, rc.ts.URL+"/hook", nil)
	if wh2["signing_secret"] != nil || wh2["secret_header_set"] != true {
		t.Fatalf("webhook update: %v", wh2)
	}
	for _, hn := range []string{"Host", "X-TeAms-Event", "Content-Type", "bad header"} {
		if r := e.do("PUT", "/api/v1/bots/"+b.ID+"/webhook", owner.Token, map[string]any{"url": rc.ts.URL, "secret_header_name": hn, "secret_header_value": "v"}); r.Status != 400 {
			t.Fatalf("header %q: %d", hn, r.Status)
		}
	}
	got := e.must(200, "GET", "/api/v1/bots/"+b.ID, owner.Token, nil)
	if got["webhook"].(map[string]any)["secret_header_set"] != true {
		t.Fatalf("bot view webhook: %v", got)
	}
	if string(e.do("GET", "/api/v1/bots/"+b.ID, owner.Token, nil).Body) == "" ||
		contains(e.do("GET", "/api/v1/bots/"+b.ID, owner.Token, nil).Body, "s3cr3t-value") {
		t.Fatal("secret leaked")
	}

	msg := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> summarize"})
	eventually(t, 3*time.Second, func() bool { return rc.count() == 1 })
	req := rc.get(0)
	h := req.Header
	ts, _ := strconv.ParseInt(h.Get("X-TeAms-Timestamp"), 10, 64)
	if !webhook.Verify(signing, ts, req.Body, h.Get("X-TeAms-Signature")) {
		t.Fatal("bad signature")
	}
	if h.Get("X-Webhook-Secret") != "s3cr3t-value" || h.Get("X-TeAms-Event") != "message.mention" || h.Get("X-TeAms-Delivery") == "" ||
		h.Get("User-Agent") != webhook.UserAgent || h.Get("Content-Type") != "application/json" {
		t.Fatalf("headers: %v", h)
	}
	var p map[string]any
	json.Unmarshal(req.Body, &p)
	pb := p["bot"].(map[string]any)
	if p["event"] != "message.mention" || p["delivery_id"] != h.Get("X-TeAms-Delivery") || pb["id"] != b.ID || pb["avatar_shape"] != "Circle" || pb["avatar_color"] != "#123" {
		t.Fatalf("payload bot: %v", p)
	}
	pm := p["message"].(map[string]any)
	if pm["id"] != msg["id"] || pm["content_plain"] != "@Bot summarize" || pm["trigger_depth"].(float64) != 0 {
		t.Fatalf("payload message: %v", pm)
	}
	if p["sender"].(map[string]any)["member_id"] != tm.MemberID || p["channel"].(map[string]any)["id"] != tm.GeneralID || p["team"].(map[string]any)["id"] != tm.ID {
		t.Fatalf("payload refs: %v", p)
	}
	lg := p["loop_guard"].(map[string]any)
	if lg["max_trigger_depth"].(float64) != 3 || lg["reply_depth_will_be"].(float64) != 1 {
		t.Fatalf("loop_guard: %v", lg)
	}
	if contains(req.Body, b.Token) || contains(req.Body, "s3cr3t-value") {
		t.Fatal("payload leaks secrets")
	}
	// bot replies with its token, mentioning the user
	reply := e.send(b.Token, tm.GeneralID, map[string]any{"content": "<@" + tm.MemberID + "> done", "reply_to": msg["id"]})
	if reply["trigger_depth"].(float64) != 1 || reply["sender"].(map[string]any)["type"] != "bot" {
		t.Fatalf("bot reply: %v", reply)
	}
	eventually(t, 2*time.Second, func() bool {
		d := deliveries(t, b.ID)
		return len(d) == 1 && d[0]["status"] == "succeeded"
	})
	dl := e.must(200, "GET", "/api/v1/bots/"+b.ID+"/webhook/deliveries", owner.Token, nil)
	if len(items(dl)) != 1 || items(dl)[0]["status"] != "succeeded" {
		t.Fatalf("deliveries api: %v", dl)
	}
	// ping test
	tr := e.must(200, "POST", "/api/v1/bots/"+b.ID+"/webhook/test", owner.Token, nil)
	if tr["ok"] != true || rc.count() != 2 || rc.get(1).Header.Get("X-TeAms-Event") != "ping" {
		t.Fatalf("test ping: %v", tr)
	}
	// rotate signing secret
	rot := e.must(200, "POST", "/api/v1/bots/"+b.ID+"/webhook/signing-secret/rotate", owner.Token, nil)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> again"})
	eventually(t, 3*time.Second, func() bool { return rc.count() == 3 })
	r3 := rc.get(2)
	ts3, _ := strconv.ParseInt(r3.Header.Get("X-TeAms-Timestamp"), 10, 64)
	if !webhook.Verify(rot["signing_secret"].(string), ts3, r3.Body, r3.Header.Get("X-TeAms-Signature")) || webhook.Verify(signing, ts3, r3.Body, r3.Header.Get("X-TeAms-Signature")) {
		t.Fatal("rotated signing secret not used")
	}
	// disabled webhook does not fire; edits never fire
	e.configureWebhook(owner, b, rc.ts.URL+"/hook", map[string]any{"enabled": false})
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> off"})
	e.must(200, "PATCH", "/api/v1/messages/"+msg["id"].(string), owner.Token, map[string]any{"content": "<@" + b.MemberID + "> edited"})
	time.Sleep(200 * time.Millisecond)
	if rc.count() != 3 {
		t.Fatalf("disabled/edit fired: %d", rc.count())
	}
}

func contains(b []byte, s string) bool {
	return len(s) > 0 && string(b) != "" && indexOf(string(b), s) >= 0
}
func indexOf(a, b string) int {
	for i := 0; i+len(b) <= len(a); i++ {
		if a[i:i+len(b)] == b {
			return i
		}
	}
	return -1
}

func TestLoopGuardDepth(t *testing.T) {
	e := newEnv(t)
	rc := newReceiver(t, nil)
	owner := e.newUser()
	tm := e.newTeam(owner)
	a, _ := e.newBot(owner, tm, nil)
	b, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, a, rc.ts.URL+"/a", nil)
	e.configureWebhook(owner, b, rc.ts.URL+"/b", nil)

	// human -> A(0) -> B(1) -> A(2) -> B(3) -> A(4: no trigger)
	m := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + a.MemberID + "> start"})
	bots := []bot{a, b}
	depths := []float64{0}
	for i := 1; i <= 4; i++ {
		from, to := bots[(i-1)%2], bots[i%2]
		m = e.send(from.Token, tm.GeneralID, map[string]any{"content": "<@" + to.MemberID + "> ping", "reply_to": m["id"]})
		depths = append(depths, m["trigger_depth"].(float64))
	}
	if fmt.Sprint(depths) != "[0 1 2 3 4]" {
		t.Fatalf("depths: %v", depths)
	}
	eventually(t, 3*time.Second, func() bool { return rc.count() == 4 })
	da, db := deliveries(t, a.ID), deliveries(t, b.ID)
	// A: depth 0 ok, depth 2 ok, depth 4 skipped
	if len(da) != 3 || da[2]["status"] != "skipped_depth" || len(db) != 2 {
		t.Fatalf("deliveries A=%v B=%v", da, db)
	}
	time.Sleep(100 * time.Millisecond)
	if rc.count() != 4 {
		t.Fatalf("depth-4 message triggered: %d", rc.count())
	}
	// bot message without reply_to has depth 1
	m = e.send(a.Token, tm.GeneralID, map[string]any{"content": "hello"})
	if m["trigger_depth"].(float64) != 1 {
		t.Fatalf("bot no reply_to depth: %v", m["trigger_depth"])
	}
	// human reply to deep message resets to 0
	m = e.send(owner.Token, tm.GeneralID, map[string]any{"content": "x", "reply_to": m["id"]})
	if m["trigger_depth"].(float64) != 0 {
		t.Fatal("human depth must be 0")
	}
	// self mention does not trigger
	before := len(deliveries(t, a.ID))
	e.send(a.Token, tm.GeneralID, map[string]any{"content": "<@" + a.MemberID + "> me"})
	if len(deliveries(t, a.ID)) != before {
		t.Fatal("self mention created delivery")
	}
}

func TestLoopGuardRateLimit(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.WebhookRatePerMinute = 2 })
	rc := newReceiver(t, nil)
	owner := e.newUser()
	tm := e.newTeam(owner)
	a, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, a, rc.ts.URL, nil)
	for i := 0; i < 4; i++ {
		e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + a.MemberID + "> hi"})
	}
	d := deliveries(t, a.ID)
	if len(d) != 4 || d[2]["status"] != "skipped_rate_limited" || d[3]["status"] != "skipped_rate_limited" {
		t.Fatalf("rate limit: %v", d)
	}
	// other channel has its own budget
	ch := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", owner.Token, map[string]any{"name": "other"})
	e.send(owner.Token, ch["id"].(string), map[string]any{"content": "<@" + a.MemberID + "> hi"})
	eventually(t, 3*time.Second, func() bool { return rc.count() == 3 })
	// window expiry
	testPool.Exec(t.Context(), `UPDATE webhook_deliveries SET created_at = now() - interval '61 seconds' WHERE bot_id=$1`, a.ID)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + a.MemberID + "> hi"})
	d = deliveries(t, a.ID)
	if d[len(d)-1]["status"] == "skipped_rate_limited" {
		t.Fatal("rate window did not expire")
	}
}

func TestWebhookRetry(t *testing.T) {
	e := newEnv(t)
	owner := e.newUser()
	tm := e.newTeam(owner)

	flaky := newReceiver(t, func(n int) int {
		if n <= 2 {
			return 503
		}
		return 200
	})
	a, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, a, flaky.ts.URL, nil)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + a.MemberID + ">"})
	eventually(t, 5*time.Second, func() bool {
		d := deliveries(t, a.ID)
		return len(d) == 1 && d[0]["status"] == "succeeded" && d[0]["attempts"] == 3
	})
	if flaky.get(0).Header.Get("X-TeAms-Delivery") != flaky.get(2).Header.Get("X-TeAms-Delivery") {
		t.Fatal("delivery id must be stable across retries")
	}

	bad := newReceiver(t, func(int) int { return 400 })
	b, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, b, bad.ts.URL, nil)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + ">"})
	eventually(t, 3*time.Second, func() bool {
		d := deliveries(t, b.ID)
		return len(d) == 1 && d[0]["status"] == "failed"
	})
	time.Sleep(200 * time.Millisecond)
	if bad.count() != 1 || deliveries(t, b.ID)[0]["last_error"] != "http_400" {
		t.Fatalf("4xx must not retry: %d", bad.count())
	}

	down := newReceiver(t, func(int) int { return 500 })
	c, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, c, down.ts.URL, nil)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + c.MemberID + ">"})
	eventually(t, 5*time.Second, func() bool {
		d := deliveries(t, c.ID)
		return len(d) == 1 && d[0]["status"] == "failed"
	})
	if down.count() != 4 || deliveries(t, c.ID)[0]["attempts"] != 4 {
		t.Fatalf("max attempts: %d", down.count())
	}

	// network error (closed server) is retried then fails
	gone := newReceiver(t, nil)
	url := gone.ts.URL
	gone.ts.Close()
	d, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, d, url, nil)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + d.MemberID + ">"})
	eventually(t, 5*time.Second, func() bool {
		x := deliveries(t, d.ID)
		return len(x) == 1 && x[0]["status"] == "failed" && x[0]["attempts"] == 4 && x[0]["last_error"] == "network_error"
	})
}
