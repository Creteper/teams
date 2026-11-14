package httpapi

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A bot can read and write messages with its own token (api.md §8.6),
// limited to its own team.
func TestBotTokenReadWrite(t *testing.T) {
	e := newEnv(t)
	owner, alice := e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	aliceM := e.addMember(owner, tm, alice)
	b, _ := e.newBot(owner, tm, nil)
	ou := e.newUser()
	ot := e.newTeam(ou)
	om := e.send(ou.Token, ot.GeneralID, map[string]any{"content": "secret"})

	// list channels of own team; other team → 404
	ch := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", owner.Token, map[string]any{"name": "news"})
	cid := ch["id"].(string)
	found := false
	for _, c := range items(e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/channels", b.Token, nil)) {
		found = found || c["id"] == cid
	}
	if !found {
		t.Fatal("bot channel list misses channel")
	}
	e.must(200, "GET", "/api/v1/channels/"+cid, b.Token, nil)
	for _, p := range []string{"/api/v1/teams/" + ot.ID + "/channels", "/api/v1/channels/" + ot.GeneralID,
		"/api/v1/channels/" + ot.GeneralID + "/messages", "/api/v1/messages/" + om["id"].(string),
		"/api/v1/teams/" + ot.ID + "/members", "/api/v1/teams/" + ot.ID + "/members/" + ot.MemberID} {
		if r := e.do("GET", p, b.Token, nil); r.Status != 404 {
			t.Fatalf("other team %s: %d", p, r.Status)
		}
	}

	// history paging with before / after
	var seqs []int64
	var ids []string
	for i := 1; i <= 7; i++ {
		m := e.send(alice.Token, cid, map[string]any{"content": "公告 " + strconv.Itoa(i)})
		seqs = append(seqs, num(m["seq"]))
		ids = append(ids, m["id"].(string))
	}
	page := func(q string) ([]int64, map[string]any) {
		r := e.must(200, "GET", "/api/v1/channels/"+cid+"/messages"+q, b.Token, nil)
		var out []int64
		for _, m := range items(r) {
			out = append(out, num(m["seq"]))
		}
		return out, r
	}
	eq := func(got []int64, want ...int64) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range got {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}
	got, r := page("?before=" + strconv.FormatInt(seqs[6], 10) + "&limit=3")
	if !eq(got, seqs[3], seqs[4], seqs[5]) || r["has_more"] != true || r["next_cursor"] != strconv.FormatInt(seqs[3], 10) {
		t.Fatalf("before page: %v %v", got, r)
	}
	got, r = page("?before=" + r["next_cursor"].(string) + "&limit=3")
	if !eq(got, seqs[0], seqs[1], seqs[2]) || r["has_more"] != false {
		t.Fatalf("older page: %v %v", got, r)
	}
	got, r = page("?after=" + strconv.FormatInt(seqs[0], 10) + "&limit=2")
	if !eq(got, seqs[1], seqs[2]) || r["has_more"] != true || r["next_cursor"] != strconv.FormatInt(seqs[2], 10) {
		t.Fatalf("after page: %v %v", got, r)
	}
	got, _ = page("")
	if !eq(got, seqs...) {
		t.Fatalf("latest: %v", got)
	}
	if r := e.do("GET", "/api/v1/channels/"+cid+"/messages?before=1&after=2", b.Token, nil); r.Status != 400 {
		t.Fatalf("before+after: %d", r.Status)
	}

	// single message
	one := e.must(200, "GET", "/api/v1/messages/"+ids[2], b.Token, nil)
	if one["content"] != "公告 3" || one["channel_id"] != cid {
		t.Fatalf("single: %v", one)
	}

	// send with reply_to and @; cannot post into another team
	reply := e.send(b.Token, cid, map[string]any{"content": "<@" + aliceM + "> 收到", "reply_to": ids[6]})
	if reply["reply_to"] != ids[6] || len(reply["mentions"].([]any)) != 1 ||
		reply["mentions"].([]any)[0].(map[string]any)["member_id"] != aliceM || reply["sender"].(map[string]any)["member_id"] != b.MemberID {
		t.Fatalf("bot reply: %v", reply)
	}
	if r := e.do("POST", "/api/v1/channels/"+ot.GeneralID+"/messages", b.Token, map[string]any{"content": "hi"}); r.Status != 404 {
		t.Fatalf("send other team: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/channels/"+cid+"/messages", b.Token, map[string]any{"content": "x", "reply_to": om["id"]}); r.Status != 400 {
		t.Fatalf("reply_to other team: %d", r.Status)
	}

	// edit / delete own; others' → 403; other team → 404
	rid := reply["id"].(string)
	ed := e.must(200, "PATCH", "/api/v1/messages/"+rid, b.Token, map[string]any{"content": "已更正"})
	if ed["content"] != "已更正" || ed["edited_at"] == nil || len(ed["mentions"].([]any)) != 0 {
		t.Fatalf("edit: %v", ed)
	}
	if r := e.do("PATCH", "/api/v1/messages/"+ids[0], b.Token, map[string]any{"content": "x"}); r.Status != 403 {
		t.Fatalf("edit others: %d", r.Status)
	}
	if r := e.do("DELETE", "/api/v1/messages/"+ids[0], b.Token, nil); r.Status != 403 {
		t.Fatalf("delete others: %d", r.Status)
	}
	for _, m := range []string{"PATCH", "DELETE"} {
		if r := e.do(m, "/api/v1/messages/"+om["id"].(string), b.Token, map[string]any{"content": "x"}); r.Status != 404 {
			t.Fatalf("%s other team: %d", m, r.Status)
		}
	}
	e.must(204, "DELETE", "/api/v1/messages/"+rid, b.Token, nil)
	if d := e.must(200, "GET", "/api/v1/messages/"+rid, b.Token, nil); d["deleted"] != true {
		t.Fatalf("deleted: %v", d)
	}

	// members
	ms := items(e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members", b.Token, nil))
	if len(ms) != 3 {
		t.Fatalf("members: %d", len(ms))
	}
	if m := e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/members/"+aliceM, b.Token, nil); m["id"] != aliceM || m["type"] != "user" {
		t.Fatalf("member: %v", m)
	}
}

// The mention payload carries no context; reply.history points at the page
// before the trigger message, and the bot's token can follow it.
func TestWebhookHistoryHint(t *testing.T) {
	e := newEnv(t)
	owner := e.newUser()
	tm := e.newTeam(owner)
	rc := newReceiver(t, nil)
	b, _ := e.newBot(owner, tm, nil)
	e.configureWebhook(owner, b, rc.ts.URL, nil)
	e.send(owner.Token, tm.GeneralID, map[string]any{"content": "公告：周五停机"})
	trig := e.send(owner.Token, tm.GeneralID, map[string]any{"content": "<@" + b.MemberID + "> 看上面"})
	eventually(t, 3*time.Second, func() bool { return rc.count() == 1 })
	body := string(rc.get(0).Body)
	var pl struct {
		Reply struct {
			History struct{ Method, URL string } `json:"history"`
		} `json:"reply"`
		Context any `json:"context"`
	}
	json.Unmarshal([]byte(body), &pl)
	seq := strconv.FormatInt(num(trig["seq"]), 10)
	want := e.cfg.PublicBaseURL + "/api/v1/channels/" + tm.GeneralID + "/messages?before=" + seq + "&limit=50"
	if pl.Reply.History.Method != "GET" || pl.Reply.History.URL != want || pl.Context != nil {
		t.Fatalf("history hint: %+v", pl)
	}
	if di, hi, ti := strings.Index(body, `"decline":`), strings.Index(body, `"history":`), strings.Index(body, `},"team":`); !(di < hi && hi < ti) {
		t.Fatalf("history not after decline: %s", body)
	}
	page := e.must(200, "GET", strings.TrimPrefix(want, e.cfg.PublicBaseURL), b.Token, nil)
	its := items(page)
	if len(its) == 0 || its[len(its)-1]["content"] != "公告：周五停机" {
		t.Fatalf("history page: %v", page)
	}
}
