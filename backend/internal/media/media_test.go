package media

import (
	"bytes"
	"image"
	"image/png"
	"testing"
)

func TestSniffClassify(t *testing.T) {
	var pb bytes.Buffer
	png.Encode(&pb, image.NewRGBA(image.Rect(0, 0, 3, 2)))
	cases := []struct {
		name string
		data []byte
		mime string
		kind string
	}{
		{"png", pb.Bytes(), "image/png", KindImage},
		{"jpeg", []byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 'J', 'F', 'I', 'F', 0}, "image/jpeg", KindImage},
		{"gif", []byte("GIF89a\x01\x00\x01\x00"), "image/gif", KindImage},
		{"webp", []byte("RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp", KindImage},
		{"mp4", []byte("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00"), "video/mp4", KindVideo},
		{"mov", []byte("\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00"), "video/quicktime", KindVideo},
		{"webm", []byte("\x1A\x45\xDF\xA3\x9f\x42\x86\x81\x01"), "video/webm", KindVideo},
		{"html", []byte("<html><script>alert(1)</script>"), "text/html; charset=utf-8", ""},
		{"svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`), "text/plain; charset=utf-8", ""},
		{"heic", []byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00"), "application/octet-stream", ""},
		{"pdf", []byte("%PDF-1.4"), "application/pdf", ""},
	}
	for _, c := range cases {
		got := Sniff(c.data)
		if got != c.mime || Classify(got) != c.kind {
			t.Errorf("%s: sniff=%q kind=%q", c.name, got, Classify(got))
		}
	}
	if w, h, ok := ImageSizeBytes(pb.Bytes()); !ok || w != 3 || h != 2 {
		t.Error("ImageSize")
	}
}
