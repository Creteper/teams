package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/creteper/teams/backend/internal/auth"
	"github.com/creteper/teams/backend/internal/netguard"
	"github.com/creteper/teams/backend/internal/webhook"
	"github.com/jackc/pgx/v5"
)

var headerNameRe = regexp.MustCompile("^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$")

var reservedHeaders = map[string]bool{
	"host": true, "content-type": true, "content-length": true, "user-agent": true,
	"transfer-encoding": true, "connection": true, "te": true, "trailer": true, "upgrade": true,
}

func validHeaderName(n string) bool {
	l := strings.ToLower(n)
	return headerNameRe.MatchString(n) && !reservedHeaders[l] && !strings.HasPrefix(l, "x-teams-")
}

// NormalizeStyle cleans avatar_shape / avatar_color: stored verbatim except
// surrounding whitespace; empty or null -> nil; max 64 runes; no control chars.
func NormalizeStyle(field string, o optString) (*string, error) {
	if o.Null {
		return nil, nil
	}
	v := strings.TrimSpace(o.V)
	if v == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(v) > 64 {
		return nil, apierr.Validation(field, field+" 最长 64 字符")
	}
	if hasControl(v) {
		return nil, apierr.Validation(field, field+" 不能包含控制字符")
	}
	return &v, nil
}

type botProfile struct {
	DisplayName *string
	Description *string
	AvatarURL   optString
	AvatarData  []byte
	Shape       optString
	Color       optString
}

func (bp *botProfile) validate() error {
	if bp.DisplayName != nil {
		v, err := cleanText("display_name", *bp.DisplayName, 1, 64)
		if err != nil {
			return err
		}
		bp.DisplayName = &v
	}
	if bp.Description != nil {
		v := strings.TrimSpace(*bp.Description)
		if utf8.RuneCountInString(v) > 500 {
			return apierr.Validation("description", "description 最长 500")
		}
		bp.Description = &v
	}
	if bp.AvatarURL.Set && bp.AvatarData != nil {
		return apierr.BadRequest("avatar_url 和 avatar 文件不能同时提供")
	}
	if bp.AvatarURL.Set && !bp.AvatarURL.Null && strings.TrimSpace(bp.AvatarURL.V) == "" {
		bp.AvatarURL.Null = true
	}
	return nil
}

