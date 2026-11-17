package main

import (
	"encoding/json"
	"github.com/hackclub/breadcrumb/engine/internal/library"
	"os"
	"path/filepath"
	"testing"
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
func TestPortalURLMustBeAnHTTPSOrigin(t *testing.T) {
	for _, server := range []string{"http://evil.example", "https://example.com@evil.example/path", "https://example.com/path", "https://example.com?token=secret", "https://example.com#fragment"} {
		if validateServer(server) == nil {
			t.Errorf("accepted invalid portal %s", server)
		}
	}
	for _, server := range []string{"https://example.com", "http://localhost:3000", "http://127.0.0.1:3000"} {
		if err := validateServer(server); err != nil {
			t.Errorf("rejected portal %s: %v", server, err)
		}
	}
}
