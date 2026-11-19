package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/hackclub/breadcrumb/engine/internal/library"
	"golang.org/x/oauth2"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type syncFailure struct {
	Message string
	Retry   time.Time
}
type queuedCapture struct {
	Record      library.Record  `json:"record"`
	Payload     library.Payload `json:"payload"`
	PayloadFile string          `json:"payloadFile,omitempty"`
	ImageFile   string          `json:"imageFile,omitempty"`
}

func digestString(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}
func (e *engine) syncDirectory(c credentials) string {
	return filepath.Join(e.lib.Dir, "sync", digestString(c.Server+"|"+c.Participant))
}
func (e *engine) loadSync(c credentials) error {
	profile := e.syncDirectory(c)
	if e.syncProfile == profile && e.syncSent != nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Join(profile, "sent"), 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(profile, "pending"), 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(filepath.Join(profile, "sent"))
	if err != nil {
		return err
	}
	e.syncSent = map[string]bool{}
	e.syncPending = map[string]bool{}
	e.syncFailures = map[string]syncFailure{}
	e.syncError = ""
	e.syncLast = ""
	e.syncSamples = nil
	e.syncBackoff = time.Time{}
	for _, entry := range entries {
		if !entry.IsDir() {
			e.syncSent[entry.Name()] = true
		}
	}
	e.syncProfile = profile
	pending, err := os.ReadDir(filepath.Join(profile, "pending"))
	if err != nil {
		return err
	}
	for _, entry := range pending {
		if filepath.Ext(entry.Name()) == ".json" {
			e.syncPending[strings.TrimSuffix(entry.Name(), ".json")] = true
		}
	}
	for _, row := range e.lib.Index.Observations {
		if err := e.queueCapture(row); err != nil {
			e.syncFailures[digestString(row.ID())] = syncFailure{err.Error(), time.Now().Add(time.Minute)}
			e.syncError = "Some captures could not be queued. Sync will retry."
		}
	}
	return nil
}

