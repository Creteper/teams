package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/creteper/teams/backend/internal/config"
	"github.com/creteper/teams/backend/internal/db"
	"github.com/creteper/teams/backend/internal/storage"
	"github.com/creteper/teams/backend/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

var testPool *pgxpool.Pool

// findDotEnv walks up from the working directory looking for backend/.env.
func findDotEnv() string {
	dir, _ := os.Getwd()
	for i := 0; i < 6; i++ {
		p := filepath.Join(dir, ".env")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		dir = filepath.Dir(dir)
	}
	return ""
}

func TestMain(m *testing.M) {
	url := os.Getenv("TEAMS_TEST_DATABASE_URL")
	if url == "" {
		if p := findDotEnv(); p != "" {
			f, _ := os.Open(p)
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				if v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "TEAMS_TEST_DATABASE_URL="); ok {
					url = v
				}
			}
			f.Close()
		}
	}
	if url == "" {
		fmt.Fprintln(os.Stderr, "TEAMS_TEST_DATABASE_URL not set (env or backend/.env); integration tests need the teams_test database")
		os.Exit(1)
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open test db:", err)
		os.Exit(1)
	}
	if _, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		fmt.Fprintln(os.Stderr, "reset schema:", err)
		os.Exit(1)
	}
	if err := db.Migrate(ctx, pool, migrations.FS); err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		os.Exit(1)
	}
	testPool = pool
	code := m.Run()
	pool.Close()
	os.Exit(code)
}

type env struct {
	t   *testing.T
	srv *Server
	ts  *httptest.Server
	cfg *config.Config
}

func testConfig() *config.Config {
	return &config.Config{
		Env: "test", HTTPAddr: "127.0.0.1:0", PublicBaseURL: "http://teams.test",
		SecretKey:   bytes.Repeat([]byte{7}, 32),
		CORSOrigins: []string{"http://localhost:5190", "http://127.0.0.1:5190"},
		SessionTTL:  time.Hour, MaxImageBytes: 1 << 20, MaxVideoBytes: 2 << 20, MaxAvatarBytes: 256 << 10,
		MaxTriggerDepth: 3, WebhookRatePerMinute: 10, WebhookTimeout: 2 * time.Second,
		WebhookRetryDelays: []time.Duration{40 * time.Millisecond, 60 * time.Millisecond, 80 * time.Millisecond},
		WebhookWorkers:     2, WebhookPollInterval: 20 * time.Millisecond,
		AllowInsecureLocal: true, AvatarFetchTimeout: 2 * time.Second,
		UserMsgRatePer10s: 100, BotMsgRatePerMinute: 100, BotProfileRatePerMinute: 100,
		Argon2Time: 1, Argon2MemKiB: 1024, Argon2Threads: 1,
	}
}

func newEnv(t *testing.T, mutate ...func(*config.Config)) *env {
	t.Helper()
	cfg := testConfig()
	cfg.UploadDir = t.TempDir()
	for _, f := range mutate {
		f(cfg)
	}
	store, err := storage.NewLocalDisk(cfg.UploadDir)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(cfg, testPool, store)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go srv.worker.Run(ctx)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.Close()
		cancel()
		// stop leftover retries from leaking into later tests
		testPool.Exec(context.Background(), `UPDATE webhook_deliveries SET status='failed' WHERE status='pending'`)
	})
	return &env{t: t, srv: srv, ts: ts, cfg: cfg}
}

type resp struct {
	Status int
	Header http.Header
	Body   []byte
}

func (r resp) JSON() map[string]any {
	var m map[string]any
	json.Unmarshal(r.Body, &m)
	return m
}

