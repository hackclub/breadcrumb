package main

import (
	"context"
	"encoding/json"
	"github.com/hackclub/breadcrumb/engine/internal/agentusage"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestAgentUploadOnlyAggregates(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.Path != "/v1/agents/ingest" || r.Header.Get("Authorization") != "Bearer usage-only" {
			t.Error("invalid boundary")
		}
		raw, _ := io.ReadAll(r.Body)
		for _, private := range []string{"prompt", "response", "cwd", "sessionId", "SENTINEL"} {
			if strings.Contains(string(raw), private) {
				t.Error("private data uploaded")
			}
		}
		var body struct {
			Consent   bool                  `json:"consent"`
			Snapshots []agentusage.Snapshot `json:"snapshots"`
		}
		if json.Unmarshal(raw, &body) != nil || !body.Consent || len(body.Snapshots) != 1 {
			t.Error("invalid snapshots")
		}
		w.Write([]byte(`{"accepted":1}`))
	}))
	defer server.Close()
	err := uploadAgentSnapshots(context.Background(), credentials{Token: "usage-only", Server: server.URL}, []agentusage.Snapshot{{Source: strings.Repeat("a", 32), Hour: time.Now().UTC().Truncate(time.Hour).Format(time.RFC3339), Revision: 1, Rows: []agentusage.SyncRow{{Provider: "codex", Model: "gpt-5.4", Tokens: agentusage.Tokens{Input: 100, Output: 10}}}}})
	if err != nil || !called {
		t.Fatal(err)
	}
}
func TestAgentSyncNeedsOptInAndScope(t *testing.T) {
	e := syncFixture(t, "https://breadcrumb.example")
	if status := e.agentSyncStatus(); status["enabled"] != false || status["allowed"] != false {
		t.Fatal("token usage must be off for connections without agents:sync", status)
	}
	status, err := e.dispatch("agentUsageSync", json.RawMessage(`{"enabled":true}`))
	if err != nil || !e.credentials.AgentSync || status.(map[string]any)["allowed"] != false {
		t.Fatal("preference was not saved, or a capture-only connection claimed token access", err)
	}
	var saved credentials
	raw, _ := os.ReadFile(filepath.Join(e.lib.Dir, "connection.json"))
	if json.Unmarshal(raw, &saved) != nil || !saved.AgentSync || saved.Token != e.credentials.Token {
		t.Fatal("preference was not persisted with the connection")
	}
	e.credentials.Scopes = strings.Join(desktopScopes, " ")
	if e.agentSyncStatus()["allowed"] != true {
		t.Fatal("combined connection should allow token usage")
	}
	if _, err = e.dispatch("agentUsageSync", json.RawMessage(`{"disconnect":true}`)); err != nil || e.credentials.AgentSync || e.credentials.Token == "" {
		t.Fatal("turning off token usage must keep capture sync connected")
	}
	if got := oauthConfig(credentials{}, "").Scopes; strings.Join(got, " ") != "email offline_access captures:sync agents:sync" {
		t.Fatal("desktop sign-in must request one combined connection", got)
	}
}

func TestLegacyTokenUsageConnectionIsRetired(t *testing.T) {
	revoked := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.URL.Path == "/api/auth/oauth2/revoke" {
			revoked <- r.Form.Get("client_id")
		}
	}))
	defer server.Close()
	e := syncFixture(t, server.URL)
	legacy := credentials{AgentOnly: true, ClientID: "legacy-usage", Server: server.URL, Token: "t", RefreshToken: "r", AutoSync: true}
	if err := writePrivate(filepath.Join(e.lib.Dir, "agent-connection.json"), legacy); err != nil {
		t.Fatal(err)
	}
	e.migrateAgentConnection()
	if _, err := os.Stat(filepath.Join(e.lib.Dir, "agent-connection.json")); !os.IsNotExist(err) {
		t.Fatal("legacy connection file remains")
	}
	if !e.credentials.AgentSync || !slices.Contains(e.device.Replaces, "legacy-usage") {
		t.Fatal("preference or replacement was lost", e.credentials.AgentSync, e.device.Replaces)
	}
	select {
	case id := <-revoked:
		if id != "legacy-usage" {
			t.Fatal("revoked the wrong client", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("legacy connection was not revoked")
	}
}

func TestDeviceRegistersOnceAndReplacesOlderConnections(t *testing.T) {
	posts := 0
	var body map[string]any
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/device" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
			t.Error("unexpected request", r.URL.Path)
		}
		posts++
		body = nil
		json.NewDecoder(r.Body).Decode(&body)
		if fail {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte(`{"replaced":1}`))
	}))
	defer server.Close()
	e := syncFixture(t, server.URL)
	e.credentials.ClientID = "current"
	e.credentials.Expires = time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)
	e.appVersion = "0.2.9"
	e.deviceName = "Synthetic laptop"
	device, err := loadDevice(e.lib.Dir)
	if err != nil || len(device.ID) < 8 {
		t.Fatal("device id", err)
	}
	e.device = device
	e.replaceConnection("old-usage")
	e.replaceConnection("current")
	fail = true
	e.registerDevice()
	if posts != 1 || e.device.Registered != "" || e.deviceRetry.IsZero() {
		t.Fatal("a failed registration must retry later")
	}
	e.registerDevice()
	if posts != 1 {
		t.Fatal("registration retried before its backoff")
	}
	fail = false
	e.deviceRetry = time.Time{}
	e.registerDevice()
	if posts != 2 || body["deviceId"] != device.ID || body["name"] != "Synthetic laptop" || body["platform"] != devicePlatform() || body["version"] != "0.2.9" {
		t.Fatal("unexpected device details", body)
	}
	if replaces, _ := body["replaces"].([]any); len(replaces) != 1 || replaces[0] != "old-usage" {
		t.Fatal("must replace older connections but never itself", body["replaces"])
	}
	if len(e.device.Replaces) != 0 || e.device.Registered == "" {
		t.Fatal("registration was not recorded", e.device)
	}
	e.registerDevice()
	if posts != 2 {
		t.Fatal("registered again without changes")
	}
	reloaded, _ := loadDevice(e.lib.Dir)
	if reloaded.ID != device.ID || reloaded.Registered != e.device.Registered {
		t.Fatal("device record was not persisted")
	}
	e.appVersion = "0.3.0"
	e.registerDevice()
	if posts != 3 || body["version"] != "0.3.0" {
		t.Fatal("app updates must refresh the device details")
	}
}
