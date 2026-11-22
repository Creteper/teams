package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/creteper/teams/backend/internal/mention"
	"github.com/creteper/teams/backend/internal/webhook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var clientMsgIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

const (
	maxContentRunes = 8000
	maxMentions     = 20
	maxAttachments  = 10
)

func apierrIsUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// TriggerDepth computes the loop-guard depth of a new message.
// parentDepth is nil when the message has no reply_to.
func TriggerDepth(senderIsBot bool, parentDepth *int) int {
	if !senderIsBot {
		return 0
	}
	if parentDepth == nil {
		return 1
	}
	return *parentDepth + 1
}

// resolveMentions returns valid team member ids referenced in content (max 20).
func resolveMentions(ctx context.Context, q querier, teamID, content string) ([]string, error) {
	ids := mention.Parse(content)
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx, `SELECT m.id FROM team_members m LEFT JOIN bots b ON b.id=m.bot_id
		WHERE m.team_id=$1 AND m.id = ANY($2::uuid[]) AND m.left_at IS NULL AND (b.id IS NULL OR b.deleted_at IS NULL)`, teamID, ids)
	if err != nil {
		return nil, err
	}
	valid := map[string]bool{}
	got, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	for _, v := range got {
		valid[v] = true
	}
	var out []string
	for _, id := range ids {
		if valid[id] && len(out) < maxMentions {
			out = append(out, id)
		}
	}
	return out, nil
}

func insertMentions(ctx context.Context, q querier, msgID string, ids []string) error {
	for i, id := range ids {
		if _, err := q.Exec(ctx, `INSERT INTO message_mentions(message_id, member_id, position) VALUES($1,$2,$3)`, msgID, id, i); err != nil {
			return err
		}
	}
	return nil
}

func validateContent(content string, attachments int) error {
	if utf8.RuneCountInString(content) > maxContentRunes {
		return apierr.Validation("content", "content 最长 8000 字符")
	}
	if strings.TrimSpace(content) == "" && attachments == 0 {
		return apierr.Validation("content", "content 和 attachment_ids 不能同时为空")
	}
	return nil
}

