package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/hackclub/breadcrumb/engine/internal/library"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func syncFixture(t *testing.T, server string) *engine {
	t.Helper()
	lib, err := library.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		r := library.Record{"id": uuid(), "date": library.Timestamp(time.Now().Add(-time.Duration(i) * time.Minute)), "app": "Synthetic editor", "bundleID": "test.editor", "windowTitle": "Synthetic test"}
		if err = lib.Append(r, library.Payload{JPEG: []byte{1, 2, 3}}, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	return &engine{lib: lib, credentials: credentials{Server: server, Token: strings.Repeat("a", 64), Participant: strings.Repeat("b", 64), Email: "synthetic@example.invalid", AutoSync: true, UploadConcurrency: 1}}
}
func TestSyncResumesImmutableQueueAfterFailureAndRetention(t *testing.T) {
	var mu sync.Mutex
	attempts := 0
	seen := map[string]string{}
	failed := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var value struct {
			Record library.Record `json:"record"`
		}
		json.Unmarshal(data, &value)
		mu.Lock()
		defer mu.Unlock()
		attempts++
		id := value.Record.ID()
		metadata, _ := json.Marshal(value.Record)
		if before, ok := seen[id]; ok && before != string(metadata) {
			t.Error("retry changed the immutable capture")
		}
		seen[id] = string(metadata)
		if !failed {
			failed = true
			http.Error(w, "Temporary failure", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	e := syncFixture(t, server.URL)
	e.syncOnce()
	if len(e.syncPending) != 2 || len(e.syncSent) != 0 {
		t.Fatal("failed capture was not retained")
	}
	e.lib.Correct(e.lib.Index.Observations[0].ID(), "Reading")
	// Queue payloads remain readable even after the rolling library expires them.
	if err := e.lib.DeleteSince(0); err != nil {
		t.Fatal(err)
	}
	restarted := &engine{lib: e.lib, credentials: e.credentials}
	restarted.syncOnce()
	restarted.syncOnce()
	if len(restarted.syncSent) != 2 || len(restarted.syncPending) != 0 {
		t.Fatalf("restart did not finish the queue: %v", restarted.syncState())
	}
	next := &engine{lib: e.lib, credentials: e.credentials}
	next.syncOnce()
	mu.Lock()
	defer mu.Unlock()
	if attempts != 3 || len(seen) != 2 {
		t.Fatalf("unexpected attempts %d, captures %d", attempts, len(seen))
	}
	files, _ := os.ReadDir(filepath.Join(next.syncProfile, "pending"))
	if len(files) != 0 {
		t.Fatal("acknowledged snapshots remain")
	}
}

func TestSharedScreenshotQueueRetainsPixelsAndOnlyUploadsThemOnce(t *testing.T) {
	images, full, references := map[string]bool{}, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var capture queuedCapture
		if err := json.NewDecoder(r.Body).Decode(&capture); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if len(capture.Payload.JPEG) == 0 {
			if !images[capture.Payload.JPEGRef] {
				http.Error(w, "Screenshot reference unavailable", 409)
				return
			}
			references++
		} else {
			if string(capture.Payload.JPEG) != string([]byte{1, 2, 3}) {
				t.Error("lost queued pixels")
			}
			full++
			images[capture.Payload.JPEGRef] = true
		}
		io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	e := syncFixture(t, server.URL)
	if err := e.loadSync(e.credentials); err != nil {
		t.Fatal(err)
	}
	if err := e.lib.DeleteSince(0); err != nil {
		t.Fatal(err)
	}
	restarted := &engine{lib: e.lib, credentials: e.credentials}
	restarted.syncOnce()
	restarted.syncOnce()
	if full != 1 || references != 1 || len(restarted.syncSent) != 2 {
		t.Fatalf("full=%d references=%d sent=%d error=%s", full, references, len(restarted.syncSent), restarted.syncError)
	}
	// Estimates use measured completions and disappear while sync is failing.
	now := time.Now()
	restarted.syncPending = map[string]bool{"a": true, "b": true}
	restarted.syncSamples = []time.Time{now.Add(-20 * time.Second), now.Add(-10 * time.Second), now}
	state := restarted.syncState()
	if eta, ok := state["etaSeconds"].(*int); !ok || eta == nil || *eta < 20 || *eta > 21 {
		t.Fatalf("invalid ETA: %v", state["etaSeconds"])
	}
	restarted.syncError = "Offline"
	if eta := restarted.syncState()["etaSeconds"].(*int); eta != nil {
		t.Fatal("failure should hide ETA")
	}
}
func TestSyncDoesNotBlockCaptureAndDisconnectCancelsUpload(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/revoke" {
			w.WriteHeader(204)
			return
		}
		close(started)
		select {
		case <-r.Context().Done():
		case <-release:
		}
		w.WriteHeader(503)
	}))
	defer server.Close()
	defer close(release)
	e := syncFixture(t, server.URL)
	done := make(chan struct{})
	go func() { e.syncOnce(); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("upload did not start")
	}
	available := make(chan struct{})
	go func() { e.mu.Lock(); e.mu.Unlock(); close(available) }()
	select {
	case <-available:
	case <-time.After(time.Second):
		t.Fatal("network upload held the capture lock")
	}
	e.mu.Lock()
	if err := e.disconnect(); err != nil {
		t.Error(err)
	}
	e.mu.Unlock()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect did not cancel the upload")
	}
	if e.credentials.AutoSync || e.credentials.Token != "" {
		t.Fatal("disconnect left sync enabled")
	}
}
func TestDesktopCallbackBindsStateAndExchangesPKCE(t *testing.T) {
	var redirect, challenge string
	var server *httptest.Server
	email := "synthetic@example.invalid"
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/auth/oauth2/register" {
			var input struct {
				Redirects []string `json:"redirect_uris"`
			}
			json.NewDecoder(r.Body).Decode(&input)
			redirect = input.Redirects[0]
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(map[string]string{"client_id": "synthetic-client"})
			return
		}
		if r.URL.Path == "/api/auth/oauth2/token" {
			r.ParseForm()
			hash := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if base64.RawURLEncoding.EncodeToString(hash[:]) != challenge || r.Form.Get("redirect_uri") != redirect {
				t.Error("PKCE or callback binding changed")
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": strings.Repeat("c", 64), "refresh_token": strings.Repeat("r", 64), "expires_in": 300, "token_type": "Bearer", "email": email, "participant": digestString(email)})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	e := syncFixture(t, server.URL)
	e.credentials = credentials{}
	e.mu.Lock()
	result, err := e.beginSignIn(server.URL)
	flow := e.auth
	e.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	defer flow.cancel()
	authorize, _ := url.Parse(result.(map[string]string)["url"])
	state := authorize.Query().Get("state")
	challenge = authorize.Query().Get("code_challenge")
	bad, err := http.Get(redirect + "?state=wrong&code=synthetic&iss=" + url.QueryEscape(server.URL+"/api/auth"))
	if err != nil {
		t.Fatal(err)
	}
	bad.Body.Close()
	if bad.StatusCode != 400 {
		t.Fatal("wrong state accepted")
	}
	response, err := http.Get(redirect + "?state=" + url.QueryEscape(state) + "&code=synthetic-code&iss=" + url.QueryEscape(server.URL+"/api/auth"))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("callback failed")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.credentials.AutoSync || e.credentials.Email != email || e.authCompleted == 0 || e.auth != nil || e.credentials.RefreshToken == "" {
		t.Fatalf("callback did not establish sync: %v", e.state())
	}
	raw, _ := os.ReadFile(filepath.Join(e.lib.Dir, "connection.json"))
	var saved credentials
	json.Unmarshal(raw, &saved)
	if !saved.AutoSync || saved.ClientID != "synthetic-client" {
		t.Fatal("OAuth connection was not persisted")
	}
}
func TestSyncRefreshesAndPersistsRotatedCredentials(t *testing.T) {
	var refreshes int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "old-refresh" {
			t.Error("invalid refresh grant")
		}
		refreshes++
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","expires_in":300}`)
	}))
	defer server.Close()
	e := syncFixture(t, server.URL)
	e.credentials.ClientID = "synthetic-client"
	e.credentials.RefreshToken = "old-refresh"
	e.credentials.Expires = time.Now().Add(-time.Minute).Format(time.RFC3339)
	e.syncOnce()
	if refreshes != 1 || e.credentials.Token != "new-access" || e.credentials.RefreshToken != "new-refresh" {
		t.Fatal("refresh rotation was not applied")
	}
	raw, _ := os.ReadFile(filepath.Join(e.lib.Dir, "connection.json"))
	var saved credentials
	json.Unmarshal(raw, &saved)
	if saved.RefreshToken != "new-refresh" {
		t.Fatal("rotated token was not persisted")
	}
}

