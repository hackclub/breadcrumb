package agentusage

import (
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
	"unicode/utf8"
)

type Tokens struct {
	Input        int64 `json:"input"` // Uncached input; output includes reasoning.
	CacheRead    int64 `json:"cacheRead"`
	CacheWrite   int64 `json:"cacheWrite"`
	CacheWrite1h int64 `json:"cacheWrite1h"` // Subset of CacheWrite.
	Output       int64 `json:"output"`
	Reasoning    int64 `json:"reasoning"` // Subset of Output.
}

func (t Tokens) add(u Tokens) Tokens {
	return Tokens{t.Input + u.Input, t.CacheRead + u.CacheRead, t.CacheWrite + u.CacheWrite, t.CacheWrite1h + u.CacheWrite1h, t.Output + u.Output, t.Reasoning + u.Reasoning}
}
func (t Tokens) valid() bool {
	return t.Input >= 0 && t.CacheRead >= 0 && t.CacheWrite >= 0 && t.CacheWrite1h >= 0 && t.CacheWrite1h <= t.CacheWrite && t.Output >= 0 && t.Reasoning >= 0 && t.Reasoning <= t.Output && t.Input+t.CacheRead+t.CacheWrite+t.Output <= 1e12
}

type Event struct {
	Tokens
	Provider string    `json:"provider"`
	ID       string    `json:"id"`
	Session  string    `json:"session"`
	Parent   string    `json:"parent,omitempty"`
	Model    string    `json:"model"`
	Time     time.Time `json:"time"`
	Project  string    `json:"project"`
}
type Context struct {
	OwnUsageStarted bool      `json:"ownUsageStarted"`
	Session         string    `json:"session"`
	Parent          string    `json:"parent,omitempty"`
	Model           string    `json:"model"`
	Project         string    `json:"project"`
	Total           int64     `json:"total"`
	Modern          bool      `json:"modern"`
	Started         time.Time `json:"started"`
	Fork            bool      `json:"fork"`
}

// Source is a usage provider with its own opt-in. Log providers read JSONL files
// incrementally; database providers re-read a local store when it changes.
type Source interface {
	ID() string
	Name() string
	Root(library string) string
}

// Provider implementations must extract only allowlisted metadata and numbers.
// Parsing state is persisted atomically with the cursor and resulting aggregates.
// One record can report several models, so a record yields zero or more events.
type Provider interface {
	Source
	Parse(io.Reader, *Context) ([]Event, error)
}
type builtin struct{ id, name, env, home, sub, file string }

func (p builtin) ID() string   { return p.id }
func (p builtin) Name() string { return p.name }
func (p builtin) Root(library string) string {
	if p.id == "import" {
		return filepath.Join(library, "agent-imports")
	}
	return filepath.Join(homeDir(p.env, p.home), p.sub)
}

// accepts limits a provider to its usage log when a session directory holds
// other JSONL files, such as Grok Build's chat history.
func (p builtin) accepts(path string) bool { return p.file == "" || filepath.Base(path) == p.file }

// begin sets file-level context before a log's first record.
func (p builtin) begin(path string, c *Context) {
	if p.id == "grok" {
		// Grok Build names each session's parent directory after its escaped working directory.
		if cwd, err := url.PathUnescape(filepath.Base(filepath.Dir(filepath.Dir(path)))); err == nil {
			c.Project = project(cwd)
		}
	}
}
func homeDir(env, home string) string {
	if base := os.Getenv(env); base != "" {
		return base
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, home)
}
func Providers() []Provider {
	return []Provider{
		builtin{id: "claude", name: "Claude Code", env: "CLAUDE_CONFIG_DIR", home: ".claude", sub: "projects"},
		builtin{id: "codex", name: "Codex", env: "CODEX_HOME", home: ".codex", sub: "sessions"},
		builtin{id: "import", name: "JSONL plugins"},
		builtin{id: "grok", name: "Grok Build", env: "GROK_HOME", home: ".grok", sub: "sessions", file: "updates.jsonl"},
	}
}

// Native readers own these IDs. OpenCode stays open to its exporter plugin: both
// use OpenCode message IDs, so the same response is counted once.
var reserved = map[string]bool{"claude": true, "codex": true, "grok": true, "antigravity": true}

