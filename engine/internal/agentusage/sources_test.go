package agentusage

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func enable(t *testing.T, s *Store, id string) {
	t.Helper()
	if err := s.Configure(id, true); err != nil {
		t.Fatal(err)
	}
}
func byModel(r Result, provider string) map[string]Tokens {
	m := map[string]Tokens{}
	for _, h := range r.Hours {
		if h.Provider == provider {
			m[h.Model] = m[h.Model].add(h.Tokens)
		}
	}
	return m
}

func grokTurn(prompt string, at time.Time) string {
	return fmt.Sprintf(`{"timestamp":%d,"timestamp_us":%d,"method":"_x.ai/session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"turn_completed","prompt_id":%q,"stop_reason":"end_turn","usage":{"inputTokens":1500,"outputTokens":60,"cachedReadTokens":1000,"cacheCreationTokens":0,"reasoningTokens":20,"modelUsage":{"grok-4.7-build":{"inputTokens":1000,"outputTokens":50,"cachedReadTokens":800,"cacheCreationTokens":0,"reasoningTokens":20},"inception/mercury-2.5":{"inputTokens":500,"outputTokens":10,"cachedReadTokens":200,"cacheCreationTokens":0,"reasoningTokens":0}}}},"_meta":{"agentTimestampMs":%d}}}`, at.Unix(), at.UnixMicro(), prompt, at.UnixMilli()) + "\n"
}

func TestGrokBuildTurnsPerModel(t *testing.T) {
	s, _ := setup(t)
	project := filepath.Join(t.TempDir(), "grok-project")
	os.MkdirAll(filepath.Join(project, ".git"), 0700)
	dir := filepath.Join(os.Getenv("GROK_HOME"), "sessions", url.PathEscape(project), "grok-session")
	os.MkdirAll(dir, 0700)
	now := time.Now().UTC()
	chat := `{"method":"session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"PROMPT_SENTINEL"}},"_meta":{"totalTokens":99999}}}` + "\n"
	os.WriteFile(filepath.Join(dir, "updates.jsonl"), []byte(chat+grokTurn("p1", now)+grokTurn("p1", now)), 0600)
	// Other session files are never read, even when they look like usage.
	os.WriteFile(filepath.Join(dir, "chat_history.jsonl"), []byte(grokTurn("p2", now)), 0600)
	enable(t, s, "grok")
	scan(t, s, 1<<20)
	r := result(t, s)
	models := byModel(r, "grok")
	if got := models["grok-4.7-build"]; got != (Tokens{Input: 200, CacheRead: 800, Output: 50, Reasoning: 20}) {
		t.Fatalf("grok-4.7-build: %+v", got)
	}
	if got := models["mercury-2.5"]; got != (Tokens{Input: 300, CacheRead: 200, Output: 10}) {
		t.Fatalf("routed model: %+v", got)
	}
	for _, h := range r.Hours {
		if h.Project != "grok-project" {
			t.Fatalf("project %q", h.Project)
		}
	}
	if len(models) != 2 {
		t.Fatalf("models: %v", models)
	}
	line := strings.Replace(grokTurn("p3", now), `"inputTokens":1000`, `"inputTokens":"PROMPT_SENTINEL"`, 1)
	if _, err := (Providers()[3]).Parse(strings.NewReader(line), &Context{}); err == nil {
		t.Fatal("string-valued Grok usage accepted")
	}
	extracted, _ := extract(strings.NewReader(chat), providerPaths["grok"])
	for k, v := range extracted {
		if strings.Contains(v, "SENTINEL") || strings.Contains(k, "SENTINEL") {
			t.Fatalf("chat decoded at %s", k)
		}
	}
}