// applyBotProfile updates profile fields; returns whether anything changed.
func (s *Server) applyBotProfile(ctx context.Context, botID string, bp *botProfile) (bool, error) {
	changed := false
	exec := func(sql string, args ...any) error {
		tag, err := s.pool.Exec(ctx, sql, args...)
		if err == nil && tag.RowsAffected() > 0 {
			changed = true
		}
		return err
	}
	if bp.DisplayName != nil {
		if err := exec(`UPDATE bots SET display_name=$2 WHERE id=$1 AND display_name IS DISTINCT FROM $2`, botID, *bp.DisplayName); err != nil {
			return false, err
		}
	}
	if bp.Description != nil {
		if err := exec(`UPDATE bots SET description=$2 WHERE id=$1 AND description IS DISTINCT FROM $2`, botID, *bp.Description); err != nil {
			return false, err
		}
	}
	if bp.Shape.Set {
		v, err := NormalizeStyle("avatar_shape", bp.Shape)
		if err != nil {
			return false, err
		}
		if err := exec(`UPDATE bots SET avatar_shape=$2 WHERE id=$1 AND avatar_shape IS DISTINCT FROM $2`, botID, v); err != nil {
			return false, err
		}
	}
	if bp.Color.Set {
		v, err := NormalizeStyle("avatar_color", bp.Color)
		if err != nil {
			return false, err
		}
		if err := exec(`UPDATE bots SET avatar_color=$2 WHERE id=$1 AND avatar_color IS DISTINCT FROM $2`, botID, v); err != nil {
			return false, err
		}
	}
	switch {
	case bp.AvatarData != nil:
		id, err := s.saveAvatar(ctx, s.pool, "bot", botID, bp.AvatarData, nil)
		if err != nil {
			return changed, err
		}
		if err := exec(`UPDATE bots SET avatar_id=$2, avatar_source_url=NULL WHERE id=$1`, botID, id); err != nil {
			return changed, err
		}
	case bp.AvatarURL.Set && bp.AvatarURL.Null:
		if err := exec(`UPDATE bots SET avatar_id=NULL, avatar_source_url=NULL WHERE id=$1 AND (avatar_id IS NOT NULL OR avatar_source_url IS NOT NULL)`, botID); err != nil {
			return changed, err
		}
	case bp.AvatarURL.Set:
		src := strings.TrimSpace(bp.AvatarURL.V)
		data, err := s.fetchAvatar(ctx, src)
		if err != nil {
			return changed, err
		}
		var curSrc *string
		var curSHA []byte
		s.pool.QueryRow(ctx, `SELECT b.avatar_source_url, a.sha256 FROM bots b LEFT JOIN avatars a ON a.id=b.avatar_id WHERE b.id=$1`, botID).Scan(&curSrc, &curSHA)
		sum := sha256Sum(data)
		if curSrc != nil && *curSrc == src && bytes.Equal(curSHA, sum) {
			return changed, nil // unchanged: idempotent sync
		}
		id, err := s.saveAvatar(ctx, s.pool, "bot", botID, data, &src)
		if err != nil {
			return changed, err
		}
		if err := exec(`UPDATE bots SET avatar_id=$2, avatar_source_url=$3 WHERE id=$1`, botID, id, src); err != nil {
			return changed, err
		}
	}
	return changed, nil
}

func (s *Server) publishBotMember(ctx context.Context, b *botView) {
	if m, err := loadMember(ctx, s.pool, b.MemberID); err == nil {
		s.hub.PublishTeam(b.TeamID, "member.updated", m)
	}
}

// botParam loads a bot visible to the caller.
func (s *Server) botParam(r *http.Request) (*botView, *actor, error) {
	id, err := pathID(r, "bot_id", "bot")
	if err != nil {
		return nil, nil, err
	}
	b, err := loadBot(r.Context(), s.pool, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, apierr.NotFound("bot")
	}
	if err != nil {
		return nil, nil, err
	}
	a, err := s.actorIn(r.Context(), s.pool, principalFrom(r.Context()), b.TeamID)
	if err != nil {
		return nil, nil, apierr.NotFound("bot")
	}
	return b, a, nil
}

func (s *Server) botAdminParam(r *http.Request) (*botView, *actor, error) {
	b, a, err := s.botParam(r)
	if err != nil {
		return nil, nil, err
	}
	if !a.admin() {
		return nil, nil, apierr.Forbidden("需要 owner 或 admin")
	}
	return b, a, nil
}

type warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (s *Server) createBot(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	var body struct {
		Name        string    `json:"name"`
		DisplayName string    `json:"display_name"`
		Description string    `json:"description"`
		AvatarURL   optString `json:"avatar_url"`
		AvatarShape optString `json:"avatar_shape"`
		AvatarColor optString `json:"avatar_color"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	name := strings.TrimSpace(body.Name)
	if !usernameRe.MatchString(name) {
		return apierr.Validation("name", "name 需 3–32 位，只能包含字母、数字、_ . -")
	}
	if strings.TrimSpace(body.DisplayName) == "" {
		body.DisplayName = name
	}
	bp := &botProfile{DisplayName: &body.DisplayName, Description: &body.Description, Shape: body.AvatarShape, Color: body.AvatarColor}
	if err := bp.validate(); err != nil {
		return err
	}
	shape, err := NormalizeStyle("avatar_shape", body.AvatarShape)
	if err != nil {
		return err
	}
	color, err := NormalizeStyle("avatar_color", body.AvatarColor)
	if err != nil {
		return err
	}
	ctx := r.Context()
	botID, memberID := newID(), newID()
	tok := auth.NewToken(auth.BotPrefix)
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO bots(id, team_id, member_id, name, display_name, description, avatar_shape, avatar_color, token_hash, token_prefix, created_by_member_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, botID, teamID, memberID, name, *bp.DisplayName, *bp.Description, shape, color,
			auth.HashToken(tok), tok[:8], a.MemberID)
		if apierrIsUnique(err) {
			return apierr.Conflict("bot 名称已存在").With("field", "name")
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO team_members(id, team_id, type, bot_id, role) VALUES($1,$2,'bot',$3,'bot')`, memberID, teamID, botID)
		return err
	})
	if err != nil {
		return err
	}
	var warnings []warning
	if body.AvatarURL.Set && !body.AvatarURL.Null && strings.TrimSpace(body.AvatarURL.V) != "" {
		if _, err := s.applyBotProfile(ctx, botID, &botProfile{AvatarURL: body.AvatarURL}); err != nil {
			if e := apierr.As(err); e != nil {
				warnings = append(warnings, warning{Code: e.Code, Message: e.Message})
			} else {
				return err
			}
		}
	}
	b, err := loadBot(ctx, s.pool, botID)
	if err != nil {
		return err
	}
	if m, err := loadMember(ctx, s.pool, memberID); err == nil {
		s.hub.PublishTeam(teamID, "member.joined", m)
	}
	resp := map[string]any{"bot": b, "token": tok}
	if len(warnings) > 0 {
		resp["warnings"] = warnings
	}
	return writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) listBots(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	rows, err := s.pool.Query(r.Context(), botSelect+`WHERE b.team_id=$1 AND b.deleted_at IS NULL ORDER BY b.created_at`, teamID)
	if err != nil {
		return err
	}
	bs, err := scanBots(rows)
	if err != nil {
		return err
	}
	if !a.admin() {
		for i := range bs {
			bs[i].Webhook = nil
		}
	}
	return writeList(w, bs, nil, false)
}

func (s *Server) getBot(w http.ResponseWriter, r *http.Request) error {
	b, a, err := s.botParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		b.Webhook = nil
	}
	return writeJSON(w, http.StatusOK, b)
}

