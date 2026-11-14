package httpapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/creteper/teams/backend/internal/auth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// writeList writes the standard {items,next_cursor,has_more} envelope.
func writeList[T any](w http.ResponseWriter, items []T, next *string, hasMore bool) error {
	if items == nil {
		items = []T{}
	}
	return writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next, "has_more": hasMore})
}

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{3,32}$`)

func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// cleanText trims and validates a single-line text field.
func cleanText(field, v string, min, max int) (string, error) {
	v = strings.TrimSpace(v)
	n := utf8.RuneCountInString(v)
	if n < min || n > max {
		return "", apierr.Validation(field, field+" 长度需在 "+itoa(min)+"–"+itoa(max)+" 之间")
	}
	if hasControl(v) {
		return "", apierr.Validation(field, field+" 不能包含控制字符")
	}
	return v, nil
}

type actor struct{ MemberID, Role, Type string }

func (a *actor) admin() bool { return a.Role == "owner" || a.Role == "admin" }

// actorIn returns the caller's active membership in teamID, or 404.
func (s *Server) actorIn(ctx context.Context, q querier, p *principal, teamID string) (*actor, error) {
	var a actor
	var err error
	if p.Bot != nil {
		if p.Bot.TeamID != teamID {
			return nil, apierr.NotFound("team")
		}
		return &actor{MemberID: p.Bot.MemberID, Role: "bot", Type: "bot"}, nil
	}
	err = q.QueryRow(ctx, `SELECT m.id, m.role, m.type FROM team_members m JOIN teams t ON t.id=m.team_id
		WHERE m.team_id=$1 AND m.user_id=$2 AND m.left_at IS NULL AND t.deleted_at IS NULL`, teamID, p.UserID).Scan(&a.MemberID, &a.Role, &a.Type)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apierr.NotFound("team")
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Server) teamIDParam(r *http.Request) (string, *actor, error) {
	id, err := pathID(r, "team_id", "team")
	if err != nil {
		return "", nil, err
	}
	a, err := s.actorIn(r.Context(), s.pool, principalFrom(r.Context()), id)
	return id, a, err
}

// ---------- auth ----------

type authResp struct {
	User      *userView `json:"user"`
	Token     string    `json:"token"`
	ExpiresAt jsTime    `json:"expires_at"`
}

func (s *Server) rateAuth(r *http.Request) error {
	if ok, wait := s.limiter.Allow("auth:"+clientIP(r), s.cfg.AuthRateLimitPerMinute, time.Minute); !ok {
		return apierr.RateLimited(wait)
	}
	return nil
}

func (s *Server) newSession(ctx context.Context, q querier, userID, ua string) (string, time.Time, error) {
	tok := auth.NewToken(auth.SessionPrefix)
	exp := time.Now().Add(s.cfg.SessionTTL)
	if len(ua) > 256 {
		ua = ua[:256]
	}
	_, err := q.Exec(ctx, `INSERT INTO sessions(id, user_id, token_hash, expires_at, user_agent) VALUES($1,$2,$3,$4,$5)`,
		newID(), userID, auth.HashToken(tok), exp, ua)
	return tok, exp, err
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) error {
	if err := s.rateAuth(r); err != nil {
		return err
	}
	var in struct{ Username, Password, DisplayName string }
	var body struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	in.Username, in.Password, in.DisplayName = strings.TrimSpace(body.Username), body.Password, body.DisplayName
	if !usernameRe.MatchString(in.Username) {
		return apierr.Validation("username", "用户名需 3–32 位，只能包含字母、数字、_ . -")
	}
	if n := utf8.RuneCountInString(in.Password); n < 8 || n > 128 {
		return apierr.Validation("password", "密码长度需在 8–128 之间")
	}
	if strings.TrimSpace(in.DisplayName) == "" {
		in.DisplayName = in.Username
	}
	dn, err := cleanText("display_name", in.DisplayName, 1, 64)
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(in.Password, s.argon)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var resp authResp
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		id := newID()
		if _, err := tx.Exec(ctx, `INSERT INTO users(id, username, password_hash, display_name) VALUES($1,$2,$3,$4)`,
			id, in.Username, hash, dn); err != nil {
			if apierrIsUnique(err) {
				return apierr.Conflict("用户名已存在").With("field", "username")
			}
			return err
		}
		tok, exp, err := s.newSession(ctx, tx, id, r.UserAgent())
		if err != nil {
			return err
		}
		u, err := loadUser(ctx, tx, id)
		resp = authResp{User: u, Token: tok, ExpiresAt: jsTime(exp)}
		return err
	})
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	if err := s.rateAuth(r); err != nil {
		return err
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	var id, hash string
	err := s.pool.QueryRow(ctx, `SELECT id, password_hash FROM users WHERE lower(username)=lower($1)`, strings.TrimSpace(body.Username)).Scan(&id, &hash)
	if err != nil {
		// equalize timing a little
		auth.VerifyPassword(body.Password, "$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g")
		return apierr.New(http.StatusUnauthorized, "unauthorized", "用户名或密码错误")
	}
	ok, err := auth.VerifyPassword(body.Password, hash)
	if err != nil || !ok {
		return apierr.New(http.StatusUnauthorized, "unauthorized", "用户名或密码错误")
	}
	tok, exp, err := s.newSession(ctx, s.pool, id, r.UserAgent())
	if err != nil {
		return err
	}
	u, err := loadUser(ctx, s.pool, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, authResp{User: u, Token: tok, ExpiresAt: jsTime(exp)})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) error {
	p := principalFrom(r.Context())
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM sessions WHERE id=$1`, p.SessionID); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) getMe(w http.ResponseWriter, r *http.Request) error {
	u, err := loadUser(r.Context(), s.pool, principalFrom(r.Context()).UserID)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, u)
}

