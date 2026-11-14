package netguard

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestIsBlocked(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
		"::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1", "255.255.255.255", "240.0.0.1"}
	for _, s := range blocked {
		if !IsBlocked(netip.MustParseAddr(s)) {
			t.Errorf("%s should be blocked", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "104.18.19.80", "2606:4700::1", "198.18.0.5"} {
		if IsBlocked(netip.MustParseAddr(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
}

func TestValidateURL(t *testing.T) {
	ok := []string{"https://example.com/hook", "https://8.8.8.8:8443/x"}
	for _, u := range ok {
		if _, err := ValidateURL(u, true, false); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
	bad := []string{"http://example.com", "ftp://example.com", "https://user:pw@example.com", "https://", "https://127.0.0.1/x",
		"https://localhost/x", "https://foo.localhost/x", "https://[::1]/", "javascript:alert(1)", "https://" + strings.Repeat("a", 2100) + ".com"}
	for _, u := range bad {
		if _, err := ValidateURL(u, true, false); err == nil {
			t.Errorf("%s should be rejected", u)
		}
	}
	if _, err := ValidateURL("http://example.com/a.png", false, false); err != nil {
		t.Error("http allowed when https not required")
	}
	if _, err := ValidateURL("http://127.0.0.1:9/x", true, true); err != nil {
		t.Error("insecure local should allow http loopback")
	}
}

func TestClientBlocksAtDialTime(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redir" {
			http.Redirect(w, r, "http://10.0.0.1/", http.StatusFound)
			return
		}
		w.Write([]byte("ok"))
	}))
	defer ts.Close()
	c := NewClient(Options{Timeout: 2 * time.Second, MaxRedirects: 3})
	_, err := c.Get(strings.Replace(ts.URL, "127.0.0.1", "localhost.", 1))
	if !IsBlockedErr(err) {
		t.Fatalf("expected blocked, got %v", err)
	}
	open := NewClient(Options{Timeout: 2 * time.Second, AllowPrivate: true, MaxRedirects: 3})
	res, err := open.Get(ts.URL)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("allow private: %v", err)
	}
	res.Body.Close()
	// redirect into a private address is re-validated
	strict := NewClient(Options{Timeout: 2 * time.Second, AllowPrivate: false, MaxRedirects: 3})
	strict.Transport = open.Transport // allow the first hop to the test server
	if _, err := strict.Get(ts.URL + "/redir"); !IsBlockedErr(err) {
		t.Fatalf("redirect to private: %v", err)
	}
}
