package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/creteper/teams/backend/internal/config"
)

// rawCall is a goroutine-safe HTTP helper (no t.Fatal).
func (e *env) rawCall(method, path, token string, body any) (int, map[string]any, error) {
	var rd io.Reader
	if body != nil {
		j, _ := json.Marshal(body)
		rd = bytes.NewReader(j)
	}
	req, err := http.NewRequest(method, e.ts.URL+path, rd)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	var m map[string]any
	b, _ := io.ReadAll(res.Body)
	json.Unmarshal(b, &m)
	return res.StatusCode, m, nil
}

// TestSeqConcurrentCatchUp: many concurrent senders in one channel while a
// reader keeps paging with after=<cursor>. Every message must be seen exactly
// once, with strictly increasing seq (commit-visible order == seq order).
func TestSeqConcurrentCatchUp(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.UserMsgRatePer10s = 10000 })
	owner := e.newUser()
	tm := e.newTeam(owner)
	other := e.must(201, "POST", "/api/v1/teams/"+tm.ID+"/channels", owner.Token, map[string]any{"name": "noise"})["id"].(string)
	const senders, perSender = 8, 40
	users := []user{owner}
	for len(users) < senders {
		u := e.newUser()
		e.addMember(owner, tm, u)
		users = append(users, u)
	}

	var (
		created   sync.Map // id -> seq
		sendErrs  atomic.Int64
		firstErr  atomic.Value
		done      atomic.Bool
		wg        sync.WaitGroup
		readerErr = make(chan error, 1)
		seen      = map[string]int64{}
	)
	fail := func(err error) {
		sendErrs.Add(1)
		firstErr.CompareAndSwap(nil, err.Error())
	}

	// reader
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		cursor := int64(0)
		poll := func() (int, error) {
			st, m, err := e.rawCall("GET", "/api/v1/channels/"+tm.GeneralID+"/messages?limit=100&after="+strconv.FormatInt(cursor, 10), owner.Token, nil)
			if err != nil {
				return 0, err
			}
			if st != 200 {
				return 0, fmt.Errorf("list status %d", st)
			}
			its := items(m)
			for _, it := range its {
				id := it["id"].(string)
				seq := int64(it["seq"].(float64))
				if seq <= cursor {
					return 0, fmt.Errorf("seq %d not after cursor %d", seq, cursor)
				}
				if _, dup := seen[id]; dup {
					return 0, fmt.Errorf("duplicate message %s", id)
				}
				seen[id] = seq
				cursor = seq
			}
			if len(its) > 0 {
				if nc, _ := m["next_cursor"].(string); nc != strconv.FormatInt(cursor, 10) {
					return 0, fmt.Errorf("next_cursor %q != last seq %d", nc, cursor)
				}
			}
			return len(its), nil
		}
		for !done.Load() {
			if _, err := poll(); err != nil {
				readerErr <- err
				return
			}
		}
		// final drain after all sends committed
		for {
			n, err := poll()
			if err != nil {
				readerErr <- err
				return
			}
			if n == 0 {
				return
			}
		}
	}()

	for i := 0; i < senders; i++ {
		wg.Add(1)
		go func(u user, i int) {
			defer wg.Done()
			for j := 0; j < perSender; j++ {
				// interleave traffic in another channel so the global seq has gaps
				if j%4 == 0 {
					if st, _, err := e.rawCall("POST", "/api/v1/channels/"+other+"/messages", u.Token, map[string]any{"content": "noise"}); err != nil || st != 201 {
						fail(fmt.Errorf("noise send: %d %v", st, err))
					}
				}
				st, m, err := e.rawCall("POST", "/api/v1/channels/"+tm.GeneralID+"/messages", u.Token,
					map[string]any{"content": fmt.Sprintf("m %d-%d", i, j), "client_msg_id": fmt.Sprintf("c-%d-%d", i, j)})
				if err != nil || st != 201 {
					fail(fmt.Errorf("send: %d %v", st, err))
					continue
				}
				created.Store(m["id"].(string), int64(m["seq"].(float64)))
			}
		}(users[i], i)
	}
	wg.Wait()
	done.Store(true)
	<-readerDone

	select {
	case err := <-readerErr:
		t.Fatalf("reader: %v", err)
	default:
	}
	if n := sendErrs.Load(); n > 0 {
		t.Fatalf("%d send errors, first: %v", n, firstErr.Load())
	}
	total := 0
	created.Range(func(k, v any) bool {
		total++
		if s, ok := seen[k.(string)]; !ok {
			t.Errorf("message %s (seq %d) missed by after= catch-up", k, v)
		} else if s != v.(int64) {
			t.Errorf("message %s seq mismatch %d vs %d", k, s, v)
		}
		return true
	})
	if total != senders*perSender || len(seen) != total {
		t.Fatalf("created %d, seen %d, want %d", total, len(seen), senders*perSender)
	}
}
