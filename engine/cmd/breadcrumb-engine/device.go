package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"
	"unicode"

	"golang.org/x/oauth2"
)

// device.json names this install so the portal can keep one connection per device and show
// which computer each connection belongs to.
type deviceRecord struct {
	ID string `json:"id"`
	// Registered is the client, name and version the portal last accepted.
	Registered string `json:"registered,omitempty"`
	// Replaces lists older connections from this device that the portal should remove.
	Replaces []string `json:"replaces,omitempty"`
}

var appVersionPattern = regexp.MustCompile(`^[0-9A-Za-z.+-]{0,32}$`)

func loadDevice(dir string) (deviceRecord, error) {
	var d deviceRecord
	path := filepath.Join(dir, "device.json")
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &d)
	}
	if len(d.ID) >= 8 {
		return d, nil
	}
	d.ID = strings.ToLower(uuid())
	return d, writePrivate(path, d)
}

func (e *engine) saveDevice(d deviceRecord) error {
	e.device = d
	return writePrivate(filepath.Join(e.lib.Dir, "device.json"), d)
}

// replaceConnection asks the portal to remove an older connection from this device.
func (e *engine) replaceConnection(clientID string) {
	if clientID == "" || slices.Contains(e.device.Replaces, clientID) {
		return
	}
	next := e.device
	next.Replaces = append(slices.Clone(next.Replaces), clientID)
	if len(next.Replaces) > 5 {
		next.Replaces = next.Replaces[len(next.Replaces)-5:]
	}
	_ = e.saveDevice(next)
}

func deviceName() string {
	name := ""
	switch runtime.GOOS {
	case "darwin":
		if out, err := exec.Command("/usr/sbin/scutil", "--get", "ComputerName").Output(); err == nil {
			name = string(out)
		}
	case "windows":
		name = os.Getenv("COMPUTERNAME")
	}
	if strings.TrimSpace(name) == "" {
		name, _ = os.Hostname()
		name = strings.TrimSuffix(name, ".local")
	}
	name = strings.Join(strings.FieldsFunc(name, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	if runes := []rune(name); len(runes) > 80 {
		name = string(runes[:80])
	}
	if name == "" {
		return "This computer"
	}
	return name
}

func devicePlatform() string { return runtime.GOOS + "-" + runtime.GOARCH }

// registerDevice runs outside the engine lock. Failures retry later and never stop syncing.
func (e *engine) registerDevice() {
	e.mu.Lock()
	c, d := e.credentials, e.device
	name := e.deviceName
	if e.demo || c.Token == "" || !c.AutoSync || d.ID == "" || e.deviceBusy || time.Now().Before(e.deviceRetry) {
		e.mu.Unlock()
		return
	}
	if expiry, err := time.Parse(time.RFC3339, c.Expires); err == nil && time.Until(expiry) < 30*time.Second {
		e.mu.Unlock()
		return // Sync renews access first.
	}
	signature := c.ClientID + "|" + name + "|" + e.appVersion
	if d.Registered == signature && len(d.Replaces) == 0 {
		e.mu.Unlock()
		return
	}
	e.deviceBusy = true
	e.mu.Unlock()
	replaces := slices.DeleteFunc(slices.Clone(d.Replaces), func(id string) bool { return id == c.ClientID })
	err := postDevice(c, map[string]any{"deviceId": d.ID, "name": name, "platform": devicePlatform(), "version": e.appVersion, "replaces": replaces})
	e.mu.Lock()
	defer e.mu.Unlock()
	e.deviceBusy = false
	if err != nil {
		e.deviceRetry = time.Now().Add(5 * time.Minute)
		return
	}
	next := e.device
	next.Registered = signature
	next.Replaces = slices.DeleteFunc(slices.Clone(next.Replaces), func(id string) bool { return id == c.ClientID || slices.Contains(replaces, id) })
	_ = e.saveDevice(next)
}

func postDevice(c credentials, body map[string]any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.Server, "/")+"/v1/device", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	client := oauthHTTPContext(ctx).Value(oauth2.HTTPClient).(*http.Client)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New("device registration was not accepted")
	}
	return nil
}
