package httpapi

import (
	"bufio"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/creteper/teams/backend/internal/media"
	"github.com/creteper/teams/backend/internal/netguard"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const maxAvatarPixels = 4096

type countingWriter struct {
	n int64
	h hash.Hash
}

func (c *countingWriter) Write(p []byte) (int, error) { c.n += int64(len(p)); return c.h.Write(p) }

func isMultipart(r *http.Request) bool {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return mt == "multipart/form-data"
}

func sanitizeFileName(n string) string {
	n = filepath.Base(strings.ReplaceAll(n, "\\", "/"))
	n = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '"' {
			return -1
		}
		return r
	}, n)
	if n == "." || n == "/" || n == "" {
		n = "file"
	}
	for utf8.RuneCountInString(n) > 200 {
		_, sz := utf8.DecodeLastRuneInString(n)
		n = n[:len(n)-sz]
	}
	return n
}

// uploadAttachment handles POST /teams/{team_id}/attachments (streaming).
func (s *Server) uploadAttachment(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !isMultipart(r) {
		return apierr.Unsupported("需要 multipart/form-data")
	}
	maxAll := max(s.cfg.MaxImageBytes, s.cfg.MaxVideoBytes)
	r.Body = http.MaxBytesReader(w, r.Body, maxAll+(1<<20))
	mr, err := r.MultipartReader()
	if err != nil {
		return apierr.BadRequest("multipart 解析失败")
	}
	ctx := r.Context()
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return apierr.Validation("file", "缺少 file 字段")
		}
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				return apierr.TooLarge("文件过大")
			}
			return apierr.BadRequest("multipart 解析失败")
		}
		if part.FormName() != "file" {
			part.Close()
			continue
		}
		return s.storeAttachment(ctx, w, teamID, a.MemberID, part.FileName(), part)
	}
}

func (s *Server) storeAttachment(ctx context.Context, w http.ResponseWriter, teamID, memberID, fileName string, src io.Reader) error {
	br := bufio.NewReaderSize(src, 4096)
	head, _ := br.Peek(512)
	if len(head) == 0 {
		return apierr.Validation("file", "文件为空")
	}
	mt := media.Sniff(head)
	kind := media.Classify(mt)
	if kind == "" {
		return apierr.Unsupported("不支持的文件类型: "+mt).With("detected", mt)
	}
	limit := s.cfg.MaxImageBytes
	if kind == media.KindVideo {
		limit = s.cfg.MaxVideoBytes
	}
	id := newID()
	now := time.Now().UTC()
	key := fmt.Sprintf("attachments/%s/%04d/%02d/%s", teamID, now.Year(), int(now.Month()), id)
	cw := &countingWriter{h: sha256.New()}
	n, err := s.store.Put(ctx, key, io.TeeReader(io.LimitReader(br, limit+1), cw))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return apierr.TooLarge("文件过大")
		}
		return err
	}
	if n > limit {
		s.store.Delete(ctx, key)
		return apierr.TooLarge(fmt.Sprintf("%s 最大 %d 字节", kind, limit)).With("max_bytes", limit)
	}
	var width, height *int
	if kind == media.KindImage {
		if f, err := s.store.Open(ctx, key); err == nil {
			if wd, ht, ok := media.ImageSize(f); ok {
				width, height = &wd, &ht
			}
			f.Close()
		}
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO attachments(id, team_id, uploader_member_id, kind, mime_type, size_bytes, file_name, storage_key, sha256, width, height)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, id, teamID, memberID, kind, mt, n, sanitizeFileName(fileName), key, cw.h.Sum(nil), width, height)
	if err != nil {
		s.store.Delete(ctx, key)
		return err
	}
	rows, err := s.pool.Query(ctx, attachmentSelect+`WHERE id=$1`, id)
	if err != nil {
		return err
	}
	av, err := pgx.CollectExactlyOneRow(rows, func(r pgx.CollectableRow) (attachmentView, error) {
		a, _, err := scanAttachment(r, s)
		return a, err
	})
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, av)
}

