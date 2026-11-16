package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const agentToken = "test-review-agent-00000000000000000001"

func queued(t *testing.T) (*service, string) {
	t.Helper()
	s, link := fixture(t)
	s.agents = map[string]string{"test-agent": agentToken}
	token := uploadToken(t, s, login(t, s, link))
	body := strings.Replace(capture, `"jpeg":"AQID"`, `"screenText":"Synthetic editor and side video","jpeg":"AQID"`, 1)
	requireStatus(t, call(s, "POST", "/v1/ingest", body, token, nil), 201)
	return s, token
}
func decodeJob(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	requireStatus(t, w, 200)
	var j map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &j); e != nil {
		t.Fatal(e)
	}
	return j
}
func resultFor(j map[string]any) string {
	b, _ := json.Marshal(map[string]any{"job": j["job"], "lease": j["lease"], "generation": j["generation"], "model": "synthetic-test", "version": "v1", "summary": "Editor with side video", "session": "Example project", "labels": []map[string]string{{"activity": "Coding", "role": "focused", "evidence": "Editor UI", "confidence": "high"}, {"activity": "Video", "role": "alongside", "evidence": "Side window; playback unknown", "confidence": "medium"}}, "flags": []string{"playback-unverified"}})
	return string(b)
}
func TestReviewClaimsAndResults(t *testing.T) {
	s, upload := queued(t)
	requireStatus(t, call(s, "POST", "/v1/review/claim", `{}`, upload, nil), 401)
	j := decodeJob(t, call(s, "POST", "/v1/review/claim", `{}`, agentToken, nil))
	if j["job"] == nil {
		t.Fatal("no job")
	}
	if decodeJob(t, call(s, "POST", "/v1/review/claim", `{}`, agentToken, nil))["job"] != nil {
		t.Fatal("busy job claimed")
	}
	requireStatus(t, call(s, "POST", "/v1/review/submit", strings.Replace(resultFor(j), "alongside", "invalid", 1), agentToken, nil), 400)
	s.agents["other-agent"] = "other-review-agent-000000000000000001"
	requireStatus(t, call(s, "POST", "/v1/review/submit", resultFor(j), s.agents["other-agent"], nil), 409)
	requireStatus(t, call(s, "POST", "/v1/review/submit", resultFor(j), agentToken, nil), 201)
	requireStatus(t, call(s, "POST", "/v1/review/submit", resultFor(j), agentToken, nil), 409)
	if decodeJob(t, call(s, "POST", "/v1/review/claim", `{}`, agentToken, nil))["job"] != nil {
		t.Fatal("reviewed job claimed")
	}
	data, e := s.store.Get(context.Background(), "review/results/"+j["job"].(string)+".json")
	if e != nil {
		t.Fatal(e)
	}
	var result reviewResult
	json.Unmarshal(data, &result)
	if result.Agent != "test-agent" || result.Lease != "" || len(result.Labels) != 2 || result.ReviewedAt.IsZero() {
		t.Fatal("bad provenance")
	}
	requireStatus(t, call(s, "GET", "/v1/review/context/"+j["job"].(string), "", agentToken, nil), 200)
}
func TestExpiredClaimCanBeReclaimed(t *testing.T) {
	s, _ := queued(t)
	keys, _, _ := s.store.List(context.Background(), "review/items/", "", 10)
	id := strings.TrimSuffix(strings.TrimPrefix(keys[0], "review/items/"), ".json")
	old := reviewLease{"test-agent", hash("old-token"), time.Now().Add(-time.Minute), 1}
	b, _ := json.Marshal(old)
	s.store.Create(context.Background(), "review/claims/"+id+"/0000000001.json", b)
	j := decodeJob(t, call(s, "POST", "/v1/review/claim", `{}`, agentToken, nil))
	if j["generation"].(float64) != 2 {
		t.Fatal("claim not advanced")
	}
	stale := map[string]any{"job": id, "lease": "old-token", "generation": 1}
	requireStatus(t, call(s, "POST", "/v1/review/submit", resultFor(stale), agentToken, nil), 409)
	requireStatus(t, call(s, "POST", "/v1/review/submit", resultFor(j), agentToken, nil), 201)
}
func TestConcurrentReviewClaims(t *testing.T) {
	s, _ := queued(t)
	results := make(chan bool, 2)
	var group sync.WaitGroup
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			w := call(s, "POST", "/v1/review/claim", `{}`, agentToken, nil)
			var j map[string]any
			json.Unmarshal(w.Body.Bytes(), &j)
			results <- j["job"] != nil
		}()
	}
	group.Wait()
	close(results)
	count := 0
	for claimed := range results {
		if claimed {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("%d claimants won", count)
	}
}
func TestAgentRunnerEndToEnd(t *testing.T) {
	python, e := exec.LookPath("python3")
	if e != nil {
		t.Skip("Python unavailable")
	}
	s, _ := queued(t)
	server := httptest.NewServer(s.handler())
	defer server.Close()
	program := filepath.Join(t.TempDir(), "reviewer.py")
	script := `import sys,json
j=json.load(sys.stdin)
assert j['capture']['upload']['payload']['screenText']
print(json.dumps({'model':'synthetic','version':'test-v1','summary':'Synthetic review','session':'Test','labels':[{'activity':'Coding','role':'focused','evidence':'Editor shown','confidence':'high'}],'flags':[]}))
`
	if e = os.WriteFile(program, []byte(script), 0600); e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command(python, "../../../agents/review.py", "--server", server.URL, "--reviewer-cmd", python, program)
	cmd.Env = append(os.Environ(), "BREADCRUMB_REVIEW_TOKEN="+agentToken)
	output, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("runner failed: %v %s", e, output)
	}
	keys, _, e := s.store.List(context.Background(), "review/results/", "", 10)
	if e != nil || len(keys) != 1 {
		t.Fatal("missing result")
	}
}
