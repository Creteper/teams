package httpapi

import (
	"encoding/json"
	"testing"
	"time"
)

func TestBotDecline(t *testing.T) {
	e := newEnv(t, withVAPID(t))
	owner, u := e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	uMember := e.addMember(owner, tm, u)
	rc := newReceiver(t, nil)
	b, _ := e.newBot(owner, tm, map[string]any{"display_name": "Dean"})
	e.configureWebhook(owner, b, rc.ts.URL, nil)
	rc2 := newReceiver(t, nil)
	b2, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, b2, rc2.ts.URL, nil)
	ws := e.dialWS(owner.Token)

	trig := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> 帮我订机票"})
	trigID := trig["id"].(string)
	eventually(t, 3*time.Second, func() bool { return rc.count() == 1 })
	// webhook payload tells the bot how to decline
	var pl struct {
		Reply struct {
			Decline struct{ Method, URL string } `json:"decline"`
		} `json:"reply"`
	}
	json.Unmarshal(rc.get(0).Body, &pl)
	if pl.Reply.Decline.Method != "POST" || pl.Reply.Decline.URL != e.cfg.PublicBaseURL+"/api/v1/messages/"+trigID+"/decline" {
		t.Fatalf("decline hint: %+v", pl.Reply.Decline)
	}
	ws.waitFor("bot.run.delivered", 2*time.Second)

	// validation and permissions
	if r := e.do("POST", "/api/v1/messages/"+trigID+"/decline", owner.Token, nil); r.Status != 403 {
		t.Fatalf("user token: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/messages/"+trigID+"/decline", b2.Token, nil); r.Status != 403 || r.errCode() != "not_mentioned" {
		t.Fatalf("not mentioned bot: %d %s", r.Status, r.Body)
	}
	if r := e.do("POST", "/api/v1/messages/"+newID()+"/decline", b.Token, nil); r.Status != 404 {
		t.Fatalf("missing message: %d", r.Status)
	}
	long := make([]rune, 201)
	for i := range long {
		long[i] = 'x'
	}
	if r := e.do("POST", "/api/v1/messages/"+trigID+"/decline", b.Token, map[string]any{"reason": string(long)}); r.Status != 400 {
		t.Fatalf("long reason: %d", r.Status)
	}
	ou := e.newUser()
	otherTeam := e.newTeam(ou)
	om := e.send(ou.Token, otherTeam.GeneralID, map[string]any{"content": "hi"})
	if r := e.do("POST", "/api/v1/messages/"+om["id"].(string)+"/decline", b.Token, nil); r.Status != 404 {
		t.Fatalf("other team message: %d", r.Status)
	}

	// decline: note message + events
	reason := "超出我的能力范围 <@" + b2.MemberID + ">"
	note := e.must(201, "POST", "/api/v1/messages/"+trigID+"/decline", b.Token, map[string]any{"reason": reason})
	if note["kind"] != "bot_declined" || note["reply_to"] != trigID || note["content"] != reason || num(note["trigger_depth"]) != 0 ||
		note["sender"].(map[string]any)["member_id"] != b.MemberID || len(note["mentions"].([]any)) != 0 {
		t.Fatalf("note: %v", note)
	}
	mc := ws.waitFor("message.created", 2*time.Second)
	for mc != nil && mc["data"].(map[string]any)["id"] != note["id"] {
		mc = ws.waitFor("message.created", 2*time.Second)
	}
	if mc == nil || mc["data"].(map[string]any)["kind"] != "bot_declined" {
		t.Fatalf("message.created: %v", mc)
	}
	dv := checkRunFields(t, ws.waitFor("bot.run.declined", 2*time.Second), tm, b.MemberID, trigID)
	if dv["decline_message_id"] != note["id"] || dv["reason"] != reason {
		t.Fatalf("bot.run.declined: %v", dv)
	}
	// idempotent
	again := e.must(200, "POST", "/api/v1/messages/"+trigID+"/decline", b.Token, nil)
	if again["id"] != note["id"] {
		t.Fatalf("repeat: %v", again)
	}
	if x := ws.waitFor("bot.run.declined", 200*time.Millisecond); x != nil {
		t.Fatalf("duplicate declined event: %v", x)
	}
	// persisted in history, run status declined
	hist := items(e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID+"/messages", u.Token, nil))
	if last := hist[len(hist)-1]; last["id"] != note["id"] || last["kind"] != "bot_declined" || hist[0]["kind"] != "message" {
		t.Fatalf("history: %v", hist)
	}
	runs := items(e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID+"/bot-runs", owner.Token, nil))
	if len(runs) == 0 || runs[0]["status"] != "declined" || runs[0]["reply_message_id"] != note["id"] {
		t.Fatalf("runs: %v", runs)
	}
	if act := items(e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID+"/bot-runs?active=true", owner.Token, nil)); len(act) != 0 {
		t.Fatalf("declined run still active: %v", act)
	}
	// the note triggers no webhook (despite <@b2> in the reason) and no mention
	time.Sleep(150 * time.Millisecond)
	if rc2.count() != 0 {
		t.Fatalf("note triggered webhook: %d", rc2.count())
	}
	// notes cannot be edited
	if r := e.do("PATCH", "/api/v1/messages/"+note["id"].(string), b.Token, map[string]any{"content": "x"}); r.Status != 403 {
		t.Fatalf("edit note: %d", r.Status)
	}
	// notes are not unread for anyone
	if c := channelByID(t, e, u.Token, tm.ID, tm.GeneralID); num(c["unread_count"]) != 1 {
		t.Fatalf("unread (trigger only): %v", c)
	}
	// replying later does not turn declined into completed
	e.send(b.Token, tm.GeneralID, map[string]any{"content": "其实可以", "reply_to": trigID})
	if x := ws.waitFor("bot.run.completed", 300*time.Millisecond); x != nil {
		t.Fatalf("completed after declined: %v", x)
	}
	runs = items(e.must(200, "GET", "/api/v1/channels/"+tm.GeneralID+"/bot-runs", owner.Token, nil))
	if runs[0]["status"] != "declined" {
		t.Fatalf("status after reply: %v", runs[0])
	}

	// already replied → 409
	t2 := e.send(u.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> 2"})
	t2ID := t2["id"].(string)
	eventually(t, 3*time.Second, func() bool { return rc.count() == 2 })
	reply := e.send(b.Token, tm.GeneralID, map[string]any{"content": "<@" + uMember + "> ok", "reply_to": t2ID})
	if num(reply["trigger_depth"]) != 1 {
		t.Fatalf("reply depth: %v", reply["trigger_depth"])
	}
	if r := e.do("POST", "/api/v1/messages/"+t2ID+"/decline", b.Token, nil); r.Status != 409 || r.errCode() != "already_replied" {
		t.Fatalf("decline after reply: %d %s", r.Status, r.Body)
	}
	// decline with no body; a bot reply to the note still uses normal depth rules
	t3 := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> 3"})
	n3 := e.must(201, "POST", "/api/v1/messages/"+t3["id"].(string)+"/decline", b.Token, nil)
	if n3["content"] != "" {
		t.Fatalf("empty reason: %v", n3)
	}
	// deleted trigger → 404
	t4 := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> 4"})
	e.must(204, "DELETE", "/api/v1/messages/"+t4["id"].(string), owner.Token, nil)
	if r := e.do("POST", "/api/v1/messages/"+t4["id"].(string)+"/decline", b.Token, nil); r.Status != 404 {
		t.Fatalf("deleted trigger: %d", r.Status)
	}
}
