package main

import (
	"encoding/json"
	"github.com/hackclub/breadcrumb/engine/internal/library"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDeleteRecentPersistsPause(t *testing.T) {
	dir := t.TempDir()
	lib, _ := library.Open(dir)
	e := &engine{lib: lib, recording: true, exclusions: []string{}}
	if _, err := e.dispatch("deleteRecent", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	var state struct {
		Recording bool `json:"recording"`
	}
	b, err := os.ReadFile(filepath.Join(dir, "desktop-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(b, &state)
	if state.Recording {
		t.Fatal("recording intent not paused")
	}
}
func TestDemoBlocksUploadsAndMaintainsSessions(t *testing.T) {
	lib, _ := library.Open(t.TempDir())
	seed(lib)
		if len(lib.Index.Observations) != 12 {
		t.Fatal("demo frames missing")
	}
	if len(library.Sessions(lib.Index.Observations)) != 1 {
		t.Fatal("demo sessions missing")
	}
	if lib.Index.Observations[0].Date() > library.Timestamp(time.Now()) {
		t.Fatal("demo frames in future")
	}
	if validateServer("http://evil.example") == nil {
		t.Fatal("insecure server accepted")
	}
	if validateServer("https://example.com@evil.example/path") == nil {
		t.Fatal("credential URL accepted")
	}
}
