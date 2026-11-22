package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) issueContext(r *http.Request) (teamID, issueID string, member *actor, err error) {
	teamID, member, err = s.teamIDParam(r)
	if err != nil {
		return
	}
	issueID, err = pathID(r, "issue_id", "Issue")
	if err != nil {
		return
	}
	var exists bool
	err = s.pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM issues WHERE team_id=$1 AND id=$2)", teamID, issueID).Scan(&exists)
	if err == nil && !exists {
		err = apierr.NotFound("Issue")
	}
	return
}

func (s *Server) updateIssueDescription(w http.ResponseWriter, r *http.Request) error {
	tid, id, _, err := s.issueContext(r)
	if err != nil {
		return err
	}
	var in struct {
		Description *string `json:"description"`
		Previous    *string `json:"previous"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.Description == nil || in.Previous == nil || utf8.RuneCountInString(*in.Description) > 32000 || strings.ContainsRune(*in.Description, 0) {
		return apierr.Validation("description", "描述无效或超过 32000 字")
	}
	ctx := r.Context()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockActiveIssue(ctx, tx, tid, id); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, "UPDATE issues SET description=$2 WHERE id=$1 AND (description=$3 OR description=$2)", id, *in.Description, *in.Previous)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apierr.Conflict("描述已被其他成员更新，请刷新后重新编辑")
		}
		return nil
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

const commentSelect = `SELECT to_jsonb(v) FROM (
	SELECT c.id,c.root_id,c.reply_to_id,c.body,c.created_at,u.display_name AS author_name, '/api/v1/avatars/' || u.avatar_id::text AS author_avatar_url,
	COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'file_name',a.file_name) ORDER BY a.created_at,a.id)
	FROM attachments a WHERE a.comment_id=c.id),'[]') AS attachments
	FROM issue_comments c JOIN team_members m ON m.id=c.author_id JOIN users u ON u.id=m.user_id
	WHERE c.issue_id=$1`

func readComments(ctx context.Context, q querier, id string, commentID *string) ([]json.RawMessage, error) {
	args := []any{id}
	sql := commentSelect
	if commentID != nil {
		sql += " AND c.id=$2"
		args = append(args, *commentID)
	}
	rows, err := q.Query(ctx, sql+") v ORDER BY v.created_at,v.id", args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
}

func (s *Server) listIssueComments(w http.ResponseWriter, r *http.Request) error {
	_, id, _, err := s.issueContext(r)
	if err != nil {
		return err
	}
	items, err := readComments(r.Context(), s.pool, id, nil)
	if err != nil {
		return err
	}
	return writeList(w, items, nil, false)
}

func (s *Server) createIssueComment(w http.ResponseWriter, r *http.Request) error {
	tid, id, me, err := s.issueContext(r)
	if err != nil {
		return err
	}
	var in struct {
		ID          string   `json:"id"`
		Body        string   `json:"body"`
		ReplyTo     *string  `json:"reply_to_id"`
		Attachments []string `json:"attachment_ids"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	in.Body = strings.TrimSpace(in.Body)
	if (in.Body == "" && len(in.Attachments) == 0) || utf8.RuneCountInString(in.Body) > 32000 || strings.ContainsRune(in.Body, 0) {
		return apierr.Validation("body", "请填写评论或添加附件，正文最多 32000 字")
	}
	if uuid.Validate(in.ID) != nil || (in.ReplyTo != nil && uuid.Validate(*in.ReplyTo) != nil) {
		return apierr.Validation("id", "评论 ID 无效")
	}
	for _, aid := range in.Attachments {
		if uuid.Validate(aid) != nil {
			return apierr.Validation("attachment_ids", "附件 ID 无效")
		}
	}
	ctx := r.Context()
	var result json.RawMessage
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockActiveIssue(ctx, tx, tid, id); err != nil {
			return err
		}
		var root *string
		if in.ReplyTo != nil {
			err := tx.QueryRow(ctx, "SELECT COALESCE(root_id,id) FROM issue_comments WHERE issue_id=$1 AND id=$2", id, *in.ReplyTo).Scan(&root)
			if errors.Is(err, pgx.ErrNoRows) {
				return apierr.Validation("reply_to_id", "找不到此 Issue 中的回复对象")
			}
			if err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx, `INSERT INTO issue_comments(id,issue_id,author_id,body,root_id,reply_to_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, in.ID, id, me.MemberID, in.Body, root, in.ReplyTo)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			var matches bool
			err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM issue_comments WHERE id=$1 AND issue_id=$2 AND author_id=$3)", in.ID, id, me.MemberID).Scan(&matches)
			if err != nil {
				return err
			}
			if !matches {
				return apierr.Conflict("评论 ID 已被使用")
			}
		} else if len(in.Attachments) > 0 {
			tag, err = tx.Exec(ctx, `UPDATE attachments SET issue_id=$1,comment_id=$2 WHERE id=ANY($3::uuid[]) AND team_id=$4 AND uploader_member_id=$5 AND issue_id IS NULL AND message_id IS NULL`, id, in.ID, in.Attachments, tid, me.MemberID)
			if err != nil {
				return err
			}
			if int(tag.RowsAffected()) != len(in.Attachments) {
				return apierr.Validation("attachment_ids", "附件不可用或已被引用")
			}
		}
		items, err := readComments(ctx, tx, id, &in.ID)
		if err != nil {
			return err
		}
		result = items[0]
		return nil
	})
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, result)
}
