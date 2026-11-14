package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"testing"

	"github.com/creteper/teams/backend/internal/config"
	"github.com/creteper/teams/backend/skill"
)

func TestSkillDownloads(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.PublicBaseURL = "https://teams.example.test" })
	b, err := skill.Load()
	if err != nil {
		t.Fatal(err)
	}
	get := func(path string, hdr map[string]string) (*http.Response, []byte) {
		req, _ := http.NewRequest("GET", e.ts.URL+path, nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res, body
	}
	sum := func(p []byte) string { s := sha256.Sum256(p); return hex.EncodeToString(s[:]) }

	// /skill: public, fields built from TEAMS_PUBLIC_BASE_URL
	info := e.must(200, "GET", "/api/v1/skill", "", nil)
	base := "https://teams.example.test/api/v1/downloads/"
	want := map[string]any{
		"name": "teams-skill", "version": b.Version,
		"install_command": "npx -y " + base + "teams-skill.tgz",
		"tgz_url":         base + "teams-skill.tgz",
		"versioned_url":   base + "teams-skill-" + b.Version + ".tgz",
		"skill_md_url":    "https://teams.example.test/api/v1/skill/SKILL.md",
		"sha256":          b.TarballSHA256, "size_bytes": float64(len(b.Tarball)),
		"skill_name": "teams-bot-integration", "install_path": ".cursor/skills/teams-bot-integration/SKILL.md",
		"skill_md_sha256": b.SkillSHA256,
	}
	for k, v := range want {
		if info[k] != v {
			t.Errorf("/skill %s = %v, want %v", k, info[k], v)
		}
	}
	if _, ok := info["skill_md"]; ok {
		t.Error("skill_md should be opt-in")
	}
	src, _ := os.ReadFile("../../skill/teams-bot-integration/SKILL.md")
	full := e.must(200, "GET", "/api/v1/skill?include=skill_md", "", nil)
	if full["skill_md"] != string(src) {
		t.Error("include=skill_md differs from source SKILL.md")
	}

	// both tarball URLs: same bytes, matching sha256, right headers
	for path, cache := range map[string]string{
		"/api/v1/downloads/teams-skill.tgz":                   "no-cache",
		"/api/v1/downloads/teams-skill-" + b.Version + ".tgz": "public, max-age=31536000, immutable",
	} {
		res, body := get(path, nil)
		if res.StatusCode != 200 || sum(body) != b.TarballSHA256 || sum(body) != info["sha256"] {
			t.Fatalf("%s: %d sha=%s", path, res.StatusCode, sum(body))
		}
		if res.Header.Get("Content-Type") != "application/gzip" || res.Header.Get("Cache-Control") != cache ||
			res.Header.Get("ETag") != `"`+b.TarballSHA256+`"` || res.Header.Get("X-TeAms-Skill-Version") != b.Version {
			t.Fatalf("%s headers: %v", path, res.Header)
		}
		if res2, _ := get(path, map[string]string{"If-None-Match": res.Header.Get("ETag")}); res2.StatusCode != 304 {
			t.Fatalf("%s revalidate: %d", path, res2.StatusCode)
		}
	}
	// SKILL.md raw
	res, body := get("/api/v1/skill/SKILL.md", nil)
	if res.StatusCode != 200 || string(body) != string(src) || res.Header.Get("Content-Type") != "text/markdown; charset=utf-8" ||
		res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("SKILL.md: %d %v", res.StatusCode, res.Header)
	}
	// unknown versions / files → 404
	for _, p := range []string{"/api/v1/downloads/teams-skill-0.0.0.tgz", "/api/v1/downloads/teams-skill-" + b.Version + ".tar",
		"/api/v1/downloads/other.tgz", "/api/v1/downloads/x/teams-skill.tgz"} {
		if r := e.do("GET", p, "", nil); r.Status != 404 || r.errCode() != "not_found" {
			t.Fatalf("%s: %d %s", p, r.Status, r.Body)
		}
	}
}
