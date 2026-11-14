package storage

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestLocalDisk(t *testing.T) {
	ctx := context.Background()
	d, err := NewLocalDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if n, err := d.Put(ctx, "a/b/c", strings.NewReader("hello")); err != nil || n != 5 {
		t.Fatal(n, err)
	}
	f, err := d.Open(ctx, "a/b/c")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(f)
	f.Close()
	if string(b) != "hello" {
		t.Fatal(string(b))
	}
	for _, k := range []string{"../x", "/etc/passwd", "a/../../x", ""} {
		if _, err := d.Put(ctx, k, strings.NewReader("x")); err == nil {
			t.Errorf("key %q accepted", k)
		}
	}
	if err := d.Delete(ctx, "a/b/c"); err != nil {
		t.Fatal(err)
	}
	if err := d.Delete(ctx, "a/b/c"); err != nil {
		t.Fatal("delete missing should be nil")
	}
}
