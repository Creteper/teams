package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/jackc/pgx/v5"
)

// unreadCap bounds unread_count so counting stays cheap on busy channels;
// clients show "999+" style badges for anything >= unreadCap.
const unreadCap = 1000

// channelStateSQL computes, in one statement, the caller's read/pin state for
// every live channel of the teams the user belongs to. $1 = user id,
// $2 = optional team id filter, $3 = optional channel id filter.
//
// Effective read position = max(user_channel_state.last_read_seq,
// team_members.join_seq): messages that existed when the user joined the team
// count as read. Unread = messages with seq above it that are not deleted,
// are ordinary messages (kind='message') and were not sent by the user.
var channelStateSQL = `
SELECT c.id, c.team_id, st.pinned_at, r.eff,
	(SELECT count(*) FROM (SELECT 1 FROM messages m
		WHERE m.channel_id = c.id AND m.seq > r.eff AND m.deleted_at IS NULL
		AND m.kind = 'message' AND m.sender_member_id <> me.id LIMIT ` + itoa(unreadCap) + `) x),
	EXISTS (SELECT 1 FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
		WHERE mm.member_id = me.id AND m.channel_id = c.id AND m.seq > r.eff AND m.deleted_at IS NULL
		AND m.kind = 'message' AND m.sender_member_id <> me.id)
FROM channels c
JOIN teams t ON t.id = c.team_id AND t.deleted_at IS NULL
JOIN team_members me ON me.team_id = c.team_id AND me.user_id = $1 AND me.left_at IS NULL
LEFT JOIN user_channel_state st ON st.user_id = $1 AND st.channel_id = c.id
CROSS JOIN LATERAL (SELECT GREATEST(COALESCE(st.last_read_seq, 0), me.join_seq) AS eff) r
WHERE c.deleted_at IS NULL
	AND ($2::uuid IS NULL OR c.team_id = $2::uuid)
	AND ($3::uuid IS NULL OR c.id = $3::uuid)`

type channelStateRow struct {
	ChannelID string
	TeamID    string
	State     channelUserState
}

func (s *Server) loadChannelStates(ctx context.Context, q querier, userID string, teamID, channelID *string) ([]channelStateRow, error) {
	rows, err := q.Query(ctx, channelStateSQL, userID, teamID, channelID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (channelStateRow, error) {
		var x channelStateRow
		var pinned *time.Time
		err := r.Scan(&x.ChannelID, &x.TeamID, &pinned, &x.State.LastReadSeq, &x.State.UnreadCount, &x.State.HasUnreadMention)
		x.State.Pinned = pinned != nil
		x.State.PinnedAt = tp(pinned)
		return x, err
	})
}

// attachChannelStates fills the per-user fields of cs (user sessions only).
func (s *Server) attachChannelStates(ctx context.Context, p *principal, teamID string, cs []channelView) error {
	if p == nil || p.Bot != nil || len(cs) == 0 {
		return nil
	}
	var chID *string
	if len(cs) == 1 {
		chID = &cs[0].ID
	}
	states, err := s.loadChannelStates(ctx, s.pool, p.UserID, &teamID, chID)
	if err != nil {
		return err
	}
	byID := make(map[string]channelUserState, len(states))
	for _, x := range states {
		byID[x.ChannelID] = x.State
	}
	for i := range cs {
		st := byID[cs[i].ID]
		cs[i].channelUserState = &st
	}
	return nil
}

// channelStateEvent is the data of channel.read / channel.pinned and the
// response of the read/pin endpoints.
type channelStateEvent struct {
	ChannelID string `json:"channel_id"`
	TeamID    string `json:"team_id"`
	channelUserState
}

func (s *Server) channelStateFor(ctx context.Context, userID, channelID string) (*channelStateEvent, error) {
	states, err := s.loadChannelStates(ctx, s.pool, userID, nil, &channelID)
	if err != nil {
		return nil, err
	}
	if len(states) == 0 {
		return nil, apierr.NotFound("频道")
	}
	return &channelStateEvent{ChannelID: states[0].ChannelID, TeamID: states[0].TeamID, channelUserState: states[0].State}, nil
}

