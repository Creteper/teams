package httpapi

import (
	"context"
	"encoding/base64"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func itoa(n int) string { return strconv.Itoa(n) }

// jsTime marshals as RFC 3339 UTC with millisecond precision.
type jsTime time.Time

func (t jsTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + time.Time(t).UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}

func tp(t *time.Time) *jsTime {
	if t == nil {
		return nil
	}
	j := jsTime(*t)
	return &j
}

func avatarURL(id *string) *string {
	if id == nil {
		return nil
	}
	u := "/api/v1/avatars/" + *id
	return &u
}

// ---------- members ----------

type memberView struct {
	ID          string  `json:"id"`
	TeamID      string  `json:"team_id"`
	Type        string  `json:"type"`
	UserID      *string `json:"user_id"`
	BotID       *string `json:"bot_id"`
	DisplayName string  `json:"display_name"`
	Username    string  `json:"username"`
	AvatarURL   *string `json:"avatar_url"`
	AvatarShape *string `json:"avatar_shape"`
	AvatarColor *string `json:"avatar_color"`
	Description *string `json:"description"` // bot description; null for users
	Role        string  `json:"role"`
	JoinedAt    jsTime  `json:"joined_at"`
	Deleted     bool    `json:"deleted,omitempty"`
}

const memberSelect = `SELECT m.id, m.team_id, m.type, m.user_id, m.bot_id, m.role, m.joined_at,
	COALESCE(u.display_name, b.display_name, ''), COALESCE(u.username, b.name, ''),
	COALESCE(u.avatar_id, b.avatar_id), b.avatar_shape, b.avatar_color, b.description,
	(m.left_at IS NOT NULL OR b.deleted_at IS NOT NULL)
	FROM team_members m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN bots b ON b.id = m.bot_id `

func scanMembers(rows pgx.Rows) ([]memberView, error) {
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (memberView, error) {
		var m memberView
		var joined time.Time
		var av *string
		err := r.Scan(&m.ID, &m.TeamID, &m.Type, &m.UserID, &m.BotID, &m.Role, &joined,
			&m.DisplayName, &m.Username, &av, &m.AvatarShape, &m.AvatarColor, &m.Description, &m.Deleted)
		m.JoinedAt = jsTime(joined)
		m.AvatarURL = avatarURL(av)
		return m, err
	})
}

func loadMembersByID(ctx context.Context, q querier, ids []string) (map[string]memberView, error) {
	out := map[string]memberView{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, memberSelect+`WHERE m.id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	ms, err := scanMembers(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range ms {
		out[m.ID] = m
	}
	return out, nil
}

func loadMember(ctx context.Context, q querier, id string) (*memberView, error) {
	m, err := loadMembersByID(ctx, q, []string{id})
	if err != nil {
		return nil, err
	}
	v, ok := m[id]
	if !ok {
		return nil, pgx.ErrNoRows
	}
	return &v, nil
}

// ---------- users ----------

type userView struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	DisplayName string  `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
	CreatedAt   jsTime  `json:"created_at"`
}

func loadUser(ctx context.Context, q querier, id string) (*userView, error) {
	var u userView
	var av *string
	var created time.Time
	err := q.QueryRow(ctx, `SELECT id, username, display_name, avatar_id, created_at FROM users WHERE id=$1`, id).
		Scan(&u.ID, &u.Username, &u.DisplayName, &av, &created)
	if err != nil {
		return nil, err
	}
	u.AvatarURL = avatarURL(av)
	u.CreatedAt = jsTime(created)
	return &u, nil
}

// ---------- teams ----------

type teamView struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	IconURL     *string `json:"icon_url"`
	OwnerUserID string  `json:"owner_user_id"`
	MyMemberID  string  `json:"my_member_id,omitempty"`
	MyRole      string  `json:"my_role,omitempty"`
	CreatedAt   jsTime  `json:"created_at"`
}

const teamSelect = `SELECT t.id, t.name, t.description, t.icon_avatar_id, t.owner_user_id, t.created_at FROM teams t `

