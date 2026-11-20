package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/hackclub/breadcrumb/engine/internal/adapter"
	"github.com/hackclub/breadcrumb/engine/internal/agentusage"
	"github.com/hackclub/breadcrumb/engine/internal/library"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type engine struct {
	usage               *agentusage.Store
	needsSetup          bool
	mu                  sync.Mutex
	lib                 *library.Library
	capture             adapter.Adapter
	recording           bool
	status              string
	capabilities        adapter.Capabilities
	exclusions          []string
	lastContext         string
	pending             string
	changed             time.Time
	lastAttempt         time.Time
	lastSample          time.Time
	fingerprint         string
	credentials         credentials
	auth                *desktopAuth
	authError           string
	authCompleted       int64
	syncCancel          context.CancelFunc
	syncInFlight        bool
	syncProfile         string
	syncSent            map[string]bool
	syncPending         map[string]bool
	syncFailures        map[string]syncFailure
	syncError           string
	syncLast            string
	syncSamples         []time.Time
	syncTransfers       map[string]syncTransfer
	syncImages          map[string]bool
	syncBytes           int64
	syncByteSamples     []syncByteSample
	syncSessionUploaded int
	syncReused          int
	syncBackoff         time.Time
	demo                bool
}
type credentials struct {
	ClientID          string `json:"clientID,omitempty"`
	RefreshToken      string `json:"refreshToken,omitempty"`
	Server            string `json:"server"`
	Token             string `json:"token"`
	Email             string `json:"email,omitempty"`
	Participant       string `json:"participant,omitempty"`
	Expires           string `json:"expires,omitempty"`
	AutoSync          bool   `json:"autoSync"`
	SyncPaused        bool   `json:"syncPaused,omitempty"`
	UploadConcurrency int    `json:"uploadConcurrency,omitempty"`
}

func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	h := hex.EncodeToString(b)
	return strings.ToUpper(h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:])
}
func defaultDirectory() (string, error) {
	var root string
	var e error
	if runtime.GOOS == "darwin" {
		home, e := os.UserHomeDir()
		if e != nil {
			return "", e
		}
		root = filepath.Join(home, "Library", "Application Support")
	} else if runtime.GOOS == "windows" {
		root = os.Getenv("LOCALAPPDATA")
		if root == "" {
			root, e = os.UserConfigDir()
		}
	} else {
		root = os.Getenv("XDG_DATA_HOME")
		if root == "" {
			var home string
			home, e = os.UserHomeDir()
			root = filepath.Join(home, ".local", "share")
		}

		if e != nil {
			return "", e
		}
	}
	current := filepath.Join(root, "Breadcrumb")
	legacy := filepath.Join(root, "Rewind")
	if _, e = os.Stat(current); os.IsNotExist(e) {
		if _, e = os.Stat(legacy); e == nil {
			if e = os.Rename(legacy, current); e != nil {
				return "", e
			}
		}
	}
	return current, nil
}
func (e *engine) state() map[string]any {
	history, saved := e.lib.Usage()
	rows := e.lib.Index.Observations
	return map[string]any{"recording": e.recording, "status": e.status, "settings": e.lib.Settings, "observations": rows, "clips": e.lib.Index.Clips, "sessions": library.Sessions(rows), "historyBytes": history, "savedBytes": saved, "capabilities": e.capabilities, "exclusions": e.exclusions, "server": e.credentials.Server, "connected": e.credentials.Token != "", "directory": e.lib.Dir, "demo": e.demo, "sync": e.syncState()}
}