func (s *Server) patchMe(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		DisplayName *string `json:"display_name"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	uid := principalFrom(ctx).UserID
	if body.DisplayName != nil {
		dn, err := cleanText("display_name", *body.DisplayName, 1, 64)
		if err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, `UPDATE users SET display_name=$2 WHERE id=$1`, uid, dn); err != nil {
			return err
		}
		s.publishUserMemberUpdated(ctx, uid)
	}
	return s.getMe(w, r)
}

// publishUserMemberUpdated emits member.updated in every team of the user.
func (s *Server) publishUserMemberUpdated(ctx context.Context, userID string) {
	rows, err := s.pool.Query(ctx, memberSelect+`JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.left_at IS NULL AND t.deleted_at IS NULL`, userID)
	if err != nil {
		return
	}
	ms, err := scanMembers(rows)
	if err != nil {
		return
	}
	for _, m := range ms {
		s.hub.PublishTeam(m.TeamID, "member.updated", m)
	}
}

// ---------- teams ----------

func (s *Server) createTeam(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	name, err := cleanText("name", body.Name, 1, 64)
	if err != nil {
		return err
	}
	desc := strings.TrimSpace(body.Description)
	if utf8.RuneCountInString(desc) > 500 {
		return apierr.Validation("description", "description 最长 500")
	}
	ctx := r.Context()
	p := principalFrom(ctx)
	teamID, memberID := newID(), newID()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO teams(id, name, description, owner_user_id) VALUES($1,$2,$3,$4)`, teamID, name, desc, p.UserID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO team_members(id, team_id, type, user_id, role) VALUES($1,$2,'user',$3,'owner')`, memberID, teamID, p.UserID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO channels(id, team_id, name, is_default, created_by_member_id) VALUES($1,$2,'general',true,$3)`, newID(), teamID, memberID)
		return err
	})
	if err != nil {
		return err
	}
	s.hub.SetTeam(p.key(), teamID, true)
	t, err := loadTeam(ctx, s.pool, teamID)
	if err != nil {
		return err
	}
	t.MyMemberID, t.MyRole = memberID, "owner"
	s.hub.PublishPrincipal(p.key(), teamID, "team.joined", t)
	return writeJSON(w, http.StatusCreated, t)
}

func (s *Server) listTeams(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	rows, err := s.pool.Query(ctx, `SELECT t.id, t.name, t.description, t.icon_avatar_id, t.owner_user_id, t.created_at, m.id, m.role
		FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 AND m.left_at IS NULL
		WHERE t.deleted_at IS NULL ORDER BY t.created_at`, principalFrom(ctx).UserID)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (teamView, error) {
		var t teamView
		var icon *string
		var created time.Time
		err := r.Scan(&t.ID, &t.Name, &t.Description, &icon, &t.OwnerUserID, &created, &t.MyMemberID, &t.MyRole)
		t.IconURL, t.CreatedAt = avatarURL(icon), jsTime(created)
		return t, err
	})
	if err != nil {
		return err
	}
	return writeList(w, items, nil, false)
}

func (s *Server) getTeam(w http.ResponseWriter, r *http.Request) error {
	id, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	t, err := loadTeam(r.Context(), s.pool, id)
	if err != nil {
		return err
	}
	t.MyMemberID, t.MyRole = a.MemberID, a.Role
	return writeJSON(w, http.StatusOK, t)
}

func (s *Server) patchTeam(w http.ResponseWriter, r *http.Request) error {
	id, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if body.Name != nil {
		n, err := cleanText("name", *body.Name, 1, 64)
		if err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, `UPDATE teams SET name=$2 WHERE id=$1`, id, n); err != nil {
			return err
		}
	}
	if body.Description != nil {
		d := strings.TrimSpace(*body.Description)
		if utf8.RuneCountInString(d) > 500 {
			return apierr.Validation("description", "description 最长 500")
		}
		if _, err := s.pool.Exec(ctx, `UPDATE teams SET description=$2 WHERE id=$1`, id, d); err != nil {
			return err
		}
	}
	return s.respondTeamUpdated(w, r, id, a)
}

