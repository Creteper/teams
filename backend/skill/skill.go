// Package skill embeds the TeAms bot integration skill (SKILL.md) and the
// self-hosted npm package that installs it (teams-skill-<version>.tgz), so
// both ship with the server binary.
//
// The single source of truth is teams-bot-integration/SKILL.md; the tarball
// in dist/ is produced by `npm run dist` in backend/packages/teams-skill,
// which copies that file into the package. TestBundleInSync fails when the
// two drift apart (edit SKILL.md → bump version → npm run dist → commit).
package skill

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"strings"
)

const (
	PackageName = "teams-skill"
	SkillName   = "teams-bot-integration"
	InstallPath = ".cursor/skills/" + SkillName + "/SKILL.md"
)

//go:embed teams-bot-integration/SKILL.md
var skillMD []byte

//go:embed dist
var dist embed.FS

// Bundle is the parsed, embedded release.
type Bundle struct {
	Version       string
	Tarball       []byte
	TarballSHA256 string
	SkillMD       []byte // source SKILL.md
	SkillSHA256   string
	PackedSkillMD []byte // SKILL.md inside the tarball
}

// InSync reports whether the tarball carries the current SKILL.md.
func (b *Bundle) InSync() bool { return bytes.Equal(b.SkillMD, b.PackedSkillMD) }

// TarballName returns "teams-skill-<version>.tgz".
func (b *Bundle) TarballName() string { return PackageName + "-" + b.Version + ".tgz" }

func hexSum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// Load parses the embedded files. dist/ must hold exactly one
// teams-skill-<version>.tgz whose package.json version matches its name.
func Load() (*Bundle, error) {
	ents, err := fs.ReadDir(dist, "dist")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), PackageName+"-") && strings.HasSuffix(e.Name(), ".tgz") {
			names = append(names, e.Name())
		}
	}
	if len(names) != 1 {
		return nil, fmt.Errorf("skill: expected exactly one %s-<version>.tgz in dist/, found %d", PackageName, len(names))
	}
	tgz, err := fs.ReadFile(dist, path.Join("dist", names[0]))
	if err != nil {
		return nil, err
	}
	version, packed, err := inspect(tgz)
	if err != nil {
		return nil, fmt.Errorf("skill: %s: %w", names[0], err)
	}
	b := &Bundle{Version: version, Tarball: tgz, TarballSHA256: hexSum(tgz),
		SkillMD: skillMD, SkillSHA256: hexSum(skillMD), PackedSkillMD: packed}
	if b.TarballName() != names[0] {
		return nil, fmt.Errorf("skill: %s contains version %s", names[0], version)
	}
	return b, nil
}

// inspect returns package.json's version and SKILL.md from an npm tarball.
func inspect(tgz []byte) (string, []byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(tgz))
	if err != nil {
		return "", nil, err
	}
	tr := tar.NewReader(zr)
	var pkgJSON, md []byte
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", nil, err
		}
		switch h.Name {
		case "package/package.json":
			pkgJSON, err = io.ReadAll(io.LimitReader(tr, 1<<20))
		case "package/SKILL.md":
			md, err = io.ReadAll(io.LimitReader(tr, 4<<20))
		}
		if err != nil {
			return "", nil, err
		}
	}
	if pkgJSON == nil || md == nil {
		return "", nil, errors.New("tarball lacks package/package.json or package/SKILL.md")
	}
	var p struct{ Name, Version string }
	if err := json.Unmarshal(pkgJSON, &p); err != nil {
		return "", nil, err
	}
	if p.Name != PackageName || p.Version == "" {
		return "", nil, fmt.Errorf("unexpected package %q@%q", p.Name, p.Version)
	}
	return p.Version, md, nil
}