func scanTeam(row pgx.Row) (*teamView, error) {
	var t teamView
	var icon *string
	var created time.Time
	if err := row.Scan(&t.ID, &t.Name, &t.Description, &icon, &t.OwnerUserID, &created); err != nil {
		return nil, err
	}
	t.IconURL = avatarURL(icon)
	t.CreatedAt = jsTime(created)
	return &t, nil
}

func loadTeam(ctx context.Context, q querier, id string) (*teamView, error) {
	return scanTeam(q.QueryRow(ctx, teamSelect+`WHERE t.id=$1 AND t.deleted_at IS NULL`, id))
}

// ---------- channels ----------

type channelView struct {
	ID                string  `json:"id"`
	TeamID            string  `json:"team_id"`
	Name              string  `json:"name"`
	Topic             string  `json:"topic"`
	IsDefault         bool    `json:"is_default"`
	CreatedByMemberID *string `json:"created_by_member_id"`
	LastMessageSeq    int64   `json:"last_message_seq"`
	CreatedAt         jsTime  `json:"created_at"`
	// Per-user state; only present in responses to a user session
	// (GET channel list / single channel), never in team-wide WS events.
	*channelUserState
}

// channelUserState is the caller's own read/pin state of a channel.
type channelUserState struct {
	Pinned           bool    `json:"pinned"`
	PinnedAt         *jsTime `json:"pinned_at"`
	LastReadSeq      int64   `json:"last_read_seq"`
	UnreadCount      int     `json:"unread_count"`
	HasUnreadMention bool    `json:"has_unread_mention"`
}

const channelSelect = `SELECT c.id, c.team_id, c.name, c.topic, c.is_default, c.created_by_member_id,
	COALESCE((SELECT max(seq) FROM messages WHERE channel_id = c.id), 0), c.created_at FROM channels c `

func scanChannels(rows pgx.Rows) ([]channelView, error) {
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (channelView, error) {
		var c channelView
		var created time.Time
		err := r.Scan(&c.ID, &c.TeamID, &c.Name, &c.Topic, &c.IsDefault, &c.CreatedByMemberID, &c.LastMessageSeq, &created)
		c.CreatedAt = jsTime(created)
		return c, err
	})
}

func loadChannel(ctx context.Context, q querier, id string) (*channelView, error) {
	rows, err := q.Query(ctx, channelSelect+`JOIN teams t ON t.id=c.team_id WHERE c.id=$1 AND c.deleted_at IS NULL AND t.deleted_at IS NULL`, id)
	if err != nil {
		return nil, err
	}
	cs, err := scanChannels(rows)
	if err != nil {
		return nil, err
	}
	if len(cs) == 0 {
		return nil, pgx.ErrNoRows
	}
	return &cs[0], nil
}

// ---------- bots ----------

type webhookView struct {
	IssuesEnabled    bool    `json:"issues_enabled"`
	URL              string  `json:"url"`
	Enabled          bool    `json:"enabled"`
	SecretHeaderName *string `json:"secret_header_name"`
	SecretHeaderSet  bool    `json:"secret_header_set"`
	SigningSecret    string  `json:"signing_secret,omitempty"`
	UpdatedAt        jsTime  `json:"updated_at"`
}

type botView struct {
	ID              string       `json:"id"`
	MemberID        string       `json:"member_id"`
	TeamID          string       `json:"team_id"`
	Name            string       `json:"name"`
	DisplayName     string       `json:"display_name"`
	Description     string       `json:"description"`
	AvatarURL       *string      `json:"avatar_url"`
	AvatarSourceURL *string      `json:"avatar_source_url"`
	AvatarShape     *string      `json:"avatar_shape"`
	AvatarColor     *string      `json:"avatar_color"`
	Webhook         *webhookView `json:"webhook"`
	CreatedAt       jsTime       `json:"created_at"`
}

const botSelect = `SELECT b.id, b.member_id, b.team_id, b.name, b.display_name, b.description, b.avatar_id,
	b.avatar_source_url, b.avatar_shape, b.avatar_color, b.created_at,
	w.url, w.enabled, coalesce(w.issues_enabled,false), w.secret_header_name, (w.secret_header_value_enc IS NOT NULL), w.updated_at
	FROM bots b LEFT JOIN bot_webhooks w ON w.bot_id = b.id `

