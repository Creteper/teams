package realtime

import (
	"encoding/json"
	"testing"
)

func recv(t *testing.T, c *Client) map[string]any {
	select {
	case b := <-c.Send:
		var m map[string]any
		json.Unmarshal(b, &m)
		return m
	default:
		return nil
	}
}

func TestHubRouting(t *testing.T) {
	h := NewHub()
	a := NewClient("user:a", []string{"t1"}, 8)
	b := NewClient("user:b", []string{"t1", "t2"}, 8)
	h.Register(a)
	h.Register(b)
	h.PublishTeam("t2", "message.created", map[string]any{})
	if recv(t, a) != nil || recv(t, b)["team_id"] != "t2" {
		t.Fatal("team routing")
	}
	h.PublishTeamExcept("t1", "user:a", "member.joined", 1)
	if recv(t, a) != nil || recv(t, b) == nil {
		t.Fatal("except")
	}
	h.SetTeam("user:a", "t2", true)
	h.PublishTeam("t2", "x", 1)
	if recv(t, a) == nil {
		t.Fatal("SetTeam add")
	}
	recv(t, b)
	h.SetTeam("user:a", "t2", false)
	h.PublishTeam("t2", "x", 1)
	if recv(t, a) != nil {
		t.Fatal("SetTeam remove")
	}
	h.PublishPrincipal("user:a", "t9", "team.joined", 1)
	if m := recv(t, a); m == nil || m["type"] != "team.joined" {
		t.Fatal("principal")
	}
	// slow consumer is kicked
	s := NewClient("user:s", []string{"t1"}, 1)
	h.Register(s)
	h.PublishTeam("t1", "x", 1)
	h.PublishTeam("t1", "x", 1)
	select {
	case <-s.Done:
	default:
		t.Fatal("slow client not kicked")
	}
	h.Unregister(a)
	if h.Count() != 2 {
		t.Fatal(h.Count())
	}
}