func (s *Server) attachmentContent(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "attachment_id", "附件")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var teamID, mt, name, key string
	err = s.pool.QueryRow(ctx, `SELECT a.team_id, a.mime_type, a.file_name, a.storage_key FROM attachments a
		LEFT JOIN messages m ON m.id=a.message_id WHERE a.id=$1 AND m.deleted_at IS NULL`, id).Scan(&teamID, &mt, &name, &key)
	if err != nil {
		return apierr.NotFound("附件")
	}
	q := r.URL.Query()
	if q.Get("sig") != "" {
		if !s.verifyAttachmentSig(id, q.Get("exp"), q.Get("sig")) {
			return apierr.New(http.StatusUnauthorized, "unauthorized", "签名无效或已过期")
		}
	} else {
		p := principalFrom(ctx)
		if p == nil {
			return apierr.Unauthorized()
		}
		if _, err := s.actorIn(ctx, s.pool, p, teamID); err != nil {
			return apierr.NotFound("附件")
		}
	}
	f, err := s.store.Open(ctx, key)
	if err != nil {
		return apierr.NotFound("附件")
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", mt)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": name}))
	h.Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "", st.ModTime(), f)
	return nil
}

// ---------- avatars ----------

type avatarInfo struct {
	ID     string
	SHA256 []byte
}

