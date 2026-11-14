package auth

import (
	"bytes"
	"strings"
	"testing"
)

func TestPassword(t *testing.T) {
	p := Argon2Params{Time: 1, MemKiB: 1024, Threads: 1}
	h, err := HashPassword("correct horse", p)
	if err != nil || !strings.HasPrefix(h, "$argon2id$") {
		t.Fatal(h, err)
	}
	if ok, _ := VerifyPassword("correct horse", h); !ok {
		t.Fatal("verify")
	}
	if ok, _ := VerifyPassword("wrong", h); ok {
		t.Fatal("wrong password accepted")
	}
	h2, _ := HashPassword("correct horse", p)
	if h == h2 {
		t.Fatal("salt not random")
	}
	if _, err := VerifyPassword("x", "garbage"); err == nil {
		t.Fatal("garbage hash")
	}
}

func TestTokens(t *testing.T) {
	a, b := NewToken(SessionPrefix), NewToken(SessionPrefix)
	if a == b || !strings.HasPrefix(a, "tas_") || len(a) != 4+43 {
		t.Fatal(a)
	}
	if bytes.Equal(HashToken(a), HashToken(b)) || len(HashToken(a)) != 32 {
		t.Fatal("hash")
	}
}