func scanBots(rows pgx.Rows) ([]botView, error) {
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (botView, error) {
		var b botView
		var av *string
		var created time.Time
		var wURL, wHeader *string
		var issuesEnabled bool
		var wEnabled, wSet *bool
		var wUpdated *time.Time
		err := r.Scan(&b.ID, &b.MemberID, &b.TeamID, &b.Name, &b.DisplayName, &b.Description, &av,
			&b.AvatarSourceURL, &b.AvatarShape, &b.AvatarColor, &created, &wURL, &wEnabled, &issuesEnabled, &wHeader, &wSet, &wUpdated)
		b.AvatarURL = avatarURL(av)
		b.CreatedAt = jsTime(created)
		if wURL != nil {
			b.Webhook = &webhookView{IssuesEnabled: issuesEnabled, URL: *wURL, Enabled: *wEnabled, SecretHeaderName: wHeader, SecretHeaderSet: *wSet, UpdatedAt: jsTime(*wUpdated)}
		}
		return b, err
	})
}

func loadBot(ctx context.Context, q querier, id string) (*botView, error) {
	rows, err := q.Query(ctx, botSelect+`WHERE b.id=$1 AND b.deleted_at IS NULL`, id)
	if err != nil {
		return nil, err
	}
	bs, err := scanBots(rows)
	if err != nil {
		return nil, err
	}
	if len(bs) == 0 {
		return nil, pgx.ErrNoRows
	}
	return &bs[0], nil
}

// ---------- messages ----------