// saveAvatar validates image bytes and stores a new avatar record.
func (s *Server) saveAvatar(ctx context.Context, q querier, ownerKind, ownerID string, data []byte, sourceURL *string) (string, error) {
	if int64(len(data)) > s.cfg.MaxAvatarBytes {
		return "", apierr.TooLarge(fmt.Sprintf("头像最大 %d 字节", s.cfg.MaxAvatarBytes)).With("max_bytes", s.cfg.MaxAvatarBytes)
	}
	if len(data) == 0 {
		return "", apierr.Validation("avatar", "图片为空")
	}
	mt := media.Sniff(data[:min(512, len(data))])
	if !media.IsImage(mt) {
		return "", apierr.Unsupported("头像只支持 jpeg/png/gif/webp").With("detected", mt)
	}
	wd, ht, ok := media.ImageSizeBytes(data)
	if !ok {
		return "", apierr.Unsupported("图片无法解析")
	}
	if wd > maxAvatarPixels || ht > maxAvatarPixels {
		return "", apierr.Validation("avatar", "图片尺寸不能超过 4096×4096")
	}
	id := newID()
	key := "avatars/" + id
	if _, err := s.store.Put(ctx, key, strings.NewReader(string(data))); err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	_, err := q.Exec(ctx, `INSERT INTO avatars(id, owner_kind, owner_id, mime_type, size_bytes, width, height, sha256, storage_key, source_url)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, ownerKind, ownerID, mt, len(data), wd, ht, sum[:], key, sourceURL)
	if err != nil {
		s.store.Delete(ctx, key)
		return "", err
	}
	return id, nil
}

// readAvatarPart reads a single image file field from a multipart request.
func (s *Server) readMultipartAvatar(w http.ResponseWriter, r *http.Request, field string) (data []byte, values map[string]string, err error) {
	if !isMultipart(r) {
		return nil, nil, apierr.Unsupported("需要 multipart/form-data")
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxAvatarBytes+(1<<20))
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, nil, apierr.BadRequest("multipart 解析失败")
	}
	values = map[string]string{}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				return nil, nil, apierr.TooLarge(fmt.Sprintf("头像最大 %d 字节", s.cfg.MaxAvatarBytes))
			}
			return nil, nil, apierr.BadRequest("multipart 解析失败")
		}
		if part.FormName() == field && part.FileName() != "" {
			b, err := io.ReadAll(io.LimitReader(part, s.cfg.MaxAvatarBytes+1))
			if err != nil {
				var mbe *http.MaxBytesError
				if errors.As(err, &mbe) {
					return nil, nil, apierr.TooLarge(fmt.Sprintf("头像最大 %d 字节", s.cfg.MaxAvatarBytes))
				}
				return nil, nil, apierr.BadRequest("读取文件失败")
			}
			if int64(len(b)) > s.cfg.MaxAvatarBytes {
				return nil, nil, apierr.TooLarge(fmt.Sprintf("头像最大 %d 字节", s.cfg.MaxAvatarBytes)).With("max_bytes", s.cfg.MaxAvatarBytes)
			}
			data = b
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(part, 4096))
		values[part.FormName()] = string(b)
	}
	return data, values, nil
}

func fetchErr(reason string) *apierr.Error {
	return apierr.New(http.StatusUnprocessableEntity, "avatar_fetch_failed", "头像拉取失败: "+reason).With("reason", reason)
}

// fetchAvatar downloads a remote image with SSRF protection.
func (s *Server) fetchAvatar(ctx context.Context, raw string) ([]byte, error) {
	u, err := netguard.ValidateURL(strings.TrimSpace(raw), false, s.cfg.AllowInsecureLocal)
	if err != nil {
		if netguard.IsBlockedErr(err) {
			return nil, fetchErr("blocked_address")
		}
		return nil, fetchErr("invalid_url")
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.AvatarFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fetchErr("invalid_url")
	}
	req.Header.Set("User-Agent", "TeAms-AvatarFetcher/1.0")
	req.Header.Set("Accept", "image/*")
	resp, err := s.fetch.Do(req)
	if err != nil {
		switch {
		case netguard.IsBlockedErr(err):
			return nil, fetchErr("blocked_address")
		case errors.Is(err, context.DeadlineExceeded) || isTimeoutErr(err):
			return nil, fetchErr("timeout")
		case strings.Contains(err.Error(), "url must use") || strings.Contains(err.Error(), "scheme"):
			return nil, fetchErr("invalid_url")
		}
		return nil, fetchErr("network_error")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fetchErr(fmt.Sprintf("http_%d", resp.StatusCode))
	}
	if resp.ContentLength > s.cfg.MaxAvatarBytes {
		return nil, fetchErr("too_large")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, s.cfg.MaxAvatarBytes+1))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || isTimeoutErr(err) {
			return nil, fetchErr("timeout")
		}
		return nil, fetchErr("network_error")
	}
	if int64(len(b)) > s.cfg.MaxAvatarBytes {
		return nil, fetchErr("too_large")
	}
	if !media.IsImage(media.Sniff(b[:min(512, len(b))])) {
		return nil, fetchErr("unsupported_type")
	}
	return b, nil
}

func isTimeoutErr(err error) bool {
	var te interface{ Timeout() bool }
	return errors.As(err, &te) && te.Timeout()
}

func (s *Server) getAvatar(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "avatar_id", "头像")
	if err != nil {
		return err
	}
	var mt, key string
	if err := s.pool.QueryRow(r.Context(), `SELECT mime_type, storage_key FROM avatars WHERE id=$1`, id).Scan(&mt, &key); err != nil {
		return apierr.NotFound("头像")
	}
	f, err := s.store.Open(r.Context(), key)
	if err != nil {
		return apierr.NotFound("头像")
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", mt)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, "", st.ModTime(), f)
	return nil
}

func (s *Server) putMyAvatar(w http.ResponseWriter, r *http.Request) error {
	data, _, err := s.readMultipartAvatar(w, r, "file")
	if err != nil {
		return err
	}
	if data == nil {
		return apierr.Validation("file", "缺少 file 字段")
	}
	ctx := r.Context()
	uid := principalFrom(ctx).UserID
	id, err := s.saveAvatar(ctx, s.pool, "user", uid, data, nil)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET avatar_id=$2 WHERE id=$1`, uid, id); err != nil {
		return err
	}
	s.publishUserMemberUpdated(ctx, uid)
	return s.getMe(w, r)
}

func (s *Server) deleteMyAvatar(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	uid := principalFrom(ctx).UserID
	tag, err := s.pool.Exec(ctx, `UPDATE users SET avatar_id=NULL WHERE id=$1 AND avatar_id IS NOT NULL`, uid)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.publishUserMemberUpdated(ctx, uid)
	}
	return s.getMe(w, r)
}

