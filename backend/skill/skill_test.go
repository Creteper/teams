package skill

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

// The embedded SKILL.md is the source file, the tarball carries the same
// bytes, and the tarball version matches packages/teams-skill/package.json.
func TestBundleInSync(t *testing.T) {
	b, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile("teams-bot-integration/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b.SkillMD, src) {
		t.Fatal("embedded SKILL.md differs from source")
	}
	if !b.InSync() {
		t.Fatal("dist tarball has a stale SKILL.md: bump version in backend/packages/teams-skill/package.json and run `npm run dist`")
	}
	var pkg struct{ Name, Version string }
	raw, err := os.ReadFile("../packages/teams-skill/package.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	if pkg.Name != PackageName || pkg.Version != b.Version {
		t.Fatalf("package.json %s@%s vs embedded %s", pkg.Name, pkg.Version, b.TarballName())
	}
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(b.Version) {
		t.Fatalf("version %q", b.Version)
	}
}

func TestSkillMDHasFrontmatterAndNoSecrets(t *testing.T) {
	if !bytes.HasPrefix(skillMD, []byte("---\nname: "+SkillName+"\ndescription: ")) {
		t.Fatal("frontmatter missing")
	}
	// real tokens look like tas_/tab_/whsec_ followed by long random text
	if m := regexp.MustCompile(`\b(tas|tab|whsec)_[A-Za-z0-9_-]{16,}`).Find(skillMD); m != nil {
		t.Fatalf("possible secret in SKILL.md: %.12s…", m)
	}
}