// away reports whether input has been idle past the configured threshold. Unknown idle
// time (an older or unsupported adapter) keeps recording, as before.
func away(idle *float64, settings library.Settings) bool {
	return idle != nil && *idle >= float64(settings.IdleMinutes*60)
}
func (e *engine) tick() {
	e.mu.Lock()
	if !e.recording || e.demo || e.capture == nil {
		e.mu.Unlock()
		return
	}
	settings := e.lib.Settings
	exclusions := append([]string(nil), e.exclusions...)
	e.mu.Unlock()
	probe, err := e.capture.Request("probe", settings, exclusions)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.capabilities = probe.Capabilities
	if err != nil {
		e.status = err.Error()
		return
	}
	if !e.recording {
		return
	}
	now := time.Now()
	if away(probe.IdleSeconds, settings) {
		e.status = "Paused while you’re away"
		return
	}
	if probe.ContextKey == "" {
		e.status = "Waiting for an eligible foreground app"
		return
	}
	if probe.ContextKey != e.pending {
		e.pending = probe.ContextKey
		e.changed = now
	}
	interval := now.Sub(e.lastSample) >= time.Duration(settings.IntervalSeconds)*time.Second
	changed := settings.CaptureChanges && e.pending != e.lastContext && now.Sub(e.changed) >= 2*time.Second && now.Sub(e.lastAttempt) >= time.Duration(settings.MinimumEventInterval)*time.Second
	if !interval && !changed {
		return
	}
	if free, err := library.Available(e.lib.Dir); err != nil || free < 5*uint64(library.GiB) {
		e.status = "Capture paused: less than 5 GiB free disk space"
		return
	}
	e.lastAttempt = now
	e.mu.Unlock()
	response, err := e.capture.Request("capture", settings, exclusions)
	e.mu.Lock()
	e.capabilities = response.Capabilities
	if err != nil {
		e.status = err.Error()
		return
	}
	if !e.recording || e.lib.Settings != settings || strings.Join(e.exclusions, "\n") != strings.Join(exclusions, "\n") {
		return
	}
	if response.ContextKey != "" && response.ContextKey != probe.ContextKey {
		e.status = "Context changed during capture; skipped"
		return
	}
	r := response.Record
	if r == nil {
		e.status = "Capture adapter returned no record"
		return
	}
	r["id"] = uuid()
	r["date"] = library.Timestamp(time.Now())
	r["sampleIntervalSeconds"] = settings.IntervalSeconds
	if response.IdleSeconds != nil {
		r["idleSeconds"] = math.Round(*response.IdleSeconds)
	}
	if changed {
		r["captureReason"] = "contextChanged"
	} else {
		r["captureReason"] = "interval"
	}
	library.Enrich(r)
	digest := sha256.Sum256(response.Payload.JPEG)
	fingerprint := probe.ContextKey + hex.EncodeToString(digest[:])
	if changed && !interval && e.fingerprint == fingerprint {
		e.lastContext = probe.ContextKey
		return
	}
	if err = e.lib.Append(r, response.Payload, time.Now()); err != nil {
		e.status = err.Error()
		return
	}
	if e.credentials.AutoSync {
		if err := e.loadSync(e.credentials); err == nil {
			if err = e.queueCapture(r); err != nil {
				e.syncError = "Could not queue the latest capture: " + err.Error()
			}
		}
	}
	e.fingerprint = fingerprint
	e.lastContext = probe.ContextKey
	e.lastSample = time.Now()
	e.status = "Recording desktop activity"
}
func (e *engine) dispatch(command string, args json.RawMessage) (any, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch command {
	case "agentUsage":
		if e.usage == nil {
			return nil, errors.New("agent usage unavailable")
		}
		var input struct {
			Range    int    `json:"range"`
			TimeZone string `json:"timeZone"`
		}
		if err := json.Unmarshal(args, &input); err != nil {
			return nil, err
		}
		return e.usage.Query(input.Range, input.TimeZone, time.Now())
	case "agentUsageSettings":
		if e.usage == nil {
			return nil, errors.New("agent usage unavailable")
		}
		var input struct {
			Provider string `json:"provider"`
			Enabled  bool   `json:"enabled"`
		}
		if err := json.Unmarshal(args, &input); err != nil {
			return nil, err
		}
		if e.demo {
			return nil, errors.New("disabled in demo mode")
		}
		if input.Provider != "" {
			if err := e.usage.Configure(input.Provider, input.Enabled); err != nil {
				return nil, err
			}
		}
		return e.usage.Status(), nil
	case "appIcon":
		var input struct {
			BundleID string `json:"bundleID"`
		}
		if err := json.Unmarshal(args, &input); err != nil {
			return nil, err
		}
		id := input.BundleID
		if id == "" || len(id) > 512 || strings.ContainsAny(id, "/\\\x00") {
			return nil, fmt.Errorf("Invalid app identifier")
		}
		if e.demo || e.capture == nil {
			return map[string]string{"icon": ""}, nil
		}
		response, err := e.capture.Request("icon:"+id, e.lib.Settings, nil)
		if err != nil {
			return nil, err
		}
		return map[string]string{"icon": response.Icon}, nil
	case "state":
		return e.state(), nil
	case "status":
		return map[string]any{"recording": e.recording, "status": e.status, "authCompleted": e.authCompleted, "needsSetup": e.needsSetup}, nil
	case "toggle":
		e.recording = !e.recording
		if e.demo {
			e.recording = false
		}
		if e.recording {
			e.status = "Starting capture…"
		} else {
			e.status = "Paused"
		}
		if err := writePrivate(filepath.Join(e.lib.Dir, "desktop-state.json"), map[string]any{"recording": e.recording, "exclusions": e.exclusions}); err != nil {
			return nil, err
		}
		e.needsSetup = false
		return e.state(), nil
	case "settings":
		var s library.Settings
		if err := json.Unmarshal(args, &s); err != nil {
			return nil, err
		}
		if err := e.lib.SetSettings(s); err != nil {
			return nil, err
		}
		return e.state(), nil
	case "exclusions":
		var input struct {
			Bundles []string `json:"bundles"`
		}
		if err := json.Unmarshal(args, &input); err != nil {
			return nil, err
		}
		if len(input.Bundles) > 100 {
			return nil, errors.New("too many exclusions")
		}
		e.exclusions = input.Bundles
		if err := writePrivate(filepath.Join(e.lib.Dir, "desktop-state.json"), map[string]any{"recording": e.recording, "exclusions": e.exclusions}); err != nil {
			return nil, err
		}
		e.needsSetup = false
		return e.state(), nil
	case "payload":
		var input struct {
			ID string `json:"id"`
		}
		json.Unmarshal(args, &input)
		return e.lib.Payload(input.ID)
	case "save":
		var input struct {
			Name  string  `json:"name"`
			Start float64 `json:"start"`
			End   float64 `json:"end"`
		}
		if err := json.Unmarshal(args, &input); err != nil {
			return nil, err
		}
		_, err := e.lib.Save(uuid(), input.Name, input.Start, input.End)
		return e.state(), err
	case "deleteClip":
		var input struct {
			ID string `json:"id"`
		}
		json.Unmarshal(args, &input)
		err := e.lib.DeleteClip(input.ID)
		return e.state(), err
	case "deleteRecent":
		if e.syncCancel != nil {
			e.syncCancel()
		}
		e.credentials.SyncPaused = true
		if err := writePrivate(filepath.Join(e.lib.Dir, "connection.json"), e.credentials); err != nil {
			return nil, err
		}
		if err := e.discardRecentQueue(library.Timestamp(time.Now().Add(-time.Hour))); err != nil {
			return nil, err
		}
		e.recording = false
		e.status = "Paused"
		if err := writePrivate(filepath.Join(e.lib.Dir, "desktop-state.json"), map[string]any{"recording": false, "exclusions": e.exclusions}); err != nil {
			return nil, err
		}
		err := e.lib.DeleteSince(library.Timestamp(time.Now().Add(-time.Hour)))
		return e.state(), err
	case "correct":
		var input struct {
			ID       string `json:"id"`
			Activity string `json:"activity"`
		}
		json.Unmarshal(args, &input)
		allowed := map[string]bool{"": true, "Coding": true, "Terminal work": true, "Reading": true, "Video page": true, "Meeting app": true, "Messaging interface": true, "AI assistant page": true, "Social page": true, "Calendar interface": true, "Developer page": true, "Browser settings": true, "Browsing": true, "Music app": true, "Email app": true, "Unclassified": true}
		if !allowed[input.Activity] {
			return nil, errors.New("invalid activity")
		}
		err := e.lib.Correct(input.ID, input.Activity)
		return e.state(), err
	case "export":
		var input struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		}
		json.Unmarshal(args, &input)
		if err := library.ValidateExportPath(input.Path); err != nil {
			return nil, err
		}
		err := e.lib.Export(input.ID, input.Path)
		return map[string]string{"path": input.Path}, err
	case "beginSignIn":
		var input struct {
			Server string `json:"server"`
		}
		if err := json.Unmarshal(args, &input); err != nil {
			return nil, err
		}
		return e.beginSignIn(input.Server)
	case "cancelSignIn":
		if e.auth != nil {
			e.auth.cancel()
			e.auth = nil
		}
		e.authError = ""
		return e.state(), nil
	case "disconnect":
		err := e.disconnect()
		return e.state(), err
	case "syncOptions":
		if e.credentials.Token == "" {
			return nil, errors.New("Sign in before configuring sync")
		}
		var input struct {
			Paused      *bool `json:"paused"`
			Concurrency *int  `json:"concurrency"`
			Retry       bool  `json:"retry"`
		}
		if err := json.Unmarshal(args, &input); err != nil {
			return nil, err
		}
		c := e.credentials
		if input.Concurrency != nil {
			if *input.Concurrency != 1 && *input.Concurrency != 2 && *input.Concurrency != 4 {
				return nil, errors.New("Choose 1, 2, or 4 upload workers")
			}
			c.UploadConcurrency = *input.Concurrency
		}
		if input.Paused != nil {
			c.SyncPaused = *input.Paused
		}
		if err := writePrivate(filepath.Join(e.lib.Dir, "connection.json"), c); err != nil {
			return nil, err
		}
		e.credentials = c
		if input.Paused != nil || input.Concurrency != nil || input.Retry {
			e.syncSamples = nil
			e.syncByteSamples = nil
		}
		if c.SyncPaused && len(e.syncTransfers) > 0 && e.syncCancel != nil {
			e.syncCancel()
		}
		if input.Retry {
			e.syncFailures = map[string]syncFailure{}
			e.syncBackoff = time.Time{}
			e.syncError = ""
		}
		return e.state(), nil
	case "permissions":
		if e.capture == nil {
			return nil, errors.New("capture adapter unavailable")
		}
		response, err := e.capture.Request("permissions", e.lib.Settings, e.exclusions)
		return response, err
	}
	return nil, fmt.Errorf("unknown engine command %q", command)
}
func writePrivate(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".desktop-state-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
func main() {
	dir := flag.String("data-dir", "", "Local library directory")
	helper := flag.String("capture-helper", "", "Native capture executable")
	demo := flag.Bool("demo", false, "Synthetic library; never records or uploads")
	flag.Parse()
	if *dir == "" {
		value, err := defaultDirectory()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		*dir = value
	}
	lib, err := library.Open(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	e := &engine{lib: lib, status: "Paused", demo: *demo, exclusions: []string{}}
	if !*demo {
		usage, err := agentusage.Open(lib.Dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Agent usage unavailable")
		} else {
			e.usage = usage
			defer usage.Close()
			go func() {
				ticker := time.NewTicker(250 * time.Millisecond)
				defer ticker.Stop()
				for range ticker.C {
					usage.Scan(agentusage.Budget)
				}
			}()
		}
	}
	var previous struct {
		Recording  bool     `json:"recording"`
		Exclusions []string `json:"exclusions"`
	}
	_, stateErr := os.Stat(filepath.Join(*dir, "desktop-state.json"))
	e.needsSetup = os.IsNotExist(stateErr)
	if data, err := os.ReadFile(filepath.Join(*dir, "desktop-state.json")); err == nil {
		json.Unmarshal(data, &previous)
		e.recording = previous.Recording
		e.exclusions = previous.Exclusions
	}
	if data, err := os.ReadFile(filepath.Join(*dir, "connection.json")); err == nil {
		json.Unmarshal(data, &e.credentials)
	}
	if *helper != "" && !*demo {
		capture, err := adapter.Start(*helper)
		if err != nil {
			e.status = "Native capture adapter could not start"
		} else {
			e.capture = capture
			if probe, err := capture.Request("probe", lib.Settings, e.exclusions); err == nil {
				e.capabilities = probe.Capabilities
				if os.IsNotExist(stateErr) && probe.RecordingPreference != nil {
					e.recording = *probe.RecordingPreference
				}
			}
			defer capture.Close()
		}
	}
	if e.recording {
		e.status = "Starting capture…"
	}
	if *demo {
		e.recording = false
		seed(lib)
		e.status = "Demo · synthetic captures"
	}
	go func() {
		for {
			if !e.syncOnce() {
				time.Sleep(time.Second)
			}
		}
	}()
	go func() {
		lastMaintenance := time.Time{}
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			e.tick()
			e.mu.Lock()
			if time.Since(lastMaintenance) > 30*time.Second {
				lastMaintenance = time.Now()
				if err := e.lib.ImportSuggestions(); err != nil {
					e.status = err.Error()
				}
				if err := e.lib.Expire(time.Now()); err != nil {
					e.status = err.Error()
				}
			}
			e.mu.Unlock()
		}
	}()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID      int             `json:"id"`
			Command string          `json:"command"`
			Args    json.RawMessage `json:"args"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			encoder.Encode(map[string]any{"id": 0, "error": "invalid command JSON"})
			continue
		}
		var result any
		var err error
		if *demo && request.Command == "permissions" {
			err = errors.New("disabled in demo mode")
		} else {
			result, err = e.dispatch(request.Command, request.Args)
		}
		if err != nil {
			encoder.Encode(map[string]any{"id": request.ID, "error": err.Error()})
		} else {
			encoder.Encode(map[string]any{"id": request.ID, "result": result})
		}
	}
}