func (r resp) errCode() string {
	m := r.JSON()
	if e, ok := m["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

func (e *env) do(method, path, token string, body any) resp {
	e.t.Helper()
	var rd io.Reader
	ct := ""
	switch b := body.(type) {
	case nil:
	case *multipartBody:
		rd, ct = &b.buf, b.ct
	default:
		j, _ := json.Marshal(b)
		rd, ct = bytes.NewReader(j), "application/json"
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, rd)
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return resp{Status: res.StatusCode, Header: res.Header, Body: b}
}

func (e *env) must(status int, method, path, token string, body any) map[string]any {
	e.t.Helper()
	r := e.do(method, path, token, body)
	if r.Status != status {
		e.t.Fatalf("%s %s: want %d got %d: %s", method, path, status, r.Status, r.Body)
	}
	return r.JSON()
}

var userSeq atomic.Int64

type user struct {
	ID, Username, Token string
}

func (e *env) newUser() user {
	e.t.Helper()
	n := fmt.Sprintf("u%d_%d", time.Now().UnixNano()%1e8, userSeq.Add(1))
	m := e.must(201, "POST", "/api/v1/auth/register", "", map[string]any{"username": n, "password": "password123", "display_name": "User " + n})
	return user{ID: m["user"].(map[string]any)["id"].(string), Username: n, Token: m["token"].(string)}
}

type team struct {
	ID, MemberID, GeneralID string
}

func (e *env) newTeam(owner user) team {
	e.t.Helper()
	m := e.must(201, "POST", "/api/v1/teams", owner.Token, map[string]any{"name": "Team"})
	tm := team{ID: m["id"].(string), MemberID: m["my_member_id"].(string)}
	ch := e.must(200, "GET", "/api/v1/teams/"+tm.ID+"/channels", owner.Token, nil)
	tm.GeneralID = items(ch)[0]["id"].(string)
	return tm
}

func (e *env) addMember(owner user, tm team, u user) string {
	e.t.Helper()
	m := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/members", owner.Token, map[string]any{"username": u.Username})
	return m["id"].(string)
}

type bot struct {
	ID, MemberID, Token string
}

var botSeq atomic.Int64

func (e *env) newBot(owner user, tm team, extra map[string]any) (bot, map[string]any) {
	e.t.Helper()
	body := map[string]any{"name": fmt.Sprintf("bot%d", botSeq.Add(1)), "display_name": "Bot"}
	for k, v := range extra {
		body[k] = v
	}
	m := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/bots", owner.Token, body)
	b := m["bot"].(map[string]any)
	return bot{ID: b["id"].(string), MemberID: b["member_id"].(string), Token: m["token"].(string)}, m
}

func items(m map[string]any) []map[string]any {
	raw, _ := m["items"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, x := range raw {
		out = append(out, x.(map[string]any))
	}
	return out
}

func (e *env) send(token, channelID string, body map[string]any) map[string]any {
	e.t.Helper()
	return e.must(201, "POST", "/api/v1/channels/"+channelID+"/messages", token, body)
}

type multipartBody struct {
	buf bytes.Buffer
	ct  string
}

func multipartFile(field, filename string, data []byte, fields map[string]string) *multipartBody {
	mb := &multipartBody{}
	w := multipart.NewWriter(&mb.buf)
	for k, v := range fields {
		w.WriteField(k, v)
	}
	if data != nil {
		fw, _ := w.CreateFormFile(field, filename)
		fw.Write(data)
	}
	w.Close()
	mb.ct = w.FormDataContentType()
	return mb
}

func pngBytes(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		img.Set(x, 0, color.RGBA{R: uint8(x), A: 255})
	}
	var b bytes.Buffer
	png.Encode(&b, img)
	return b.Bytes()
}

func eventually(t *testing.T, d time.Duration, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

// ---------- webhook receiver ----------

type received struct {
	Header http.Header
	Body   []byte
}

type receiver struct {
	mu     sync.Mutex
	reqs   []received
	status func(n int) int // n = 1-based request count
	ts     *httptest.Server
}

func newReceiver(t *testing.T, status func(n int) int) *receiver {
	rc := &receiver{status: status}
	rc.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		rc.mu.Lock()
		rc.reqs = append(rc.reqs, received{Header: r.Header.Clone(), Body: b})
		n := len(rc.reqs)
		rc.mu.Unlock()
		code := 200
		if rc.status != nil {
			code = rc.status(n)
		}
		w.WriteHeader(code)
	}))
	t.Cleanup(rc.ts.Close)
	return rc
}

func (rc *receiver) count() int {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return len(rc.reqs)
}

func (rc *receiver) get(i int) received {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.reqs[i]
}

// ---------- websocket client ----------

type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
	ch   chan map[string]any
}

func (e *env) wsURL() string { return "ws" + strings.TrimPrefix(e.ts.URL, "http") + "/api/v1/ws" }

func (e *env) dialWS(token string) *wsClient {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, e.wsURL(), nil)
	if err != nil {
		e.t.Fatal(err)
	}
	c := &wsClient{t: e.t, conn: conn, ch: make(chan map[string]any, 100)}
	b, _ := json.Marshal(map[string]string{"type": "auth", "token": token})
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		e.t.Fatal(err)
	}
	go func() {
		defer close(c.ch)
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var m map[string]any
			json.Unmarshal(data, &m)
			c.ch <- m
		}
	}()
	e.t.Cleanup(func() { conn.CloseNow() })
	ready := c.waitFor("ready", 3*time.Second)
	if ready == nil {
		e.t.Fatal("no ready frame")
	}
	return c
}

// waitFor returns the next event of typ (skipping others), or nil on timeout.
func (c *wsClient) waitFor(typ string, d time.Duration) map[string]any {
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case m, ok := <-c.ch:
			if !ok {
				return nil
			}
			if m["type"] == typ {
				return m
			}
		case <-timer.C:
			return nil
		}
	}
}

func (c *wsClient) send(v any) {
	b, _ := json.Marshal(v)
	c.conn.Write(context.Background(), websocket.MessageText, b)
}
