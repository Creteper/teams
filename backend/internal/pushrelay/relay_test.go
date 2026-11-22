package pushrelay

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type sendFunc func(*http.Request) (*http.Response, error)

func (f sendFunc) Do(r *http.Request) (*http.Response, error) { return f(r) }

func TestEncryptedRoundTrip(t *testing.T) {
	const endpoint = "https://fcm.googleapis.com/wp/abc:123"
	token := strings.Repeat("a", 64)
	upstreamStatus := 201
	calls := 0
	upstream := sendFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		body, err := io.ReadAll(r.Body)
		if err != nil || r.URL.String() != endpoint || !strings.HasPrefix(r.Header.Get("Authorization"), "vapid t=") ||
			r.Header.Get("X-Teams-Relay-Token") != "" || r.Header.Get("Content-Encoding") != "aes128gcm" ||
			len(body) == 0 || bytes.Contains(body, []byte("test plaintext")) {
			t.Error("invalid upstream request")
		}
		return &http.Response{StatusCode: upstreamStatus, Body: http.NoBody}, nil
	})
	server := httptest.NewServer(Handler(token, upstream))
	defer server.Close()
	client := Client{URL: server.URL + "/push", Token: token, Direct: server.Client()}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err = rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	sub := webpush.Subscription{Endpoint: endpoint, Keys: webpush.Keys{P256dh: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), Auth: base64.RawURLEncoding.EncodeToString(auth)}}
	send := func() (*http.Response, error) {
		return webpush.SendNotificationWithContext(context.Background(), []byte("test plaintext"), &sub, &webpush.Options{HTTPClient: client, VAPIDPublicKey: pub, VAPIDPrivateKey: priv, Subscriber: "ops@example.com", TTL: 86400, Urgency: webpush.UrgencyHigh})
	}
	for _, status := range []int{201, 410, 429} {
		upstreamStatus = status
		res, err := send()
		if err != nil || res.StatusCode != status {
			t.Fatalf("status %d, err %v", status, err)
		}
		res.Body.Close()
	}
	client.Token = strings.Repeat("b", 64)
	if _, err := send(); err == nil {
		t.Fatal("wrong token accepted")
	}
	client.URL = server.URL + "/missing"
	if _, err := send(); err == nil {
		t.Fatal("FC 404 treated as expired subscription")
	}
	if calls != 3 {
		t.Fatalf("unexpected FCM calls: %d", calls)
	}
}

func TestTargetRestriction(t *testing.T) {
	token := strings.Repeat("a", 64)
	h := Handler(token, sendFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream"); return nil, nil }))
	for _, path := range []string{"https://example.com/", "//example.com", "/wp/../other", "/wp/token?redirect=other", "/wp/%2fabc"} {
		r := httptest.NewRequest("POST", "/push", strings.NewReader("data"))
		r.Header.Set("X-Teams-Relay-Token", token)
		r.Header.Set(pathHeader, path)
		r.Header.Set(vapidHeader, "vapid t=test")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	r := httptest.NewRequest("POST", "https://updates.push.services.mozilla.com/wpush/v2/example", nil)
	c := Client{Direct: sendFunc(func(out *http.Request) (*http.Response, error) {
		if out != r || out.Header.Get("X-Teams-Relay-Token") != "" {
			t.Fatal("non-FCM destination modified")
		}
		return &http.Response{StatusCode: 201, Body: http.NoBody}, nil
	})}
	res, err := c.Do(r)
	if err != nil || res.StatusCode != 201 {
		t.Fatal("unexpected direct delivery result")
	}
}