type senderView struct {
	MemberID    string  `json:"member_id"`
	Type        string  `json:"type"`
	DisplayName string  `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
	AvatarShape *string `json:"avatar_shape"`
	AvatarColor *string `json:"avatar_color"`
}

type mentionView struct {
	MemberID    string `json:"member_id"`
	Type        string `json:"type"`
	DisplayName string `json:"display_name"`
}

type attachmentView struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	MimeType   string `json:"mime_type"`
	SizeBytes  int64  `json:"size_bytes"`
	FileName   string `json:"file_name"`
	Width      *int   `json:"width"`
	Height     *int   `json:"height"`
	DurationMs *int   `json:"duration_ms"`
	URL        string `json:"url"`
	ExpiresAt  jsTime `json:"expires_at"`
}

type messageView struct {
	QACard       *qaCard          `json:"qa_card,omitempty"`
	ID           string           `json:"id"`
	Seq          int64            `json:"seq"`
	Kind         string           `json:"kind"`
	TeamID       string           `json:"team_id"`
	ChannelID    string           `json:"channel_id"`
	Sender       senderView       `json:"sender"`
	Content      string           `json:"content"`
	Mentions     []mentionView    `json:"mentions"`
	Attachments  []attachmentView `json:"attachments"`
	ReplyTo      *string          `json:"reply_to"`
	TriggerDepth int              `json:"trigger_depth"`
	CreatedAt    jsTime           `json:"created_at"`
	EditedAt     *jsTime          `json:"edited_at"`
	Deleted      bool             `json:"deleted"`
}

// signedAttachmentURL returns a relative URL valid for one hour.
func (s *Server) signedAttachmentURL(id string) (string, time.Time) {
	t := time.Now().Add(time.Hour).Truncate(time.Second)
	exp := strconv.FormatInt(t.Unix(), 10)
	sig := base64.RawURLEncoding.EncodeToString(s.box.Sign("att|" + id + "|" + exp))
	return "/api/v1/attachments/" + id + "/content?exp=" + exp + "&sig=" + sig, t
}

func (s *Server) verifyAttachmentSig(id, exp, sig string) bool {
	n, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || time.Now().Unix() > n {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(sig)
	return err == nil && s.box.Verify("att|"+id+"|"+exp, b)
}

func scanAttachment(r pgx.CollectableRow, s *Server) (attachmentView, *string, error) {
	var a attachmentView
	var msg *string
	err := r.Scan(&a.ID, &msg, &a.Kind, &a.MimeType, &a.SizeBytes, &a.FileName, &a.Width, &a.Height, &a.DurationMs)
	var exp time.Time
	a.URL, exp = s.signedAttachmentURL(a.ID)
	a.ExpiresAt = jsTime(exp)
	return a, msg, err
}

const attachmentSelect = `SELECT id, message_id, kind, mime_type, size_bytes, file_name, width, height, duration_ms FROM attachments `

// loadMessages loads full message views, preserving the order of ids.
func (s *Server) loadMessages(ctx context.Context, q querier, ids []string) ([]messageView, error) {
	if len(ids) == 0 {
		return []messageView{}, nil
	}
	rows, err := q.Query(ctx, `SELECT id, seq, kind, team_id, channel_id, sender_member_id, content, reply_to, trigger_depth,
		created_at, edited_at, deleted_at, qa_card FROM messages WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	type raw struct {
		v      messageView
		sender string
	}
	byID := map[string]*raw{}
	memberIDs := map[string]bool{}
	_, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (struct{}, error) {
		var x raw
		var created time.Time
		var edited, deleted *time.Time
		err := r.Scan(&x.v.ID, &x.v.Seq, &x.v.Kind, &x.v.TeamID, &x.v.ChannelID, &x.sender, &x.v.Content, &x.v.ReplyTo,
			&x.v.TriggerDepth, &created, &edited, &deleted, &x.v.QACard)
		x.v.CreatedAt = jsTime(created)
		x.v.EditedAt = tp(edited)
		x.v.Deleted = deleted != nil
		x.v.Mentions = []mentionView{}
		x.v.Attachments = []attachmentView{}
		if x.v.Deleted {
			x.v.Content = ""
			x.v.QACard = nil
		}
		byID[x.v.ID] = &x
		memberIDs[x.sender] = true
		return struct{}{}, err
	})
	if err != nil {
		return nil, err
	}
	// mentions
	type men struct{ msg, member string }
	var mens []men
	mrows, err := q.Query(ctx, `SELECT message_id, member_id FROM message_mentions WHERE message_id = ANY($1::uuid[]) ORDER BY message_id, position`, ids)
	if err != nil {
		return nil, err
	}
	_, err = pgx.CollectRows(mrows, func(r pgx.CollectableRow) (struct{}, error) {
		var m men
		err := r.Scan(&m.msg, &m.member)
		mens = append(mens, m)
		memberIDs[m.member] = true
		return struct{}{}, err
	})
	if err != nil {
		return nil, err
	}
	var mids []string
	for id := range memberIDs {
		mids = append(mids, id)
	}
	members, err := loadMembersByID(ctx, q, mids)
	if err != nil {
		return nil, err
	}
	for _, x := range byID {
		m := members[x.sender]
		x.v.Sender = senderView{MemberID: x.sender, Type: m.Type, DisplayName: m.DisplayName, AvatarURL: m.AvatarURL, AvatarShape: m.AvatarShape, AvatarColor: m.AvatarColor}
	}
	for _, mm := range mens {
		if x := byID[mm.msg]; x != nil && !x.v.Deleted {
			m := members[mm.member]
			x.v.Mentions = append(x.v.Mentions, mentionView{MemberID: mm.member, Type: m.Type, DisplayName: m.DisplayName})
		}
	}
	arows, err := q.Query(ctx, attachmentSelect+`WHERE message_id = ANY($1::uuid[]) ORDER BY created_at, id`, ids)
	if err != nil {
		return nil, err
	}
	_, err = pgx.CollectRows(arows, func(r pgx.CollectableRow) (struct{}, error) {
		a, msg, err := scanAttachment(r, s)
		if err == nil && msg != nil {
			if x := byID[*msg]; x != nil && !x.v.Deleted {
				x.v.Attachments = append(x.v.Attachments, a)
			}
		}
		return struct{}{}, err
	})
	if err != nil {
		return nil, err
	}
	out := make([]messageView, 0, len(ids))
	for _, id := range ids {
		if x := byID[id]; x != nil {
			out = append(out, x.v)
		}
	}
	return out, nil
}

func (s *Server) loadMessage(ctx context.Context, q querier, id string) (*messageView, error) {
	ms, err := s.loadMessages(ctx, q, []string{id})
	if err != nil {
		return nil, err
	}
	if len(ms) == 0 {
		return nil, pgx.ErrNoRows
	}
	return &ms[0], nil
}