var ident = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:@+-]{0,199}$`)

func validProject(name string) bool {
	if name == "" {
		return true
	}
	if name == "." || name == ".." || utf8.RuneCountInString(name) > 200 || !utf8.ValidString(name) || strings.ContainsAny(name, `/\:`) {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func project(cwd string) string {
	if !filepath.IsAbs(cwd) {
		return ""
	}
	for dir := filepath.Clean(cwd); ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return filepath.Base(dir)
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	return ""
}
func repositoryName(remote string) string {
	remote = strings.TrimSuffix(strings.TrimRight(remote, "/"), ".git")
	name := filepath.Base(strings.ReplaceAll(remote, `\`, "/"))
	if !ident.MatchString(name) {
		return ""
	}
	return name
}

func number(f fields, k string) int64 {
	v, e := strconv.ParseInt(f[k], 10, 64)
	if e != nil || v < 0 || v > 1e12 {
		return 0
	}
	return v
}

// modelID drops a router's vendor prefix, as in "inception/mercury-2.5", which
// leaves the model's own ID for display and pricing.
func modelID(model string) string { return model[strings.LastIndexByte(model, '/')+1:] }

func epoch(f fields, k string) int64 {
	v, _ := strconv.ParseInt(f[k], 10, 64)
	return max(v, 0)
}
func usage(f fields, p string, claude bool) Tokens {
	t := Tokens{Input: number(f, p+"input_tokens"), CacheRead: number(f, p+"cached_input_tokens"), CacheWrite: number(f, p+"cache_write_input_tokens"), Output: number(f, p+"output_tokens"), Reasoning: number(f, p+"reasoning_output_tokens")}
	if claude {
		t.CacheRead = number(f, p+"cache_read_input_tokens")
		t.CacheWrite = number(f, p+"cache_creation_input_tokens")
		t.CacheWrite1h = number(f, p+"cache_creation.ephemeral_1h_input_tokens")
	} else {
		t.Input -= t.CacheRead + t.CacheWrite
	}
	return t
}

func usagePaths(metadata string, prefixes ...string) map[string]bool {
	m := map[string]bool{}
	for _, k := range strings.Fields(metadata) {
		m[k] = true
	}
	for _, prefix := range prefixes {
		for _, k := range strings.Fields("input_tokens cached_input_tokens cache_write_input_tokens cache_read_input_tokens cache_creation_input_tokens cache_creation.ephemeral_5m_input_tokens cache_creation.ephemeral_1h_input_tokens output_tokens reasoning_output_tokens total_tokens") {
			m[prefix+k] = true
		}
	}
	return m
}

var providerPaths = map[string]map[string]bool{
	"claude": usagePaths("type timestamp sessionId cwd requestId message.id message.model", "message.usage."),
	"codex":  usagePaths("type timestamp payload.type payload.id payload.timestamp payload.cwd payload.forked_from_id payload.parent_thread_id payload.history_mode payload.subagent_history_start_ordinal payload.model payload.git.repository_url payload.response_id", "payload.usage.", "payload.info.last_token_usage.", "payload.info.total_token_usage."),
	"import": usagePaths("provider id session parent model time project input cacheRead cacheWrite cacheWrite1h output reasoning"),
	"grok":   grokPaths(),
}

var grokTokens = strings.Fields("inputTokens outputTokens cachedReadTokens cacheCreationTokens reasoningTokens")

func grokPaths() map[string]bool {
	m := usagePaths("timestamp timestamp_us params.sessionId params._meta.agentTimestampMs params.update.sessionUpdate params.update.prompt_id")
	for _, k := range grokTokens {
		m["params.update.usage."+k] = true
		m["params.update.usage.modelUsage.*."+k] = true
	}
	return m
}

// Grok Build saves usage per model on each completed turn. Input includes cache
// reads and writes; output includes reasoning.
func parseGrok(f fields, c *Context) ([]Event, error) {
	if f["params.update.sessionUpdate"] != "turn_completed" {
		return nil, nil
	}
	at := time.UnixMilli(epoch(f, "params._meta.agentTimestampMs"))
	if f["params._meta.agentTimestampMs"] == "" {
		at = time.UnixMicro(epoch(f, "timestamp_us"))
	}
	if at.Unix() <= 0 {
		return nil, errJSON
	}
	session, prompt := f["params.sessionId"], f["params.update.prompt_id"]
	if prompt == "" {
		prompt = strconv.FormatInt(at.UnixMicro(), 10)
	}
	totals := map[string]string{}
	const models = "params.update.usage.modelUsage."
	for k := range f {
		if rest, ok := strings.CutPrefix(k, models); ok {
			if i := strings.LastIndexByte(rest, '.'); i > 0 {
				totals[rest[:i]] = models + rest[:i] + "."
			}
		}
	}
	if len(totals) == 0 {
		totals["grok"] = "params.update.usage."
	}
	events := []Event{}
	for model, prefix := range totals {
		input, read, write, output := number(f, prefix+"inputTokens"), number(f, prefix+"cachedReadTokens"), number(f, prefix+"cacheCreationTokens"), number(f, prefix+"outputTokens")
		t := Tokens{Input: max(0, input-read-write), CacheRead: read, CacheWrite: write, Output: output, Reasoning: min(output, number(f, prefix+"reasoningTokens"))}
		if t.Input+t.CacheRead+t.CacheWrite+t.Output == 0 {
			continue
		}
		events = append(events, Event{Tokens: t, Provider: "grok", ID: session + ":" + prompt + ":" + model, Session: session, Model: modelID(model), Time: at.UTC(), Project: c.Project})
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Model < events[j].Model })
	return events, nil
}

func (p builtin) Parse(r io.Reader, c *Context) ([]Event, error) {
	allowed := providerPaths[p.id]
	f, err := extract(r, allowed, p.id == "import")
	if err != nil {
		return nil, err
	}
	for k, v := range f {
		if strings.HasSuffix(k, "_tokens") || strings.HasSuffix(k, "Tokens") || k == "input" || k == "cacheRead" || k == "cacheWrite" || k == "cacheWrite1h" || k == "output" || k == "reasoning" {
			n, e := strconv.ParseInt(v, 10, 64)
			if e != nil || n < 0 || n > 1e12 {
				return nil, errJSON
			}
		}
	}
	if p.id == "grok" {
		events, err := parseGrok(f, c)
		for _, e := range events {
			if !e.valid() {
				return nil, errJSON
			}
		}
		return events, err
	}
	e := Event{Provider: p.id, Session: c.Session, Parent: c.Parent, Model: c.Model, Project: c.Project}
	e.Time, _ = time.Parse(time.RFC3339Nano, f["timestamp"])
	switch p.id {
	case "claude":
		if f["type"] != "assistant" {
			return nil, nil
		}
		e.Session = f["sessionId"]
		e.Model = f["message.model"]
		e.Project = project(f["cwd"])
		if f["message.id"] == "" {
			return nil, nil
		}
		e.ID = f["message.id"] + ":" + f["requestId"]
		e.Tokens = usage(f, "message.usage.", true)
	case "codex":
		switch f["type"] {
		case "session_meta":
			c.Session = f["payload.id"]
			c.Started, _ = time.Parse(time.RFC3339Nano, f["payload.timestamp"])
			c.Parent = f["payload.forked_from_id"]
			if c.Parent == "" {
				c.Parent = f["payload.parent_thread_id"]
			}
			c.Fork = c.Parent != "" || f["payload.subagent_history_start_ordinal"] != "" || (f["payload.history_mode"] != "" && f["payload.history_mode"] != "none")
			c.Project = project(f["payload.cwd"])
			if c.Project == "" {
				c.Project = repositoryName(f["payload.git.repository_url"])
			}
			return nil, nil
		case "turn_context":
			c.Model = f["payload.model"]
			return nil, nil
		case "token_usage_record":
			if c.Fork && !c.Started.IsZero() && e.Time.Before(c.Started) {
				return nil, nil
			}
			e.ID = f["payload.response_id"]
			e.Tokens = usage(f, "payload.usage.", false)

		case "event_msg":
			if f["payload.type"] != "token_count" || c.Modern {
				return nil, nil
			}
			total := number(f, "payload.info.total_token_usage.total_tokens")
			if c.Fork {
				if c.Started.IsZero() || e.Time.Before(c.Started) {
					return nil, nil
				}
				// The child's own cumulative counter can restart below inherited totals.
				// Its first fresh last_token_usage still represents new work.
				if !c.OwnUsageStarted {
					c.Total = 0
					c.OwnUsageStarted = true
				}
			}
			if total <= c.Total {
				return nil, nil
			}
			c.Total = total
			e.ID = c.Session + ":" + strconv.FormatInt(total, 10)
			e.Tokens = usage(f, "payload.info.last_token_usage.", false)
		default:
			return nil, nil
		}
	case "import":
		// Strict plugin schema: no additional fields, even if they look harmless.
		strict := map[string]bool{}
		for _, k := range strings.Fields("provider id session parent model time project input cacheRead cacheWrite cacheWrite1h output reasoning") {
			strict[k] = true
		}
		for k := range f {
			if !strict[k] {
				return nil, errJSON
			}
		}
		e = Event{Provider: f["provider"], ID: f["id"], Session: f["session"], Parent: f["parent"], Model: f["model"], Project: f["project"], Tokens: Tokens{number(f, "input"), number(f, "cacheRead"), number(f, "cacheWrite"), number(f, "cacheWrite1h"), number(f, "output"), number(f, "reasoning")}}
		if !validProject(e.Project) {
			return nil, errJSON
		}
		e.Time, err = time.Parse(time.RFC3339Nano, f["time"])
		if err != nil {
			return nil, err
		}
		if reserved[e.Provider] || !ident.MatchString(e.Provider) {
			return nil, errJSON
		}
	}
	if !e.valid() {
		return nil, errJSON
	}
	if p.id == "codex" && f["type"] == "token_usage_record" {
		c.Modern = true
	}
	return []Event{e}, nil
}
func (e Event) valid() bool {
	return ident.MatchString(e.Session) && ident.MatchString(e.Model) && e.ID != "" && len(e.ID) <= 512 && !e.Time.IsZero() && e.Tokens.valid()
}
