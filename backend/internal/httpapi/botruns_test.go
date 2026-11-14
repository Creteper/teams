package httpapi

import (
	"strings"
	"testing"
	"time"

	"github.com/creteper/teams/backend/internal/config"
)

func checkRunFields(t *testing.T, ev map[string]any, tm team, botMember, trigger string) map[string]any {
	t.Helper()
	if ev == nil {
		t.Fatal("missing bot.run event")
	}
	d := ev["data"].(map[string]any)
	if ev["team_id"] != tm.ID || d["team_id"] != tm.ID || d["channel_id"] != tm.GeneralID || d["bot_member_id"] != botMember ||
		d["trigger_message_id"] != trigger || d["delivery_id"] == nil || d["at"] == nil {
		t.Fatalf("bot.run fields: %v", ev)
	}
	return d
}

func TestBotRunLifecycle(t *testing.T) {
	e := newEnv(t)
	owner := e.newUser()
	tm := e.newTeam(owner)
	ws := e.dialWS(owner.Token)
	rc := newReceiver(t, nil)
	b, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, b, rc.ts.URL, nil)

	m := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> go"})
	trig := m["id"].(string)
	st := checkRunFields(t, ws.waitFor("bot.run.started", 2*time.Second), tm, b.MemberID, trig)
	dl := checkRunFields(t, ws.waitFor("bot.run.delivered", 2*time.Second), tm, b.MemberID, trig)
	if dl["delivery_id"] != st["delivery_id"] {
		t.Fatal("delivery id mismatch")
	}
	// active list shows delivered run
	act := items(e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID+"/bot-runs?active=true", owner.Token, nil))
	if len(act) != 1 || act[0]["status"] != "delivered" || act[0]["delivery_id"] != st["delivery_id"] || act[0]["trigger_message_id"] != trig {
		t.Fatalf("active runs: %v", act)
	}
	reply := e.send(b.Token, tm.GeneralID, map[string]any{"content": "done", "reply_to": trig})
	cp := checkRunFields(t, ws.waitFor("bot.run.completed", 2*time.Second), tm, b.MemberID, trig)
	if cp["reply_message_id"] != reply["id"] || cp["delivery_id"] != st["delivery_id"] {
		t.Fatalf("completed: %v", cp)
	}
	if act := items(e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID+"/bot-runs?active=true", owner.Token, nil)); len(act) != 0 {
		t.Fatalf("completed run still active: %v", act)
	}
	all := items(e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID+"/bot-runs", owner.Token, nil))
	if len(all) != 1 || all[0]["status"] != "completed" || all[0]["reply_message_id"] != reply["id"] {
		t.Fatalf("all runs: %v", all)
	}
	// a second reply does not emit completed again
	e.send(b.Token, tm.GeneralID, map[string]any{"content": "more", "reply_to": trig})
	if ev := ws.waitFor("bot.run.completed", 300*time.Millisecond); ev != nil {
		t.Fatalf("duplicate completed: %v", ev)
	}
	// outsider cannot read runs
	if r := e.do("GET", "/api/v1/channels/"+tm.GeneralID+"/bot-runs?active=true", e.newUser().Token, nil); r.Status != 404 {
		t.Fatalf("outsider runs: %d", r.Status)
	}
}

func TestBotRunRetryFailAndNoWebhook(t *testing.T) {
	e := newEnv(t)
	owner := e.newUser()
	tm := e.newTeam(owner)
	ws := e.dialWS(owner.Token)

	// no webhook -> immediate failed(no_webhook), no started
	nb, _ := e.newBot(owner, tm, nil)
	m := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + nb.MemberID + "> hi"})
	f := checkRunFields(t, ws.waitFor("bot.run.failed", 2*time.Second), tm, nb.MemberID, m["id"].(string))
	if f["reason"] != "no_webhook" {
		t.Fatalf("no_webhook: %v", f)
	}

	// 500 forever -> started, retrying x3 (attempt, next_retry_at, reason), failed(http_error, status_code)
	down := newReceiver(t, func(int) int { return 500 })
	b, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, b, down.ts.URL, nil)
	m = e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> hi"})
	trig := m["id"].(string)
	var types []string
	var fail map[string]any
	deadline := time.Now().Add(5 * time.Second)
	for fail == nil && time.Now().Before(deadline) {
		select {
		case ev := <-ws.ch:
			typ, _ := ev["type"].(string)
			if !strings.HasPrefix(typ, "bot.run.") {
				continue
			}
			d := checkRunFields(t, ev, tm, b.MemberID, trig)
			types = append(types, typ)
			if typ == "bot.run.retrying" {
				if d["attempt"] == nil || d["next_retry_at"] == nil || d["reason"] != "http_error" || d["status_code"].(float64) != 500 {
					t.Fatalf("retrying fields: %v", d)
				}
				if act := items(e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID+"/bot-runs?active=true", owner.Token, nil)); len(act) != 1 {
					t.Fatalf("retrying run not active: %v", act)
				}
			}
			if typ == "bot.run.failed" {
				fail = d
			}
		case <-time.After(100 * time.Millisecond):
		}
	}
	if strings.Join(types, ",") != "bot.run.started,bot.run.retrying,bot.run.retrying,bot.run.retrying,bot.run.failed" {
		t.Fatalf("event sequence: %v", types)
	}
	if fail["reason"] != "http_error" || fail["status_code"].(float64) != 500 {
		t.Fatalf("failed: %v", fail)
	}

	// network error reason
	gone := newReceiver(t, nil)
	url := gone.ts.URL
	gone.ts.Close()
	g, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, g, url, nil)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + g.MemberID + "> hi"})
	var last map[string]any
	eventually(t, 5*time.Second, func() bool {
		ev := ws.waitFor("bot.run.failed", 50*time.Millisecond)
		if ev != nil && ev["data"].(map[string]any)["bot_member_id"] == g.MemberID {
			last = ev["data"].(map[string]any)
			return true
		}
		return false
	})
	if last["reason"] != "network_error" {
		t.Fatalf("network failure reason: %v", last)
	}
}

