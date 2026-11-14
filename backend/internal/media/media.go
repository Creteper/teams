// Package media sniffs uploaded file types and reads image dimensions.
package media

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"

	_ "golang.org/x/image/webp"
)

const (
	KindImage = "image"
	KindVideo = "video"
)

var imageTypes = map[string]bool{"image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true}
var videoTypes = map[string]bool{"video/mp4": true, "video/webm": true, "video/quicktime": true}

// Sniff detects the MIME type from the first bytes (up to 512).
func Sniff(head []byte) string {
	if len(head) >= 12 && string(head[4:8]) == "ftyp" {
		if string(head[8:12]) == "qt  " {
			return "video/quicktime"
		}
		// image/avif, heic etc. share ftyp; only accept common video brands.
		switch string(head[8:12]) {
		case "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VP", "dash", "3gp4", "3gp5", "MSNV":
			return "video/mp4"
		}
	}
	return http.DetectContentType(head)
}

// Classify returns the attachment kind for an allowed MIME type, or "".
func Classify(mime string) string {
	switch {
	case imageTypes[mime]:
		return KindImage
	case videoTypes[mime]:
		return KindVideo
	}
	return ""
}

func IsImage(mime string) bool { return imageTypes[mime] }

// ImageSize returns width/height for a supported image, ok=false otherwise.
func ImageSize(r io.Reader) (int, int, bool) {
	cfg, _, err := image.DecodeConfig(r)
	if err != nil {
		return 0, 0, false
	}
	return cfg.Width, cfg.Height, true
}

// ImageSizeBytes is ImageSize for an in-memory buffer.
func ImageSizeBytes(b []byte) (int, int, bool) { return ImageSize(bytes.NewReader(b)) }