func (s *Server) respondTeamUpdated(w http.ResponseWriter, r *http.Request, id string, a *actor) error {
	t, err := loadTeam(r.Context(), s.pool, id)
	if err != nil {
		return err
	}
	s.hub.PublishTeam(id, "team.updated", t)
	t.MyMemberID, t.MyRole = a.MemberID, a.Role
	return writeJSON(w, http.StatusOK, t)
}

func (s *Server) deleteTeam(w http.ResponseWriter, r *http.Request) error {
	id, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if a.Role != "owner" {
		return apierr.Forbidden("只有 owner 可以删除 team")
	}
	if _, err := s.pool.Exec(r.Context(), `UPDATE teams SET deleted_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	s.hub.PublishTeam(id, "team.deleted", map[string]string{"team_id": id})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---------- members ----------

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	limit := 100
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return apierr.Validation("limit", "limit 无效")
		}
		limit = min(n, 200)
	}
	sql := memberSelect + `WHERE m.team_id=$1 AND m.left_at IS NULL AND (b.id IS NULL OR b.deleted_at IS NULL)`
	args := []any{id}
	switch t := q.Get("type"); t {
	case "":
	case "user", "bot":
		args = append(args, t)
		sql += ` AND m.type=$` + itoa(len(args))
	default:
		return apierr.Validation("type", "type 只能是 user 或 bot")
	}
	if c := q.Get("cursor"); c != "" {
		u, err := uuid.Parse(c)
		if err != nil {
			return apierr.Validation("cursor", "cursor 无效")
		}
		args = append(args, u.String())
		sql += ` AND m.id > $` + itoa(len(args))
	}
	args = append(args, limit+1)
	rows, err := s.pool.Query(r.Context(), sql+` ORDER BY m.id LIMIT $`+itoa(len(args)), args...)
	if err != nil {
		return err
	}
	ms, err := scanMembers(rows)
	if err != nil {
		return err
	}
	hasMore := len(ms) > limit
	var next *string
	if hasMore {
		ms = ms[:limit]
		v := ms[len(ms)-1].ID
		next = &v
	}
	return writeList(w, ms, next, hasMore)
}

func (s *Server) addMember(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	var body struct {
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if body.Role == "" {
		body.Role = "member"
	}
	if body.Role != "member" && body.Role != "admin" {
		return apierr.Validation("role", "role 只能是 member 或 admin")
	}
	ctx := r.Context()
	var userID string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM users WHERE lower(username)=lower($1)`, strings.TrimSpace(body.Username)).Scan(&userID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.NotFound("用户")
		}
		return err
	}
	mid := newID()
	_, err = s.pool.Exec(ctx, `INSERT INTO team_members(id, team_id, type, user_id, role) VALUES($1,$2,'user',$3,$4)`, mid, teamID, userID, body.Role)
	if apierrIsUnique(err) {
		return apierr.Conflict("该用户已是成员")
	}
	if err != nil {
		return err
	}
	m, err := loadMember(ctx, s.pool, mid)
	if err != nil {
		return err
	}
	if t, err := loadTeam(ctx, s.pool, teamID); err == nil {
		t.MyMemberID, t.MyRole = mid, body.Role
		s.announceJoin(ctx, teamID, userID, m, t)
	}
	return writeJSON(w, http.StatusCreated, m)
}

func (s *Server) targetMember(r *http.Request, teamID string) (*memberView, error) {
	mid, err := pathID(r, "member_id", "成员")
	if err != nil {
		return nil, err
	}
	m, err := loadMember(r.Context(), s.pool, mid)
	if err != nil || m.TeamID != teamID || m.Deleted {
		return nil, apierr.NotFound("成员")
	}
	return m, nil
}