func writeSQLite(t *testing.T, path string, statements ...string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0700)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, s := range statements {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

func TestOpenCodeCompletedResponses(t *testing.T) {
	s, _ := setup(t)
	project := filepath.Join(t.TempDir(), "oc-project")
	os.MkdirAll(filepath.Join(project, ".git"), 0700)
	now := time.Now().UnixMilli()
	message := func(id, session string, created, completed int64, model string) string {
		done := ""
		if completed > 0 {
			done = fmt.Sprintf(`,"completed":%d`, completed)
		}
		data := fmt.Sprintf(`{"role":"assistant","model":{"id":%q,"providerID":"opencode"},"time":{"created":%d%s},"tokens":{"input":100,"output":30,"reasoning":10,"cache":{"read":500,"write":40}},"parts":[{"text":"PROMPT_SENTINEL"}]}`, model, created, done)
		return fmt.Sprintf(`INSERT INTO session_message VALUES (%q, %q, 'assistant', 1, %d, %d, '%s')`, id, session, created, created, data)
	}
	path := filepath.Join(os.Getenv("OPENCODE_DATA_DIR"), "opencode.db")
	writeSQLite(t, path,
		"CREATE TABLE session_v2 (id text PRIMARY KEY, directory text NOT NULL, parent_id text, fork_session_id text, time_created integer NOT NULL)",
		"CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
		fmt.Sprintf(`INSERT INTO session_v2 VALUES ('s1', %q, NULL, NULL, %d)`, project, now-60000),
		fmt.Sprintf(`INSERT INTO session_v2 VALUES ('fork', %q, NULL, 's1', %d)`, project, now-1000),
		message("m1", "s1", now-50000, now-49000, "deepseek-v4.1-flash-free"),
		message("streaming", "s1", now-40000, 0, "deepseek-v4.1-flash-free"),
		// A fork's copy of an earlier response keeps its original creation time.
		message("copy", "fork", now-50000, now-49000, "deepseek-v4.1-flash-free"),
		message("own", "fork", now-500, now-400, "openai/gpt-6.1-sol"),
	)
	enable(t, s, "opencode")
	scan(t, s, 1<<20)
	models := byModel(result(t, s), "opencode")
	want := Tokens{Input: 100, CacheRead: 500, CacheWrite: 40, Output: 40, Reasoning: 10}
	if models["deepseek-v4.1-flash-free"] != want || models["gpt-6.1-sol"] != want || len(models) != 2 {
		t.Fatalf("OpenCode usage: %+v", models)
	}
	// Completing a response later counts it once, without recounting the others.
	db, _ := sql.Open("sqlite", path)
	db.Exec(`UPDATE session_message SET time_updated = ?, data = json_set(data, '$.time.completed', ?) WHERE id = 'streaming'`, now, now)
	db.Close()
	os.Chtimes(path, time.Now().Add(time.Second), time.Now().Add(time.Second))
	scan(t, s, 1<<20)
	if got := byModel(result(t, s), "opencode")["deepseek-v4.1-flash-free"]; got.Input != 200 {
		t.Fatalf("completed response: %+v", got)
	}
	for _, h := range result(t, s).Hours {
		if h.Project != "oc-project" {
			t.Fatalf("project %q", h.Project)
		}
	}
}

// proto encodes test metadata: ints become varints, strings and nested
// messages become length-delimited fields.
func proto(fields ...any) []byte {
	var b []byte
	varint := func(v uint64) {
		for v >= 0x80 {
			b = append(b, byte(v)|0x80)
			v >>= 7
		}
		b = append(b, byte(v))
	}
	for i := 0; i < len(fields); i += 2 {
		n := uint64(fields[i].(int))
		switch v := fields[i+1].(type) {
		case int:
			varint(n << 3)
			varint(uint64(v))
		case string:
			varint(n<<3 | 2)
			varint(uint64(len(v)))
			b = append(b, v...)
		case []byte:
			varint(n<<3 | 2)
			varint(uint64(len(v)))
			b = append(b, v...)
		}
	}
	return b
}

func TestAntigravityMetadata(t *testing.T) {
	s, _ := setup(t)
	at := time.Now().UTC().Add(-time.Hour)
	ts := proto(1, int(at.Unix()))
	usage := func(model int, id string, input int) []byte {
		return proto(1, model, 2, input, 3, 50, 5, 900, 9, 20, 10, 30, 11, id)
	}
	generation := proto(1, proto(3, 1533, 19, "Gemini 4 Neon (Medium)", 4, usage(1533, "response-1", 100), 9, proto(4, ts), 17, proto(2, usage(1533, "retry-1", 10))))
	// The step repeats response-1 with a larger count and saves only the model code.
	step := proto(24, proto(1, 1533), 9, usage(0, "response-1", 120), 8, ts)
	unnamed := proto(24, proto(1, 1535), 9, usage(0, "response-2", 7), 8, ts)
	path := filepath.Join(os.Getenv("ANTIGRAVITY_DATA_DIR"), "conversations", "conversation-1.db")
	writeSQLite(t, path,
		"CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0)",
		"CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, metadata blob, step_payload blob)",
	)
	db, _ := sql.Open("sqlite", path)
	db.Exec("INSERT INTO gen_metadata (idx, data) VALUES (0, ?)", generation)
	db.Exec("INSERT INTO steps (idx, metadata, step_payload) VALUES (0, ?, 'PROMPT_SENTINEL'), (1, ?, 'PROMPT_SENTINEL')", step, unnamed)
	db.Close()
	enable(t, s, "antigravity")
	scan(t, s, 1<<20)
	r := result(t, s)
	models := byModel(r, "antigravity")
	if got := models["gemini-4-neon"]; got != (Tokens{Input: 130, CacheRead: 1800, Output: 100, Reasoning: 40}) {
		t.Fatalf("gemini-4-neon: %+v", got)
	}
	if got := models["antigravity-model-1535"]; got.Input != 7 {
		t.Fatalf("unnamed model: %+v", models)
	}
	for _, h := range r.Hours {
		if !h.Hour.Equal(at.Truncate(time.Hour)) {
			t.Fatalf("hour %v", h.Hour)
		}
	}
	if _, err := decodeProto([]byte{0x0a, 0x05, 'x'}); err == nil {
		t.Fatal("truncated metadata accepted")
	}
}
