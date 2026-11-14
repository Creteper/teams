// Package mention parses <@member_id> markers in message content.
package mention

import (
	"regexp"
	"strings"
)

var re = regexp.MustCompile(`<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>`)

// Parse returns the unique member ids (lower-cased) referenced in content,
// in order of first appearance.
func Parse(content string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range re.FindAllStringSubmatch(content, -1) {
		id := strings.ToLower(m[1])
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// Plain replaces markers whose id is in names with "@name"; unknown markers
// are left untouched.
func Plain(content string, names map[string]string) string {
	return re.ReplaceAllStringFunc(content, func(s string) string {
		id := strings.ToLower(re.FindStringSubmatch(s)[1])
		if n, ok := names[id]; ok {
			return "@" + n
		}
		return s
	})
}
