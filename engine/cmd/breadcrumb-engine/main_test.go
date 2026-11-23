package main

import (
	"encoding/json"
	"github.com/hackclub/breadcrumb/engine/internal/adapter"
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

type idleAdapter struct{ idle *float64 }

func (a idleAdapter) Request(command string, _ library.Settings, _ []string) (adapter.Response, error) {
	response := adapter.Response{OK: true, ContextKey: "Editor:1:main.go", IdleSeconds: a.idle}
	if command == "capture" {
		response.Record = library.Record{"app": "Editor", "bundleID": "Editor", "windowTitle": "main.go"}
		response.Payload = library.Payload{JPEG: []byte{0xff, 0xd8, 0xff, 0xd9}}
	}
	return response, nil
}
func (idleAdapter) Close() error { return nil }

func TestCapturePausesWhileAway(t *testing.T) {
	for _, tc := range []struct {
		name     string
		idle     *float64
		captured bool
	}{
		{"away", ptr(5 * 60), false},
		{"active", ptr(42.4), true},
		{"unknown", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lib, err := library.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			e := &engine{lib: lib, recording: true, capture: idleAdapter{tc.idle}}
			e.tick()
			rows := lib.Index.Observations
			if got := len(rows) == 1; got != tc.captured {
				t.Fatalf("captured = %v, want %v (status %q)", got, tc.captured, e.status)
			}
			if !tc.captured && e.status != "Paused while you’re away" {
				t.Fatalf("status = %q", e.status)
			}
			if tc.captured && tc.idle != nil && rows[0]["idleSeconds"] != float64(42) {
				t.Fatalf("idleSeconds = %v", rows[0]["idleSeconds"])
			}
		})
	}
}

func TestOlderSettingsKeepIdleDefault(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"retentionHours":0,"storageGiB":20,"savedStorageGiB":4,"intervalSeconds":60,"captureChanges":true,"minimumEventInterval":10,"recognizeText":true,"jpegQuality":0.65,"maximumWidth":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	lib, err := library.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if lib.Settings.IdleMinutes != 5 || lib.Settings.MaximumWidth != 0 {
		t.Fatalf("settings = %+v", lib.Settings)
	}
}

func ptr(value float64) *float64 { return &value }

type sharingAdapter struct{ commands []string }

func (a *sharingAdapter) Request(command string, _ library.Settings, _ []string) (adapter.Response, error) {
	a.commands = append(a.commands, command)
	return adapter.Response{OK: true, Capabilities: adapter.Capabilities{Backend: "Wayland portal + PipeWire", Permission: "portal-required"}}, nil
}
func (*sharingAdapter) Close() error { return nil }

func TestPauseEndsWaylandSharing(t *testing.T) {
	lib, err := library.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	capture := &sharingAdapter{}
	e := &engine{lib: lib, capture: capture, recording: true, capabilities: adapter.Capabilities{Backend: "Wayland portal + PipeWire", Screenshot: true}}
	if _, err := e.dispatch("toggle", nil); err != nil {
		t.Fatal(err)
	}
	if e.recording || e.capabilities.Screenshot || len(capture.commands) != 1 || capture.commands[0] != "suspend-sharing" {
		t.Fatalf("pause did not end sharing: %+v, %v", e.capabilities, capture.commands)
	}
	if _, err := e.dispatch("toggle", nil); err != nil {
		t.Fatal(err)
	}
	if len(capture.commands) != 1 {
		t.Fatal("resuming must not silently reopen the picker")
	}
}
