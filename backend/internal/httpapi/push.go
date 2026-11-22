package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/creteper/teams/backend/internal/mention"
	"github.com/creteper/teams/backend/internal/netguard"
	"github.com/jackc/pgx/v5"
)

const (
	pushTTL          = 24 * 60 * 60 // seconds the push service keeps an undelivered notification
	pushTimeout      = 10 * time.Second
	pushConcurrency  = 8
	pushExcerptRunes = 100
	maxPushSubsUser  = 20
)

// pusher sends Web Push (RFC 8030/8291/8292) notifications for channel messages.
type pusher struct {
	enabled    bool
	publicKey  string
	privateKey string
	subscriber string // VAPID "sub" without the mailto: prefix (the library adds it)
	client     webpush.HTTPClient
	sem        chan struct{}
	wg         sync.WaitGroup // in-flight batches (tests wait on it)
}

func newPusher(pub, priv, subject string, allowInsecureLocal bool) *pusher {
	p := &pusher{
		publicKey: pub, privateKey: priv,
		subscriber: strings.TrimPrefix(subject, "mailto:"),
		enabled:    pub != "" && priv != "" && subject != "",
		sem:        make(chan struct{}, pushConcurrency),
		// Push service endpoints are public https URLs supplied by the
		// browser; use the same SSRF-guarded client policy as webhooks.
		client: netguard.NewClient(netguard.Options{Timeout: pushTimeout, AllowPrivate: allowInsecureLocal, RequireHTTPS: true, MaxRedirects: 0}),
	}
	return p
}

func pushDisabled() *apierr.Error {
	return apierr.New(http.StatusServiceUnavailable, "push_disabled", "服务器未配置浏览器推送（VAPID）")
}

func (s *Server) getVAPIDPublicKey(w http.ResponseWriter, r *http.Request) error {
	var key *string
	if s.push.enabled {
		k := s.push.publicKey
		key = &k
	}
	return writeJSON(w, http.StatusOK, map[string]any{"enabled": s.push.enabled, "public_key": key})
}

// decodeKey accepts base64url (with or without padding) and standard base64.
func decodeKey(v string) ([]byte, error) {
	v = strings.TrimSpace(v)
	if b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(v, "=")); err == nil {
		return b, nil
	}
	return base64.StdEncoding.DecodeString(v)
}

type pushSubView struct {
	ID        string `json:"id"`
	Endpoint  string `json:"endpoint"`
	CreatedAt jsTime `json:"created_at"`
	UpdatedAt jsTime `json:"updated_at"`
}

