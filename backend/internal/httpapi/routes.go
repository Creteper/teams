package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/creteper/teams/backend/internal/apierr"
)

func (s *Server) routes() {
	s.mux = http.NewServeMux()
	const v = "/api/v1"
	h := s.handle

	h("GET "+v+"/healthz", public, s.healthz)
	h("POST "+v+"/auth/register", public, s.register)
	h("POST "+v+"/auth/login", public, s.login)
	h("POST "+v+"/auth/logout", userOnly, s.logout)
	h("GET "+v+"/me", userOnly, s.getMe)
	h("PATCH "+v+"/me", userOnly, s.patchMe)
	h("PUT "+v+"/me/avatar", userOnly, s.putMyAvatar)
	h("DELETE "+v+"/me/avatar", userOnly, s.deleteMyAvatar)

	h("POST "+v+"/teams", userOnly, s.createTeam)
	h("GET "+v+"/teams", userOnly, s.listTeams)
	h("GET "+v+"/teams/{team_id}", anyAuth, s.getTeam)
	h("PATCH "+v+"/teams/{team_id}", userOnly, s.patchTeam)
	h("DELETE "+v+"/teams/{team_id}", userOnly, s.deleteTeam)
	h("PUT "+v+"/teams/{team_id}/icon", userOnly, s.putTeamIcon)
	h("DELETE "+v+"/teams/{team_id}/icon", userOnly, s.deleteTeamIcon)

	h("GET "+v+"/teams/{team_id}/members", anyAuth, s.listMembers)
	h("POST "+v+"/teams/{team_id}/members", userOnly, s.addMember)
	h("GET "+v+"/teams/{team_id}/members/{member_id}", anyAuth, s.getMember)
	h("PATCH "+v+"/teams/{team_id}/members/{member_id}", userOnly, s.patchMember)
	h("DELETE "+v+"/teams/{team_id}/members/me", userOnly, s.leaveTeam)
	h("DELETE "+v+"/teams/{team_id}/members/{member_id}", userOnly, s.removeMember)

	h("POST "+v+"/teams/{team_id}/invites", userOnly, s.createInvite)
	h("GET "+v+"/teams/{team_id}/invites", userOnly, s.listInvites)
	h("DELETE "+v+"/teams/{team_id}/invites/{invite_id}", userOnly, s.revokeInvite)
	h("GET "+v+"/invites/{code}", public, s.previewInvite)
	h("POST "+v+"/invites/{code}/accept", userOnly, s.acceptInvite)

	h("GET "+v+"/teams/{team_id}/channels", anyAuth, s.listChannels)
	h("POST "+v+"/teams/{team_id}/channels", userOnly, s.createChannel)
	h("GET "+v+"/channels/{channel_id}", anyAuth, s.getChannel)
	h("PATCH "+v+"/channels/{channel_id}", userOnly, s.patchChannel)
	h("DELETE "+v+"/channels/{channel_id}", userOnly, s.deleteChannel)
	h("POST "+v+"/channels/{channel_id}/read", userOnly, s.markRead)
	h("PUT "+v+"/channels/{channel_id}/pin", userOnly, s.setPin(true))
	h("DELETE "+v+"/channels/{channel_id}/pin", userOnly, s.setPin(false))
	h("GET "+v+"/me/unread", userOnly, s.getMyUnread)

	h("GET "+v+"/channels/{channel_id}/messages", anyAuth, s.listMessages)
	h("POST "+v+"/channels/{channel_id}/messages", anyAuth, s.sendMessage)
	h("GET "+v+"/channels/{channel_id}/bot-runs", anyAuth, s.listBotRuns)
	h("GET "+v+"/messages/{message_id}", anyAuth, s.getMessage)
	h("PATCH "+v+"/messages/{message_id}", anyAuth, s.editMessage)
	h("DELETE "+v+"/messages/{message_id}", anyAuth, s.deleteMessage)
	h("POST "+v+"/messages/{message_id}/decline", botOnly, s.declineMessage)

	h("POST "+v+"/teams/{team_id}/attachments", anyAuth, s.uploadAttachment)
	h("GET "+v+"/attachments/{attachment_id}", anyAuth, s.getAttachment)
	h("POST "+v+"/attachments/urls", anyAuth, s.attachmentURLs)
	h("GET "+v+"/attachments/{attachment_id}/content", public, s.attachmentContent)
	h("GET "+v+"/avatars/{avatar_id}", public, s.getAvatar)

	h("POST "+v+"/teams/{team_id}/bots", userOnly, s.createBot)
	h("GET "+v+"/teams/{team_id}/bots", anyAuth, s.listBots)
	h("GET "+v+"/bots/me", botOnly, s.getBotMe)
	h("GET "+v+"/bot/me", botOnly, s.getBotMe)
	h("PATCH "+v+"/bots/me", botOnly, s.patchBotMe)
	h("PUT "+v+"/bots/me/avatar", botOnly, s.putBotMeAvatar)
	h("DELETE "+v+"/bots/me/avatar", botOnly, s.deleteBotMeAvatar)
	h("GET "+v+"/bots/{bot_id}", anyAuth, s.getBot)
	h("PATCH "+v+"/bots/{bot_id}", userOnly, s.patchBot)
	h("DELETE "+v+"/bots/{bot_id}", userOnly, s.deleteBot)
	h("PUT "+v+"/bots/{bot_id}/avatar", userOnly, s.putBotAvatar)
	h("DELETE "+v+"/bots/{bot_id}/avatar", userOnly, s.deleteBotAvatar)
	h("POST "+v+"/bots/{bot_id}/token/rotate", userOnly, s.rotateBotToken)
	h("PUT "+v+"/bots/{bot_id}/webhook", userOnly, s.putWebhook)
	h("DELETE "+v+"/bots/{bot_id}/webhook", userOnly, s.deleteWebhook)
	h("POST "+v+"/bots/{bot_id}/webhook/signing-secret/rotate", userOnly, s.rotateSigningSecret)
	h("POST "+v+"/bots/{bot_id}/webhook/test", userOnly, s.testWebhook)
	h("GET "+v+"/bots/{bot_id}/webhook/deliveries", userOnly, s.listDeliveries)

	h("GET "+v+"/push/vapid-public-key", userOnly, s.getVAPIDPublicKey)
	h("POST "+v+"/push/subscriptions", userOnly, s.putPushSubscription)
	h("DELETE "+v+"/push/subscriptions", userOnly, s.deletePushSubscription)

	h("GET "+v+"/ws", public, s.serveWS)

	h("GET "+v+"/skill", public, s.getSkill)
	h("GET "+v+"/skill/SKILL.md", public, s.getSkillMD)
	h("GET "+v+"/downloads/{file}", public, s.download)

	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, r, apierr.New(http.StatusNotFound, "not_found", "接口不存在"))
	})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.pool.Ping(ctx); err != nil {
		return writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "db_unavailable"})
	}
	return writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// cleanupLoop removes unreferenced attachments (>24h), orphaned avatars
