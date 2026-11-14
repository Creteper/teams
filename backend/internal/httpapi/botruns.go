package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/creteper/teams/backend/internal/webhook"
	"github.com/jackc/pgx/v5"
)

// botRunTTL bounds how long a run is reported as active.
const botRunTTL = 10 * time.Minute

type runAnnounce struct {
	DeliveryID, BotMemberID, Type, Reason string
}

func runData(teamID, channelID, botMemberID, triggerID, deliveryID string, extra map[string]any) map[string]any {
	d := map[string]any{
		"team_id": teamID, "channel_id": channelID, "bot_member_id": botMemberID,
		"trigger_message_id": triggerID, "delivery_id": deliveryID, "at": jsTime(time.Now()),
	}
	for k, v := range extra {
		d[k] = v
	}
	return d
}

// publishRuns emits bot.run.started / bot.run.failed(no_webhook) after commit.
func (s *Server) publishRuns(teamID, channelID, triggerID string, runs []runAnnounce) {
	for _, r := range runs {
		extra := map[string]any{}
		if r.Type == "failed" {
			extra["reason"] = r.Reason
			extra["status_code"] = nil
		}
		s.hub.PublishTeam(teamID, "bot.run."+r.Type, runData(teamID, channelID, r.BotMemberID, triggerID, r.DeliveryID, extra))
	}
}

// notifyRun is the webhook worker callback for delivered/retrying/failed.
func (s *Server) notifyRun(ctx context.Context, d webhook.Delivery, ev webhook.RunEvent) {
	if d.MessageID == nil || d.ChannelID == nil {
		return
	}
	var teamID, botMemberID string
	if err := s.pool.QueryRow(ctx, `SELECT b.team_id, b.member_id FROM bots b WHERE b.id=$1`, d.BotID).Scan(&teamID, &botMemberID); err != nil {
		return
	}
	extra := map[string]any{"attempt": ev.Attempt}
	switch ev.Type {
	case "retrying":
		extra["next_retry_at"] = jsTime(*ev.NextRetryAt)
		extra["reason"] = ev.Reason
		extra["status_code"] = ev.StatusCode
	case "failed":
		extra["reason"] = ev.Reason
		extra["status_code"] = ev.StatusCode
	case "delivered":
		extra["status_code"] = ev.StatusCode
	}
	s.hub.PublishTeam(teamID, "bot.run."+ev.Type, runData(teamID, *d.ChannelID, botMemberID, *d.MessageID, d.ID, extra))
}

// completeRuns marks runs triggered by replyTo for this bot as completed
// (inside the message transaction). Returns delivery ids.
func completeRuns(ctx context.Context, tx pgx.Tx, botMemberID, replyTo, replyID string) ([]string, error) {
	rows, err := tx.Query(ctx, `UPDATE webhook_deliveries d SET run_status='completed', reply_message_id=$3, run_updated_at=now(), run_reason=NULL
		FROM bots b WHERE b.id=d.bot_id AND b.member_id=$1 AND d.message_id=$2 AND d.event='message.mention'
		AND COALESCE(d.run_status, '') NOT IN ('completed', 'declined') RETURNING d.id`, botMemberID, replyTo, replyID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

type botRunView struct {
	DeliveryID       string  `json:"delivery_id"`
	TeamID           string  `json:"team_id"`
	ChannelID        string  `json:"channel_id"`
	BotMemberID      string  `json:"bot_member_id"`
	TriggerMessageID string  `json:"trigger_message_id"`
	Status           string  `json:"status"`
	Attempt          int     `json:"attempt"`
	NextRetryAt      *jsTime `json:"next_retry_at"`
	Reason           *string `json:"reason"`
	StatusCode       *int    `json:"status_code"`
	ReplyMessageID   *string `json:"reply_message_id"`
	StartedAt        jsTime  `json:"started_at"`
	UpdatedAt        jsTime  `json:"updated_at"`
}

func (s *Server) listBotRuns(w http.ResponseWriter, r *http.Request) error {
	c, _, err := s.channelParam(r)
	if err != nil {
		return err
	}
	sql := `SELECT d.id, b.member_id, d.message_id, d.run_status, d.attempts, d.next_attempt_at, d.run_reason, d.last_status_code,
		d.reply_message_id, d.created_at, d.run_updated_at
		FROM webhook_deliveries d JOIN bots b ON b.id=d.bot_id
		WHERE d.channel_id=$1 AND d.run_status IS NOT NULL`
	if r.URL.Query().Get("active") == "true" {
		sql += ` AND d.run_status IN ('started','delivered','retrying') AND d.created_at > now() - make_interval(secs => $2)
			ORDER BY d.created_at LIMIT 100`
	} else {
		sql += ` AND $2::float8 > 0 ORDER BY d.created_at DESC LIMIT 50`
	}
	rows, err := s.pool.Query(r.Context(), sql, c.ID, botRunTTL.Seconds())
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (botRunView, error) {
		var v botRunView
		var next, created, updated time.Time
		err := row.Scan(&v.DeliveryID, &v.BotMemberID, &v.TriggerMessageID, &v.Status, &v.Attempt, &next, &v.Reason, &v.StatusCode,
			&v.ReplyMessageID, &created, &updated)
		v.TeamID, v.ChannelID = c.TeamID, c.ID
		if v.Status == "retrying" {
			v.NextRetryAt = tp(&next)
		}
		v.StartedAt, v.UpdatedAt = jsTime(created), jsTime(updated)
		return v, err
	})
	if err != nil {
		return err
	}
	if items == nil {
		items = []botRunView{}
	}
	return writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
