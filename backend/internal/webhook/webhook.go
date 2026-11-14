// Package webhook delivers outbound bot webhooks from a PostgreSQL-backed
// queue with HMAC signatures, a configurable secret header and retries.
package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creteper/teams/backend/internal/netguard"
	"github.com/creteper/teams/backend/internal/secretbox"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const UserAgent = "TeAms-Webhook/1.0"

// ErrDrop means the delivery cannot be built anymore (e.g. message deleted)
// and should be marked failed without retry.
var ErrDrop = errors.New("delivery dropped")

// Sign returns "sha256=<hex>" of HMAC-SHA256(secret, ts + "." + body).
func Sign(secret string, ts int64, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(strconv.FormatInt(ts, 10)))
	m.Write([]byte("."))
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// Verify checks a signature header value (for receivers / tests).
func Verify(secret string, ts int64, body []byte, sig string) bool {
	return hmac.Equal([]byte(Sign(secret, ts, body)), []byte(sig))
}

type Target struct {
	URL           string
	Enabled       bool
	HeaderName    string
	HeaderValue   string
	SigningSecret string
}

// LoadTarget reads and decrypts a bot's webhook configuration.
func LoadTarget(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, box *secretbox.Box, botID string) (*Target, error) {
	var t Target
	var hn *string
	var hv, ss []byte
	err := q.QueryRow(ctx, `SELECT url, enabled, secret_header_name, secret_header_value_enc, signing_secret_enc
		FROM bot_webhooks WHERE bot_id=$1`, botID).Scan(&t.URL, &t.Enabled, &hn, &hv, &ss)
	if err != nil {
		return nil, err
	}
	if hn != nil {
		t.HeaderName = *hn
	}
	if len(hv) > 0 {
		p, err := box.Open(hv)
		if err != nil {
			return nil, fmt.Errorf("decrypt header secret: %w", err)
		}
		t.HeaderValue = string(p)
	}
	p, err := box.Open(ss)
	if err != nil {
		return nil, fmt.Errorf("decrypt signing secret: %w", err)
	}
	t.SigningSecret = string(p)
	return &t, nil
}

type Result struct {
	StatusCode int
	RetryAfter time.Duration
	Err        error
}

// Retryable reports whether the result warrants another attempt.
func (r Result) Retryable() bool {
	if r.Err != nil {
		return !netguard.IsBlockedErr(r.Err)
	}
	return r.StatusCode >= 500 || r.StatusCode == http.StatusTooManyRequests
}

func (r Result) OK() bool { return r.Err == nil && r.StatusCode >= 200 && r.StatusCode < 300 }

// Payload is a rendered delivery: the JSON body plus extra X-TeAms-*
// headers that duplicate key identifiers for receivers that truncate bodies.
type Payload struct {
	Body    []byte
	Headers map[string]string
}

// Send performs one signed POST.
func Send(ctx context.Context, client *http.Client, t *Target, event, deliveryID string, p Payload) Result {
	body := p.Body
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.URL, bytes.NewReader(body))
	if err != nil {
		return Result{Err: err}
	}
	ts := time.Now().Unix()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("X-TeAms-Event", event)
	req.Header.Set("X-TeAms-Delivery", deliveryID)
	req.Header.Set("X-TeAms-Timestamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-TeAms-Signature", Sign(t.SigningSecret, ts, body))
	for k, v := range p.Headers {
		if strings.HasPrefix(strings.ToLower(k), "x-teams-") && req.Header.Get(k) == "" {
			req.Header.Set(k, v)
		}
	}
	if t.HeaderName != "" {
		req.Header.Set(t.HeaderName, t.HeaderValue)
	}
	resp, err := client.Do(req)
	if err != nil {
		return Result{Err: err}
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	res := Result{StatusCode: resp.StatusCode}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		if n, err := strconv.Atoi(ra); err == nil && n > 0 {
			res.RetryAfter = time.Duration(n) * time.Second
		}
	}
	return res
}

