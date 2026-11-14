package httpapi

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var inviteCodeRe = regexp.MustCompile(`^[0-9A-Za-z]{10}$`)

// NewInviteCode returns a 10-char base62 code from crypto/rand.
func NewInviteCode() string {
	b := make([]byte, 10)
	n := big.NewInt(int64(len(base62)))
	for i := range b {
		v, err := rand.Int(rand.Reader, n)
		if err != nil {
			panic(err)
		}
		b[i] = base62[v.Int64()]
	}
	return string(b)
}

type inviteView struct {
	ID        string  `json:"id"`
	Code      string  `json:"code"`
	TeamID    string  `json:"team_id"`
	URLPath   string  `json:"url_path"`
	ExpiresAt *jsTime `json:"expires_at"`
	MaxUses   *int    `json:"max_uses"`
	Uses      int     `json:"uses"`
	RevokedAt *jsTime `json:"revoked_at"`
	CreatedBy string  `json:"created_by"`
	CreatedAt jsTime  `json:"created_at"`
}

const inviteSelect = `SELECT id, code, team_id, expires_at, max_uses, uses, revoked_at, created_by, created_at FROM team_invites `

func scanInvite(r pgx.CollectableRow) (inviteView, error) {
	var v inviteView
	var exp, rev *time.Time
	var created time.Time
	err := r.Scan(&v.ID, &v.Code, &v.TeamID, &exp, &v.MaxUses, &v.Uses, &rev, &v.CreatedBy, &created)
	v.URLPath = "/invite/" + v.Code
	v.ExpiresAt, v.RevokedAt, v.CreatedAt = tp(exp), tp(rev), jsTime(created)
	return v, err
}

// inviteInvalidReason returns "", "revoked", "expired" or "exhausted".
func inviteInvalidReason(exp, rev *time.Time, maxUses *int, uses int, now time.Time) string {
	switch {
	case rev != nil:
		return "revoked"
	case exp != nil && !now.Before(*exp):
		return "expired"
	case maxUses != nil && uses >= *maxUses:
		return "exhausted"
	}
	return ""
}

func inviteGone(reason string) *apierr.Error {
	msg := map[string]string{"revoked": "邀请已作废", "expired": "邀请已过期", "exhausted": "邀请次数已用完"}[reason]
	return apierr.New(http.StatusGone, "invite_"+reason, msg)
}

func inviteNotFound() *apierr.Error {
	return apierr.New(http.StatusNotFound, "invite_not_found", "邀请不存在")
}

func (s *Server) createInvite(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	var body struct {
		ExpiresInSeconds *int `json:"expires_in_seconds"`
		MaxUses          *int `json:"max_uses"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &body); err != nil {
			return err
		}
	}
	var exp *time.Time
	if body.ExpiresInSeconds != nil {
		n := *body.ExpiresInSeconds
		if n < 60 || n > 2592000 {
			return apierr.Validation("expires_in_seconds", "expires_in_seconds 需在 60–2592000 之间")
		}
		t := time.Now().Add(time.Duration(n) * time.Second)
		exp = &t
	}
	if body.MaxUses != nil && (*body.MaxUses < 1 || *body.MaxUses > 1000) {
		return apierr.Validation("max_uses", "max_uses 需在 1–1000 之间")
	}
	ctx := r.Context()
	id := newID()
	for attempt := 0; ; attempt++ {
		_, err = s.pool.Exec(ctx, `INSERT INTO team_invites(id, team_id, code, created_by, expires_at, max_uses) VALUES($1,$2,$3,$4,$5,$6)`,
			id, teamID, NewInviteCode(), a.MemberID, exp, body.MaxUses)
		if err == nil || !apierrIsUnique(err) || attempt >= 4 {
			break
		}
	}
	if err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, inviteSelect+`WHERE id=$1`, id)
	if err != nil {
		return err
	}
	v, err := pgx.CollectExactlyOneRow(rows, scanInvite)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, v)
}

func (s *Server) listInvites(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
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
	sql := inviteSelect + `WHERE team_id=$1`
	args := []any{teamID}
	if c := q.Get("cursor"); c != "" {
		u, err := uuid.Parse(c)
		if err != nil {
			return apierr.Validation("cursor", "cursor 无效")
		}
		args = append(args, u.String())
		sql += ` AND id < $2`
	}
	args = append(args, limit+1)
	rows, err := s.pool.Query(r.Context(), sql+` ORDER BY id DESC LIMIT $`+itoa(len(args)), args...)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, scanInvite)
	if err != nil {
		return err
	}
	hasMore := len(items) > limit
	var next *string
	if hasMore {
		items = items[:limit]
		v := items[len(items)-1].ID
		next = &v
	}
	return writeList(w, items, next, hasMore)
}

func (s *Server) revokeInvite(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	id, err := pathID(r, "invite_id", "邀请")
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(r.Context(), `UPDATE team_invites SET revoked_at = COALESCE(revoked_at, now()) WHERE id=$1 AND team_id=$2`, id, teamID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return inviteNotFound()
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) previewInvite(w http.ResponseWriter, r *http.Request) error {
	if ok, wait := s.limiter.Allow("invite-preview:"+clientIP(r), s.cfg.InvitePreviewRatePerMinute, time.Minute); !ok {
		return apierr.RateLimited(wait)
	}
	code := r.PathValue("code")
	if !inviteCodeRe.MatchString(code) {
		return inviteNotFound()
	}
	ctx := r.Context()
	var teamID, teamName string
	var icon *string
	var exp, rev *time.Time
	var maxUses *int
	var uses int
	err := s.pool.QueryRow(ctx, `SELECT t.id, t.name, t.icon_avatar_id, i.expires_at, i.revoked_at, i.max_uses, i.uses
		FROM team_invites i JOIN teams t ON t.id=i.team_id WHERE i.code=$1 AND t.deleted_at IS NULL`, code).
		Scan(&teamID, &teamName, &icon, &exp, &rev, &maxUses, &uses)
	if errors.Is(err, pgx.ErrNoRows) {
		return inviteNotFound()
	}
	if err != nil {
		return err
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM team_members m LEFT JOIN bots b ON b.id=m.bot_id
		WHERE m.team_id=$1 AND m.left_at IS NULL AND (b.id IS NULL OR b.deleted_at IS NULL)`, teamID).Scan(&count); err != nil {
		return err
	}
	reason := inviteInvalidReason(exp, rev, maxUses, uses, time.Now())
	resp := map[string]any{
		"code":       code,
		"team":       map[string]any{"id": teamID, "name": teamName, "icon_url": avatarURL(icon), "member_count": count},
		"expires_at": tp(exp),
		"valid":      reason == "",
	}
	if reason != "" {
		resp["reason"] = reason
	}
	return writeJSON(w, http.StatusOK, resp)
}

