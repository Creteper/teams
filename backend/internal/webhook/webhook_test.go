package webhook

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/creteper/teams/backend/internal/netguard"
)

func TestSignVerify(t *testing.T) {
	body := []byte(`{"event":"message.mention"}`)
	sig := Sign("whsec_test", 1763130000, body)
	if !strings.HasPrefix(sig, "sha256=") || len(sig) != 7+64 {
		t.Fatal(sig)
	}
	// known vector: HMAC-SHA256("whsec_test", "1763130000.{...}")
	if !Verify("whsec_test", 1763130000, body, sig) {
		t.Fatal("verify failed")
	}
	if Verify("whsec_other", 1763130000, body, sig) || Verify("whsec_test", 1763130001, body, sig) || Verify("whsec_test", 1763130000, []byte("x"), sig) {
		t.Fatal("verify should fail on any change")
	}
}

func TestRetryable(t *testing.T) {
	cases := []struct {
		r    Result
		want bool
	}{
		{Result{StatusCode: 500}, true},
		{Result{StatusCode: 503}, true},
		{Result{StatusCode: http.StatusTooManyRequests}, true},
		{Result{StatusCode: 400}, false},
		{Result{StatusCode: 404}, false},
		{Result{Err: errors.New("conn refused")}, true},
		{Result{Err: netguard.ErrBlocked}, false},
	}
	for _, c := range cases {
		if c.r.Retryable() != c.want {
			t.Errorf("%+v retryable=%v", c.r, !c.want)
		}
	}
	if !(Result{StatusCode: 204}).OK() || (Result{StatusCode: 302}).OK() {
		t.Error("OK()")
	}
	if ErrorClass(Result{Err: netguard.ErrBlocked}) != "blocked_address" || ErrorClass(Result{StatusCode: 502}) != "http_502" {
		t.Error("ErrorClass")
	}
}
