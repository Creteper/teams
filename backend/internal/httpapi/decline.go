package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/jackc/pgx/v5"
)

// declineMessage handles POST /messages/{message_id}/decline (bot token).
//
// A bot that was @-mentioned in the message states that it will not reply.
// TeAms stores a note message of kind "bot_declined" (sender = the bot,
// reply_to = the trigger message) so everyone sees it in the channel
// history, and marks the run "declined" (terminal). The note never triggers
// webhooks, mention parsing, Web Push or unread counts and does not count
// towards trigger_depth.
func (s *Server) declineMessage(w http.ResponseWriter, r *http.Request) error {
	triggerID, err := pathID(r, "message_id", "消息")
	if err != nil {
		return err
	}
	ctx := r.Context()
	bp := principalFrom(ctx).Bot
	var body struct {
		Reason *string `json:"reason"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &body); err != nil && !isEmptyBody(err) {
			return err
		}
	}
	reason := ""
	if body.Reason != nil {
		if reason, err = cleanText("reason", *body.Reason, 0, 200); err != nil {
			return err
		}
	}
	var teamID, channelID string
	var deletedAt *time.Time
	var hasCard bool
	err = s.pool.QueryRow(ctx, `SELECT m.team_id, m.channel_id, m.deleted_at, m.qa_card IS NOT NULL FROM messages m
		JOIN channels c ON c.id = m.channel_id WHERE m.id=$1 AND c.deleted_at IS NULL`, triggerID).Scan(&teamID, &channelID, &deletedAt, &hasCard)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (teamID != bp.TeamID || deletedAt != nil)) {
		return apierr.NotFound("消息")
	}
	if err != nil {
		return err
	}
	if hasCard {
		return apierr.Forbidden("QA 卡片需要绑定 Agent 逐题作答")
	}
	var deliveryID, noteID string
	created := false
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var runStatus, replyID *string
		err := tx.QueryRow(ctx, `SELECT id, run_status, reply_message_id::text FROM webhook_deliveries
			WHERE bot_id=$1 AND message_id=$2 AND event='message.mention' FOR UPDATE`, bp.ID, triggerID).Scan(&deliveryID, &runStatus, &replyID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.New(http.StatusForbidden, "not_mentioned", "这条消息没有 @ 你，不能声明不回复")
		}
		if err != nil {
			return err
		}
		if runStatus != nil {
			switch *runStatus {
			case "completed":
				return apierr.New(http.StatusConflict, "already_replied", "已经回复过这条消息，不能再声明不回复")
			case "declined":
				if replyID != nil {
					noteID = *replyID
					return nil
				}
			}
		}
		// same per-channel ordering lock as sendMessage (seq == visibility order)
		var one int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, channelID).Scan(&one); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return apierr.NotFound("频道")
			}
			return err
		}
		noteID = newID()
		if _, err := tx.Exec(ctx, `INSERT INTO messages(id, team_id, channel_id, sender_member_id, content, reply_to, trigger_depth, kind)
			VALUES($1,$2,$3,$4,$5,$6,0,'bot_declined')`, noteID, teamID, channelID, bp.MemberID, reason, triggerID); err != nil {
			return err
		}
		created = true
		_, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET run_status='declined', reply_message_id=$2, run_reason=NULL, run_updated_at=now()
			WHERE id=$1`, deliveryID, noteID)
		return err
	})
	if err != nil {
		return err
	}
	m, err := s.loadMessage(ctx, s.pool, noteID)
	if err != nil {
		return err
	}
	if !created {
		return writeJSON(w, http.StatusOK, m)
	}
	s.hub.PublishTeam(teamID, "message.created", m)
	var rsn any
	if reason != "" {
		rsn = reason
	}
	s.hub.PublishTeam(teamID, "bot.run.declined", runData(teamID, channelID, bp.MemberID, triggerID, deliveryID,
		map[string]any{"decline_message_id": noteID, "reason": rsn}))
	return writeJSON(w, http.StatusCreated, m)
}