// ErrorClass returns a short, secret-free description for last_error.
func ErrorClass(r Result) string {
	switch {
	case r.Err == nil:
		return "http_" + strconv.Itoa(r.StatusCode)
	case netguard.IsBlockedErr(r.Err):
		return "blocked_address"
	case errors.Is(r.Err, context.DeadlineExceeded) || isTimeout(r.Err):
		return "timeout"
	default:
		return "network_error"
	}
}

func isTimeout(err error) bool {
	var te interface{ Timeout() bool }
	return errors.As(err, &te) && te.Timeout()
}

type Delivery struct {
	ID        string
	BotID     string
	MessageID *string
	ChannelID *string
	Event     string
	Attempts  int // including the current one
}

// RunEvent describes a bot-run state change (bot.run.*).
type RunEvent struct {
	Type        string // delivered | retrying | failed
	Attempt     int
	NextRetryAt *time.Time
	Reason      string
	StatusCode  *int
}

// RunReason maps an ErrorClass to the public bot.run.failed reason.
func RunReason(cls string) string {
	switch {
	case cls == "timeout":
		return "timeout"
	case cls == "blocked_address" || cls == "invalid_url":
		return "invalid_url"
	case strings.HasPrefix(cls, "http_"):
		return "http_error"
	case cls == "webhook_not_configured":
		return "no_webhook"
	case cls == "dropped":
		return "message_deleted"
	default:
		return "network_error"
	}
}

// BuildFunc renders the JSON body for a delivery.
type BuildFunc func(ctx context.Context, d Delivery) (Payload, error)

type Worker struct {
	Pool    *pgxpool.Pool
	Box     *secretbox.Box
	Client  *http.Client
	Build   BuildFunc
	Delays  []time.Duration // len(Delays)+1 = max attempts
	Poll    time.Duration
	Workers int
	Lease   time.Duration
	// Notify is called after a run state change of a message.mention delivery.
	Notify   func(ctx context.Context, d Delivery, ev RunEvent)
	wake     chan struct{}
	initOnce sync.Once
}

func (w *Worker) init() {
	w.initOnce.Do(func() {
		w.wake = make(chan struct{}, 1)
		if w.Lease == 0 {
			w.Lease = 2 * time.Minute
		}
		if w.Poll == 0 {
			w.Poll = time.Second
		}
		if w.Workers == 0 {
			w.Workers = 1
		}
	})
}

// Wake nudges idle workers (call after enqueueing).
func (w *Worker) Wake() {
	w.init()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// Run blocks until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	w.init()
	var wg sync.WaitGroup
	for i := 0; i < w.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				n, err := w.RunOnce(ctx)
				if err != nil && ctx.Err() == nil {
					slog.Error("webhook worker", "err", err)
				}
				if n > 0 {
					continue
				}
				select {
				case <-ctx.Done():
					return
				case <-w.wake:
				case <-time.After(w.Poll):
				}
			}
		}()
	}
	wg.Wait()
}

// RunOnce claims and processes up to 5 due deliveries; returns how many.
func (w *Worker) RunOnce(ctx context.Context) (int, error) {
	w.init()
	rows, err := w.Pool.Query(ctx, `UPDATE webhook_deliveries SET attempts = attempts + 1,
			next_attempt_at = now() + make_interval(secs => $1)
		WHERE id IN (SELECT id FROM webhook_deliveries WHERE status='pending' AND next_attempt_at <= now()
			ORDER BY next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED)
		RETURNING id, bot_id, message_id, channel_id, event, attempts`, w.Lease.Seconds())
	if err != nil {
		return 0, err
	}
	ds, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Delivery, error) {
		var d Delivery
		err := r.Scan(&d.ID, &d.BotID, &d.MessageID, &d.ChannelID, &d.Event, &d.Attempts)
		return d, err
	})
	if err != nil {
		return 0, err
	}
	for _, d := range ds {
		w.process(ctx, d)
	}
	return len(ds), nil
}