func TestParallelSyncIsBoundedAndFasterWithoutDuplicateCaptures(t *testing.T) {
	var mu sync.Mutex
	active, peak := 0, 0
	seen := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var capture queuedCapture
		if err := json.NewDecoder(r.Body).Decode(&capture); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		active++
		if active > peak {
			peak = active
		}
		seen[capture.Record.ID()]++
		mu.Unlock()
		time.Sleep(60 * time.Millisecond)
		io.WriteString(w, `{"ok":true}`)
		mu.Lock()
		active--
		mu.Unlock()
	}))
	defer server.Close()
	run := func(concurrency int) time.Duration {
		e := syncFixture(t, server.URL)
		e.credentials.UploadConcurrency = concurrency
		for i := 0; i < 10; i++ {
			r := library.Record{"id": uuid(), "date": library.Timestamp(time.Now()), "app": "Synthetic", "bundleID": "test.synthetic", "windowTitle": "Upload benchmark"}
			if err := e.lib.Append(r, library.Payload{JPEG: []byte{byte(i + 10), 2, 3}, Tree: []library.Node{}}, time.Now()); err != nil {
				t.Fatal(err)
			}
		}
		started := time.Now()
		for e.syncOnce() {
		}
		if len(e.syncSent) != 12 || len(e.syncPending) != 0 {
			t.Fatalf("incomplete sync: %v", e.syncState())
		}
		if e.syncBytes == 0 || e.syncSessionUploaded != 12 {
			t.Fatal("missing transfer metrics")
		}
		return time.Since(started)
	}
	serial := run(1)
	parallel := run(4)
	mu.Lock()
	defer mu.Unlock()
	if peak != 4 {
		t.Fatalf("expected a maximum of 4 concurrent requests, got %d", peak)
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("capture %s uploaded %d times", id, count)
		}
	}
	t.Logf("Synthetic 60ms request latency, 12 captures: serial=%s parallel=%s speedup=%.2fx", serial, parallel, float64(serial)/float64(parallel))
}

