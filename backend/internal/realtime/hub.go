// Package realtime fans out events to connected WebSocket clients by team.
package realtime

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Event struct {
	Type   string `json:"type"`
	ID     string `json:"id,omitempty"`
	TS     string `json:"ts,omitempty"`
	TeamID string `json:"team_id,omitempty"`
	Data   any    `json:"data"`
}

// Client is one connection. Principal is "user:<id>" or "bot:<id>".
type Client struct {
	Principal string
	Send      chan []byte
	teams     map[string]bool
	closed    bool
	closeOnce sync.Once
	Done      chan struct{}
}

func NewClient(principal string, teams []string, buf int) *Client {
	c := &Client{Principal: principal, Send: make(chan []byte, buf), teams: map[string]bool{}, Done: make(chan struct{})}
	for _, t := range teams {
		c.teams[t] = true
	}
	return c
}

// Kick signals the connection loop to terminate (slow consumer).
func (c *Client) Kick() { c.closeOnce.Do(func() { close(c.Done) }) }

type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]bool
}

func NewHub() *Hub { return &Hub{clients: map[*Client]bool{}} }

func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()
}

func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	delete(h.clients, c)
	c.closed = true
	h.mu.Unlock()
	c.Kick()
}

func NewEvent(typ, teamID string, data any) Event {
	id, _ := uuid.NewV7()
	return Event{Type: typ, ID: "evt_" + id.String(), TS: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), TeamID: teamID, Data: data}
}

func (h *Hub) deliver(match func(*Client) bool, ev Event) {
	b, err := json.Marshal(ev)
	if err != nil {
		slog.Error("marshal event", "err", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c.closed || !match(c) {
			continue
		}
		select {
		case c.Send <- b:
		default:
			slog.Warn("ws client too slow, disconnecting", "principal", c.Principal)
			c.Kick()
		}
	}
}

// PublishTeam sends an event to every client subscribed to teamID.
func (h *Hub) PublishTeam(teamID, typ string, data any) {
	h.deliver(func(c *Client) bool { return c.teams[teamID] }, NewEvent(typ, teamID, data))
}

// PublishTeamExcept sends to teamID subscribers except one principal.
func (h *Hub) PublishTeamExcept(teamID, except, typ string, data any) {
	h.deliver(func(c *Client) bool { return c.teams[teamID] && c.Principal != except }, NewEvent(typ, teamID, data))
}

// PublishPrincipal sends an event to all connections of one principal.
func (h *Hub) PublishPrincipal(principal, teamID, typ string, data any) {
	h.deliver(func(c *Client) bool { return c.Principal == principal }, NewEvent(typ, teamID, data))
}

func (h *Hub) SetTeam(principal, teamID string, member bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if c.Principal == principal {
			if member {
				c.teams[teamID] = true
			} else {
				delete(c.teams, teamID)
			}
		}
	}
}

// Count returns the number of connected clients (tests/metrics).
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
