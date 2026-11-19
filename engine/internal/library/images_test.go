package library

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func screenshot(t *testing.T, patch int) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, 256, 256))
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			c := color.RGBA{30, 30, 30, 255}
			if x < patch && y < patch {
				c = color.RGBA{220, 220, 220, 255}
			}
			im.SetRGBA(x, y, c)
		}
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, im, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestScreenshotReuseSurvivesRetentionAndExport(t *testing.T) {
	l, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	first := screenshot(t, 0)
	if err = l.Append(record(id1, now.Add(-time.Hour)), Payload{JPEG: first, Tree: []Node{{Role: "old"}}}, now); err != nil {
		t.Fatal(err)
	}
	text := "Fresh OCR"
	if err = l.Append(record(id2, now), Payload{JPEG: screenshot(t, 3), Tree: []Node{{Role: "new"}}, ScreenText: &text}, now); err != nil {
		t.Fatal(err)
	}
	if l.Index.Observations[1]["duplicateOf"] != id1 {
		t.Fatal("small change should reuse image")
	}
	files, _ := os.ReadDir(filepath.Join(l.Dir, "images"))
	if len(files) != 1 {
		t.Fatalf("stored %d images", len(files))
	}
	// Delete the original observation while keeping its shared pixels alive.
	l.Index.Observations = l.Index.Observations[1:]
	if err = l.commit(l.Index); err != nil {
		t.Fatal(err)
	}
	l, err = Open(l.Dir)
	if err != nil {
		t.Fatal(err)
	}
	p, err := l.Payload(id2)
	if err != nil || !bytes.Equal(p.JPEG, first) || p.Tree[0].Role != "new" || *p.ScreenText != text {
		t.Fatalf("lost pixels or fresh metadata: %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(l.Dir, id2+".json"))
	var stored Payload
	json.Unmarshal(raw, &stored)
	if len(stored.JPEG) != 0 || stored.JPEGRef == "" {
		t.Fatal("payload should store a reference")
	}
	if _, err = l.Save("clip", "Shared", 0, Timestamp(now)); err != nil {
		t.Fatal(err)
	}
	if err = l.Export("clip", filepath.Join(t.TempDir(), "clip.zip")); err != nil {
		t.Fatal(err)
	}
	if err = l.DeleteSince(0); err != nil {
		t.Fatal(err)
	}
	files, _ = os.ReadDir(filepath.Join(l.Dir, "images"))
	if len(files) != 0 {
		t.Fatal("unreferenced pixels retained")
	}
}

func TestScreenshotChangesAndReferenceValidation(t *testing.T) {
	if similar(screenshot(t, 0), screenshot(t, 64)) {
		t.Fatal("meaningful screen changes must retain new pixels")
	}
	if similar([]byte("invalid"), screenshot(t, 0)) {
		t.Fatal("invalid image compared as equal")
	}
	l, _ := Open(t.TempDir())
	if _, err := l.Image("../../outside"); err == nil {
		t.Fatal("unsafe image reference accepted")
	}
}
