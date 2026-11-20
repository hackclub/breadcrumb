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
	"strings"
	"time"
)

func (e *engine) agentSyncStatus() map[string]any {
	return map[string]any{"enabled": e.agentCredentials.AutoSync, "connected": e.agentCredentials.Token != "", "server": e.agentCredentials.Server, "lastSynced": e.agentLastSynced, "error": e.agentSyncError, "signingIn": e.auth != nil, "authError": e.authError}
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
		return errors.New("Token usage upload was not accepted; reconnect if permission was revoked")
	}
	return nil
}
func (e *engine) syncAgentUsage() {
	e.mu.Lock()
	c := e.agentCredentials
	if e.demo || e.usage == nil || !c.AutoSync || c.Token == "" {
		e.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	e.agentCancel = cancel
	e.mu.Unlock()
	defer cancel()
	expiry, _ := time.Parse(time.RFC3339, c.Expires)
	if time.Until(expiry) < time.Minute {
		next, err := refreshOAuth(ctx, c)
		e.mu.Lock()
		if e.agentCredentials.Token != c.Token || !e.agentCredentials.AutoSync {
			e.mu.Unlock()
			return
		}
		if err != nil {
			e.agentSyncError = "Could not refresh token usage access. Reconnect token usage."
			e.mu.Unlock()
			return
		}
		if err := writePrivate(filepath.Join(e.lib.Dir, "agent-connection.json"), next); err != nil {
			e.agentSyncError = "Could not save token usage access"
			e.mu.Unlock()
			return
		}
		e.agentCredentials = next
		c = next
		e.mu.Unlock()
	}
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
		active := e.agentCredentials.Token == c.Token && e.agentCredentials.AutoSync
		e.mu.Unlock()
		if !active || ctx.Err() != nil {
			return
		}
		err = uploadAgentSnapshots(ctx, c, batch)
		e.mu.Lock()
		if e.agentCredentials.Token != c.Token || !e.agentCredentials.AutoSync {
			e.mu.Unlock()
			return
		}
		if err != nil {
			e.agentSyncError = "Token usage sync interrupted. Reconnect if access was revoked."
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