func (s *Server) acceptInvite(w http.ResponseWriter, r *http.Request) error {
	code := r.PathValue("code")
	if !inviteCodeRe.MatchString(code) {
		return inviteNotFound()
	}
	ctx := r.Context()
	uid := principalFrom(ctx).UserID
	var teamID, memberID, role string
	already := false
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var inviteID string
		var exp, rev *time.Time
		var maxUses *int
		var uses int
		err := tx.QueryRow(ctx, `SELECT i.id, i.team_id, i.expires_at, i.revoked_at, i.max_uses, i.uses
			FROM team_invites i JOIN teams t ON t.id=i.team_id WHERE i.code=$1 AND t.deleted_at IS NULL FOR UPDATE OF i`, code).
			Scan(&inviteID, &teamID, &exp, &rev, &maxUses, &uses)
		if errors.Is(err, pgx.ErrNoRows) {
			return inviteNotFound()
		}
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT id, role FROM team_members WHERE team_id=$1 AND user_id=$2 AND left_at IS NULL`, teamID, uid).Scan(&memberID, &role)
		if err == nil {
			already = true
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if reason := inviteInvalidReason(exp, rev, maxUses, uses, time.Now()); reason != "" {
			return inviteGone(reason)
		}
		memberID, role = newID(), "member"
		if _, err := tx.Exec(ctx, `INSERT INTO team_members(id, team_id, type, user_id, role) VALUES($1,$2,'user',$3,'member')`, memberID, teamID, uid); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE team_invites SET uses = uses + 1 WHERE id=$1`, inviteID)
		return err
	})
	if err != nil {
		return err
	}
	m, err := loadMember(ctx, s.pool, memberID)
	if err != nil {
		return err
	}
	t, err := loadTeam(ctx, s.pool, teamID)
	if err != nil {
		return err
	}
	t.MyMemberID, t.MyRole = memberID, role
	if !already {
		s.announceJoin(ctx, teamID, uid, m, t)
	}
	return writeJSON(w, http.StatusOK, map[string]any{"team": t, "member": m, "already_member": already})
}

// announceJoin: others get member.joined; the user's own connections get
// team.joined and are subscribed to the team.
func (s *Server) announceJoin(_ context.Context, teamID, userID string, m *memberView, t *teamView) {
	key := "user:" + userID
	s.hub.PublishTeamExcept(teamID, key, "member.joined", m)
	s.hub.SetTeam(key, teamID, true)
	s.hub.PublishPrincipal(key, teamID, "team.joined", t)
}
