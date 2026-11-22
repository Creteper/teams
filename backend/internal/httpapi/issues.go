package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type issueOption struct {
	Kind  string `json:"kind"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (s *Server) listIssueOptions(w http.ResponseWriter, r *http.Request) error {
	tid, _, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	rows, err := s.pool.Query(r.Context(), "SELECT kind,name,color FROM issue_options WHERE team_id=$1 ORDER BY position", tid)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[issueOption])
	if err != nil {
		return err
	}
	return writeList(w, items, nil, false)
}

var issueColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (s *Server) createIssueOption(w http.ResponseWriter, r *http.Request) error {
	tid, _, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	var option issueOption
	if err := decodeJSON(r, &option); err != nil {
		return err
	}
	option.Name, err = cleanText("name", option.Name, 1, 48)
	if err != nil {
		return err
	}
	if option.Kind != "status" && option.Kind != "label" {
		return apierr.Validation("kind", "请选择状态或标签")
	}
	if !issueColor.MatchString(option.Color) {
		return apierr.Validation("color", "颜色格式无效")
	}
	_, err = s.pool.Exec(r.Context(), "INSERT INTO issue_options(team_id,kind,name,color) VALUES($1,$2,$3,$4)", tid, option.Kind, option.Name, option.Color)
	if apierrIsUnique(err) {
		return apierr.Conflict("同名选项已存在")
	}
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, option)
}

// Load the member display names, team-specific options and attachment metadata in one snapshot.
const issueSelect = `SELECT to_jsonb(v) FROM (
	SELECT i.id,i.team_id,t.name AS team_name,i.title,i.description,i.creator_id,i.assignee_id,
	COALESCE(cu.display_name,cb.display_name) AS creator_name,'/api/v1/avatars/' || COALESCE(cu.avatar_id,cb.avatar_id)::text AS creator_avatar_url,COALESCE(au.display_name,ab.display_name) AS assignee_name,
	i.priority,i.created_at,i.archived_at,i.start_date,i.end_date,
	jsonb_build_object('kind',st.kind,'name',st.name,'color',st.color) AS status,
	COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',o.kind,'name',o.name,'color',o.color) ORDER BY o.position)
		FROM issue_options o WHERE o.team_id=i.team_id AND o.kind='label' AND o.name=ANY(i.labels)), '[]') AS labels,
	COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'file_name',a.file_name) ORDER BY a.created_at,a.id)
		FROM attachments a WHERE a.issue_id=i.id AND a.comment_id IS NULL), '[]') AS attachments
	FROM issues i JOIN teams t ON t.id=i.team_id AND t.deleted_at IS NULL
	JOIN issue_options st ON st.team_id=i.team_id AND st.kind='status' AND st.name=i.status
	JOIN team_members c ON c.id=i.creator_id LEFT JOIN users cu ON cu.id=c.user_id LEFT JOIN bots cb ON cb.id=c.bot_id
	LEFT JOIN team_members a ON a.id=i.assignee_id LEFT JOIN users au ON au.id=a.user_id LEFT JOIN bots ab ON ab.id=a.bot_id
	`

func readIssues(ctx context.Context, q querier, filter string, args ...any) ([]json.RawMessage, error) {
	rows, err := q.Query(ctx, issueSelect+filter+`) v ORDER BY v.created_at DESC,v.id DESC`, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
}

func (s *Server) listTeamIssues(w http.ResponseWriter, r *http.Request) error {
	tid, _, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	items, err := readIssues(r.Context(), s.pool, "WHERE i.team_id=$1 AND (i.archived_at IS NOT NULL)=$2", tid, r.URL.Query().Get("archived") == "true")
	if err != nil {
		return err
	}
	return writeList(w, items, nil, false)
}

func (s *Server) listMyIssues(w http.ResponseWriter, r *http.Request) error {
	items, err := readIssues(r.Context(), s.pool, `WHERE a.team_id=i.team_id AND a.user_id=$1 AND a.left_at IS NULL AND (i.archived_at IS NOT NULL)=$2`, principalFrom(r.Context()).UserID, r.URL.Query().Get("archived") == "true")
	if err != nil {
		return err
	}
	return writeList(w, items, nil, false)
}

type issueInput struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Status      string   `json:"status"`
	Priority    string   `json:"priority"`
	Assignee    *string  `json:"assignee_id"`
	Labels      []string `json:"labels"`
	Start       *string  `json:"start_date"`
	End         *string  `json:"end_date"`
	Attachments []string `json:"attachment_ids"`
}

func (in *issueInput) validate() error {
	var err error
	in.Title, err = cleanText("title", in.Title, 1, 240)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(in.ID); err != nil {
		return apierr.Validation("id", "Issue ID 无效")
	}
	if utf8.RuneCountInString(in.Description) > 32000 || strings.ContainsRune(in.Description, 0) {
		return apierr.Validation("description", "描述无效或过长")
	}
	if !validIssuePriority(in.Priority) {
		return apierr.Validation("priority", "优先级无效")
	}
	if in.Assignee != nil {
		if _, err := uuid.Parse(*in.Assignee); err != nil {
			return apierr.Validation("assignee_id", "成员 ID 无效")
		}
	}
	if err := validateIssueDates(in.Start, in.End); err != nil {
		return err
	}
	for _, id := range in.Attachments {
		if _, err := uuid.Parse(id); err != nil {
			return apierr.Validation("attachment_ids", "附件 ID 无效")
		}
	}
	return nil
}

func (s *Server) createIssue(w http.ResponseWriter, r *http.Request) error {
	tid, actor, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	var in issueInput
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := in.validate(); err != nil {
		return err
	}
	ctx := r.Context()
	var result json.RawMessage
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `INSERT INTO issues(id,team_id,title,description,status,priority,creator_id,assignee_id,labels,start_date,end_date)
			SELECT $1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::text[],'{}'),$10::text::date,$11::text::date
			WHERE EXISTS(SELECT 1 FROM issue_options WHERE team_id=$2 AND kind='status' AND name=$5)
			AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM team_members WHERE id=$8 AND team_id=$2 AND left_at IS NULL))
			AND NOT EXISTS(SELECT unnest($9::text[]) EXCEPT SELECT name FROM issue_options WHERE team_id=$2 AND kind='label')
			ON CONFLICT (id) DO NOTHING`, in.ID, tid, in.Title, in.Description, in.Status, in.Priority, actor.MemberID, in.Assignee, in.Labels, in.Start, in.End)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 && len(in.Attachments) > 0 {
			tag, err = tx.Exec(ctx, `UPDATE attachments SET issue_id=$1 WHERE id=ANY($2::uuid[]) AND team_id=$3
				AND uploader_member_id=$4 AND issue_id IS NULL AND message_id IS NULL`, in.ID, in.Attachments, tid, actor.MemberID)
			if err != nil {
				return err
			}
			if int(tag.RowsAffected()) != len(in.Attachments) {
				return apierr.Validation("attachment_ids", "附件不可用或已被引用")
			}
		}
		items, err := readIssues(ctx, tx, "WHERE i.id=$1 AND i.team_id=$2 AND i.creator_id=$3", in.ID, tid, actor.MemberID)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			return apierr.Validation("issue", "请检查团队、状态、标签和分配人")
		}
		result = items[0]
		return nil
	})
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, result)
}

func validateIssueDates(start, end *string) error {
	for _, date := range []*string{start, end} {
		if date != nil {
			if _, err := time.Parse(time.DateOnly, *date); err != nil || (*date)[:4] == "0000" {
				return apierr.Validation("date", "日期格式无效")
			}
		}
	}
	if start != nil && end != nil && *end < *start {
		return apierr.Validation("end_date", "截止日期早于开始日期")
	}
	return nil
}

func (s *Server) updateIssueProperty(w http.ResponseWriter, r *http.Request) error {
	tid, id, _, err := s.issueContext(r)
	if err != nil {
		return err
	}
	var in struct {
		Field string  `json:"field"`
		Value *string `json:"value"`
		Start *string `json:"start_date"`
		End   *string `json:"end_date"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	args := []any{id, tid, in.Value}
	var update string
	switch in.Field {
	case "title":
		if in.Value == nil {
			return apierr.Validation("title", "请填写标题")
		}
		title, err := cleanText("title", *in.Value, 1, 240)
		if err != nil {
			return err
		}
		args[2] = title
		update = "SET title=$3 WHERE id=$1 AND team_id=$2"
	case "status":
		update = "SET status=$3 WHERE id=$1 AND team_id=$2 AND EXISTS (SELECT 1 FROM issue_options WHERE team_id=$2 AND kind='status' AND name=$3)"
	case "priority":
		if in.Value == nil || !validIssuePriority(*in.Value) {
			return apierr.Validation("priority", "优先级无效")
		}
		update = "SET priority=$3 WHERE id=$1 AND team_id=$2"
	case "assignee":
		if in.Value != nil {
			if _, err := uuid.Parse(*in.Value); err != nil {
				return apierr.Validation("assignee_id", "成员 ID 无效")
			}
		}
		update = "SET assignee_id=$3 WHERE id=$1 AND team_id=$2 AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM team_members WHERE id=$3 AND team_id=$2 AND left_at IS NULL))"
	case "add_label", "remove_label":
		set := "array_remove(labels,$3)"
		if in.Field == "add_label" {
			set = "CASE WHEN $3=ANY(labels) THEN labels ELSE array_append(labels,$3) END"
		}
		update = "SET labels=" + set + " WHERE id=$1 AND team_id=$2 AND EXISTS (SELECT 1 FROM issue_options WHERE team_id=$2 AND kind='label' AND name=$3)"
	case "schedule":
		if err := validateIssueDates(in.Start, in.End); err != nil {
			return err
		}
		args = []any{id, tid, in.Start, in.End}
		update = "SET start_date=$3::text::date,end_date=$4::text::date WHERE id=$1 AND team_id=$2"
	default:
		return apierr.Validation("field", "无效的 Issue 属性")
	}
	ctx := r.Context()
	var result json.RawMessage
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockActiveIssue(ctx, tx, tid, id); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, "UPDATE issues "+update, args...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apierr.Validation("value", "所选属性不属于当前团队或已不可用")
		}
		result, err = readIssue(ctx, tx, tid, id)
		return err
	})
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func validIssuePriority(priority string) bool {
	return slices.Contains([]string{"none", "urgent", "high", "medium", "low"}, priority)
}

