package agentusage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func claude(id string) string {
	return fmt.Sprintf(`{"type":"assistant","timestamp":%q,"sessionId":"session","cwd":"C:\\work\\project","requestId":"req","message":{"id":%q,"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_1h_input_tokens":2},"output_tokens":3},"content":[{"text":"PROMPT_SENTINEL","tool":"TOOL_SENTINEL"}]},"response":"RESPONSE_SENTINEL"}`, time.Now().UTC().Format(time.RFC3339), id) + "\n"
}
func setup(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "claude")
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	t.Setenv("CODEX_HOME", filepath.Join(dir, "codex"))
	root := filepath.Join(home, "projects", "project")
	os.MkdirAll(root, 0700)
	s, e := Open(filepath.Join(dir, "library"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s, filepath.Join(root, "session.jsonl")
}
func scan(t *testing.T, s *Store, budget int) {
	t.Helper()
	s.nextDiscovery = time.Time{}
	for i := 0; i < 10000; i++ {
		if e := s.Scan(budget); e != nil {
			t.Fatal(e)
		}
		if s.Status().Pending == 0 {
			return
		}
	}
	t.Fatal("scan never finished")
}
func result(t *testing.T, s *Store) Result {
	t.Helper()
	r, e := s.Query(7, "America/New_York", time.Now())
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func sum(r Result) int64 {
	var n int64
	for _, h := range r.Hours {
		n += h.Input
	}
	return n
}
func TestOptInIncrementalAndPrivacy(t *testing.T) {
	s, path := setup(t)
	line := claude("one")
	os.WriteFile(path, []byte(line+line), 0600)
	scan(t, s, 71)
	if sum(result(t, s)) != 0 {
		t.Fatal("read while disabled")
	}
	s.Configure("claude", true)
	scan(t, s, 71)
	if sum(result(t, s)) != 10 {
		t.Fatal("dedup failed")
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	next := claude("two")
	f.WriteString(next[:len(next)-1])
	f.Close()
	scan(t, s, 41)
	if sum(result(t, s)) != 10 {
		t.Fatal("partial line included")
	}
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString("\n{malformed}\n")
	f.Close()
	scan(t, s, 41)
	r := result(t, s)
	if sum(r) != 20 {
		t.Fatal("append not captured")
	}
	b, _ := json.Marshal(r)
	if strings.Contains(string(b), "SENTINEL") || strings.Contains(string(b), `C:\\`) {
		t.Fatal("private content returned")
	}
	raw, _ := os.ReadFile(filepath.Join(s.dir, "agent-usage.db"))
	if strings.Contains(string(raw), "SENTINEL") {
		t.Fatal("private content stored")
	}
	if r.Hours[0].Project != "project" {
		t.Fatal("windows project")
	}
	os.WriteFile(path, []byte(claude("three")), 0600)
	scan(t, s, 100)
	if sum(result(t, s)) != 30 {
		t.Fatal("truncation")
	}
	os.Rename(path, path+".old")
	os.WriteFile(path, []byte(claude("four")), 0600)
	scan(t, s, 100)
	if sum(result(t, s)) != 40 {
		t.Fatal("rotation")
	}
}
func codexRecord(kind, payload string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":%q,"payload":%s}`+"\n", time.Now().UTC().Format(time.RFC3339), kind, payload)
}
func TestCodexPreferenceReplayAndRestart(t *testing.T) {
	s, _ := setup(t)
	root := filepath.Join(os.Getenv("CODEX_HOME"), "sessions", "2026", "11", "20")
	os.MkdirAll(root, 0700)
	s.Configure("codex", true)
	meta := codexRecord("session_meta", `{"id":"parent","cwd":"/work/project"}`) + codexRecord("turn_context", `{"model":"gpt-5.4"}`)
	legacy := codexRecord("event_msg", `{"type":"token_count","info":{"total_token_usage":{"total_tokens":110},"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}}`)
	modern := codexRecord("token_usage_record", `{"response_id":"response","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":5}}`)
	path := filepath.Join(root, "rollout-parent.jsonl")
	os.WriteFile(path, []byte(meta+legacy+legacy), 0600)
	scan(t, s, 150)
	if sum(result(t, s)) != 60 {
		t.Fatal("legacy totals dedup")
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString(modern + legacy + modern)
	f.Close()
	scan(t, s, 150)
	if sum(result(t, s)) != 60 {
		t.Fatal("modern should replace legacy")
	}
	child := codexRecord("session_meta", `{"id":"child","forked_from_id":"parent","cwd":"/work/project"}`) + codexRecord("turn_context", `{"model":"gpt-5.4"}`) + modern + legacy
	os.WriteFile(filepath.Join(root, "rollout-child.jsonl"), []byte(child), 0600)
	scan(t, s, 150)
	if sum(result(t, s)) != 60 {
		t.Fatal("fork replay counted")
	}
	dir := s.dir
	s.Close()
	opened, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	*s = *opened
	scan(t, s, 150)
	if sum(result(t, s)) != 60 {
		t.Fatal("restart counted twice")
	}
}
func TestPluginStrict(t *testing.T) {
	p := Providers()[2]
	valid := fmt.Sprintf(`{"provider":"custom","id":"one","session":"session","model":"model","time":%q,"project":"demo","input":100,"output":5}`, time.Now().Format(time.RFC3339))
	e, err := p.Parse(strings.NewReader(valid), &Context{})
	if err != nil || e == nil {
		t.Fatalf("valid plugin: %v", err)
	}
	for _, bad := range []string{strings.Replace(valid, `"input":100`, `"input":-1`, 1), strings.Replace(valid, `"input":100`, `"input":"100"`, 1), strings.Replace(valid, `"input":100`, `"input":1.5`, 1), strings.Replace(valid, `"project":"demo"`, `"project":"/Users/person/demo"`, 1), strings.Replace(valid, `"output":5`, `"output":5,"prompt":"SECRET"`, 1), strings.Replace(valid, `"output":5`, `"output":5,"anything":{"text":"SECRET"}`, 1)} {
		if e, err := p.Parse(strings.NewReader(bad), &Context{}); err == nil || e != nil {
			t.Fatalf("accepted invalid plugin: %s", bad)
		}
	}
}
func TestDiscardedContentMemory(t *testing.T) {
	// A large ignored value is consumed directly, without retaining a complete line.
	p := Providers()[0]
	record := strings.TrimSuffix(claude("large"), "\n")
	record = strings.Replace(record, "PROMPT_SENTINEL", strings.Repeat("x", 2<<20), 1)
	if e, err := p.Parse(strings.NewReader(record), &Context{}); err != nil || e == nil {
		t.Fatal(err)
	}
}
