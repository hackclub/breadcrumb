package main

import (
	"context"
	"encoding/json"
	"github.com/hackclub/breadcrumb/engine/internal/agentusage"
	"io"
	"net/http"
	"net/http/httptest"
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
	err := uploadAgentSnapshots(context.Background(), credentials{Token: "usage-only", Server: server.URL, AgentOnly: true}, []agentusage.Snapshot{{Source: strings.Repeat("a", 32), Hour: time.Now().UTC().Truncate(time.Hour).Format(time.RFC3339), Revision: 1, Rows: []agentusage.SyncRow{{Provider: "codex", Model: "gpt-5.4", Tokens: agentusage.Tokens{Input: 100, Output: 10}}}}})
	if err != nil || !called {
		t.Fatal(err)
	}
}
func TestAgentSyncOffByDefaultAndIndependent(t *testing.T) {
	e := engine{credentials: credentials{Token: "capture-only", AutoSync: true}}
	e.syncAgentUsage()
	if e.agentCredentials.Token != "" || e.agentCredentials.AutoSync {
		t.Fatal("capture sync enabled token uploads")
	}
	if oauthConfig(credentials{AgentOnly: true}, "").Scopes[2] != "agents:sync" || oauthConfig(credentials{}, "").Scopes[2] != "captures:sync" {
		t.Fatal("mixed consent")
	}
}