func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) error {
	c, a, err := s.channelParam(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	p := principalFrom(ctx)
	var body struct {
		QACard        *qaCard  `json:"qa_card"`
		Content       string   `json:"content"`
		AttachmentIDs []string `json:"attachment_ids"`
		ReplyTo       *string  `json:"reply_to"`
		ClientMsgID   *string  `json:"client_msg_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if body.QACard != nil {
		if err := body.QACard.validateNew(); err != nil {
			return err
		}
		body.Content = "<@" + body.QACard.Recipient + "> QA 卡片 · " + body.QACard.Questions[0].Prompt
	}
	if err := validateContent(body.Content, len(body.AttachmentIDs)); err != nil {
		return err
	}
	if len(body.AttachmentIDs) > maxAttachments {
		return apierr.Validation("attachment_ids", "最多 10 个附件")
	}
	attIDs := map[string]bool{}
	for _, id := range body.AttachmentIDs {
		u, err := uuid.Parse(id)
		if err != nil {
			return apierr.Validation("attachment_ids", "附件 id 无效")
		}
		attIDs[u.String()] = true
	}
	var clientID *string
	if body.ClientMsgID != nil {
		if !clientMsgIDRe.MatchString(*body.ClientMsgID) {
			return apierr.Validation("client_msg_id", "client_msg_id 需 1–64 位，只能包含 A-Z a-z 0-9 _ -")
		}
		clientID = body.ClientMsgID
		if existing, ok := s.findClientMsg(ctx, s.pool, a.MemberID, c.ID, *clientID); ok {
			m, err := s.loadMessage(ctx, s.pool, existing)
			if err != nil {
				return err
			}
			return writeJSON(w, http.StatusOK, m)
		}
	}
	// rate limits
	if p.Bot != nil {
		if ok, wait := s.limiter.Allow("msg:bot:"+p.Bot.ID+":"+c.ID, s.cfg.BotMsgRatePerMinute, time.Minute); !ok {
			return apierr.RateLimited(wait)
		}
	} else if ok, wait := s.limiter.Allow("msg:user:"+a.MemberID, s.cfg.UserMsgRatePer10s, 10*time.Second); !ok {
		return apierr.RateLimited(wait)
	}

	msgID := newID()
	var runs []runAnnounce
	var completed []string
	var replyToID string
	var dupID string
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if clientID != nil {
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "cmid:"+a.MemberID+":"+c.ID+":"+*clientID); err != nil {
				return err
			}
			if existing, ok := s.findClientMsg(ctx, tx, a.MemberID, c.ID, *clientID); ok {
				dupID = existing
				return nil
			}
		}
		var parentDepth *int
		var replyTo *string
		if body.ReplyTo != nil && *body.ReplyTo != "" {
			u, err := uuid.Parse(*body.ReplyTo)
			if err != nil {
				return apierr.Validation("reply_to", "reply_to 无效")
			}
			var pch string
			var pd int
			err = tx.QueryRow(ctx, `SELECT channel_id, trigger_depth FROM messages WHERE id=$1`, u.String()).Scan(&pch, &pd)
			if err != nil || pch != c.ID {
				return apierr.Validation("reply_to", "reply_to 必须是同一频道的消息")
			}
			parentDepth = &pd
			rs := u.String()
			replyTo = &rs
		}
		depth := TriggerDepth(p.Bot != nil, parentDepth)
		mentions, err := resolveMentions(ctx, tx, c.TeamID, body.Content)
		if err != nil {
			return err
		}
		if card := body.QACard; card != nil {
			if len(mentions) == 0 || mentions[0] != card.Recipient {
				return apierr.Validation("recipient_member_id", "回答人必须是本团队的有效成员")
			}
			mentions = []string{card.Recipient}
		}
		// Serialize inserts per channel: the seq (identity) is drawn only after
		// this row lock is held, and the lock is released at commit, so within a
		// channel seq order == commit (visibility) order and after=<seq>
		// catch-up can never skip a message that commits later with a smaller seq.
		var locked int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, c.ID).Scan(&locked); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return apierr.NotFound("频道")
			}
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO messages(id, team_id, channel_id, sender_member_id, content, reply_to, trigger_depth, client_msg_id, qa_card)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, msgID, c.TeamID, c.ID, a.MemberID, body.Content, replyTo, depth, clientID, body.QACard)
		if err != nil {
			return err
		}
		if err := insertMentions(ctx, tx, msgID, mentions); err != nil {
			return err
		}
		if len(attIDs) > 0 {
			ids := make([]string, 0, len(attIDs))
			for id := range attIDs {
				ids = append(ids, id)
			}
			tag, err := tx.Exec(ctx, `UPDATE attachments SET message_id=$1 WHERE id = ANY($2::uuid[]) AND team_id=$3
				AND uploader_member_id=$4 AND message_id IS NULL AND issue_id IS NULL AND kind <> 'file'`, msgID, ids, c.TeamID, a.MemberID)
			if err != nil {
				return err
			}
			if int(tag.RowsAffected()) != len(ids) {
				return apierr.Validation("attachment_ids", "附件不存在、不是你上传的或已被其他消息引用")
			}
		}
		if p.Bot != nil && replyTo != nil {
			replyToID = *replyTo
			if completed, err = completeRuns(ctx, tx, a.MemberID, *replyTo, msgID); err != nil {
				return err
			}
		}
		runs, err = s.enqueueMentionWebhooks(ctx, tx, msgID, c.ID, a.MemberID, depth, mentions)
		return err
	})
	if err != nil {
		return err
	}
	if dupID != "" {
		m, err := s.loadMessage(ctx, s.pool, dupID)
		if err != nil {
			return err
		}
		return writeJSON(w, http.StatusOK, m)
	}
	m, err := s.loadMessage(ctx, s.pool, msgID)
	if err != nil {
		return err
	}
	s.hub.PublishTeam(c.TeamID, "message.created", m)
	if p.Bot == nil {
		// your own message marks the channel read up to it (synced to your other devices)
		if changed, err := advanceRead(ctx, s.pool, p.UserID, c.ID, m.Seq); err == nil && changed {
			s.publishChannelRead(ctx, p.UserID, c.ID)
		}
	}
	s.notifyTeamMembers(m, c.Name)
	for _, did := range completed {
		s.hub.PublishTeam(c.TeamID, "bot.run.completed", runData(c.TeamID, c.ID, a.MemberID, replyToID, did, map[string]any{"reply_message_id": msgID}))
	}
	s.publishRuns(c.TeamID, c.ID, msgID, runs)
	for _, r := range runs {
		if r.Type == "started" {
			s.worker.Wake()
			break
		}
	}
	return writeJSON(w, http.StatusCreated, m)
}

// findClientMsg looks up an idempotent resend (same sender+channel, 24h).
func (s *Server) findClientMsg(ctx context.Context, q querier, memberID, channelID, clientID string) (string, bool) {
	var id string
	err := q.QueryRow(ctx, `SELECT id FROM messages WHERE sender_member_id=$1 AND channel_id=$2 AND client_msg_id=$3
		AND created_at > now() - interval '24 hours' ORDER BY seq DESC LIMIT 1`, memberID, channelID, clientID).Scan(&id)
	return id, err == nil
}

type mentionedBot struct {
	ID, MemberID string
	HasHook      bool
}

// enqueueMentionWebhooks applies the loop guard and inserts deliveries.
// Returns the bot runs to announce after commit.
func (s *Server) enqueueMentionWebhooks(ctx context.Context, tx pgx.Tx, msgID, channelID, senderMemberID string, depth int, mentions []string) ([]runAnnounce, error) {
	if len(mentions) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `SELECT b.id, b.member_id, COALESCE(w.enabled, false) FROM bots b LEFT JOIN bot_webhooks w ON w.bot_id=b.id
		WHERE b.member_id = ANY($1::uuid[]) AND b.deleted_at IS NULL AND b.member_id <> $2`, mentions, senderMemberID)
	if err != nil {
		return nil, err
	}
	bots, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (mentionedBot, error) {
		var b mentionedBot
		err := r.Scan(&b.ID, &b.MemberID, &b.HasHook)
		return b, err
	})
	if err != nil {
		return nil, err
	}
	var runs []runAnnounce
	for _, mb := range bots {
		botID := mb.ID
		status := "pending"
		var lastErr *string
		if depth > s.cfg.MaxTriggerDepth {
			status = "skipped_depth"
		} else if !mb.HasHook {
			status = "failed"
		} else {
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "wh:"+botID+":"+channelID); err != nil {
				return nil, err
			}
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries WHERE bot_id=$1 AND channel_id=$2
				AND created_at > now() - interval '60 seconds' AND status NOT IN ('skipped_depth','skipped_rate_limited')
				AND COALESCE(last_error,'') <> 'no_webhook'`, botID, channelID).Scan(&n); err != nil {
				return nil, err
			}
			if s.cfg.WebhookRatePerMinute > 0 && n >= s.cfg.WebhookRatePerMinute {
				status = "skipped_rate_limited"
			}
		}
		var runStatus, runReason *string
		switch status {
		case "pending":
			v := "started"
			runStatus = &v
		case "failed":
			e, v, rr := "no_webhook", "failed", "no_webhook"
			lastErr, runStatus, runReason = &e, &v, &rr
		default:
			e := status
			lastErr = &e
		}
		id := newID()
		_, err := tx.Exec(ctx, `INSERT INTO webhook_deliveries(id, bot_id, message_id, channel_id, event, status, last_error, finished_at, run_status, run_reason)
			VALUES($1,$2,$3,$4,'message.mention',$5,$6, CASE WHEN $5='pending' THEN NULL ELSE now() END, $7, $8)`,
			id, botID, msgID, channelID, status, lastErr, runStatus, runReason)
		if err != nil {
			return nil, err
		}
		switch status {
		case "pending":
			runs = append(runs, runAnnounce{DeliveryID: id, BotMemberID: mb.MemberID, Type: "started"})
		case "failed":
			runs = append(runs, runAnnounce{DeliveryID: id, BotMemberID: mb.MemberID, Type: "failed", Reason: "no_webhook"})
		}
	}
	return runs, nil
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) error {
	c, _, err := s.channelParam(r)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	limit := 50
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return apierr.Validation("limit", "limit 无效")
		}
		limit = min(n, 100)
	}
	before, after := q.Get("before"), q.Get("after")
	if before != "" && after != "" {
		return apierr.BadRequest("before 和 after 不能同时使用")
	}
	parse := func(v, f string) (int64, error) {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return 0, apierr.Validation(f, f+" 必须是 seq 整数")
		}
		return n, nil
	}
	var sql string
	args := []any{c.ID, limit + 1}
	switch {
	case after != "":
		n, err := parse(after, "after")
		if err != nil {
			return err
		}
		sql = `SELECT id FROM messages WHERE channel_id=$1 AND seq > $3 ORDER BY seq ASC LIMIT $2`
		args = append(args, n)
	case before != "":
		n, err := parse(before, "before")
		if err != nil {
			return err
		}
		sql = `SELECT id FROM messages WHERE channel_id=$1 AND seq < $3 ORDER BY seq DESC LIMIT $2`
		args = append(args, n)
	default:
		sql = `SELECT id FROM messages WHERE channel_id=$1 ORDER BY seq DESC LIMIT $2`
	}
	ctx := r.Context()
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	hasMore := len(ids) > limit
	if hasMore {
		ids = ids[:limit]
	}
	if after == "" {
		slices.Reverse(ids) // always return ascending seq
	}
	items, err := s.loadMessages(ctx, s.pool, ids)
	if err != nil {
		return err
	}
	var next *string
	if len(items) > 0 {
		var v string
		if after != "" {
			v = strconv.FormatInt(items[len(items)-1].Seq, 10)
		} else {
			v = strconv.FormatInt(items[0].Seq, 10)
		}
		next = &v
	}
	return writeList(w, items, next, hasMore)
}

