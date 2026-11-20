package agentusage

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
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
	Session string    `json:"session"`
	Parent  string    `json:"parent,omitempty"`
	Model   string    `json:"model"`
	Project string    `json:"project"`
	Total   int64     `json:"total"`
	Modern  bool      `json:"modern"`
	Started time.Time `json:"started"`
	Fork    bool      `json:"fork"`
}

// Provider implementations must extract only allowlisted metadata and numbers.
// Parsing state is persisted atomically with the cursor and resulting aggregates.
type Provider interface {
	ID() string
	Name() string
	Root(library string) string
	Parse(io.Reader, *Context) (*Event, error)
}
type builtin struct{ id, name, env, home, sub string }

func (p builtin) ID() string   { return p.id }
func (p builtin) Name() string { return p.name }
func (p builtin) Root(library string) string {
	if p.id == "import" {
		return filepath.Join(library, "agent-imports")
	}
	base := os.Getenv(p.env)
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, p.home)
	}
	return filepath.Join(base, p.sub)
}
func Providers() []Provider {
	return []Provider{builtin{"claude", "Claude Code", "CLAUDE_CONFIG_DIR", ".claude", "projects"}, builtin{"codex", "Codex", "CODEX_HOME", ".codex", "sessions"}, builtin{id: "import", name: "JSONL plugins"}}
}

var ident = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:@+-]{0,199}$`)

func project(cwd string) string {
	if filepath.IsAbs(cwd) {
		for dir := filepath.Clean(cwd); ; dir = filepath.Dir(dir) {
			if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
				cwd = dir
				break
			}
			if filepath.Dir(dir) == dir {
				break
			}
		}
	}

	cwd = strings.ReplaceAll(cwd, `\`, "/")
	s := filepath.Base(strings.TrimRight(cwd, "/"))
	if s == "." || s == "/" || strings.Contains(s, ":") {
		return ""
	}
	return s
}
func number(f fields, k string) int64 {
	v, e := strconv.ParseInt(f[k], 10, 64)
	if e != nil || v < 0 || v > 1e12 {
		return 0
	}
	return v
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

var paths = func() map[string]bool {
	m := map[string]bool{}
	for _, k := range strings.Fields("type timestamp sessionId cwd requestId message.id message.model payload.type payload.id payload.timestamp payload.cwd payload.forked_from_id payload.parent_thread_id payload.source.subagent payload.history_mode payload.subagent_history_start_ordinal payload.model payload.response_id provider id session parent model time project input cacheRead cacheWrite cacheWrite1h output reasoning") {
		m[k] = true
	}
	for _, prefix := range []string{"message.usage.", "payload.usage.", "payload.info.last_token_usage.", "payload.info.total_token_usage."} {
		for _, k := range strings.Fields("input_tokens cached_input_tokens cache_write_input_tokens cache_read_input_tokens cache_creation_input_tokens cache_creation.ephemeral_5m_input_tokens cache_creation.ephemeral_1h_input_tokens output_tokens reasoning_output_tokens total_tokens") {
			m[prefix+k] = true
		}
	}
	return m
}()

func (p builtin) Parse(r io.Reader, c *Context) (*Event, error) {
	allowed := paths
	if p.id == "import" {
		allowed = map[string]bool{}
		for _, k := range strings.Fields("provider id session parent model time project input cacheRead cacheWrite cacheWrite1h output reasoning") {
			allowed[k] = true
		}
	}
	f, err := extract(r, allowed, p.id == "import")
	if err != nil {
		return nil, err
	}
	for k, v := range f {
		if strings.HasSuffix(k, "_tokens") || k == "input" || k == "cacheRead" || k == "cacheWrite" || k == "cacheWrite1h" || k == "output" || k == "reasoning" {
			n, e := strconv.ParseInt(v, 10, 64)
			if e != nil || n < 0 || n > 1e12 {
				return nil, errJSON
			}
		}
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
			if total <= c.Total {
				return nil, nil
			}
			c.Total = total
			if c.Fork && (c.Started.IsZero() || e.Time.Before(c.Started)) {
				return nil, nil
			}
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
		if !ident.MatchString(e.Project) && e.Project != "" {
			return nil, errJSON
		}
		e.Time, err = time.Parse(time.RFC3339Nano, f["time"])
		if err != nil {
			return nil, err
		}
		if e.Provider == "claude" || e.Provider == "codex" || !ident.MatchString(e.Provider) {
			return nil, errJSON
		}
	}
	if !ident.MatchString(e.Session) || !ident.MatchString(e.Model) || e.ID == "" || len(e.ID) > 512 || e.Time.IsZero() || !e.Tokens.valid() {
		return nil, errJSON
	}
	if p.id == "codex" && f["type"] == "token_usage_record" {
		c.Modern = true
	}
	return &e, nil
}