func (s *Server) patchMember(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	m, err := s.targetMember(r, teamID)
	if err != nil {
		return err
	}
	var body struct {
		Role string `json:"role"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if m.Type != "user" || m.Role == "owner" {
		return apierr.Forbidden("不能修改 owner 或 bot 的角色")
	}
	if body.Role != "member" && body.Role != "admin" {
		return apierr.Validation("role", "role 只能是 member 或 admin")
	}
	ctx := r.Context()
	if _, err := s.pool.Exec(ctx, `UPDATE team_members SET role=$2 WHERE id=$1`, m.ID, body.Role); err != nil {
		return err
	}
	m, err = loadMember(ctx, s.pool, m.ID)
	if err != nil {
		return err
	}
	s.hub.PublishTeam(teamID, "member.updated", m)
	return writeJSON(w, http.StatusOK, m)
}

func (s *Server) removeMember(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	m, err := s.targetMember(r, teamID)
	if err != nil {
		return err
	}
	if m.Type == "bot" {
		return apierr.BadRequest("删除 bot 请用 DELETE /api/v1/bots/{bot_id}")
	}
	if m.Role == "owner" {
		return apierr.Forbidden("owner 不能被移除或退出")
	}
	if m.ID != a.MemberID && !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	ctx := r.Context()
	if _, err := s.pool.Exec(ctx, `UPDATE team_members SET left_at=now() WHERE id=$1`, m.ID); err != nil {
		return err
	}
	s.hub.SetTeam("user:"+*m.UserID, teamID, false)
	s.hub.PublishTeam(teamID, "member.left", map[string]string{"member_id": m.ID})
	s.hub.PublishPrincipal("user:"+*m.UserID, teamID, "team.removed", map[string]string{"team_id": teamID})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---------- channels ----------

func (s *Server) listChannels(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	rows, err := s.pool.Query(r.Context(), channelSelect+`WHERE c.team_id=$1 AND c.deleted_at IS NULL ORDER BY c.is_default DESC, c.created_at`, id)
	if err != nil {
		return err
	}
	cs, err := scanChannels(rows)
	if err != nil {
		return err
	}
	return writeList(w, cs, nil, false)
}

func (s *Server) createChannel(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	var body struct {
		Name  string `json:"name"`
		Topic string `json:"topic"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	name, err := cleanText("name", body.Name, 1, 64)
	if err != nil {
		return err
	}
	topic, err := cleanText("topic", body.Topic, 0, 250)
	if err != nil {
		return err
	}
	ctx := r.Context()
	id := newID()
	_, err = s.pool.Exec(ctx, `INSERT INTO channels(id, team_id, name, topic, created_by_member_id) VALUES($1,$2,$3,$4,$5)`, id, teamID, name, topic, a.MemberID)
	if apierrIsUnique(err) {
		return apierr.Conflict("频道名已存在").With("field", "name")
	}
	if err != nil {
		return err
	}
	c, err := loadChannel(ctx, s.pool, id)
	if err != nil {
		return err
	}
	s.hub.PublishTeam(teamID, "channel.created", c)
	return writeJSON(w, http.StatusCreated, c)
}

// channelParam loads the channel and the caller's membership in its team.
func (s *Server) channelParam(r *http.Request) (*channelView, *actor, error) {
	id, err := pathID(r, "channel_id", "频道")
	if err != nil {
		return nil, nil, err
	}
	c, err := loadChannel(r.Context(), s.pool, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, apierr.NotFound("频道")
	}
	if err != nil {
		return nil, nil, err
	}
	a, err := s.actorIn(r.Context(), s.pool, principalFrom(r.Context()), c.TeamID)
	if err != nil {
		return nil, nil, apierr.NotFound("频道")
	}
	return c, a, nil
}

func (s *Server) getChannel(w http.ResponseWriter, r *http.Request) error {
	c, _, err := s.channelParam(r)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, c)
}

func (s *Server) patchChannel(w http.ResponseWriter, r *http.Request) error {
	c, a, err := s.channelParam(r)
	if err != nil {
		return err
	}
	if !a.admin() && (c.CreatedByMemberID == nil || *c.CreatedByMemberID != a.MemberID) {
		return apierr.Forbidden("需要 owner/admin 或频道创建者")
	}
	var body struct {
		Name  *string `json:"name"`
		Topic *string `json:"topic"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if body.Name != nil {
		n, err := cleanText("name", *body.Name, 1, 64)
		if err != nil {
			return err
		}
		_, err = s.pool.Exec(ctx, `UPDATE channels SET name=$2 WHERE id=$1`, c.ID, n)
		if apierrIsUnique(err) {
			return apierr.Conflict("频道名已存在").With("field", "name")
		}
		if err != nil {
			return err
		}
	}
	if body.Topic != nil {
		t, err := cleanText("topic", *body.Topic, 0, 250)
		if err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, `UPDATE channels SET topic=$2 WHERE id=$1`, c.ID, t); err != nil {
			return err
		}
	}
	c, err = loadChannel(ctx, s.pool, c.ID)
	if err != nil {
		return err
	}
	s.hub.PublishTeam(c.TeamID, "channel.updated", c)
	return writeJSON(w, http.StatusOK, c)
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) error {
	c, a, err := s.channelParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	if c.IsDefault {
		return apierr.Forbidden("默认频道不能删除")
	}
	if _, err := s.pool.Exec(r.Context(), `UPDATE channels SET deleted_at=now() WHERE id=$1`, c.ID); err != nil {
		return err
	}
	s.hub.PublishTeam(c.TeamID, "channel.deleted", map[string]string{"id": c.ID})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
