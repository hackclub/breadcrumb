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
	"sync"
	"time"
)

type syncFailure struct {
	Message string
	Retry   time.Time
}
type syncTransfer struct {
	ID   string  `json:"id"`
	App  string  `json:"app"`
	Date float64 `json:"date"`
}
type syncByteSample struct {
	At    time.Time
	Bytes int64
}

func syncConcurrency(c credentials) int {
	switch c.UploadConcurrency {
	case 1, 2, 4:
		return c.UploadConcurrency
	}
	return 4
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
	if err := os.MkdirAll(filepath.Join(profile, "images"), 0700); err != nil {
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
	e.syncImages = map[string]bool{}
	e.syncBytes = 0
	e.syncByteSamples = nil
	e.syncSessionUploaded = 0
	e.syncReused = 0
	images, err := os.ReadDir(filepath.Join(profile, "images"))
	if err != nil {
		return err
	}
	for _, image := range images {
		if !image.IsDir() && len(image.Name()) == 64 {
			e.syncImages[image.Name()] = true
		}
	}
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
	active := []syncTransfer{}
	for _, transfer := range e.syncTransfers {
		active = append(active, transfer)
	}
	var eta *int
	rate, byteRate := 0.0, 0.0
	running := pending > 0 && !e.credentials.SyncPaused && e.credentials.AutoSync && e.syncError == "" && time.Now().After(e.syncBackoff)
	if n := len(e.syncSamples); n >= 2 && running {
		rate = float64(n-1) / max(.001, time.Since(e.syncSamples[0]).Seconds())
		if n >= 3 && len(e.syncFailures) == 0 {
			remaining := max(1, int(float64(pending)/rate))
			eta = &remaining
		}
	}
	if n := len(e.syncByteSamples); n >= 2 && running {
		first := e.syncByteSamples[0]
		byteRate = float64(e.syncBytes-first.Bytes) / max(.001, time.Since(first.At).Seconds())
	}
	syncError := e.syncError
	if syncError == "" && e.credentials.Token != "" && !e.credentials.AutoSync {
		// Sync is only switched off this way after the portal rejects the connection; that reason is not persisted.
		syncError = "Sync stopped because the portal rejected this connection. Sign in again to resume syncing."
	}
	return map[string]any{"email": e.credentials.Email, "enabled": e.credentials.AutoSync, "paused": e.credentials.SyncPaused, "uploaded": uploaded, "pending": pending, "etaSeconds": eta, "uploading": e.syncInFlight, "active": active, "parallelism": syncConcurrency(e.credentials), "capturesPerSecond": rate, "bytesPerSecond": byteRate, "bytesSent": e.syncBytes, "sessionUploaded": e.syncSessionUploaded, "imagesReused": e.syncReused, "retryAt": e.syncBackoff.UTC().Format(time.RFC3339), "error": syncError, "failed": len(e.syncFailures), "lastSynced": e.syncLast, "signingIn": e.auth != nil, "authError": e.authError}
}

func queuedPayload(profile, id string) (queuedCapture, error) {
	var capture queuedCapture
	data, err := os.ReadFile(filepath.Join(profile, "pending", id+".json"))
	if err != nil {
		return capture, err
	}
	if err = json.Unmarshal(data, &capture); err != nil {
		return capture, err
	}
	if capture.PayloadFile != "" {
		if filepath.Base(capture.PayloadFile) != capture.PayloadFile {
			return capture, errors.New("Invalid queue payload")
		}
		data, err = os.ReadFile(filepath.Join(profile, "pending", capture.PayloadFile))
		if err != nil {
			return capture, err
		}
		if err = json.Unmarshal(data, &capture.Payload); err != nil {
			return capture, err
		}
	}
	if capture.ImageFile != "" {
		if filepath.Base(capture.ImageFile) != capture.ImageFile {
			return capture, errors.New("Invalid queued screenshot")
		}
		capture.Payload.JPEG, err = os.ReadFile(filepath.Join(profile, "pending", capture.ImageFile))
		if err != nil {
			return capture, err
		}
	}
	if len(capture.Payload.JPEG) > 0 && capture.Payload.JPEGRef == "" {
		hash := sha256.Sum256(capture.Payload.JPEG)
		capture.Payload.JPEGRef = hex.EncodeToString(hash[:])
	}
	return capture, nil
}

// A bounded batch shares cancellation and finishes before OAuth refresh starts.
// A full backlog immediately schedules the next batch, with no per-frame sleep.
func (e *engine) syncOnce() bool {
	e.mu.Lock()
	if e.demo || !e.credentials.AutoSync || e.credentials.SyncPaused || e.credentials.Token == "" || e.syncInFlight || time.Now().Before(e.syncBackoff) {
		e.mu.Unlock()
		return false
	}
	c := e.credentials
	if expiry, err := time.Parse(time.RFC3339, c.Expires); err == nil && c.RefreshToken != "" && time.Until(expiry) < 90*time.Second {
		return e.refreshSync(c)
	}
	if err := e.loadSync(c); err != nil {
		e.syncError = "Could not open the sync queue: " + err.Error()
		e.mu.Unlock()
		return false
	}
	for _, row := range e.lib.Index.Observations {
		key := digestString(row.ID())
		if !e.syncSent[key] && !e.syncPending[key] && !time.Now().Before(e.syncFailures[key].Retry) {
			if err := e.queueCapture(row); err != nil {
				e.syncFailures[key] = syncFailure{err.Error(), time.Now().Add(time.Minute)}
			}
		}
	}
	type work struct {
		id      string
		capture queuedCapture
		known   bool
	}
	jobs := []work{}
	profile := e.syncProfile
	for id := range e.syncPending {
		if time.Now().Before(e.syncFailures[id].Retry) {
			continue
		}
		capture, err := queuedPayload(profile, id)
		if err != nil {
			e.syncFailures[id] = syncFailure{err.Error(), time.Now().Add(time.Minute)}
			e.syncError = "A capture could not be queued. Sync will retry."
			continue
		}
		jobs = append(jobs, work{id, capture, e.syncImages[capture.Payload.JPEGRef]})
		if len(jobs) >= syncConcurrency(c) {
			break
		}
	}
	if len(jobs) == 0 {
		e.mu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.syncCancel = cancel
	e.syncInFlight = true
	e.syncTransfers = map[string]syncTransfer{}
	for _, job := range jobs {
		app, _ := job.capture.Record["app"].(string)
		e.syncTransfers[job.id] = syncTransfer{job.capture.Record.ID(), app, job.capture.Record.Date()}
	}
	if len(e.syncSamples) == 0 {
		e.syncSamples = append(e.syncSamples, time.Now())
	}
	if len(e.syncByteSamples) == 0 {
		e.syncByteSamples = append(e.syncByteSamples, syncByteSample{time.Now(), e.syncBytes})
	}
	e.mu.Unlock()
	var workers sync.WaitGroup
	for _, job := range jobs {
		workers.Add(1)
		go func() {
			defer workers.Done()
			stats, err := uploadTo(ctx, c, job.capture.Record, job.capture.Payload, job.known)
			e.finishUpload(ctx, c, profile, job.id, job.capture, stats, err)
		}()
	}
	workers.Wait()
	cancel()
	e.mu.Lock()
	e.syncInFlight = false
	e.syncCancel = nil
	e.mu.Unlock()
	return true
}

func (e *engine) finishUpload(ctx context.Context, c credentials, profile, id string, capture queuedCapture, stats uploadStats, err error) {
	if err == nil {
		err = writePrivate(filepath.Join(profile, "sent", id), map[string]string{"id": capture.Record.ID(), "syncedAt": time.Now().UTC().Format(time.RFC3339)})
		if err == nil {
			if stats.ImageRef != "" {
				_ = os.WriteFile(filepath.Join(profile, "images", stats.ImageRef), nil, 0600)
			}
			_ = os.Remove(filepath.Join(profile, "pending", id+".json"))
			for _, name := range []string{capture.PayloadFile, capture.ImageFile} {
				if name != "" {
					_ = os.Remove(filepath.Join(profile, "pending", name))
				}
			}
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.syncTransfers, id)
	if e.syncProfile != profile {
		return
	}
	e.syncBytes += stats.Bytes
	e.syncByteSamples = append(e.syncByteSamples, syncByteSample{time.Now(), e.syncBytes})
	if len(e.syncByteSamples) > 21 {
		e.syncByteSamples = e.syncByteSamples[1:]
	}
	if err == nil {
		e.syncSent[id] = true
		delete(e.syncPending, id)
		delete(e.syncFailures, id)
		e.syncSamples = append(e.syncSamples, time.Now())
		if len(e.syncSamples) > 21 {
			e.syncSamples = e.syncSamples[1:]
		}
		e.syncSessionUploaded++
		if stats.Reused {
			e.syncReused++
		}
		if stats.ImageRef != "" {
			e.syncImages[stats.ImageRef] = true
		}
		e.syncLast = time.Now().UTC().Format(time.RFC3339)
		if len(e.syncFailures) == 0 {
			e.syncError = ""
		}
		return
	}
	if ctx.Err() != nil || e.credentials.Token != c.Token || !e.credentials.AutoSync || e.credentials.SyncPaused {
		return
	}
	var remote *apiError
	if errors.As(err, &remote) && (remote.Status == 401 || remote.Status == 403) {
		e.credentials.AutoSync = false
		e.syncError = "Your connection expired or was revoked. Sign in again to resume syncing."
		_ = writePrivate(filepath.Join(e.lib.Dir, "connection.json"), e.credentials)
		if e.syncCancel != nil {
			e.syncCancel()
		}
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

// Called with the engine locked; refresh remains serialized with every upload.
func (e *engine) refreshSync(c credentials) bool {
	ctx, cancel := context.WithCancel(context.Background())
	e.syncCancel = cancel
	e.syncInFlight = true
	e.mu.Unlock()
	refreshed, err := refreshOAuth(ctx, c)
	cancel()
	e.mu.Lock()
	defer e.mu.Unlock()
	e.syncInFlight = false
	e.syncCancel = nil
	if e.credentials.Token != c.Token {
		return false
	}
	if err == nil {
		refreshed.SyncPaused = e.credentials.SyncPaused
		refreshed.UploadConcurrency = e.credentials.UploadConcurrency
		e.credentials = refreshed
		if err = writePrivate(filepath.Join(e.lib.Dir, "connection.json"), refreshed); err != nil {
			e.credentials.AutoSync = false
			e.syncError = "Could not save the refreshed connection. Sign in again to resume."
			return false
		}
		e.syncError = ""
		return true
	}
	var remote *oauth2.RetrieveError
	if errors.As(err, &remote) && (remote.Response.StatusCode == 400 || remote.Response.StatusCode == 401 || remote.Response.StatusCode == 403) {
		e.credentials.AutoSync = false
		e.syncError = "Your connection expired or was revoked. Sign in again to resume syncing."
		_ = writePrivate(filepath.Join(e.lib.Dir, "connection.json"), e.credentials)
	} else {
		e.syncBackoff = time.Now().Add(30 * time.Second)
		e.syncError = "Could not refresh your connection. Retrying automatically."
	}
	return false
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
