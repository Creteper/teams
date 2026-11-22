package httpapi

import (
	"strings"
	"testing"
)

func TestIssueWorkflow(t *testing.T) {
	e := newEnv(t)
	owner, assignee, observer := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	member := e.addMember(owner, tm, assignee)
	e.addMember(owner, tm, observer)
	other := e.newTeam(observer)
	base := "/api/v1/teams/" + tm.ID
	opts := items(e.must(200, "GET", base+"/issue-options", owner.Token, nil))
	if len(opts) == 0 {
		t.Fatal("missing default statuses")
	}
	for _, kind := range []string{"status", "label"} {
		body := map[string]any{"kind": kind, "name": "Review", "color": "#5588aa"}
		e.must(201, "POST", base+"/issue-options", assignee.Token, body)
		e.must(409, "POST", base+"/issue-options", owner.Token, body)
	}
	attachment := e.must(201, "POST", base+"/issue-attachments", owner.Token, multipartFile("file", "notes.txt", []byte("notes"), nil))
	input := map[string]any{"id": newID(), "title": "Issue", "description": "Details", "status": "Review", "labels": []string{"Review"}, "priority": "high", "assignee_id": member, "start_date": "2026-11-19", "end_date": "2026-11-22", "attachment_ids": []any{attachment["id"]}}
	e.must(400, "POST", base+"/issues", assignee.Token, input)
	input["assignee_id"] = other.MemberID
	e.must(400, "POST", base+"/issues", owner.Token, input)
	input["assignee_id"] = member
	for i := 0; i < 2; i++ {
		result := e.must(201, "POST", base+"/issues", owner.Token, input)
		if result["creator_id"] != tm.MemberID || result["assignee_id"] != member || result["end_date"] != "2026-11-22" || len(result["attachments"].([]any)) != 1 || len(result["labels"].([]any)) != 1 {
			t.Fatalf("issue fields: %v", result)
		}
	}
	if got := len(items(e.must(200, "GET", base+"/issues", observer.Token, nil))); got != 1 {
		t.Fatalf("team issue count %d", got)
	}
	if got := len(items(e.must(200, "GET", "/api/v1/me/issues", assignee.Token, nil))); got != 1 {
		t.Fatalf("assigned issue count %d", got)
	}
	for _, who := range []user{owner, observer} {
		if got := len(items(e.must(200, "GET", "/api/v1/me/issues", who.Token, nil))); got != 0 {
			t.Fatalf("expected no assigned issues, got %d", got)
		}
	}
	e.must(404, "GET", "/api/v1/teams/"+other.ID+"/issues", owner.Token, nil)
	e.must(204, "DELETE", base+"/members/me", assignee.Token, nil)
	if got := len(items(e.must(200, "GET", "/api/v1/me/issues", assignee.Token, nil))); got != 0 {
		t.Fatalf("departed member still sees %d issues", got)
	}
	input["id"] = newID()
	input["assignee_id"] = nil
	e.must(400, "POST", base+"/issues", owner.Token, input)
	file := e.do("GET", attachment["url"].(string), "", nil)
	if file.Status != 200 || string(file.Body) != "notes" || !strings.HasPrefix(file.Header.Get("Content-Disposition"), "attachment") {
		t.Fatal("file download failed")
	}
}

func TestIssueDiscussion(t *testing.T) {
	e := newEnv(t)
	alice, bob, outsider := e.newUser(), e.newUser(), e.newUser()
	tm := e.newTeam(alice)
	e.addMember(alice, tm, bob)
	base := "/api/v1/teams/" + tm.ID
	newIssue := func() string {
		id := newID()
		e.must(201, "POST", base+"/issues", alice.Token, map[string]any{"id": id, "title": "讨论", "status": "待处理", "priority": "none"})
		return base + "/issues/" + id
	}
	issue, other := newIssue(), newIssue()
	change := map[string]any{"previous": "", "description": "## 验收\n\n**结果**"}
	e.must(204, "PATCH", issue+"/description", bob.Token, change)
	e.must(409, "PATCH", issue+"/description", alice.Token, map[string]any{"previous": "", "description": "旧草稿"})
	e.must(404, "PATCH", issue+"/description", outsider.Token, change)
	url := issue + "/comments"
	root := e.must(201, "POST", url, alice.Token, map[string]any{"id": newID(), "body": "主题"})
	reply := e.must(201, "POST", url, bob.Token, map[string]any{"id": newID(), "body": "回复", "reply_to_id": root["id"]})
	file := e.must(201, "POST", base+"/issue-attachments", alice.Token, multipartFile("file", "sample.txt", []byte("text"), nil))
	data := map[string]any{"id": newID(), "reply_to_id": reply["id"], "attachment_ids": []any{file["id"]}}
	e.must(400, "POST", other+"/comments", alice.Token, data)
	e.must(400, "POST", url, bob.Token, data)
	e.must(404, "POST", url, outsider.Token, data)
	for i := 0; i < 2; i++ {
		last := e.must(201, "POST", url, alice.Token, data)
		if last["root_id"] != root["id"] || last["reply_to_id"] != reply["id"] || len(last["attachments"].([]any)) != 1 {
			t.Fatalf("reply: %v", last)
		}
	}
	if got := len(items(e.must(200, "GET", url, bob.Token, nil))); got != 3 {
		t.Fatalf("got %d comments", got)
	}
	e.must(404, "GET", url, outsider.Token, nil)
	for _, item := range items(e.must(200, "GET", base+"/issues", alice.Token, nil)) {
		if len(item["attachments"].([]any)) != 0 {
			t.Fatal("comment attachment appeared on issue")
		}
	}
}

