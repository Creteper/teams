package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/coder/websocket"
	"github.com/creteper/teams/backend/internal/realtime"
	"github.com/jackc/pgx/v5"
)

const (
	wsAuthTimeout = 5 * time.Second
	wsReadIdle    = 60 * time.Second
	wsSendBuffer  = 256
	closeUnauth   = websocket.StatusCode(4401)
)

func (s *Server) originPatterns() []string {
	var out []string
	for _, o := range s.cfg.CORSOrigins {
		if u, err := url.Parse(o); err == nil && u.Host != "" {
			out = append(out, u.Host)
		}
	}
	return out
}

func frame(typ string, data any) []byte {
	b, _ := json.Marshal(realtime.Event{Type: typ, Data: data})
	return b
}

func (s *Server) wsReject(ctx context.Context, conn *websocket.Conn, msg string) {
	conn.Write(ctx, websocket.MessageText, frame("error", map[string]string{"code": "unauthorized", "message": msg}))
	conn.Close(closeUnauth, "unauthorized")
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) error {
	var p *principal
	if tok := bearer(r); tok != "" {
		var err error
		if p, err = s.authenticate(r.Context(), tok); err != nil {
			return err
		}
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.originPatterns()})
	if err != nil {
		return nil // Accept already wrote the HTTP error (e.g. bad Origin)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)
	ctx := r.Context()

	if p == nil {
		actx, cancel := context.WithTimeout(ctx, wsAuthTimeout)
		_, data, err := conn.Read(actx)
		cancel()
		if err != nil {
			s.wsReject(ctx, conn, "需要在 5 秒内发送 auth 帧")
			return nil
		}
		var msg struct {
			Type  string `json:"type"`
			Token string `json:"token"`
		}
		if json.Unmarshal(data, &msg) != nil || msg.Type != "auth" {
			s.wsReject(ctx, conn, "第一帧必须是 auth")
			return nil
		}
		if p, err = s.authenticate(ctx, msg.Token); err != nil {
			s.wsReject(ctx, conn, "令牌无效")
			return nil
		}
	}

	memberIDs, err := s.wsMemberships(ctx, p)
	if err != nil {
		conn.Close(websocket.StatusInternalError, "internal")
		return nil
	}
	teams := make([]string, 0, len(memberIDs))
	for t := range memberIDs {
		teams = append(teams, t)
	}
	var lastSeq int64
	s.pool.QueryRow(ctx, `SELECT COALESCE(max(seq),0) FROM messages WHERE team_id = ANY($1::uuid[])`, teams).Scan(&lastSeq)

	c := realtime.NewClient(p.key(), teams, wsSendBuffer)
	s.hub.Register(c)
	defer s.hub.Unregister(c)
	if err := conn.Write(ctx, websocket.MessageText, frame("ready", map[string]any{
		"member_ids": memberIDs, "server_time": jsTime(time.Now()), "last_seq": lastSeq,
	})); err != nil {
		return nil
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		defer cancel()
		for {
			rctx, rcancel := context.WithTimeout(ctx, wsReadIdle)
			_, data, err := conn.Read(rctx)
			rcancel()
			if err != nil {
				return
			}
			var msg struct {
				Type string `json:"type"`
			}
			json.Unmarshal(data, &msg)
			var out []byte
			switch msg.Type {
			case "ping":
				out = frame("pong", map[string]any{})
			case "auth":
				continue
			default:
				out = frame("error", map[string]string{"code": "unknown_type", "message": "不支持的帧类型"})
			}
			select {
			case c.Send <- out:
			default:
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			conn.Close(websocket.StatusNormalClosure, "")
			return nil
		case <-c.Done:
			conn.Close(websocket.StatusPolicyViolation, "slow consumer")
			return nil
		case b := <-c.Send:
			wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(wctx, websocket.MessageText, b)
			wcancel()
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					slog.Debug("ws write", "err", err)
				}
				return nil
			}
		}
	}
}

// wsMemberships returns team_id -> member_id for the principal.
func (s *Server) wsMemberships(ctx context.Context, p *principal) (map[string]string, error) {
	out := map[string]string{}
	if p.Bot != nil {
		out[p.Bot.TeamID] = p.Bot.MemberID
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT m.team_id, m.id FROM team_members m JOIN teams t ON t.id=m.team_id
		WHERE m.user_id=$1 AND m.left_at IS NULL AND t.deleted_at IS NULL`, p.UserID)
	if err != nil {
		return nil, err
	}
	_, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (struct{}, error) {
		var t, m string
		err := r.Scan(&t, &m)
		out[t] = m
		return struct{}{}, err
	})
	return out, err
}