func (s *Server) putTeamIcon(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	data, _, err := s.readMultipartAvatar(w, r, "file")
	if err != nil {
		return err
	}
	if data == nil {
		return apierr.Validation("file", "缺少 file 字段")
	}
	ctx := r.Context()
	id, err := s.saveAvatar(ctx, s.pool, "team", teamID, data, nil)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `UPDATE teams SET icon_avatar_id=$2 WHERE id=$1`, teamID, id); err != nil {
		return err
	}
	return s.respondTeamUpdated(w, r, teamID, a)
}

func (s *Server) deleteTeamIcon(w http.ResponseWriter, r *http.Request) error {
	teamID, a, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	if !a.admin() {
		return apierr.Forbidden("需要 owner 或 admin")
	}
	if _, err := s.pool.Exec(r.Context(), `UPDATE teams SET icon_avatar_id=NULL WHERE id=$1`, teamID); err != nil {
		return err
	}
	return s.respondTeamUpdated(w, r, teamID, a)
}

func sha256Sum(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}

// getAttachment returns attachment metadata with a fresh signed URL.
func (s *Server) getAttachment(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "attachment_id", "附件")
	if err != nil {
		return err
	}
	items, err := s.attachmentsFor(r.Context(), principalFrom(r.Context()), []string{id})
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return apierr.NotFound("附件")
	}
	return writeJSON(w, http.StatusOK, items[0])
}

func (s *Server) attachmentURLs(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if len(body.IDs) == 0 || len(body.IDs) > 100 {
		return apierr.Validation("ids", "ids 需 1–100 个")
	}
	var ids []string
	seen := map[string]bool{}
	for _, v := range body.IDs {
		u, err := uuid.Parse(v)
		if err != nil {
			return apierr.Validation("ids", "附件 id 无效")
		}
		if !seen[u.String()] {
			seen[u.String()] = true
			ids = append(ids, u.String())
		}
	}
	items, err := s.attachmentsFor(r.Context(), principalFrom(r.Context()), ids)
	if err != nil {
		return err
	}
	found := map[string]bool{}
	for _, a := range items {
		found[a.ID] = true
	}
	missing := []string{}
	for _, id := range ids {
		if !found[id] {
			missing = append(missing, id)
		}
	}
	return writeJSON(w, http.StatusOK, map[string]any{"items": items, "missing": missing})
}

// attachmentsFor returns attachments the principal can see (team member,
// not attached to a deleted message), in the order of ids.
func (s *Server) attachmentsFor(ctx context.Context, p *principal, ids []string) ([]attachmentView, error) {
	var teamFilter string
	args := []any{ids}
	if p.Bot != nil {
		teamFilter = `a.team_id = $2`
		args = append(args, p.Bot.TeamID)
	} else {
		teamFilter = `a.team_id IN (SELECT m.team_id FROM team_members m JOIN teams t ON t.id=m.team_id
			WHERE m.user_id=$2 AND m.left_at IS NULL AND t.deleted_at IS NULL)`
		args = append(args, p.UserID)
	}
	rows, err := s.pool.Query(ctx, `SELECT a.id, a.message_id, a.kind, a.mime_type, a.size_bytes, a.file_name, a.width, a.height, a.duration_ms
		FROM attachments a LEFT JOIN messages m ON m.id=a.message_id
		WHERE a.id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND `+teamFilter, args...)
	if err != nil {
		return nil, err
	}
	got, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (attachmentView, error) {
		a, _, err := scanAttachment(r, s)
		return a, err
	})
	if err != nil {
		return nil, err
	}
	by := map[string]attachmentView{}
	for _, a := range got {
		by[a.ID] = a
	}
	out := []attachmentView{}
	for _, id := range ids {
		if a, ok := by[id]; ok {
			out = append(out, a)
		}
	}
	return out, nil
}