func TestBotRunSkippedEmitsNothing(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.WebhookRatePerMinute = 1 })
	owner := e.newUser()
	tm := e.newTeam(owner)
	rc := newReceiver(t, nil)
	b, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, b, rc.ts.URL, nil)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> 1"})
	ws := e.dialWS(owner.Token)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> 2"}) // rate limited
	if ev := ws.waitFor("bot.run.started", 300*time.Millisecond); ev != nil {
		t.Fatalf("rate-limited run emitted started: %v", ev)
	}
	// depth-skipped: bot replying chain at depth 4
	testPool.Exec(t.Context(), `UPDATE webhook_deliveries SET created_at = now() - interval '2 minutes' WHERE bot_id=$1`, b.ID)
	other, _ := e.newBot(owner, tm, nil)
	m := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "x"})
	for i := 0; i < 4; i++ {
		m = e.send(other.Token, tm.GeneralID, map[string]any{"content": "y", "reply_to": m["id"]})
	}
	e.send(other.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> deep", "reply_to": m["id"]})
	if ev := ws.waitFor("bot.run.started", 300*time.Millisecond); ev != nil {
		t.Fatalf("depth-skipped run emitted started: %v", ev)
	}
}

func TestTeamPatchAndLeave(t *testing.T) {
	e := newEnv(t)
	owner, alice, bob := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	aliceMember := e.addMember(owner, tm, alice)
	e.addMember(owner, tm, bob)
	wsA := e.dialWS(alice.Token)
	wsB := e.dialWS(bob.Token)

	name50 := strings.Repeat("团", 50)
	up := e.must(200, "PATCH", "/api/v1/teams/"+tm.ID, owner.Token, map[string]any{"name": "  " + name50 + " ", "description": "  hello\nworld  "})
	if up["name"] != name50 || up["description"] != "hello\nworld" {
		t.Fatalf("patch team: %v", up)
	}
	if ev := wsA.waitFor("team.updated", 2*time.Second); ev == nil || ev["team_id"] != tm.ID || ev["data"].(map[string]any)["description"] != "hello\nworld" {
		t.Fatalf("team.updated: %v", ev)
	}
	for _, body := range []map[string]any{{"name": strings.Repeat("团", 51)}, {"name": "   "}, {"description": strings.Repeat("d", 501)}} {
		if r := e.do("PATCH", "/api/v1/teams/"+tm.ID, owner.Token, body); r.Status != 400 {
			t.Fatalf("validation %v: %d", body, r.Status)
		}
	}
	e.must(200, "PATCH", "/api/v1/teams/"+tm.ID, owner.Token, map[string]any{"description": strings.Repeat("d", 500)})
	if r := e.do("PATCH", "/api/v1/teams/"+tm.ID, alice.Token, map[string]any{"name": "x"}); r.Status != 403 {
		t.Fatalf("member patch: %d", r.Status)
	}
	got := e.must(200, "GET", "/api/v1/teams/"+tm.ID, alice.Token, nil)
	if _, ok := got["description"]; !ok {
		t.Fatal("team.description missing")
	}

	// leave via /members/me
	if r := e.do("DELETE", "/api/v1/teams/"+tm.ID+"/members/me", owner.Token, nil); r.Status != 409 || r.errCode() != "owner_cannot_leave" {
		t.Fatalf("owner leave: %d %s", r.Status, r.Body)
	}
	if r := e.do("DELETE", "/api/v1/teams/"+tm.ID+"/members/"+tm.MemberID, owner.Token, nil); r.Status != 409 {
		t.Fatalf("owner self-remove: %d", r.Status)
	}
	e.must(204, "DELETE", "/api/v1/teams/"+tm.ID+"/members/me", alice.Token, nil)
	if ev := wsA.waitFor("team.removed", 2*time.Second); ev == nil || ev["team_id"] != tm.ID {
		t.Fatalf("team.removed: %v", ev)
	}
	if ev := wsB.waitFor("member.left", 2*time.Second); ev == nil || ev["data"].(map[string]any)["member_id"] != aliceMember {
		t.Fatalf("member.left: %v", ev)
	}
	if r := e.do("DELETE", "/api/v1/teams/"+tm.ID+"/members/me", alice.Token, nil); r.Status != 404 {
		t.Fatalf("leave twice: %d", r.Status)
	}
	b, _ := e.newBot(owner, tm, nil)
	if r := e.do("DELETE", "/api/v1/teams/"+tm.ID+"/members/me", b.Token, nil); r.Status != 403 {
		t.Fatalf("bot leave: %d", r.Status)
	}
}