// messageParam loads a message and checks the caller can see it.
func (s *Server) messageParam(r *http.Request) (*messageView, *actor, string, error) {
	id, err := pathID(r, "message_id", "消息")
	if err != nil {
		return nil, nil, "", err
	}
	ctx := r.Context()
	var teamID, sender string
	err = s.pool.QueryRow(ctx, `SELECT m.team_id, m.sender_member_id FROM messages m JOIN channels c ON c.id=m.channel_id
		WHERE m.id=$1 AND c.deleted_at IS NULL`, id).Scan(&teamID, &sender)
	if err != nil {
		return nil, nil, "", apierr.NotFound("消息")
	}
	a, err := s.actorIn(ctx, s.pool, principalFrom(ctx), teamID)
	if err != nil {
		return nil, nil, "", apierr.NotFound("消息")
	}
	m, err := s.loadMessage(ctx, s.pool, id)
	if err != nil {
		return nil, nil, "", err
	}
	return m, a, sender, nil
}

func (s *Server) getMessage(w http.ResponseWriter, r *http.Request) error {
	m, _, _, err := s.messageParam(r)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, m)
}

func (s *Server) editMessage(w http.ResponseWriter, r *http.Request) error {
	m, a, sender, err := s.messageParam(r)
	if err != nil {
		return err
	}
	if sender != a.MemberID {
		return apierr.Forbidden("只能编辑自己的消息")
	}
	if m.Deleted {
		return apierr.NotFound("消息")
	}
	if m.Kind != "message" || m.QACard != nil {
		return apierr.Forbidden("这类消息不能编辑")
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if err := validateContent(body.Content, len(m.Attachments)); err != nil {
		return err
	}
	ctx := r.Context()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		mentions, err := resolveMentions(ctx, tx, m.TeamID, body.Content)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE messages SET content=$2, edited_at=now() WHERE id=$1`, m.ID, body.Content); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM message_mentions WHERE message_id=$1`, m.ID); err != nil {
			return err
		}
		return insertMentions(ctx, tx, m.ID, mentions)
	})
	if err != nil {
		return err
	}
	m, err = s.loadMessage(ctx, s.pool, m.ID)
	if err != nil {
		return err
	}
	s.hub.PublishTeam(m.TeamID, "message.updated", m)
	return writeJSON(w, http.StatusOK, m)
}