// setRun updates run_status unless the run already ended (completed, or
// declined by the bot); returns whether it changed (so events are not
// emitted after the run ended).
func (w *Worker) setRun(ctx context.Context, d Delivery, runStatus, reason string) bool {
	if d.MessageID == nil {
		return false
	}
	tag, err := w.Pool.Exec(ctx, `UPDATE webhook_deliveries SET run_status=$2, run_reason=NULLIF($3,''), run_updated_at=now()
		WHERE id=$1 AND COALESCE(run_status, '') NOT IN ('completed', 'declined')`, d.ID, runStatus, reason)
	return err == nil && tag.RowsAffected() > 0
}

func (w *Worker) notify(ctx context.Context, d Delivery, ev RunEvent) {
	if w.Notify != nil {
		w.Notify(ctx, d, ev)
	}
}

func (w *Worker) finish(ctx context.Context, id, status string, code *int, lastErr string) {
	_, err := w.Pool.Exec(ctx, `UPDATE webhook_deliveries SET status=$2, last_status_code=$3, last_error=NULLIF($4,''),
		finished_at = CASE WHEN $2='pending' THEN NULL ELSE now() END WHERE id=$1`, id, status, code, lastErr)
	if err != nil {
		slog.Error("update delivery", "id", id, "err", err)
	}
}

func (w *Worker) fail(ctx context.Context, d Delivery, code *int, cls string) {
	w.finish(ctx, d.ID, "failed", code, cls)
	reason := RunReason(cls)
	if w.setRun(ctx, d, "failed", reason) {
		w.notify(ctx, d, RunEvent{Type: "failed", Attempt: d.Attempts, Reason: reason, StatusCode: code})
	}
}

func (w *Worker) process(ctx context.Context, d Delivery) {
	t, err := LoadTarget(ctx, w.Pool, w.Box, d.BotID)
	if err != nil || !t.Enabled {
		w.fail(ctx, d, nil, "webhook_not_configured")
		return
	}
	pl, err := w.Build(ctx, d)
	if err != nil {
		if errors.Is(err, ErrDrop) {
			w.fail(ctx, d, nil, "dropped")
		} else {
			slog.Error("build webhook payload", "delivery", d.ID, "err", err)
			w.retryOrFail(ctx, d, nil, "build_error", 0)
		}
		return
	}
	res := Send(ctx, w.Client, t, d.Event, d.ID, pl)
	var code *int
	if res.Err == nil {
		c := res.StatusCode
		code = &c
	}
	slog.Info("webhook delivery", "delivery", d.ID, "bot", d.BotID, "attempt", d.Attempts, "bytes", len(pl.Body), "result", ErrorClass(res))
	switch {
	case res.OK():
		w.finish(ctx, d.ID, "succeeded", code, "")
		if w.setRun(ctx, d, "delivered", "") {
			w.notify(ctx, d, RunEvent{Type: "delivered", Attempt: d.Attempts, StatusCode: code})
		}
	case res.Retryable():
		w.retryOrFail(ctx, d, code, ErrorClass(res), res.RetryAfter)
	default:
		w.fail(ctx, d, code, ErrorClass(res))
	}
}

func (w *Worker) retryOrFail(ctx context.Context, d Delivery, code *int, cls string, retryAfter time.Duration) {
	if d.Attempts > len(w.Delays) {
		w.fail(ctx, d, code, cls)
		return
	}
	delay := w.Delays[d.Attempts-1]
	delay = time.Duration(float64(delay) * (0.8 + 0.4*rand.Float64()))
	if retryAfter > delay {
		delay = retryAfter
	}
	next := time.Now().Add(delay)
	_, err := w.Pool.Exec(ctx, `UPDATE webhook_deliveries SET status='pending', last_status_code=$2, last_error=$3,
		next_attempt_at = $4 WHERE id=$1`, d.ID, code, cls, next)
	if err != nil {
		slog.Error("schedule retry", "id", d.ID, "err", err)
		return
	}
	reason := RunReason(cls)
	if w.setRun(ctx, d, "retrying", reason) {
		w.notify(ctx, d, RunEvent{Type: "retrying", Attempt: d.Attempts, NextRetryAt: &next, Reason: reason, StatusCode: code})
	}
}