// (>1h), old delivery logs (>7d) and expired sessions once per hour.
func (s *Server) cleanupLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		s.Cleanup(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Server) Cleanup(ctx context.Context) {
	del := func(sql string) {
		rows, err := s.pool.Query(ctx, sql)
		if err != nil {
			slog.Error("cleanup", "err", err)
			return
		}
		var keys []string
		for rows.Next() {
			var k string
			if rows.Scan(&k) == nil {
				keys = append(keys, k)
			}
		}
		rows.Close()
		for _, k := range keys {
			s.store.Delete(ctx, k)
		}
	}
	del(`DELETE FROM attachments WHERE message_id IS NULL AND created_at < now() - interval '24 hours' RETURNING storage_key`)
	del(`DELETE FROM avatars a WHERE created_at < now() - interval '1 hour'
		AND NOT EXISTS (SELECT 1 FROM users WHERE avatar_id=a.id)
		AND NOT EXISTS (SELECT 1 FROM teams WHERE icon_avatar_id=a.id)
		AND NOT EXISTS (SELECT 1 FROM bots WHERE avatar_id=a.id) RETURNING storage_key`)
	if _, err := s.pool.Exec(ctx, `DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < now() - interval '7 days'`); err != nil {
		slog.Error("cleanup deliveries", "err", err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`); err != nil {
		slog.Error("cleanup sessions", "err", err)
	}
}