// Pin the immutable payload with a hard link, so retention cannot remove queued work.
// Only metadata is copied on the normal path; filesystems without links use a private copy.
func (e *engine) queueCapture(row library.Record) error {
	if len(row.ID()) != 36 || filepath.Base(row.ID()) != row.ID() {
		return errors.New("Invalid capture ID")
	}
	id := digestString(row.ID())
	if e.syncSent[id] || e.syncPending[id] {
		return nil
	}
	target := filepath.Join(e.syncProfile, "pending", id+".payload")
	if _, err := os.Stat(target); os.IsNotExist(err) {
		if err = os.Link(filepath.Join(e.lib.Dir, row.ID()+".json"), target); err != nil {
			payload, readErr := e.lib.Payload(row.ID())
			if readErr != nil {
				return readErr
			}
			if err = writePrivate(target, payload); err != nil {
				return err
			}
		}
	}
	capture := queuedCapture{Record: row, PayloadFile: id + ".payload"}
	if ref, ok := row["screenshotRef"].(string); ok {
		source, err := e.lib.ImagePath(ref)
		if err != nil {
			return err
		}
		capture.ImageFile = id + ".jpg"
		target := filepath.Join(e.syncProfile, "pending", capture.ImageFile)
		if _, err = os.Stat(target); os.IsNotExist(err) {
			if err = os.Link(source, target); err != nil {
				data, readErr := os.ReadFile(source)
				if readErr != nil {
					return readErr
				}
				if err = os.WriteFile(target, data, 0600); err != nil {
					return err
				}
			}
		} else if err != nil {
			return err
		}
	}
	if err := writePrivate(filepath.Join(e.syncProfile, "pending", id+".json"), capture); err != nil {
		return err
	}
	e.syncPending[id] = true
	return nil
}
func (e *engine) syncState() map[string]any {
	pending, uploaded := 0, 0
	if e.credentials.AutoSync {
		if err := e.loadSync(e.credentials); err != nil {
			e.syncError = err.Error()
		}
	}
	if e.credentials.Token != "" && e.syncProfile == e.syncDirectory(e.credentials) {
		uploaded = len(e.syncSent)
		pending = len(e.syncPending)
		for key := range e.syncFailures {
			if !e.syncPending[key] {
				pending++
			}
		}
	}
	var eta *int
	if n := len(e.syncSamples); pending > 0 && n >= 3 && e.syncError == "" && time.Now().After(e.syncBackoff) {
		seconds := e.syncSamples[n-1].Sub(e.syncSamples[0]).Seconds() / float64(n-1)
		seconds = max(seconds, time.Since(e.syncSamples[n-1]).Seconds())
		remaining := max(1, int(seconds*float64(pending)))
		eta = &remaining
	}
	return map[string]any{"email": e.credentials.Email, "enabled": e.credentials.AutoSync, "uploaded": uploaded, "pending": pending, "etaSeconds": eta, "uploading": e.syncInFlight, "error": e.syncError, "failed": len(e.syncFailures), "lastSynced": e.syncLast, "signingIn": e.auth != nil, "authError": e.authError}
}
func (e *engine) syncOnce() {
	e.mu.Lock()
	if e.demo || !e.credentials.AutoSync || e.credentials.Token == "" || e.syncInFlight || time.Now().Before(e.syncBackoff) {
		e.mu.Unlock()
		return
	}
	c := e.credentials

	if expiry, err := time.Parse(time.RFC3339, c.Expires); err == nil && c.RefreshToken != "" && time.Until(expiry) < 30*time.Second {
		ctx, cancel := context.WithCancel(context.Background())
		e.syncCancel = cancel
		e.syncInFlight = true
		e.mu.Unlock()
		refreshed, refreshErr := refreshOAuth(ctx, c)
		cancel()
		e.mu.Lock()
		defer e.mu.Unlock()
		e.syncInFlight = false
		e.syncCancel = nil
		if e.credentials.Token != c.Token {
			return
		}
		if refreshErr == nil {
			e.credentials = refreshed
			if err = writePrivate(filepath.Join(e.lib.Dir, "connection.json"), refreshed); err != nil {
				e.credentials.AutoSync = false
				e.syncError = "Could not save the refreshed connection. Sign in again to resume."
			} else {
				e.syncError = ""
			}
		} else {
			var remote *oauth2.RetrieveError
			if errors.As(refreshErr, &remote) && (remote.Response.StatusCode == 400 || remote.Response.StatusCode == 401 || remote.Response.StatusCode == 403) {
				e.credentials.AutoSync = false
				e.syncError = "Your connection expired or was revoked. Sign in again to resume syncing."
				_ = writePrivate(filepath.Join(e.lib.Dir, "connection.json"), e.credentials)
			} else {
				e.syncBackoff = time.Now().Add(30 * time.Second)
				e.syncError = "Could not refresh your connection. Retrying automatically."
			}
		}
		return
	}
	if err := e.loadSync(c); err != nil {
		e.syncError = "Could not open the sync queue: " + err.Error()
		e.mu.Unlock()
		return
	}
	for _, row := range e.lib.Index.Observations {
		key := digestString(row.ID())
		if !e.syncSent[key] && !e.syncPending[key] && !time.Now().Before(e.syncFailures[key].Retry) {
			if err := e.queueCapture(row); err != nil {
				e.syncFailures[key] = syncFailure{err.Error(), time.Now().Add(time.Minute)}
			}
		}
	}
	var id string
	for candidate := range e.syncPending {
		if !time.Now().Before(e.syncFailures[candidate].Retry) {
			id = candidate
			break
		}
	}
	if id == "" {
		e.mu.Unlock()
		return
	}
	profile := e.syncProfile
	path := filepath.Join(profile, "pending", id+".json")
	var capture queuedCapture
	data, err := os.ReadFile(path)
	if err == nil {
		err = json.Unmarshal(data, &capture)
	}
	if err == nil && capture.PayloadFile != "" {
		if filepath.Base(capture.PayloadFile) != capture.PayloadFile {
			err = errors.New("Invalid queue payload")
		} else {
			data, err = os.ReadFile(filepath.Join(profile, "pending", capture.PayloadFile))
			if err == nil {
				err = json.Unmarshal(data, &capture.Payload)
			}
		}
	}
	if err != nil {
		e.syncFailures[id] = syncFailure{err.Error(), time.Now().Add(time.Minute)}
		e.syncError = "A capture could not be queued. Sync will retry."
		e.mu.Unlock()
		return
	}
	if capture.ImageFile != "" {
		if filepath.Base(capture.ImageFile) != capture.ImageFile {
			err = errors.New("Invalid queued screenshot")
		} else {
			capture.Payload.JPEG, err = os.ReadFile(filepath.Join(profile, "pending", capture.ImageFile))
		}
		if err != nil {
			e.syncError = "Could not read queued screenshot"
			e.syncFailures[id] = syncFailure{err.Error(), time.Now().Add(time.Minute)}
			e.mu.Unlock()
			return
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.syncCancel = cancel
	e.syncInFlight = true
	e.mu.Unlock()
	_, err = uploadTo(ctx, c, capture.Record, capture.Payload)
	cancel()
	// Persist acknowledgement before discarding the immutable retry snapshot.
	if err == nil {
		err = writePrivate(filepath.Join(profile, "sent", id), map[string]string{"id": capture.Record.ID(), "syncedAt": time.Now().UTC().Format(time.RFC3339)})
		if err == nil {
			_ = os.Remove(path)
			if capture.PayloadFile != "" {
				_ = os.Remove(filepath.Join(profile, "pending", capture.PayloadFile))
			}
			if capture.ImageFile != "" {
				_ = os.Remove(filepath.Join(profile, "pending", capture.ImageFile))
			}
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.syncInFlight = false
	e.syncCancel = nil
	if e.credentials.Server != c.Server || e.credentials.Token != c.Token {
		return
	}
	if err == nil {
		e.syncSent[id] = true
		now := time.Now()
		if n := len(e.syncSamples); n > 0 && now.Sub(e.syncSamples[n-1]) > 2*time.Minute {
			e.syncSamples = nil
		}
		e.syncSamples = append(e.syncSamples, now)
		if len(e.syncSamples) > 20 {
			e.syncSamples = e.syncSamples[1:]
		}
		delete(e.syncPending, id)
		delete(e.syncFailures, id)
		e.syncLast = time.Now().UTC().Format(time.RFC3339)
		e.syncError = ""
		return
	}
	var remote *apiError
	if errors.As(err, &remote) && (remote.Status == 401 || remote.Status == 403) {
		e.credentials.AutoSync = false
		e.syncError = "Your connection expired or was revoked. Sign in again to resume syncing."
		_ = writePrivate(filepath.Join(e.lib.Dir, "connection.json"), e.credentials)
		return
	}
	retry := time.Now().Add(30 * time.Second)
	if errors.As(err, &remote) && (remote.Status == 400 || remote.Status == 409 || remote.Status == 413) {
		retry = time.Now().Add(10 * time.Minute)
		e.syncError = "A capture could not be synced: " + remote.Error()
	} else {
		e.syncBackoff = retry
		e.syncError = "Sync interrupted. Retrying automatically."
	}
	e.syncFailures[id] = syncFailure{err.Error(), retry}
}

func (e *engine) discardRecentQueue(since float64) error {
	profiles, err := os.ReadDir(filepath.Join(e.lib.Dir, "sync"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, profile := range profiles {
		if !profile.IsDir() {
			continue
		}
		folder := filepath.Join(e.lib.Dir, "sync", profile.Name(), "pending")
		entries, err := os.ReadDir(folder)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			data, err := os.ReadFile(filepath.Join(folder, entry.Name()))
			if err != nil {
				return err
			}
			var capture queuedCapture
			if err = json.Unmarshal(data, &capture); err != nil {
				return err
			}
			if capture.Record.Date() >= since {
				if err = os.Remove(filepath.Join(folder, entry.Name())); err != nil {
					return err
				}
				if capture.PayloadFile != "" && filepath.Base(capture.PayloadFile) == capture.PayloadFile {
					if err = os.Remove(filepath.Join(folder, capture.PayloadFile)); err != nil && !os.IsNotExist(err) {
						return err
					}
				}
				if capture.ImageFile != "" && filepath.Base(capture.ImageFile) == capture.ImageFile {
					if err = os.Remove(filepath.Join(folder, capture.ImageFile)); err != nil && !os.IsNotExist(err) {
						return err
					}
				}
				delete(e.syncPending, strings.TrimSuffix(entry.Name(), ".json"))
			}
		}
	}
	return nil
}
