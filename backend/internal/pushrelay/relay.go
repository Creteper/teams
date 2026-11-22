// Package pushrelay forwards already-encrypted Web Push requests to FCM.
package pushrelay

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
)

const (
	host        = "fcm.googleapis.com"
	maxBody     = 4096
	pathHeader  = "X-Teams-Fcm-Path"
	vapidHeader = "X-Teams-Vapid"
)

var endpointPath = regexp.MustCompile(`^/(fcm/send|wp)/[a-zA-Z0-9_:-][a-zA-Z0-9_.:-]*$`)

type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Client routes only FCM requests through the configured relay. Other push
// providers use the application's existing outbound client.
type Client struct {
	Direct HTTPClient
	URL    string
	Token  string
}

type receipt struct {
	Status int `json:"fcm_status"`
}

func (c Client) Do(req *http.Request) (*http.Response, error) {
	if !strings.EqualFold(req.URL.Hostname(), host) {
		return c.Direct.Do(req)
	}
	if req.Body != nil {
		defer req.Body.Close()
	}
	path := req.URL.EscapedPath()
	if req.URL.Scheme != "https" || (req.URL.Port() != "" && req.URL.Port() != "443") || req.URL.User != nil || req.URL.RawQuery != "" || !endpointPath.MatchString(path) {
		return nil, errors.New("unsupported FCM subscription endpoint")
	}
	out, err := http.NewRequestWithContext(req.Context(), http.MethodPost, c.URL, req.Body)
	if err != nil {
		return nil, err
	}
	out.ContentLength = req.ContentLength
	out.Header.Set("Content-Type", "application/octet-stream")
	out.Header.Set("X-Teams-Relay-Token", c.Token)
	out.Header.Set(pathHeader, path)
	out.Header.Set(vapidHeader, req.Header.Get("Authorization"))
	res, err := c.Direct.Do(out)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	// Only a receipt from a completed upstream call can expire a subscription.
	// An FC URL/trigger error (including an HTTP 404) is a delivery failure.
	if res.StatusCode != http.StatusOK {
		return nil, errors.New("push relay unavailable")
	}
	var reply receipt
	if err := json.NewDecoder(io.LimitReader(res.Body, 1024)).Decode(&reply); err != nil || reply.Status < 200 || reply.Status > 599 {
		return nil, errors.New("invalid push relay receipt")
	}
	return &http.Response{StatusCode: reply.Status, Body: http.NoBody, Header: make(http.Header)}, nil
}

func Handler(token string, client HTTPClient) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /push", func(w http.ResponseWriter, r *http.Request) {
		path, authorization := r.Header.Get(pathHeader), r.Header.Get(vapidHeader)
		if len(path) > 2048 || !endpointPath.MatchString(path) || len(authorization) > 4096 || !strings.HasPrefix(authorization, "vapid t=") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil || len(body) == 0 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		out, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://"+host+path, bytes.NewReader(body))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		out.Header.Set("Authorization", authorization)
		out.Header.Set("Content-Type", "application/octet-stream")
		out.Header.Set("Content-Encoding", "aes128gcm")
		out.Header.Set("TTL", "86400")
		out.Header.Set("Urgency", "high")
		res, err := client.Do(out)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer res.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(receipt{Status: res.StatusCode})
	})
	mux.HandleFunc("POST /check-fcm", func(w http.ResponseWriter, r *http.Request) {
		// Any HTTP response from Google's root proves DNS, TCP and TLS connectivity.
		probe, err := http.NewRequestWithContext(r.Context(), http.MethodHead, "https://"+host+"/", nil)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		res, err := client.Do(probe)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer res.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"reachable": true, "fcm_http_status": res.StatusCode})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(token) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Teams-Relay-Token")), []byte(token)) != 1 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
