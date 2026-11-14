// Package httpapi implements the TeAms REST + WebSocket API.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/creteper/teams/backend/internal/auth"
	"github.com/creteper/teams/backend/internal/config"
	"github.com/creteper/teams/backend/internal/netguard"
	"github.com/creteper/teams/backend/internal/ratelimit"
	"github.com/creteper/teams/backend/internal/realtime"
	"github.com/creteper/teams/backend/internal/secretbox"
	"github.com/creteper/teams/backend/internal/storage"
	"github.com/creteper/teams/backend/internal/webhook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	cfg        *config.Config
	pool       *pgxpool.Pool
	box        *secretbox.Box
	hub        *realtime.Hub
	store      storage.Storage
	limiter    *ratelimit.Limiter
	worker     *webhook.Worker
	hookClient *http.Client
	fetch      *http.Client
	argon      auth.Argon2Params
	mux        *http.ServeMux
}

func New(cfg *config.Config, pool *pgxpool.Pool, store storage.Storage) (*Server, error) {
	box, err := secretbox.New(cfg.SecretKey)
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg: cfg, pool: pool, box: box, hub: realtime.NewHub(), store: store, limiter: ratelimit.New(),
		argon: auth.Argon2Params{Time: cfg.Argon2Time, MemKiB: cfg.Argon2MemKiB, Threads: cfg.Argon2Threads},
	}
	s.hookClient = netguard.NewClient(netguard.Options{Timeout: cfg.WebhookTimeout, AllowPrivate: cfg.AllowInsecureLocal, RequireHTTPS: true, MaxRedirects: 0})
	s.fetch = netguard.NewClient(netguard.Options{Timeout: cfg.AvatarFetchTimeout, AllowPrivate: cfg.AllowInsecureLocal, RequireHTTPS: false, MaxRedirects: 3})
	s.worker = &webhook.Worker{
		Pool: pool, Box: box, Client: s.hookClient, Build: s.buildDeliveryPayload,
		Delays: cfg.WebhookRetryDelays, Poll: cfg.WebhookPollInterval, Workers: cfg.WebhookWorkers,
		Lease: cfg.WebhookTimeout + 30*time.Second,
	}
	s.worker.Notify = s.notifyRun
	s.routes()
	return s, nil
}

func (s *Server) Hub() *realtime.Hub      { return s.hub }
func (s *Server) Worker() *webhook.Worker { return s.worker }
func (s *Server) Handler() http.Handler   { return s.middleware(s.mux) }

// RunBackground starts the webhook worker and the cleanup loop.
func (s *Server) RunBackground(ctx context.Context) {
	go s.worker.Run(ctx)
	go s.cleanupLoop(ctx)
}

// ---------- principal / auth ----------

type botPrincipal struct{ ID, MemberID, TeamID string }

type principal struct {
	UserID    string
	SessionID string
	Bot       *botPrincipal
}

func (p *principal) key() string {
	if p.Bot != nil {
		return "bot:" + p.Bot.ID
	}
	return "user:" + p.UserID
}

type ctxKey int

const principalKey ctxKey = 1

