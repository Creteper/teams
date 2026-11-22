package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type qaAnswer struct {
	Choice string `json:"choice"`
	Text   string `json:"text,omitempty"`
}
type qaQuestion struct {
	Prompt  string    `json:"prompt"`
	Options []string  `json:"options"`
	Answer  *qaAnswer `json:"answer,omitempty"`
}
type qaCard struct {
	Recipient string       `json:"recipient_member_id"`
	Questions []qaQuestion `json:"questions"`
	Revision  int          `json:"revision"`
}

func (card *qaCard) validateNew() error {
	id, err := uuid.Parse(card.Recipient)
	if err != nil {
		return apierr.Validation("recipient_member_id", "请选择回答人")
	}
	card.Recipient = id.String()
	if card.Revision != 0 || len(card.Questions) == 0 || len(card.Questions) > 64 {
		return apierr.Validation("questions", "每张卡片支持 1 至 64 道新问题")
	}
	for i := range card.Questions {
		q := &card.Questions[i]
		q.Prompt, err = cleanText("prompt", q.Prompt, 1, 500)
		if err != nil {
			return err
		}
		if q.Answer != nil || len(q.Options) > 4 {
			return apierr.Validation("options", "每题最多四个自定义选项，答案由绑定人填写")
		}
		if q.Options == nil {
			q.Options = []string{}
		}
		for j, opt := range q.Options {
			q.Options[j], err = cleanText("options", opt, 1, 160)
			if err != nil {
				return err
			}
			if q.Options[j] == "其他" {
				return apierr.Validation("options", "其他选项已自动添加")
			}
		}
	}
	return nil
}

func (s *Server) answerQA(w http.ResponseWriter, r *http.Request) error {
	m, a, _, err := s.messageParam(r)
	if err != nil {
		return err
	}
	var in struct {
		Question *int `json:"question"`
		qaAnswer
	}
	if err = decodeJSON(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var completed []string
	var changed bool
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var card *qaCard
		err := tx.QueryRow(ctx, `SELECT qa_card FROM messages WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, m.ID).Scan(&card)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.NotFound("QA 卡片")
		}
		if err != nil {
			return err
		}
		if card == nil {
			return apierr.NotFound("QA 卡片")
		}
		if card.Recipient != a.MemberID {
			return apierr.Forbidden("只有绑定人可以回答")
		}
		if in.Question == nil || *in.Question < 0 || *in.Question >= len(card.Questions) {
			return apierr.Validation("question", "题号无效")
		}
		i := *in.Question
		q := &card.Questions[i]
		switch in.Choice {
		case "other":
			in.Text, err = cleanText("text", in.Text, 1, 2000)
			if err != nil {
				return err
			}
		case "skip":
			if principalFrom(ctx).Bot != nil {
				return apierr.Forbidden("Agent 必须逐题回答")
			}
		default:
			if len(in.Choice) != 1 || !strings.Contains("ABCD"[:len(q.Options)], in.Choice) {
				return apierr.Validation("choice", "选项无效")
			}
		}
		if in.Choice != "other" && in.Text != "" {
			return apierr.Validation("text", "自填内容应选择其他")
		}
		if q.Answer != nil {
			if *q.Answer == in.qaAnswer {
				return nil
			}
			if q.Answer.Choice != "skip" {
				return apierr.Conflict("该题已回答")
			}
		}
		if principalFrom(ctx).Bot != nil {
			for _, prev := range card.Questions[:i] {
				if prev.Answer == nil {
					return apierr.Conflict("Agent 需要先回答前一题")
				}
			}
		}
		q.Answer = &in.qaAnswer
		card.Revision++
		if _, err = tx.Exec(ctx, "UPDATE messages SET qa_card=$2 WHERE id=$1", m.ID, card); err != nil {
			return err
		}
		changed = true
		done := true
		for _, item := range card.Questions {
			if item.Answer == nil {
				done = false
				break
			}
		}
		if done && principalFrom(ctx).Bot != nil {
			completed, err = completeRuns(ctx, tx, a.MemberID, m.ID, m.ID)
			if err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO webhook_deliveries(id,bot_id,event,status,event_data)
			SELECT $1,b.id,'qa.answered','pending',jsonb_build_object('message_id',$2::uuid,'channel_id',$3::uuid,'question',$4::int,'revision',$5::int,'complete',$6::boolean)
			FROM bots b JOIN bot_webhooks w ON w.bot_id=b.id AND w.enabled
			WHERE b.member_id=$7 AND b.deleted_at IS NULL`, newID(), m.ID, m.ChannelID, i, card.Revision, done, m.Sender.MemberID)
		return err
	})
	if err != nil {
		return err
	}
	m, err = s.loadMessage(ctx, s.pool, m.ID)
	if err != nil {
		return err
	}
	if changed {
		s.hub.PublishTeam(m.TeamID, "message.updated", m)
		for _, id := range completed {
			s.hub.PublishTeam(m.TeamID, "bot.run.completed", runData(m.TeamID, m.ChannelID, a.MemberID, m.ID, id, map[string]any{"reply_message_id": m.ID}))
		}
		s.worker.Wake()
	}
	return writeJSON(w, http.StatusOK, m)
}