// putPushSubscription handles POST /push/subscriptions with the browser's
// PushSubscription JSON. Upserts by endpoint and binds it to the caller's
// user and session.
func (s *Server) putPushSubscription(w http.ResponseWriter, r *http.Request) error {
	if !s.push.enabled {
		return pushDisabled()
	}
	var body struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	endpoint := strings.TrimSpace(body.Endpoint)
	u, err := netguard.ValidateURL(endpoint, true, s.cfg.AllowInsecureLocal)
	if err != nil {
		return apierr.Validation("endpoint", "endpoint 必须是公网 https 地址")
	}
	if u.Scheme != "https" && !s.cfg.AllowInsecureLocal {
		return apierr.Validation("endpoint", "endpoint 必须是 https 地址")
	}
	if b, err := decodeKey(body.Keys.P256dh); err != nil || len(b) != 65 || b[0] != 4 {
		return apierr.Validation("keys.p256dh", "keys.p256dh 无效（需为 65 字节 P-256 公钥的 base64url）")
	}
	if b, err := decodeKey(body.Keys.Auth); err != nil || len(b) != 16 {
		return apierr.Validation("keys.auth", "keys.auth 无效（需为 16 字节的 base64url）")
	}
	ctx := r.Context()
	p := principalFrom(ctx)
	ua := r.UserAgent()
	if len(ua) > 256 {
		ua = ua[:256]
	}
	var v pushSubView
	var created, updated time.Time
	var inserted bool
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `INSERT INTO push_subscriptions(id, user_id, session_id, endpoint, p256dh, auth, user_agent)
			VALUES($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, session_id=EXCLUDED.session_id,
				p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent, updated_at=now(), last_error=NULL
			RETURNING id, endpoint, created_at, updated_at, (xmax = 0)`,
			newID(), p.UserID, p.SessionID, endpoint, strings.TrimSpace(body.Keys.P256dh), strings.TrimSpace(body.Keys.Auth), ua).
			Scan(&v.ID, &v.Endpoint, &created, &updated, &inserted)
		if err != nil {
			return err
		}
		// keep only the newest subscriptions per user
		_, err = tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id=$1 AND id NOT IN
			(SELECT id FROM push_subscriptions WHERE user_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2)`, p.UserID, maxPushSubsUser)
		return err
	})
	if err != nil {
		return err
	}
	v.CreatedAt, v.UpdatedAt = jsTime(created), jsTime(updated)
	status := http.StatusOK
	if inserted {
		status = http.StatusCreated
	}
	return writeJSON(w, status, v)
}

// deletePushSubscription handles DELETE /push/subscriptions; the endpoint is
// given as ?endpoint= or JSON {"endpoint": "…"}. Only the caller's own
// subscription is removed; always 204.
func (s *Server) deletePushSubscription(w http.ResponseWriter, r *http.Request) error {
	endpoint := r.URL.Query().Get("endpoint")
	if endpoint == "" && r.ContentLength != 0 {
		var body struct {
			Endpoint string `json:"endpoint"`
		}
		if err := decodeJSON(r, &body); err != nil && !isEmptyBody(err) {
			return err
		}
		endpoint = body.Endpoint
	}
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return apierr.Validation("endpoint", "需要 endpoint")
	}
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2`,
		endpoint, principalFrom(r.Context()).UserID); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---------- sending ----------

type pushRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type pushSender struct {
	MemberID    string  `json:"member_id"`
	DisplayName string  `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
}

type pushMessage struct {
	ID      string `json:"id"`
	Seq     int64  `json:"seq"`
	Excerpt string `json:"excerpt"`
}

// pushPayload is the decrypted JSON the service worker receives.
type pushPayload struct {
	Type    string      `json:"type"`
	Tag     string      `json:"tag"`
	Team    pushRef     `json:"team"`
	Channel pushRef     `json:"channel"`
	Sender  pushSender  `json:"sender"`
	Message pushMessage `json:"message"`
	URL     string      `json:"url"`
}

// excerpt renders <@id> as @name and cuts to n runes (adding "…").
func excerpt(m *messageView, n int) string {
	names := map[string]string{}
	for _, mm := range m.Mentions {
		names[mm.MemberID] = mm.DisplayName
	}
	t := strings.Join(strings.Fields(mention.Plain(m.Content, names)), " ")
	if t == "" && len(m.Attachments) > 0 {
		return "[附件]"
	}
	if utf8.RuneCountInString(t) > n {
		rs := []rune(t)
		t = string(rs[:n]) + "…"
	}
	return t
}

func buildPushPayload(m *messageView, teamName, channelName string) pushPayload {
	return pushPayload{
		Type:    "message",
		Tag:     "msg-" + m.ID,
		Team:    pushRef{ID: m.TeamID, Name: teamName},
		Channel: pushRef{ID: m.ChannelID, Name: channelName},
		Sender:  pushSender{MemberID: m.Sender.MemberID, DisplayName: m.Sender.DisplayName, AvatarURL: m.Sender.AvatarURL},
		Message: pushMessage{ID: m.ID, Seq: m.Seq, Excerpt: excerpt(m, pushExcerptRunes)},
		URL:     "/teams/" + url.PathEscape(m.TeamID) + "/channels/" + url.PathEscape(m.ChannelID) + "?msg=" + url.QueryEscape(m.ID),
	}
}

// notifyTeamMembers pushes a new channel message to subscribed human members
// of the team (asynchronously; never blocks the request). The sender, bots
// and non-"message" kinds are skipped.
func (s *Server) notifyTeamMembers(m *messageView, channelName string) {
	if !s.push.enabled || m.Kind != "message" || m.Deleted {
		return
	}
	s.push.wg.Add(1)
	go func() {
		defer s.push.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		s.sendTeamPushes(ctx, m, channelName)
	}()
}

type pushSub struct {
	ID, Endpoint, P256dh, Auth, MemberID string
}

func (s *Server) sendTeamPushes(ctx context.Context, m *messageView, channelName string) {
	rows, err := s.pool.Query(ctx, `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, tm.id FROM push_subscriptions ps
		JOIN team_members tm ON tm.user_id = ps.user_id
		JOIN sessions se ON se.id = ps.session_id AND se.expires_at > now()
		JOIN channels c ON c.team_id = tm.team_id AND c.id = $1 AND c.deleted_at IS NULL
		WHERE tm.team_id = $2 AND tm.join_seq < $3 AND tm.type = 'user' AND tm.left_at IS NULL AND tm.id <> $4`, m.ChannelID, m.TeamID, m.Seq, m.Sender.MemberID)
	if err != nil {
		slog.Error("push: load subscriptions", "err", err)
		return
	}
	subs, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (pushSub, error) {
		var x pushSub
		err := r.Scan(&x.ID, &x.Endpoint, &x.P256dh, &x.Auth, &x.MemberID)
		return x, err
	})
	if err != nil || len(subs) == 0 {
		return
	}
	var teamName string
	if err := s.pool.QueryRow(ctx, `SELECT name FROM teams WHERE id=$1 AND deleted_at IS NULL`, m.TeamID).Scan(&teamName); err != nil {
		return
	}
	payload := buildPushPayload(m, teamName, channelName)
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	mentioned := make(map[string]bool, len(m.Mentions))
	for _, mention := range m.Mentions {
		mentioned[mention.MemberID] = true
	}
	var mentionBody []byte
	if len(mentioned) > 0 {
		payload.Type = "mention"
		mentionBody, err = json.Marshal(payload)
		if err != nil {
			return
		}
	}
	var wg sync.WaitGroup
	for _, sub := range subs {
		data := body
		if mentioned[sub.MemberID] {
			data = mentionBody
		}
		wg.Add(1)
		s.push.sem <- struct{}{}
		go func() {
			defer func() { <-s.push.sem; wg.Done() }()
			s.sendPush(ctx, sub, data)
		}()
	}
	wg.Wait()
}

func endpointHost(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil {
		return u.Host
	}
	return ""
}

func (s *Server) sendPush(ctx context.Context, sub pushSub, body []byte) {
	sctx, cancel := context.WithTimeout(ctx, pushTimeout)
	defer cancel()
	// webpush-go appends padding into the message buffer, so every send needs
	// its own copy (sharing one slice across goroutines is a data race).
	res, err := webpush.SendNotificationWithContext(sctx, bytes.Clone(body), &webpush.Subscription{
		Endpoint: sub.Endpoint, Keys: webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		HTTPClient: s.push.client, Subscriber: s.push.subscriber, TTL: pushTTL, Urgency: webpush.UrgencyHigh,
		VAPIDPublicKey: s.push.publicKey, VAPIDPrivateKey: s.push.privateKey,
	})
	host := endpointHost(sub.Endpoint)
	if err != nil {
		reason := "network_error"
		if netguard.IsBlockedErr(err) {
			reason = "blocked_address"
		} else if sctx.Err() != nil {
			reason = "timeout"
		}
		slog.Warn("push failed", "subscription", sub.ID, "host", host, "reason", reason)
		s.pool.Exec(ctx, `UPDATE push_subscriptions SET last_error=$2 WHERE id=$1`, sub.ID, reason)
		return
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	res.Body.Close()
	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		s.pool.Exec(ctx, `UPDATE push_subscriptions SET last_success_at=now(), last_error=NULL WHERE id=$1`, sub.ID)
	case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone:
		// subscription expired or was revoked by the browser
		s.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id=$1`, sub.ID)
		slog.Info("push subscription gone, removed", "subscription", sub.ID, "host", host, "status", res.StatusCode)
	default:
		slog.Warn("push failed", "subscription", sub.ID, "host", host, "status", res.StatusCode)
		s.pool.Exec(ctx, `UPDATE push_subscriptions SET last_error=$2 WHERE id=$1`, sub.ID, "http_"+itoa(res.StatusCode))
	}
}
