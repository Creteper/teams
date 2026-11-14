package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func lookup(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestDefaultsAndInsecureFlag(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	c, err := FromLookup(lookup(map[string]string{"TEAMS_DATABASE_URL": "postgres://x", "TEAMS_SECRET_KEY": key}))
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != "127.0.0.1:8090" || c.MaxTriggerDepth != 3 || c.WebhookRatePerMinute != 10 || c.AllowInsecureLocal {
		t.Fatalf("%+v", c)
	}
	if strings.Join(c.CORSOrigins, ",") != "http://localhost:5190,http://127.0.0.1:5190" {
		t.Fatal(c.CORSOrigins)
	}
	// flag ignored outside dev
	c, _ = FromLookup(lookup(map[string]string{"TEAMS_DATABASE_URL": "x", "TEAMS_SECRET_KEY": key, "TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL": "true"}))
	if c.AllowInsecureLocal {
		t.Fatal("insecure flag must need TEAMS_ENV=dev")
	}
	c, _ = FromLookup(lookup(map[string]string{"TEAMS_DATABASE_URL": "x", "TEAMS_SECRET_KEY": key, "TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL": "true", "TEAMS_ENV": "dev"}))
	if !c.AllowInsecureLocal {
		t.Fatal("dev should honor flag")
	}
	if _, err := FromLookup(lookup(map[string]string{})); err == nil {
		t.Fatal("missing required vars")
	}
	if _, err := FromLookup(lookup(map[string]string{"TEAMS_DATABASE_URL": "x", "TEAMS_SECRET_KEY": "c2hvcnQ="})); err == nil {
		t.Fatal("short key")
	}
}

func TestVAPIDConfig(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	base := map[string]string{"TEAMS_DATABASE_URL": "x", "TEAMS_SECRET_KEY": key}
	with := func(kv ...string) map[string]string {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	c, err := FromLookup(lookup(base))
	if err != nil || c.PushEnabled() {
		t.Fatalf("push should be off by default: %v", err)
	}
	pub := make([]byte, 65)
	pub[0] = 4
	pubS := base64.RawURLEncoding.EncodeToString(pub)
	privS := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	c, err = FromLookup(lookup(with("TEAMS_VAPID_PUBLIC_KEY", pubS, "TEAMS_VAPID_PRIVATE_KEY", privS, "TEAMS_VAPID_SUBJECT", "mailto:ops@example.com")))
	if err != nil || !c.PushEnabled() {
		t.Fatalf("valid vapid: %v", err)
	}
	for _, m := range []map[string]string{
		with("TEAMS_VAPID_PUBLIC_KEY", pubS),
		with("TEAMS_VAPID_PUBLIC_KEY", "short", "TEAMS_VAPID_PRIVATE_KEY", privS, "TEAMS_VAPID_SUBJECT", "mailto:a@b"),
		with("TEAMS_VAPID_PUBLIC_KEY", pubS, "TEAMS_VAPID_PRIVATE_KEY", "c2hvcnQ", "TEAMS_VAPID_SUBJECT", "mailto:a@b"),
		with("TEAMS_VAPID_PUBLIC_KEY", pubS, "TEAMS_VAPID_PRIVATE_KEY", privS, "TEAMS_VAPID_SUBJECT", "ops@example.com"),
	} {
		if _, err := FromLookup(lookup(m)); err == nil {
			t.Fatalf("expected error for %v", m)
		} else if strings.Contains(err.Error(), privS) {
			t.Fatal("error leaks key")
		}
	}
}
