package secretbox

import (
	"bytes"
	"testing"
)

func TestSealOpenSign(t *testing.T) {
	b, err := New(bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	ct := b.Seal([]byte("secret"))
	if bytes.Contains(ct, []byte("secret")) {
		t.Fatal("plaintext visible")
	}
	pt, err := b.Open(ct)
	if err != nil || string(pt) != "secret" {
		t.Fatal(err)
	}
	ct[len(ct)-1] ^= 1
	if _, err := b.Open(ct); err == nil {
		t.Fatal("tamper not detected")
	}
	other, _ := New(bytes.Repeat([]byte{2}, 32))
	if _, err := other.Open(b.Seal([]byte("x"))); err == nil {
		t.Fatal("wrong key opened")
	}
	if !b.Verify("m", b.Sign("m")) || b.Verify("m2", b.Sign("m")) {
		t.Fatal("sign")
	}
	if _, err := New([]byte("short")); err == nil {
		t.Fatal("short key accepted")
	}
}
