package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/hackclub/breadcrumb/engine/internal/agentusage"
	"golang.org/x/oauth2"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func hasScope(c credentials, scope string) bool {
	return slices.Contains(strings.Fields(c.Scopes), scope)
}

// Token usage uploads with the device's one connection once it grants agents:sync.
func (e *engine) agentSyncStatus() map[string]any {
	c := e.credentials
	return map[string]any{"enabled": c.AgentSync, "connected": c.Token != "", "allowed": c.Token != "" && hasScope(c, "agents:sync"), "server": c.Server, "lastSynced": e.agentLastSynced, "error": e.agentSyncError, "signingIn": e.auth != nil, "authError": e.authError}
}

// migrateAgentConnection retires the separate token-usage connection from before 0.2.9. Its
// preference carries over, and the portal removes it when this device next registers.
func (e *engine) migrateAgentConnection() {
	path := filepath.Join(e.lib.Dir, "agent-connection.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var legacy credentials
	json.Unmarshal(data, &legacy)
	if legacy.Token != "" && legacy.AutoSync && e.credentials.Token != "" && !e.credentials.AgentSync {
		next := e.credentials
		next.AgentSync = true
		if writePrivate(filepath.Join(e.lib.Dir, "connection.json"), next) != nil {
			return
		}
		e.credentials = next
	}
	e.replaceConnection(legacy.ClientID)
	if os.Remove(path) == nil {
		go revokeOAuth(legacy)
	}
}

func uploadAgentSnapshots(ctx context.Context, c credentials, snapshots []agentusage.Snapshot) error {
	data, err := json.Marshal(map[string]any{"consent": true, "snapshots": snapshots})
	if err != nil {
		return err
	}
	if len(data) > 512*1024 {
		return errors.New("Token usage batch is too large")
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.Server, "/")+"/v1/agents/ingest", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	client := oauthHTTPContext(ctx).Value(oauth2.HTTPClient).(*http.Client)
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("Token usage upload interrupted")
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New("Token usage upload was not accepted")
	}
	return nil
}

// same reports whether c is still the active token-usage connection.
func (e *engine) sameAgentConnection(c credentials) bool {
	return e.credentials.ClientID == c.ClientID && e.credentials.Participant == c.Participant && e.credentials.AgentSync && e.credentials.AutoSync
}

func (e *engine) syncAgentUsage() {
	e.mu.Lock()
	c := e.credentials
	if e.demo || e.usage == nil || !c.AgentSync || !c.AutoSync || c.Token == "" || !hasScope(c, "agents:sync") {
		e.mu.Unlock()
		return
	}
	if expiry, err := time.Parse(time.RFC3339, c.Expires); err == nil && c.RefreshToken != "" && time.Until(expiry) < 90*time.Second {
		// Capture sync renews the shared connection; renew here only when it is idle.
		if e.syncInFlight {
			e.mu.Unlock()
			return
		}
		if !e.refreshSync(c) { // Returns with the engine unlocked.
			return
		}
		e.mu.Lock()
		c = e.credentials
		if !e.sameAgentConnection(c) {
			e.mu.Unlock()
			return
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	e.agentCancel = cancel
	e.mu.Unlock()
	defer cancel()
	snapshots, err := e.usage.Export(time.Now())
	if err != nil {
		e.mu.Lock()
		e.agentSyncError = "Could not prepare token usage"
		e.mu.Unlock()
		return
	}
	ackPath := filepath.Join(e.lib.Dir, "agent-upload-ack-"+digestString(c.Server+"|"+c.Participant)+".json")
	ack := map[string]int64{}
	if data, err := os.ReadFile(ackPath); err == nil {
		json.Unmarshal(data, &ack)
	}
	for i := 0; i < len(snapshots); {
		batch := []agentusage.Snapshot{}
		size := 0
		for i < len(snapshots) && len(batch) < 24 {
			s := snapshots[i]
			if ack[s.Hour] >= s.Revision {
				i++
				continue
			}
			raw, _ := json.Marshal(s)
			if size+len(raw) > 500*1024 && len(batch) > 0 {
				break
			}
			size += len(raw)
			batch = append(batch, s)
			i++
		}
		if len(batch) == 0 {
			continue
		}
		e.mu.Lock()
		active := e.sameAgentConnection(c)
		e.mu.Unlock()
		if !active || ctx.Err() != nil {
			return
		}
		err = uploadAgentSnapshots(ctx, c, batch)
		e.mu.Lock()
		if !e.sameAgentConnection(c) {
			e.mu.Unlock()
			return
		}
		if err != nil {
			e.agentSyncError = "Token usage sync interrupted. It will retry automatically."
			e.mu.Unlock()
			return
		}
		for _, s := range batch {
			ack[s.Hour] = s.Revision
		}
		err = writePrivate(ackPath, ack)
		if err != nil {
			e.agentSyncError = "Could not save token usage upload progress"
			e.mu.Unlock()
			return
		}
		e.agentLastSynced = time.Now().UTC().Format(time.RFC3339)
		e.agentSyncError = ""
		e.mu.Unlock()
	}
}