// advanceRead moves the user's read position forward to seq (never back).
// Returns whether the stored position changed.
func advanceRead(ctx context.Context, q querier, userID, channelID string, seq int64) (bool, error) {
	tag, err := q.Exec(ctx, `INSERT INTO user_channel_state(user_id, channel_id, last_read_seq) VALUES($1,$2,$3)
		ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_seq = EXCLUDED.last_read_seq, updated_at = now()
		WHERE user_channel_state.last_read_seq < EXCLUDED.last_read_seq`, userID, channelID, seq)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// publishChannelRead sends channel.read to every connection of the user.
func (s *Server) publishChannelRead(ctx context.Context, userID, channelID string) {
	ev, err := s.channelStateFor(ctx, userID, channelID)
	if err != nil {
		return
	}
	s.hub.PublishPrincipal("user:"+userID, ev.TeamID, "channel.read", ev)
}

// markRead handles POST /channels/{channel_id}/read  {"seq": N} (optional).
func (s *Server) markRead(w http.ResponseWriter, r *http.Request) error {
	c, _, err := s.channelParam(r)
	if err != nil {
		return err
	}
	var body struct {
		Seq *int64 `json:"seq"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &body); err != nil && !isEmptyBody(err) {
			return err
		}
	}
	if body.Seq != nil && *body.Seq < 0 {
		return apierr.Validation("seq", "seq 不能为负数")
	}
	ctx := r.Context()
	uid := principalFrom(ctx).UserID
	// clamp to the newest message of this channel (seq is global, so a
	// larger value must not pre-mark future messages as read)
	var maxSeq int64
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(max(seq), 0) FROM messages WHERE channel_id=$1`, c.ID).Scan(&maxSeq); err != nil {
		return err
	}
	target := maxSeq
	if body.Seq != nil && *body.Seq < maxSeq {
		target = *body.Seq
	}
	changed, err := advanceRead(ctx, s.pool, uid, c.ID, target)
	if err != nil {
		return err
	}
	ev, err := s.channelStateFor(ctx, uid, c.ID)
	if err != nil {
		return err
	}
	if changed {
		s.hub.PublishPrincipal("user:"+uid, ev.TeamID, "channel.read", ev)
	}
	return writeJSON(w, http.StatusOK, ev)
}

func isEmptyBody(err error) bool {
	e := apierr.As(err)
	return e != nil && e.Message == "请求体为空"
}

// setPin handles PUT / DELETE /channels/{channel_id}/pin (idempotent).
func (s *Server) setPin(pin bool) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		c, _, err := s.channelParam(r)
		if err != nil {
			return err
		}
		ctx := r.Context()
		uid := principalFrom(ctx).UserID
		var tag interface{ RowsAffected() int64 }
		if pin {
			tag, err = s.pool.Exec(ctx, `INSERT INTO user_channel_state(user_id, channel_id, pinned_at) VALUES($1,$2,now())
				ON CONFLICT (user_id, channel_id) DO UPDATE SET pinned_at = now(), updated_at = now()
				WHERE user_channel_state.pinned_at IS NULL`, uid, c.ID)
		} else {
			tag, err = s.pool.Exec(ctx, `UPDATE user_channel_state SET pinned_at = NULL, updated_at = now()
				WHERE user_id=$1 AND channel_id=$2 AND pinned_at IS NOT NULL`, uid, c.ID)
		}
		if err != nil {
			return err
		}
		ev, err := s.channelStateFor(ctx, uid, c.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			s.hub.PublishPrincipal("user:"+uid, ev.TeamID, "channel.pinned", ev)
		}
		return writeJSON(w, http.StatusOK, ev)
	}
}

// getMyUnread handles GET /me/unread: channels with unread messages across
// all of the user's teams (channels with nothing unread are omitted).
func (s *Server) getMyUnread(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	states, err := s.loadChannelStates(ctx, s.pool, principalFrom(ctx).UserID, nil, nil)
	if err != nil {
		return err
	}
	items := []channelStateEvent{}
	for _, x := range states {
		if x.State.UnreadCount > 0 || x.State.HasUnreadMention {
			items = append(items, channelStateEvent{ChannelID: x.ChannelID, TeamID: x.TeamID, channelUserState: x.State})
		}
	}
	return writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
