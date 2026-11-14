package httpapi

import (
	"strings"
	"testing"
	"time"
)

func TestTriggerDepth(t *testing.T) {
	two := 2
	if TriggerDepth(false, &two) != 0 || TriggerDepth(true, nil) != 1 || TriggerDepth(true, &two) != 3 {
		t.Fatal("TriggerDepth")
	}
}

func TestNormalizeStyle(t *testing.T) {
	v, err := NormalizeStyle("avatar_shape", optString{Set: true, V: "  Rounded Square "})
	if err != nil || *v != "Rounded Square" {
		t.Fatal(v, err)
	}
	v, _ = NormalizeStyle("avatar_color", optString{Set: true, V: "#FFAA00"})
	if *v != "#FFAA00" {
		t.Fatal("must not lowercase")
	}
	if v, _ := NormalizeStyle("x", optString{Set: true, Null: true}); v != nil {
		t.Fatal("null")
	}
	if v, _ := NormalizeStyle("x", optString{Set: true, V: " \t "}); v != nil {
		t.Fatal("blank")
	}
	if _, err := NormalizeStyle("x", optString{Set: true, V: strings.Repeat("字", 65)}); err == nil {
		t.Fatal("65 runes")
	}
	if _, err := NormalizeStyle("x", optString{Set: true, V: strings.Repeat("字", 64)}); err != nil {
		t.Fatal("64 runes")
	}
	if _, err := NormalizeStyle("x", optString{Set: true, V: "a\x00b"}); err == nil {
		t.Fatal("control char")
	}
}

func TestInviteCodeAndReason(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c := NewInviteCode()
		if !inviteCodeRe.MatchString(c) || seen[c] {
			t.Fatal(c)
		}
		seen[c] = true
	}
	now := time.Now()
	past, future := now.Add(-time.Second), now.Add(time.Hour)
	one := 1
	if inviteInvalidReason(nil, nil, nil, 99, now) != "" ||
		inviteInvalidReason(&past, nil, nil, 0, now) != "expired" ||
		inviteInvalidReason(&future, &past, nil, 0, now) != "revoked" ||
		inviteInvalidReason(&future, nil, &one, 1, now) != "exhausted" {
		t.Fatal("reasons")
	}
}

func TestValidHeaderName(t *testing.T) {
	for _, ok := range []string{"X-Webhook-Secret", "Authorization", "x-api-key"} {
		if !validHeaderName(ok) {
			t.Error(ok)
		}
	}
	for _, bad := range []string{"Host", "content-type", "X-TeAms-Signature", "x-teams-anything", "bad name", "", strings.Repeat("a", 65)} {
		if validHeaderName(bad) {
			t.Error(bad)
		}
	}
}
