package httpapi

import (
	"bytes"
	"net/http"
	"time"

	"github.com/creteper/teams/backend/internal/apierr"
	"github.com/creteper/teams/backend/skill"
)

// Bot integration skill: SKILL.md and the self-hosted npm package that
// installs it (npx <tgz url>), embedded in the binary (package skill).
// All public; served under /api/ so the existing nginx /api/ proxy covers it.

const (
	skillLatestFile  = skill.PackageName + ".tgz"
	cacheRevalidate  = "no-cache"
	cacheImmutable   = "public, max-age=31536000, immutable"
	skillDownloadDir = "/api/v1/downloads/"
)

type skillInfo struct {
	Name           string  `json:"name"`
	Version        string  `json:"version"`
	InstallCommand string  `json:"install_command"`
	TgzURL         string  `json:"tgz_url"`
	VersionedURL   string  `json:"versioned_url"`
	SkillMDURL     string  `json:"skill_md_url"`
	SHA256         string  `json:"sha256"`
	SizeBytes      int     `json:"size_bytes"`
	SkillName      string  `json:"skill_name"`
	InstallPath    string  `json:"install_path"`
	SkillMDSHA256  string  `json:"skill_md_sha256"`
	SkillMD        *string `json:"skill_md,omitempty"`
}

func (s *Server) skillBundle() (*skill.Bundle, error) {
	if s.skill == nil {
		return nil, apierr.New(http.StatusServiceUnavailable, "skill_unavailable", "skill 包不可用")
	}
	return s.skill, nil
}

// GET /api/v1/skill[?include=skill_md]
func (s *Server) getSkill(w http.ResponseWriter, r *http.Request) error {
	b, err := s.skillBundle()
	if err != nil {
		return err
	}
	base := s.cfg.PublicBaseURL
	latest := base + skillDownloadDir + skillLatestFile
	info := skillInfo{
		Name: skill.PackageName, Version: b.Version,
		InstallCommand: "npx -y " + latest,
		TgzURL:         latest,
		VersionedURL:   base + skillDownloadDir + b.TarballName(),
		SkillMDURL:     base + "/api/v1/skill/SKILL.md",
		SHA256:         b.TarballSHA256, SizeBytes: len(b.Tarball),
		SkillName: skill.SkillName, InstallPath: skill.InstallPath, SkillMDSHA256: b.SkillSHA256,
	}
	if r.URL.Query().Get("include") == "skill_md" {
		md := string(b.SkillMD)
		info.SkillMD = &md
	}
	w.Header().Set("Cache-Control", cacheRevalidate)
	return writeJSON(w, http.StatusOK, info)
}

// GET /api/v1/skill/SKILL.md
func (s *Server) getSkillMD(w http.ResponseWriter, r *http.Request) error {
	b, err := s.skillBundle()
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", "text/markdown; charset=utf-8")
	h.Set("Cache-Control", cacheRevalidate)
	h.Set("ETag", `"`+b.SkillSHA256+`"`)
	h.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b.SkillMD))
	return nil
}

// GET /api/v1/downloads/teams-skill.tgz (latest, revalidate) and
// GET /api/v1/downloads/teams-skill-<version>.tgz (immutable).
func (s *Server) download(w http.ResponseWriter, r *http.Request) error {
	b, err := s.skillBundle()
	if err != nil {
		return err
	}
	var cache string
	switch r.PathValue("file") {
	case skillLatestFile:
		cache = cacheRevalidate
	case b.TarballName():
		cache = cacheImmutable
	default:
		return apierr.NotFound("文件")
	}
	h := w.Header()
	h.Set("Content-Type", "application/gzip")
	h.Set("Content-Disposition", `attachment; filename="`+b.TarballName()+`"`)
	h.Set("Cache-Control", cache)
	h.Set("ETag", `"`+b.TarballSHA256+`"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-TeAms-Skill-Version", b.Version)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b.Tarball))
	return nil
}