func TestPauseCancelsEveryUploadAndResumesWithoutLosingQueue(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		started <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-release:
			io.WriteString(w, `{"ok":true}`)
		}
	}))
	defer server.Close()
	e := syncFixture(t, server.URL)
	e.credentials.UploadConcurrency = 2
	e.recording = true
	finished := make(chan struct{})
	go func() { e.syncOnce(); close(finished) }()
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			close(release)
			t.Fatal("uploads did not run concurrently")
		}
	}
	if _, err := e.dispatch("syncOptions", json.RawMessage(`{"paused":true}`)); err != nil {
		close(release)
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("pause did not cancel all uploads")
	}
	if !e.recording || len(e.syncPending) != 2 || len(e.syncFailures) != 0 || e.syncOnce() {
		close(release)
		t.Fatal("pause changed recording, lost work, or kept uploading")
	}
	close(release)
	if _, err := e.dispatch("syncOptions", json.RawMessage(`{"paused":false,"concurrency":1}`)); err != nil {
		t.Fatal(err)
	}
	for e.syncOnce() {
	}
	if len(e.syncSent) != 2 || len(e.syncPending) != 0 {
		t.Fatal("resume did not finish queue")
	}
	var saved credentials
	data, _ := os.ReadFile(filepath.Join(e.lib.Dir, "connection.json"))
	json.Unmarshal(data, &saved)
	if saved.SyncPaused || saved.UploadConcurrency != 1 {
		t.Fatal("sync options did not persist")
	}
}

func TestStoppedConnectionExplainsHowToResume(t *testing.T) {
	lib, err := library.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := &engine{lib: lib, credentials: credentials{Server: "https://example.com", Token: "token"}}
	if message, _ := e.syncState()["error"].(string); !strings.Contains(message, "Sign in again") {
		t.Fatalf("stopped sync did not explain how to resume: %q", message)
	}
	e.credentials.AutoSync = true
	e.credentials.SyncPaused = true
	e.syncProfile = e.syncDirectory(e.credentials)
	e.syncSent = map[string]bool{}
	if message, _ := e.syncState()["error"].(string); message != "" {
		t.Fatalf("enabled sync reported an error: %q", message)
	}
}