func readIssue(ctx context.Context, q querier, tid, id string) (json.RawMessage, error) {
	items, err := readIssues(ctx, q, "WHERE i.id=$1 AND i.team_id=$2", id, tid)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, apierr.NotFound("Issue")
	}
	return items[0], nil
}

func (s *Server) getIssue(w http.ResponseWriter, r *http.Request) error {
	tid, _, err := s.teamIDParam(r)
	if err != nil {
		return err
	}
	id, err := pathID(r, "issue_id", "Issue")
	if err != nil {
		return err
	}
	item, err := readIssue(r.Context(), s.pool, tid, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, item)
}

// Serialize edits and comments with archiving, including attachment claims in the same transaction.
func lockActiveIssue(ctx context.Context, tx pgx.Tx, tid, id string) error {
	var archived bool
	err := tx.QueryRow(ctx, "SELECT archived_at IS NOT NULL FROM issues WHERE team_id=$1 AND id=$2 FOR UPDATE", tid, id).Scan(&archived)
	if err == pgx.ErrNoRows {
		return apierr.NotFound("Issue")
	}
	if err != nil {
		return err
	}
	if archived {
		return apierr.Conflict("Issue 已归档，只能查看和下载附件")
	}
	return nil
}

func (s *Server) archiveIssue(w http.ResponseWriter, r *http.Request) error {
	tid, id, _, err := s.issueContext(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var result json.RawMessage
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "UPDATE issues SET archived_at=now() WHERE team_id=$1 AND id=$2 AND archived_at IS NULL", tid, id)
		if err != nil {
			return err
		}
		result, err = readIssue(ctx, tx, tid, id)
		return err
	})
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}