func (s *Server) patchBot(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	var body struct {
		DisplayName *string   `json:"display_name"`
		Description *string   `json:"description"`
		AvatarURL   optString `json:"avatar_url"`
		AvatarShape optString `json:"avatar_shape"`
		AvatarColor optString `json:"avatar_color"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	bp := &botProfile{DisplayName: body.DisplayName, Description: body.Description, AvatarURL: body.AvatarURL, Shape: body.AvatarShape, Color: body.AvatarColor}
	return s.updateBotProfile(w, r, b, bp, false)
}

func (s *Server) updateBotProfile(w http.ResponseWriter, r *http.Request, b *botView, bp *botProfile, self bool) error {
	if err := bp.validate(); err != nil {
		return err
	}
	ctx := r.Context()
	changed, err := s.applyBotProfile(ctx, b.ID, bp)
	if changed {
		if nb, lerr := loadBot(ctx, s.pool, b.ID); lerr == nil {
			s.publishBotMember(ctx, nb)
		}
	}
	if err != nil {
		return err
	}
	nb, err := loadBot(ctx, s.pool, b.ID)
	if err != nil {
		return err
	}
	if self {
		nb.Webhook = nil
		m, err := loadMember(ctx, s.pool, nb.MemberID)
		if err != nil {
			return err
		}
		return writeJSON(w, http.StatusOK, map[string]any{"bot": nb, "member": m})
	}
	return writeJSON(w, http.StatusOK, nb)
}

func (s *Server) deleteBot(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE bots SET deleted_at=now() WHERE id=$1`, b.ID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE team_members SET left_at=now() WHERE id=$1`, b.MemberID)
		return err
	})
	if err != nil {
		return err
	}
	s.hub.SetTeam("bot:"+b.ID, b.TeamID, false)
	s.hub.PublishTeam(b.TeamID, "member.left", map[string]string{"member_id": b.MemberID})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) rotateBotToken(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	tok := auth.NewToken(auth.BotPrefix)
	if _, err := s.pool.Exec(r.Context(), `UPDATE bots SET token_hash=$2, token_prefix=$3 WHERE id=$1`, b.ID, auth.HashToken(tok), tok[:8]); err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"bot_id": b.ID, "token": tok})
}

func (s *Server) putBotAvatar(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	return s.uploadBotAvatar(w, r, b, false)
}

func (s *Server) uploadBotAvatar(w http.ResponseWriter, r *http.Request, b *botView, self bool) error {
	data, _, err := s.readMultipartAvatar(w, r, "file")
	if err != nil {
		return err
	}
	if data == nil {
		return apierr.Validation("file", "缺少 file 字段")
	}
	return s.updateBotProfile(w, r, b, &botProfile{AvatarData: data}, self)
}

func (s *Server) deleteBotAvatar(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	return s.updateBotProfile(w, r, b, &botProfile{AvatarURL: optString{Set: true, Null: true}}, false)
}

// ---------- bots/me (bot token) ----------

func (s *Server) selfBot(r *http.Request) (*botView, error) {
	p := principalFrom(r.Context())
	b, err := loadBot(r.Context(), s.pool, p.Bot.ID)
	if err != nil {
		return nil, apierr.Unauthorized()
	}
	return b, nil
}

func (s *Server) rateBotProfile(b *botView) error {
	if ok, wait := s.limiter.Allow("botprofile:"+b.ID, s.cfg.BotProfileRatePerMinute, time.Minute); !ok {
		return apierr.RateLimited(wait)
	}
	return nil
}

func (s *Server) getBotMe(w http.ResponseWriter, r *http.Request) error {
	b, err := s.selfBot(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	m, err := loadMember(ctx, s.pool, b.MemberID)
	if err != nil {
		return err
	}
	t, err := loadTeam(ctx, s.pool, b.TeamID)
	if err != nil {
		return err
	}
	t.MyMemberID, t.MyRole = b.MemberID, "bot"
	b.Webhook = nil
	return writeJSON(w, http.StatusOK, map[string]any{"bot": b, "member": m, "team": t})
}

func (s *Server) patchBotMe(w http.ResponseWriter, r *http.Request) error {
	b, err := s.selfBot(r)
	if err != nil {
		return err
	}
	if err := s.rateBotProfile(b); err != nil {
		return err
	}
	bp := &botProfile{}
	if isMultipart(r) {
		data, vals, err := s.readMultipartAvatar(w, r, "avatar")
		if err != nil {
			return err
		}
		bp.AvatarData = data
		if v, ok := vals["display_name"]; ok {
			bp.DisplayName = &v
		}
		if v, ok := vals["description"]; ok {
			bp.Description = &v
		}
		if v, ok := vals["avatar_url"]; ok {
			bp.AvatarURL = optString{Set: true, V: v}
		}
		if v, ok := vals["avatar_shape"]; ok {
			bp.Shape = optString{Set: true, V: v}
		}
		if v, ok := vals["avatar_color"]; ok {
			bp.Color = optString{Set: true, V: v}
		}
	} else {
		var raw map[string]json.RawMessage
		if err := decodeJSON(r, &raw); err != nil {
			return err
		}
		for k := range raw {
			switch k {
			case "display_name", "description", "avatar_url", "avatar_shape", "avatar_color":
			default:
				return apierr.Validation(k, "bot 不能修改字段 "+k)
			}
		}
		var body struct {
			DisplayName *string   `json:"display_name"`
			Description *string   `json:"description"`
			AvatarURL   optString `json:"avatar_url"`
			AvatarShape optString `json:"avatar_shape"`
			AvatarColor optString `json:"avatar_color"`
		}
		b2, _ := json.Marshal(raw)
		if err := json.Unmarshal(b2, &body); err != nil {
			return apierr.BadRequest("JSON 格式错误")
		}
		bp = &botProfile{DisplayName: body.DisplayName, Description: body.Description, AvatarURL: body.AvatarURL, Shape: body.AvatarShape, Color: body.AvatarColor}
	}
	return s.updateBotProfile(w, r, b, bp, true)
}

func (s *Server) putBotMeAvatar(w http.ResponseWriter, r *http.Request) error {
	b, err := s.selfBot(r)
	if err != nil {
		return err
	}
	if err := s.rateBotProfile(b); err != nil {
		return err
	}
	return s.uploadBotAvatar(w, r, b, true)
}

func (s *Server) deleteBotMeAvatar(w http.ResponseWriter, r *http.Request) error {
	b, err := s.selfBot(r)
	if err != nil {
		return err
	}
	return s.updateBotProfile(w, r, b, &botProfile{AvatarURL: optString{Set: true, Null: true}}, true)
}

// ---------- webhook config ----------

func newSigningSecret() string { return auth.NewToken("whsec_") }

func (s *Server) putWebhook(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	var body struct {
		URL               string    `json:"url"`
		Enabled           *bool     `json:"enabled"`
		SecretHeaderName  optString `json:"secret_header_name"`
		SecretHeaderValue optString `json:"secret_header_value"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	u, err := netguard.ValidateURL(strings.TrimSpace(body.URL), true, s.cfg.AllowInsecureLocal)
	if err != nil {
		if netguard.IsBlockedErr(err) {
			return apierr.Validation("url", "webhook 地址不能指向内网/本机").With("reason", "blocked_address")
		}
		return apierr.Validation("url", "webhook url 无效: "+err.Error())
	}
	ctx := r.Context()
	var exists bool
	var curName *string
	var curVal []byte
	err = s.pool.QueryRow(ctx, `SELECT secret_header_name, secret_header_value_enc FROM bot_webhooks WHERE bot_id=$1`, b.ID).Scan(&curName, &curVal)
	if err == nil {
		exists = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	name, val := curName, curVal
	if body.SecretHeaderName.Set {
		if body.SecretHeaderName.Null || strings.TrimSpace(body.SecretHeaderName.V) == "" {
			name, val = nil, nil
			if body.SecretHeaderValue.Set && !body.SecretHeaderValue.Null && body.SecretHeaderValue.V != "" {
				return apierr.Validation("secret_header_name", "提供 secret_header_value 时必须同时提供 secret_header_name")
			}
		} else {
			n := strings.TrimSpace(body.SecretHeaderName.V)
			if !validHeaderName(n) {
				return apierr.Validation("secret_header_name", "header 名不合法或为保留头")
			}
			if (curName == nil || !strings.EqualFold(*curName, n)) && (!body.SecretHeaderValue.Set || body.SecretHeaderValue.V == "") {
				return apierr.Validation("secret_header_value", "设置新的 secret_header_name 时必须提供 secret_header_value")
			}
			name = &n
		}
	}
	if body.SecretHeaderValue.Set && !body.SecretHeaderValue.Null && body.SecretHeaderValue.V != "" {
		if name == nil {
			return apierr.Validation("secret_header_name", "提供 secret_header_value 时必须同时提供 secret_header_name")
		}
		v := body.SecretHeaderValue.V
		if len(v) > 1024 || strings.ContainsAny(v, "\r\n\x00") {
			return apierr.Validation("secret_header_value", "secret_header_value 无效")
		}
		val = s.box.Seal([]byte(v))
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	var newSecret string
	if exists {
		_, err = s.pool.Exec(ctx, `UPDATE bot_webhooks SET url=$2, enabled=$3, secret_header_name=$4, secret_header_value_enc=$5, updated_at=now() WHERE bot_id=$1`,
			b.ID, u.String(), enabled, name, val)
	} else {
		newSecret = newSigningSecret()
		_, err = s.pool.Exec(ctx, `INSERT INTO bot_webhooks(bot_id, url, enabled, secret_header_name, secret_header_value_enc, signing_secret_enc) VALUES($1,$2,$3,$4,$5,$6)`,
			b.ID, u.String(), enabled, name, val, s.box.Seal([]byte(newSecret)))
	}
	if err != nil {
		return err
	}
	nb, err := loadBot(ctx, s.pool, b.ID)
	if err != nil {
		return err
	}
	nb.Webhook.SigningSecret = newSecret
	return writeJSON(w, http.StatusOK, nb.Webhook)
}

func (s *Server) deleteWebhook(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM bot_webhooks WHERE bot_id=$1`, b.ID); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) rotateSigningSecret(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	sec := newSigningSecret()
	tag, err := s.pool.Exec(r.Context(), `UPDATE bot_webhooks SET signing_secret_enc=$2, updated_at=now() WHERE bot_id=$1`, b.ID, s.box.Seal([]byte(sec)))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apierr.NotFound("webhook 配置")
	}
	return writeJSON(w, http.StatusOK, map[string]string{"signing_secret": sec})
}

func (s *Server) testWebhook(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	t, err := webhook.LoadTarget(ctx, s.pool, s.box, b.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierr.NotFound("webhook 配置")
	}
	if err != nil {
		return err
	}
	d := webhook.Delivery{ID: newID(), BotID: b.ID, Event: "ping", Attempts: 1}
	body, err := s.buildDeliveryPayload(ctx, d)
	if err != nil {
		return err
	}
	res := webhook.Send(ctx, s.hookClient, t, "ping", d.ID, body)
	status := "failed"
	if res.OK() {
		status = "succeeded"
	}
	var code *int
	if res.Err == nil {
		c := res.StatusCode
		code = &c
	}
	cls := webhook.ErrorClass(res)
	s.pool.Exec(ctx, `INSERT INTO webhook_deliveries(id, bot_id, event, status, attempts, last_status_code, last_error, finished_at)
		VALUES($1,$2,'ping',$3,1,$4,$5,now())`, d.ID, b.ID, status, code, cls)
	return writeJSON(w, http.StatusOK, map[string]any{"ok": res.OK(), "delivery_id": d.ID, "status_code": code, "result": cls})
}

type deliveryView struct {
	ID             string  `json:"id"`
	MessageID      *string `json:"message_id"`
	ChannelID      *string `json:"channel_id"`
	Event          string  `json:"event"`
	Status         string  `json:"status"`
	Attempts       int     `json:"attempts"`
	LastStatusCode *int    `json:"last_status_code"`
	LastError      *string `json:"last_error"`
	NextAttemptAt  *jsTime `json:"next_attempt_at"`
	CreatedAt      jsTime  `json:"created_at"`
	FinishedAt     *jsTime `json:"finished_at"`
}

func (s *Server) listDeliveries(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.botAdminParam(r)
	if err != nil {
		return err
	}
	rows, err := s.pool.Query(r.Context(), `SELECT id, message_id, channel_id, event, status, attempts, last_status_code, last_error,
		next_attempt_at, created_at, finished_at FROM webhook_deliveries WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 100`, b.ID)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (deliveryView, error) {
		var d deliveryView
		var next, created time.Time
		var fin *time.Time
		err := r.Scan(&d.ID, &d.MessageID, &d.ChannelID, &d.Event, &d.Status, &d.Attempts, &d.LastStatusCode, &d.LastError, &next, &created, &fin)
		d.CreatedAt, d.FinishedAt = jsTime(created), tp(fin)
		if d.Status == "pending" {
			d.NextAttemptAt = tp(&next)
		}
		return d, err
	})
	if err != nil {
		return err
	}
	return writeList(w, items, nil, false)
}
