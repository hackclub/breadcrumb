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
	t.Setenv("GROK_HOME", filepath.Join(dir, "grok"))
	t.Setenv("OPENCODE_DATA_DIR", filepath.Join(dir, "opencode"))
	t.Setenv("ANTIGRAVITY_DATA_DIR", filepath.Join(dir, "antigravity"))
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
	if r.Hours[0].Project != "" {
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
	s = opened
	t.Cleanup(func() { s.Close() })
	scan(t, s, 150)
	if sum(result(t, s)) != 60 {
		t.Fatal("restart counted twice")
	}
}
func TestPluginStrict(t *testing.T) {
	p := Providers()[2]
	valid := fmt.Sprintf(`{"provider":"custom","id":"one","session":"session","model":"model","time":%q,"project":"demo","input":100,"output":5}`, time.Now().Format(time.RFC3339))
	e, err := parseOne(p, valid, &Context{})
	if err != nil || e == nil {
		t.Fatalf("valid plugin: %v", err)
	}
	for _, bad := range []string{strings.Replace(valid, `"input":100`, `"input":-1`, 1), strings.Replace(valid, `"input":100`, `"input":"100"`, 1), strings.Replace(valid, `"input":100`, `"input":1.5`, 1), strings.Replace(valid, `"project":"demo"`, `"project":"/Users/person/demo"`, 1), strings.Replace(valid, `"output":5`, `"output":5,"prompt":"SECRET"`, 1), strings.Replace(valid, `"output":5`, `"output":5,"anything":{"text":"SECRET"}`, 1)} {
		if e, err := parseOne(p, bad, &Context{}); err == nil || e != nil {
			t.Fatalf("accepted invalid plugin: %s", bad)
		}
	}
}
func TestDiscardedContentMemory(t *testing.T) {
	// A large ignored value is consumed directly, without retaining a complete line.
	p := Providers()[0]
	record := strings.TrimSuffix(claude("large"), "\n")
	record = strings.Replace(record, "PROMPT_SENTINEL", strings.Repeat("x", 2<<20), 1)
	if e, err := parseOne(p, record, &Context{}); err != nil || e == nil {
		t.Fatal(err)
	}
}

func TestPluginDiscoveryAndSeparateOptIn(t *testing.T) {
	s, _ := setup(t)
	dir := filepath.Join(s.dir, "agent-imports", "opencode")
	os.MkdirAll(dir, 0700)
	record := fmt.Sprintf(`{"provider":"opencode","id":"one","session":"s","model":"free-model","time":%q,"input":15,"output":2}`+"\n", time.Now().Format(time.RFC3339))
	os.WriteFile(filepath.Join(dir, "usage.jsonl"), []byte(record), 0600)
	status := s.Status()
	found := false
	for _, p := range status.Providers {
		if p.ID == "plugin:opencode" {
			found = p.Detected && !p.Enabled
		}
	}
	if !found {
		t.Fatal("plugin not discovered off by default")
	}
	s.Configure("import", true)
	scan(t, s, 256)
	if sum(result(t, s)) != 0 {
		t.Fatal("generic importer bypassed plugin toggle")
	}
	if err := s.Configure("plugin:opencode", true); err != nil {
		t.Fatal(err)
	}
	scan(t, s, 256)
	if sum(result(t, s)) != 15 {
		t.Fatal("plugin not imported")
	}
}

func TestNativeReadersDiscardImportNamedContent(t *testing.T) {
	content := strings.Repeat("PROMPT_SENTINEL", 10000)
	line := strings.TrimSpace(claude("privacy"))
	line = strings.TrimSuffix(line, "}") + fmt.Sprintf(`,"input":%q,"output":%q,"payload":{"usage":{"input_tokens":"TOOL_SENTINEL"}}}`, content, content)
	event, err := parseOne(Providers()[0], line, &Context{})
	if err != nil || event == nil || event.Input != 10 {
		t.Fatalf("discarded content affected usage: %v", err)
	}
	extracted, err := extract(strings.NewReader(line), providerPaths["claude"])
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range extracted {
		if strings.Contains(value, "SENTINEL") {
			t.Fatalf("content decoded at %s", key)
		}
	}
	codex := fmt.Sprintf(`{"type":"token_usage_record","timestamp":%q,"input":%q,"output":%q,"message":{"usage":{"input_tokens":"TOOL_SENTINEL"}},"payload":{"response_id":"r","usage":{"input_tokens":100,"output_tokens":10}}}`, time.Now().Format(time.RFC3339), content, content)
	event, err = parseOne(Providers()[1], codex, &Context{Session: "s", Model: "model"})
	if err != nil || event == nil || event.Input != 100 {
		t.Fatalf("Codex content affected usage: %v", err)
	}
	for _, provider := range []string{"claude", "codex"} {
		if _, err := extract(strings.NewReader(`{"message":{"usage":{"input_tokens":"PROMPT_SENTINEL"}},"payload":{"usage":{"input_tokens":"RESPONSE_SENTINEL"}}}`), providerPaths[provider]); err == nil {
			t.Fatal("string-valued usage was decoded")
		}
	}
}

func TestLegacyForkCountsFreshUsageAfterCounterReset(t *testing.T) {
	p := Providers()[1]
	started := time.Now().UTC().Add(-10 * time.Minute)
	meta := fmt.Sprintf(`{"type":"session_meta","payload":{"id":"child","forked_from_id":"parent","timestamp":%q}}`, started.Format(time.RFC3339))
	c := Context{Model: "gpt-5.4"}
	if _, err := parseOne(p, meta, &c); err != nil {
		t.Fatal(err)
	}
	record := func(at time.Time, total int) string {
		return fmt.Sprintf(`{"type":"event_msg","timestamp":%q,"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":%d},"last_token_usage":{"input_tokens":15,"cached_input_tokens":5,"output_tokens":5}}}}`, at.Format(time.RFC3339), total)
	}
	inherited := record(started.Add(-time.Minute), 1000)
	if event, err := parseOne(p, inherited, &c); err != nil || event != nil {
		t.Fatal("inherited usage counted")
	}
	fresh := record(started.Add(time.Minute), 20)
	event, err := parseOne(p, fresh, &c)
	if err != nil || event == nil || event.Input != 10 {
		t.Fatal("fresh fork usage lost after reset")
	}
	if event, err := parseOne(p, fresh, &c); err != nil || event != nil {
		t.Fatal("fresh usage counted twice")
	}
}

func parseOne(p Provider, line string, c *Context) (*Event, error) {
	events, err := p.Parse(strings.NewReader(line), c)
	if len(events) == 0 {
		return nil, err
	}
	return &events[0], err
}