func TestIssueTableProperties(t *testing.T) {
	e := newEnv(t)
	owner, outsider := e.newUser(), e.newUser()
	tm := e.newTeam(owner)
	other := e.newTeam(outsider)
	base := "/api/v1/teams/" + tm.ID
	id := newID()
	e.must(201, "POST", base+"/issues", owner.Token, map[string]any{"id": id, "title": "更新属性", "status": "待处理", "priority": "none", "assignee_id": tm.MemberID})
	path := base + "/issues/" + id
	patch := func(code int, field string, value any) map[string]any {
		return e.must(code, "PATCH", path, owner.Token, map[string]any{"field": field, "value": value})
	}
	e.must(404, "PATCH", path, outsider.Token, map[string]any{"field": "priority", "value": "high"})
	patch(400, "assignee", other.MemberID)
	patch(400, "status", "unknown")
	patch(400, "priority", "unknown")
	patch(400, "add_label", "unknown")
	patch(200, "priority", "high")
	patch(200, "status", "进行中")
	for _, name := range []string{"one", "two"} {
		e.must(201, "POST", base+"/issue-options", owner.Token, map[string]any{"kind": "label", "name": name, "color": "#eef744"})
		patch(200, "add_label", name)
		patch(200, "add_label", name)
	}
	for n := 0; n < 2; n++ {
		r := patch(200, "remove_label", "one")
		if len(r["labels"].([]any)) != 1 {
			t.Fatal(r)
		}
	}
	e.must(400, "PATCH", path, owner.Token, map[string]any{"field": "schedule", "start_date": "2026-10-02", "end_date": "2026-10-01"})
	r := e.must(200, "PATCH", path, owner.Token, map[string]any{"field": "schedule", "end_date": "2026-11-21"})
	if r["priority"] != "high" || r["status"].(map[string]any)["name"] != "进行中" || r["start_date"] != nil || r["end_date"] != "2026-11-21" {
		t.Fatal(r)
	}
	patch(200, "assignee", nil)
	if len(items(e.must(200, "GET", "/api/v1/me/issues", owner.Token, nil))) != 0 {
		t.Fatal("unassigned issue remains in personal list")
	}
}

func TestBotIssueLifecycleAndReadOnlyArchive(t *testing.T) {
	e := newEnv(t)
	owner := e.newUser()
	tm := e.newTeam(owner)
	bot, _ := e.newBot(owner, tm, nil)
	other := e.newTeam(owner)
	base := "/api/v1/teams/" + tm.ID
	id := newID()
	path := base + "/issues/" + id
	foreignPath := "/api/v1/teams/" + other.ID + "/issues/" + id
	e.must(404, "GET", foreignPath, bot.Token, nil)
	e.must(200, "GET", base+"/issue-options", bot.Token, nil)
	file := e.must(201, "POST", base+"/issue-attachments", bot.Token, multipartFile("file", "brief.txt", []byte("brief"), nil))
	created := e.must(201, "POST", base+"/issues", bot.Token, map[string]any{"id": id, "title": "**初稿**", "status": "待处理", "priority": "none", "assignee_id": tm.MemberID, "attachment_ids": []any{file["id"]}})
	if created["creator_id"] != bot.MemberID || created["creator_name"] != "Bot" || created["archived_at"] != nil {
		t.Fatal(created)
	}
	patch := map[string]any{"field": "title", "value": "验收 `CLI`"}
	update := e.must(200, "PATCH", path, bot.Token, patch)
	if update["title"] != patch["value"] {
		t.Fatal(update)
	}
	e.must(204, "PATCH", path+"/description", bot.Token, map[string]any{"description": "**说明**", "previous": ""})
	attachment := e.must(201, "POST", base+"/issue-attachments", owner.Token, multipartFile("file", "notes.txt", []byte("notes"), nil))
	comment := e.must(201, "POST", path+"/comments", owner.Token, map[string]any{"id": newID(), "body": "讨论"})
	e.must(201, "POST", path+"/comments", owner.Token, map[string]any{"id": newID(), "body": "回复", "reply_to_id": comment["id"], "attachment_ids": []any{attachment["id"]}})
	e.must(404, "POST", foreignPath+"/archive", bot.Token, nil)
	archive := e.must(200, "POST", path+"/archive", bot.Token, nil)
	if archive["archived_at"] == nil || archive["archived_at"] != e.must(200, "POST", path+"/archive", owner.Token, nil)["archived_at"] {
		t.Fatal("unstable archive timestamp")
	}
	for _, list := range []string{base + "/issues", "/api/v1/me/issues"} {
		if len(items(e.must(200, "GET", list, owner.Token, nil))) != 0 || len(items(e.must(200, "GET", list+"?archived=true", owner.Token, nil))) != 1 {
			t.Fatal(list)
		}
	}
	for _, tok := range []string{owner.Token, bot.Token} {
		item := e.must(200, "GET", path, tok, nil)
		if item["description"] != "**说明**" || item["title"] != patch["value"] || len(item["attachments"].([]any)) != 1 {
			t.Fatal(item)
		}
		e.must(409, "PATCH", path, tok, patch)
		e.must(409, "PATCH", path+"/description", tok, map[string]any{"description": "new", "previous": "**说明**"})
		if len(items(e.must(200, "GET", path+"/comments", tok, nil))) != 2 {
			t.Fatal("missing discussion")
		}
	}
	for _, parent := range []any{nil, comment["id"]} {
		e.must(409, "POST", path+"/comments", owner.Token, map[string]any{"id": newID(), "body": "late", "reply_to_id": parent})
	}
	for _, f := range []map[string]any{file, attachment} {
		meta := e.must(200, "GET", "/api/v1/attachments/"+f["id"].(string), bot.Token, nil)
		if r := e.do("GET", meta["url"].(string), "", nil); r.Status != 200 || len(r.Body) == 0 {
			t.Fatal("missing archived attachment")
		}
	}
}
