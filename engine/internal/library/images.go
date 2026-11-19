package library

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image/jpeg"
	"os"
	"path/filepath"
)

func (l *Library) ImagePath(ref string) (string, error) {
	b, err := hex.DecodeString(ref)
	if err != nil || len(b) != sha256.Size || hex.EncodeToString(b) != ref {
		return "", errors.New("invalid screenshot reference")
	}
	return filepath.Join(l.Dir, "images", ref+".jpg"), nil
}

func (l *Library) Image(ref string) ([]byte, error) {
	path, err := l.ImagePath(ref)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

// Compare to the retained image, rather than the last incoming frame, so small
// changes cannot accumulate into an unrelated screenshot. Metadata stays fresh.
func (l *Library) deduplicate(r Record, p *Payload) []byte {
	if len(p.JPEG) == 0 {
		p.JPEGRef = ""
		return nil
	}
	if n := len(l.Index.Observations); n > 0 {
		previous := l.Index.Observations[n-1]
		if previous["displayID"] == r["displayID"] && previous["captureScope"] == r["captureScope"] {
			if old, err := l.Payload(previous.ID()); err == nil && similar(p.JPEG, old.JPEG) {
				p.JPEG = old.JPEG
				r["duplicateOf"] = previous.ID()
				r["screenshotDate"] = previous.Date()
				if date, ok := previous["screenshotDate"].(float64); ok {
					r["screenshotDate"] = date
				}
			}
		}
	}
	hash := sha256.Sum256(p.JPEG)
	p.JPEGRef = hex.EncodeToString(hash[:])
	if _, reused := r["duplicateOf"]; !reused {
		r["screenshotDate"] = r.Date()
	}
	r["screenshotRef"] = p.JPEGRef
	r["screenshotBytes"] = float64(len(p.JPEG))
	image := p.JPEG
	p.JPEG = nil
	return image
}

func similar(a, b []byte) bool {
	if bytes.Equal(a, b) {
		return true
	}
	left, err := jpeg.Decode(bytes.NewReader(a))
	if err != nil {
		return false
	}
	right, err := jpeg.Decode(bytes.NewReader(b))
	if err != nil || left.Bounds() != right.Bounds() {
		return false
	}
	bounds := left.Bounds()
	changed, total, difference := 0, 0, uint64(0)
	// A fixed sample grid bounds comparison work for Retina/4K displays.
	for y := bounds.Min.Y; y < bounds.Max.Y; y += max(1, bounds.Dy()/128) {
		for x := bounds.Min.X; x < bounds.Max.X; x += max(1, bounds.Dx()/128) {
			lr, lg, lb, _ := left.At(x, y).RGBA()
			rr, rg, rb, _ := right.At(x, y).RGBA()
			d := func(a, b uint32) uint64 {
				if a > b {
					return uint64((a - b) >> 8)
				}
				return uint64((b - a) >> 8)
			}
			r, g, b := d(lr, rr), d(lg, rg), d(lb, rb)
			difference += r + g + b
			if max(r, g, b) > 24 {
				changed++
			}
			total++
		}
	}
	// Ignore tiny changes such as a caret or clock; larger changes get new pixels.
	return total > 0 && changed*200 <= total && difference <= uint64(total)*3
}
