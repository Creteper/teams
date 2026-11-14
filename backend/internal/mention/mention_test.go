package mention

import (
	"reflect"
	"testing"
)

const (
	a = "0193aaaa-1111-7000-8000-000000000001"
	b = "0193bbbb-2222-7000-8000-000000000002"
)

func TestParse(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"no mentions", nil},
		{"<@" + a + "> hi", []string{a}},
		{"<@" + a + "><@" + b + "> <@" + a + ">", []string{a, b}},
		{"<@0193AAAA-1111-7000-8000-000000000001>", []string{a}},
		{"<@" + a + "  > <@not-a-uuid> @" + a + " <" + a + ">", nil},
		{"`<@" + b + ">` in code still counts", []string{b}},
	}
	for _, c := range cases {
		if got := Parse(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Parse(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestPlain(t *testing.T) {
	got := Plain("<@"+a+"> ping <@"+b+">", map[string]string{a: "Grok"})
	if got != "@Grok ping <@"+b+">" {
		t.Fatal(got)
	}
}