func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request) error {
	m, a, sender, err := s.messageParam(r)
	if err != nil {
		return err
	}
	if sender != a.MemberID && !a.admin() {
		return apierr.Forbidden("只能删除自己的消息")
	}
	if !m.Deleted {
		if _, err := s.pool.Exec(r.Context(), `UPDATE messages SET deleted_at=now() WHERE id=$1`, m.ID); err != nil {
			return err
		}
		s.hub.PublishTeam(m.TeamID, "message.deleted", map[string]any{"id": m.ID, "channel_id": m.ChannelID, "seq": m.Seq})
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---------- webhook payload ----------

type payloadBot struct {
	ID          string  `json:"id"`
	MemberID    string  `json:"member_id"`
	Name        string  `json:"name"`
	DisplayName string  `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
	AvatarShape *string `json:"avatar_shape"`
	AvatarColor *string `json:"avatar_color"`
}

func (s *Server) abs(u *string) *string {
	if u == nil {
		return nil
	}
	v := s.cfg.PublicBaseURL + *u
	return &v
}

func (s *Server) payloadBot(b *botView) payloadBot {
	return payloadBot{ID: b.ID, MemberID: b.MemberID, Name: b.Name, DisplayName: b.DisplayName,
		AvatarURL: s.abs(b.AvatarURL), AvatarShape: b.AvatarShape, AvatarColor: b.AvatarColor}
}

// Webhook payload types. Field order is part of the contract: identifiers
// and routing data come first and the long text (content_plain) last,
// so receivers that truncate long bodies still see who sent what.
type payloadTeam struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	IconURL *string `json:"icon_url"`
}

type payloadPing struct {
	Event      string      `json:"event"`
	DeliveryID string      `json:"delivery_id"`
	SentAt     jsTime      `json:"sent_at"`
	Team       payloadTeam `json:"team"`
	Bot        payloadBot  `json:"bot"`
}

type payloadLoopGuard struct {
	TriggerDepth     int `json:"trigger_depth"`
	MaxTriggerDepth  int `json:"max_trigger_depth"`
	ReplyDepthWillBe int `json:"reply_depth_will_be"`
}

type payloadSender struct {
	MemberID    string  `json:"member_id"`
	Type        string  `json:"type"`
	UserID      *string `json:"user_id"`
	BotID       *string `json:"bot_id"`
	Username    string  `json:"username"`
	DisplayName string  `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
	AvatarShape *string `json:"avatar_shape"`
	AvatarColor *string `json:"avatar_color"`
}

type payloadChannel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type payloadAttachment struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	MimeType  string `json:"mime_type"`
	SizeBytes int64  `json:"size_bytes"`
	FileName  string `json:"file_name"`
	Width     *int   `json:"width"`
	Height    *int   `json:"height"`
	URL       string `json:"url"`
}

type payloadMessage struct {
	ID           string              `json:"id"`
	Seq          int64               `json:"seq"`
	ReplyTo      *string             `json:"reply_to"`
	TriggerDepth int                 `json:"trigger_depth"`
	CreatedAt    jsTime              `json:"created_at"`
	Mentions     []mentionView       `json:"mentions"`
	Attachments  []payloadAttachment `json:"attachments"`
	ContentPlain string              `json:"content_plain"`
	QACard       *qaCard             `json:"qa_card,omitempty"`
}

type payloadReplyHint struct {
	Content string `json:"content"`
	ReplyTo string `json:"reply_to"`
}

type payloadDeclineHint struct {
	Reason string `json:"reason"`
}

// payloadDecline tells the bot how to state "I won't reply" (§7.7).
type payloadDecline struct {
	Method   string             `json:"method"`
	URL      string             `json:"url"`
	BodyHint payloadDeclineHint `json:"body_hint"`
}

// payloadHistory tells the bot how to page back through the channel with
// its own token (§8.6); the payload itself carries no context messages.
type payloadHistory struct {
	Method string `json:"method"`
	URL    string `json:"url"`
}

type payloadReply struct {
	Method   string           `json:"method"`
	URL      string           `json:"url"`
	Auth     string           `json:"auth"`
	BodyHint payloadReplyHint `json:"body_hint"`
	Decline  payloadDecline   `json:"decline"`
	History  payloadHistory   `json:"history"`
}

type payloadMention struct {
	Event      string           `json:"event"`
	DeliveryID string           `json:"delivery_id"`
	SentAt     jsTime           `json:"sent_at"`
	LoopGuard  payloadLoopGuard `json:"loop_guard"`
	Sender     payloadSender    `json:"sender"`
	Channel    payloadChannel   `json:"channel"`
	Message    payloadMessage   `json:"message"`
	Reply      payloadReply     `json:"reply"`
	Team       payloadTeam      `json:"team"`
	Bot        payloadBot       `json:"bot"`
}

// marshalPayload encodes without HTML escaping, so "<@id>" stays literal.
func marshalPayload(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func (s *Server) buildDeliveryPayload(ctx context.Context, d webhook.Delivery) (webhook.Payload, error) {
	var none webhook.Payload
	b, err := loadBot(ctx, s.pool, d.BotID)
	if err != nil {
		return none, webhook.ErrDrop
	}
	t, err := loadTeam(ctx, s.pool, b.TeamID)
	if err != nil {
		return none, webhook.ErrDrop
	}
	team := payloadTeam{ID: t.ID, Name: t.Name, IconURL: s.abs(t.IconURL)}
	now := jsTime(time.Now())
	if strings.HasPrefix(d.Event, "issue.") || d.Event == "qa.answered" {
		if strings.HasPrefix(d.Event, "issue.") && (b.Webhook == nil || !b.Webhook.IssuesEnabled) {
			return none, webhook.ErrDrop
		}
		var data json.RawMessage
		if err := s.pool.QueryRow(ctx, "SELECT event_data FROM webhook_deliveries WHERE id=$1", d.ID).Scan(&data); err != nil {
			return none, err
		}
		body, err := marshalPayload(map[string]any{"event": d.Event, "delivery_id": d.ID, "sent_at": now, "team": team, "bot": s.payloadBot(b), "data": data})
		return webhook.Payload{Body: body}, err
	}
	if d.Event == "ping" || d.MessageID == nil {
		body, err := marshalPayload(payloadPing{Event: "ping", DeliveryID: d.ID, SentAt: now, Team: team, Bot: s.payloadBot(b)})
		return webhook.Payload{Body: body}, err
	}
	m, err := s.loadMessage(ctx, s.pool, *d.MessageID)
	if err != nil || m.Deleted {
		return none, webhook.ErrDrop
	}
	ch, err := loadChannel(ctx, s.pool, m.ChannelID)
	if err != nil {
		return none, webhook.ErrDrop
	}
	sm, err := loadMember(ctx, s.pool, m.Sender.MemberID)
	if err != nil {
		return none, err
	}
	names := map[string]string{}
	for _, mm := range m.Mentions {
		names[mm.MemberID] = mm.DisplayName
	}
	atts := make([]payloadAttachment, 0, len(m.Attachments))
	for _, a := range m.Attachments {
		atts = append(atts, payloadAttachment{ID: a.ID, Kind: a.Kind, MimeType: a.MimeType, SizeBytes: a.SizeBytes,
			FileName: a.FileName, Width: a.Width, Height: a.Height, URL: s.cfg.PublicBaseURL + a.URL})
	}
	mentions := m.Mentions
	if mentions == nil {
		mentions = []mentionView{}
	}
	p := payloadMention{
		Event:      "message.mention",
		DeliveryID: d.ID,
		SentAt:     now,
		LoopGuard:  payloadLoopGuard{TriggerDepth: m.TriggerDepth, MaxTriggerDepth: s.cfg.MaxTriggerDepth, ReplyDepthWillBe: m.TriggerDepth + 1},
		Sender: payloadSender{MemberID: sm.ID, Type: sm.Type, UserID: sm.UserID, BotID: sm.BotID, Username: sm.Username,
			DisplayName: sm.DisplayName, AvatarURL: s.abs(sm.AvatarURL), AvatarShape: sm.AvatarShape, AvatarColor: sm.AvatarColor},
		Channel: payloadChannel{ID: ch.ID, Name: ch.Name},
		Message: payloadMessage{QACard: m.QACard, ID: m.ID, Seq: m.Seq, ReplyTo: m.ReplyTo, TriggerDepth: m.TriggerDepth, CreatedAt: m.CreatedAt,
			Mentions: mentions, Attachments: atts, ContentPlain: mention.Plain(m.Content, names)},
		Reply: payloadReply{Method: "POST", URL: s.cfg.PublicBaseURL + "/api/v1/channels/" + ch.ID + "/messages",
			Auth: "Authorization: Bearer <BOT_TOKEN>", BodyHint: payloadReplyHint{Content: "<@" + sm.ID + "> …", ReplyTo: m.ID},
			Decline: payloadDecline{Method: "POST", URL: s.cfg.PublicBaseURL + "/api/v1/messages/" + m.ID + "/decline",
				BodyHint: payloadDeclineHint{Reason: "（可选，≤200 字）"}},
			History: payloadHistory{Method: "GET", URL: s.cfg.PublicBaseURL + "/api/v1/channels/" + ch.ID +
				"/messages?before=" + strconv.FormatInt(m.Seq, 10) + "&limit=50"}},
		Team: team,
		Bot:  s.payloadBot(b),
	}
	body, err := marshalPayload(p)
	if err != nil {
		return none, err
	}
	return webhook.Payload{Body: body, Headers: map[string]string{
		"X-TeAms-Message-Id":       m.ID,
		"X-TeAms-Channel-Id":       ch.ID,
		"X-TeAms-Sender-Member-Id": sm.ID,
		"X-TeAms-Sender-Type":      sm.Type,
		"X-TeAms-Trigger-Depth":    strconv.Itoa(m.TriggerDepth),
	}}, nil
}
