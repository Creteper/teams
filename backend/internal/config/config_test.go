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
