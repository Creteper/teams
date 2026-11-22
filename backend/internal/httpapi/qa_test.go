package httpapi

import (
	"encoding/json"
	"testing"
	"time"
)

func TestQACardConversation(t *testing.T) {
	e := newEnv(t, withVAPID(t))
	owner, user, other := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	uid := e.addMember(owner, tm, user)
	botA, _ := e.newBot(owner, tm, nil)
	botB, _ := e.newBot(owner, tm, nil)
	rc := newReceiver(t, nil)
	e.configureWebhook(owner, botB, rc.ts.URL, nil)
	push := newReceiver(t, func(int) int { return 201 })
	sub := newBrowserSub(t, push.ts.URL+"/push")
	e.must(201, "POST", "/api/v1/push/subscriptions", user.Token, sub.json())
	questions := []qaQuestion{{Prompt: "选择", Options: []string{"one", "two", "three", "four"}}, {Prompt: "补充", Options: []string{}}}
	for _, sender := range []string{owner.Token, botA.Token} {
		for _, recipient := range []string{uid, botB.MemberID} {
			m := e.send(sender, tm.GeneralID, map[string]any{"qa_card": qaCard{Recipient: recipient, Questions: questions}})
			path := "/api/v1/messages/" + m["id"].(string)
			if len(m["mentions"].([]any)) != 1 || m["qa_card"] == nil {
				t.Fatal("missing QA mention")
			}
			submit := func(status int, token string, q int, choice, text string) map[string]any {
				return e.must(status, "PUT", path+"/qa-answer", token, map[string]any{"question": q, "choice": choice, "text": text})
			}
			submit(404, other.Token, 0, "A", "")
			submit(403, sender, 0, "A", "")
			if recipient == uid {
				e.srv.push.wg.Wait()
				if push.count() == 0 || sub.decrypt(t, push.get(push.count()-1).Body)["type"] != "mention" {
					t.Fatal("no bound-user mention push")
				}
				submit(200, user.Token, 0, "skip", "")
				submit(200, user.Token, 1, "other", "自由回答")
				submit(200, user.Token, 0, "D", "")
				submit(409, user.Token, 0, "A", "")
			} else {
				submit(403, botB.Token, 0, "skip", "")
				submit(409, botB.Token, 1, "other", "ahead")
				submit(400, botB.Token, 0, "E", "")
				submit(200, botB.Token, 0, "A", "")
				submit(200, botB.Token, 0, "A", "")
				submit(400, botB.Token, 1, "other", " ")
				submit(200, botB.Token, 1, "other", "done")
				if num(e.must(200, "GET", path, owner.Token, nil)["qa_card"].(map[string]any)["revision"]) != 2 {
					t.Fatal("incorrect answer count")
				}
			}
		}
	}
	eventually(t, 3*time.Second, func() bool { return rc.count() == 2 })
	var event struct {
		Message struct {
			Card *qaCard `json:"qa_card"`
		} `json:"message"`
	}
	if json.Unmarshal(rc.get(0).Body, &event) != nil || event.Message.Card == nil {
		t.Fatal("no card in bot webhook")
	}
	questions[0].Options = append(questions[0].Options, "five")
	e.must(400, "POST", "/api/v1/channels/"+tm.GeneralID+"/messages", owner.Token, map[string]any{"qa_card": qaCard{Recipient: uid, Questions: questions}})
}

func TestIssueWebhookOptIn(t *testing.T) {
	e := newEnv(t)
	u := e.newUser()
	tm := e.newTeam(u)
	bot, _ := e.newBot(u, tm, nil)
	rc := newReceiver(t, nil)
	e.configureWebhook(u, bot, rc.ts.URL, nil)
	post := "/api/v1/teams/" + tm.ID + "/issues"
	create := func(id string) {
		e.must(201, "POST", post, u.Token, map[string]any{"id": id, "title": "Test", "priority": "none", "status": "待处理"})
	}
	create(newID())
	e.must(200, "PUT", "/api/v1/bots/me/issue-webhook", bot.Token, map[string]bool{"enabled": true})
	id := newID()
	create(id)
	create(id)
	e.must(200, "PATCH", post+"/"+id, bot.Token, map[string]string{"field": "title", "value": "Changed"})
	e.must(201, "POST", post+"/"+id+"/comments", u.Token, map[string]string{"id": newID(), "body": "Note"})
	e.must(200, "POST", post+"/"+id+"/archive", bot.Token, nil)
	eventually(t, 3*time.Second, func() bool { return rc.count() == 4 })
	found := map[string]bool{}
	for i := 0; i < 4; i++ {
		var payload struct {
			Event string
			Data  struct {
				Issue string `json:"issue_id"`
			}
		}
		if json.Unmarshal(rc.get(i).Body, &payload) != nil || payload.Data.Issue != id {
			t.Fatal("wrong issue")
		}
		found[payload.Event] = true
	}
	for _, ev := range []string{"issue.created", "issue.updated", "issue.commented", "issue.archived"} {
		if !found[ev] {
			t.Fatal(ev)
		}
	}
}