func principalFrom(ctx context.Context) *principal {
	p, _ := ctx.Value(principalKey).(*principal)
	return p
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// authenticate resolves a session or bot token.
func (s *Server) authenticate(ctx context.Context, tok string) (*principal, error) {
	switch {
	case strings.HasPrefix(tok, auth.SessionPrefix):
		var p principal
		var expires, lastUsed time.Time
		err := s.pool.QueryRow(ctx, `SELECT id, user_id, expires_at, last_used_at FROM sessions WHERE token_hash=$1`,
			auth.HashToken(tok)).Scan(&p.SessionID, &p.UserID, &expires, &lastUsed)
		if err != nil || time.Now().After(expires) {
			return nil, apierr.Unauthorized()
		}
		if time.Since(lastUsed) > time.Minute {
			s.pool.Exec(ctx, `UPDATE sessions SET last_used_at=now(), expires_at=now()+make_interval(secs => $2) WHERE id=$1`,
				p.SessionID, s.cfg.SessionTTL.Seconds())
		}
		return &p, nil
	case strings.HasPrefix(tok, auth.BotPrefix):
		var b botPrincipal
		err := s.pool.QueryRow(ctx, `SELECT b.id, b.member_id, b.team_id FROM bots b JOIN teams t ON t.id=b.team_id
			WHERE b.token_hash=$1 AND b.deleted_at IS NULL AND t.deleted_at IS NULL`, auth.HashToken(tok)).Scan(&b.ID, &b.MemberID, &b.TeamID)
		if err != nil {
			return nil, apierr.Unauthorized()
		}
		return &principal{Bot: &b}, nil
	}
	return nil, apierr.Unauthorized()
}

type access int

const (
	public access = iota
	userOnly
	botOnly
	anyAuth
)

type handlerFunc func(w http.ResponseWriter, r *http.Request) error

func (s *Server) handle(pattern string, acc access, h handlerFunc) {
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if acc != public {
			tok := bearer(r)
			if tok == "" {
				writeErr(w, r, apierr.Unauthorized())
				return
			}
			p, err := s.authenticate(r.Context(), tok)
			if err != nil {
				writeErr(w, r, err)
				return
			}
			if acc == userOnly && p.Bot != nil {
				writeErr(w, r, apierr.Forbidden("bot 令牌不能调用此接口"))
				return
			}
			if acc == botOnly && p.Bot == nil {
				writeErr(w, r, apierr.Forbidden("此接口只能用 bot 令牌调用"))
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), principalKey, p))
		} else if tok := bearer(r); tok != "" {
			if p, err := s.authenticate(r.Context(), tok); err == nil {
				r = r.WithContext(context.WithValue(r.Context(), principalKey, p))
			}
		}
		if err := h(w, r); err != nil {
			writeErr(w, r, err)
		}
	})
}

// ---------- middleware ----------

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(c int)           { w.status = c; w.ResponseWriter.WriteHeader(c) }
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid := "req_" + uuid.NewString()
		w.Header().Set("X-Request-Id", rid)
		r = r.WithContext(context.WithValue(r.Context(), ridKey, rid))
		if o := r.Header.Get("Origin"); o != "" && slices.Contains(s.cfg.CORSOrigins, o) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", o)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			h.Set("Access-Control-Expose-Headers", "X-Request-Id, Retry-After")
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		sw := &statusWriter{ResponseWriter: w, status: 200}
		start := time.Now()
		defer func() {
			if v := recover(); v != nil {
				slog.Error("panic", "err", v, "stack", string(debug.Stack()))
				writeErr(sw, r, apierr.Internal())
			}
			slog.Debug("http", "method", r.Method, "path", r.URL.Path, "status", sw.status, "dur", time.Since(start), "rid", rid)
		}()
		next.ServeHTTP(sw, r)
	})
}

const ridKey ctxKey = 2

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		// behind a local reverse proxy / tunnel
		if v := r.Header.Get("CF-Connecting-IP"); v != "" {
			return v
		}
		if v := r.Header.Get("X-Forwarded-For"); v != "" {
			first, _, _ := strings.Cut(v, ",")
			return strings.TrimSpace(first)
		}
	}
	return host
}

// ---------- JSON helpers ----------

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	e := apierr.As(err)
	if e == nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			e = apierr.Conflict("资源已存在")
		} else if errors.Is(err, pgx.ErrNoRows) {
			e = apierr.NotFound("资源")
		} else {
			slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
			e = apierr.Internal()
		}
	}
	if e.RetryAfter > 0 {
		w.Header().Set("Retry-After", itoa(e.RetryAfter))
	}
	rid, _ := r.Context().Value(ridKey).(string)
	writeJSON(w, e.Status, map[string]any{"error": e, "request_id": rid})
}

func decodeJSON(r *http.Request, v any) error {
	ct := r.Header.Get("Content-Type")
	if ct != "" && !strings.HasPrefix(ct, "application/json") {
		return apierr.Unsupported("需要 application/json")
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return apierr.BadRequest("请求体为空")
		}
		return apierr.BadRequest("JSON 格式错误: " + err.Error())
	}
	return nil
}

// optString distinguishes absent / null / value in PATCH bodies.
type optString struct {
	Set  bool
	Null bool
	V    string
}

func (o *optString) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Null = true
		return nil
	}
	return json.Unmarshal(b, &o.V)
}

func pathID(r *http.Request, name, what string) (string, error) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		return "", apierr.NotFound(what)
	}
	return id.String(), nil
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }
