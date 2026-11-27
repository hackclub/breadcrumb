package agentusage

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// databaseSource reads usage from another app's SQLite store. Stores are opened
// read-only and queried for allowlisted values; message and step contents are
// never selected. Each store is re-read when it or its write-ahead log changes,
// and event IDs keep re-reads from counting a response twice.
type databaseSource interface {
	Source
	databases(root string) []string
	read(db *sql.DB, path string, c *Cursor) ([]Event, error)
}

// Sources lists every built-in provider in display order, with the generic JSONL
// importer last.
func Sources() []Source {
	sources, importer := []Source{}, Source(nil)
	for _, p := range Providers() {
		if p.ID() == "import" {
			importer = p
		} else {
			sources = append(sources, p)
		}
	}
	return append(sources, openCode{}, antigravity{}, importer)
}

// openReadOnly never writes the store. immutable skips locking for a store whose
// app is closed, where a read-only open can fail without its shared-memory file.
func openReadOnly(path string, immutable bool) (*sql.DB, error) {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	mode := "mode=ro"
	if immutable {
		mode += "&immutable=1"
	}
	db, err := sql.Open("sqlite", "file:"+(&url.URL{Path: p}).EscapedPath()+"?"+mode+"&_pragma=busy_timeout(200)&_pragma=query_only(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}
func tables(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query("SELECT name FROM sqlite_master WHERE type = 'table'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names[name] = true
	}
	return names, rows.Err()
}

// OpenCode v2 keeps each response in session_message. Only completed assistant
// responses count, so their token totals are final when read.
type openCode struct{}

func (openCode) ID() string   { return "opencode" }
func (openCode) Name() string { return "OpenCode" }
func (openCode) Root(string) string {
	if dir := os.Getenv("OPENCODE_DATA_DIR"); dir != "" {
		return dir
	}
	if data := os.Getenv("XDG_DATA_HOME"); filepath.IsAbs(data) {
		return filepath.Join(data, "opencode")
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".local", "share", "opencode")
}

var openCodeDatabase = regexp.MustCompile(`^opencode(-[A-Za-z0-9_-]+)?\.db$`)

func (openCode) databases(root string) []string {
	entries, _ := os.ReadDir(root)
	paths := []string{}
	for _, e := range entries {
		if e.Type().IsRegular() && openCodeDatabase.MatchString(e.Name()) {
			paths = append(paths, filepath.Join(root, e.Name()))
		}
	}
	return paths
}
func (openCode) read(db *sql.DB, _ string, c *Cursor) ([]Event, error) {
	names, err := tables(db)
	if err != nil || !names["session_message"] || !names["session_v2"] {
		return nil, err
	}
	// Offset holds the newest update time read. Rows updated within a minute of it
	// are read again in case they committed out of order.
	rows, err := db.Query(`SELECT m.id, m.session_id, m.time_created, m.time_updated, s.directory,
		COALESCE(s.fork_session_id, s.parent_id, ''), s.time_created,
		json_extract(m.data, '$.model.id'), CAST(json_extract(m.data, '$.time.completed') AS INTEGER),
		CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), CAST(json_extract(m.data, '$.tokens.output') AS INTEGER),
		CAST(json_extract(m.data, '$.tokens.reasoning') AS INTEGER), CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER),
		CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER)
		FROM session_message m JOIN session_v2 s ON s.id = m.session_id
		WHERE m.type = 'assistant' AND m.time_updated >= ?`, max(0, c.Offset-60000))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []Event{}
	projects := map[string]string{}
	for rows.Next() {
		var id, session, directory, parent string
		var created, updated, started int64
		var model sql.NullString
		var completed, input, output, reasoning, read, write sql.NullInt64
		if err := rows.Scan(&id, &session, &created, &updated, &directory, &parent, &started, &model, &completed, &input, &output, &reasoning, &read, &write); err != nil {
			return nil, err
		}
		c.Offset = max(c.Offset, updated)
		// A fork copies earlier responses under new IDs; only its own responses count.
		if !completed.Valid || completed.Int64 <= 0 || (parent != "" && created < started) {
			continue
		}
		if _, ok := projects[directory]; !ok {
			projects[directory] = project(directory)
		}
		n := func(v sql.NullInt64) int64 { return min(max(v.Int64, 0), 1e12) }
		e := Event{Provider: "opencode", ID: id, Session: session, Parent: parent, Model: modelID(model.String), Time: time.UnixMilli(completed.Int64).UTC(), Project: projects[directory],
			Tokens: Tokens{Input: n(input), CacheRead: n(read), CacheWrite: n(write), Output: n(output) + n(reasoning), Reasoning: n(reasoning)}}
		if e.valid() && e.Input+e.CacheRead+e.CacheWrite+e.Output > 0 {
			events = append(events, e)
		}
	}
	return events, rows.Err()
}

// Antigravity keeps one SQLite store per conversation. Usage is protobuf metadata
// beside each generation and step, apart from the conversation text.
type antigravity struct{}

func (antigravity) ID() string   { return "antigravity" }
func (antigravity) Name() string { return "Antigravity" }
func (a antigravity) roots() []string {
	if dir := os.Getenv("ANTIGRAVITY_DATA_DIR"); dir != "" {
		return strings.Split(dir, string(os.PathListSeparator))
	}
	h, _ := os.UserHomeDir()
	roots := []string{}
	for _, name := range []string{"antigravity-cli", "antigravity", "antigravity-ide"} {
		roots = append(roots, filepath.Join(h, ".gemini", name))
	}
	return append(roots, filepath.Join(h, ".config", "antigravity"))
}
func (a antigravity) Root(string) string {
	roots := a.roots()
	for _, root := range roots {
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			return root
		}
	}
	return roots[0]
}

var conversationDatabase = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}\.db$`)

func (a antigravity) databases(string) []string {
	paths, seen := []string{}, map[string]bool{}
	for _, root := range a.roots() {
		dir := filepath.Join(root, "conversations")
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			dir = root
		}
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			dir = real
		}
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			info, err := e.Info()
			if err != nil || !e.Type().IsRegular() || !conversationDatabase.MatchString(e.Name()) || time.Since(info.ModTime()) > 92*24*time.Hour || seen[filepath.Join(dir, e.Name())] {
				continue
			}
			seen[filepath.Join(dir, e.Name())] = true
			paths = append(paths, filepath.Join(dir, e.Name()))
		}
	}
	return paths
}

// Enumerated models from older Antigravity builds that did not save a model name.
var antigravityModels = map[uint64]string{
	246: "gemini-2.5-pro", 312: "gemini-2.5-flash", 313: "gemini-2.5-flash-thinking", 329: "gemini-2.5-flash-thinking",
	330: "gemini-2.5-flash-lite", 281: "claude-sonnet-4", 282: "claude-sonnet-4", 290: "claude-opus-4", 291: "claude-opus-4",
	333: "claude-sonnet-4-5", 334: "claude-sonnet-4-5", 340: "claude-haiku-4-5", 341: "claude-haiku-4-5", 1026: "claude-opus-4-6",
	1035: "claude-sonnet-4-6", 1016: "gemini-3.1-pro", 1036: "gemini-3.1-pro", 1037: "gemini-3.1-pro", 1018: "gemini-3-flash-preview",
	1084: "gemini-3-flash-preview", 1047: "gemini-3-flash-preview",
}
var displaySuffix = regexp.MustCompile(`\s*\([^)]*\)\s*$`)
var claudeOrder = regexp.MustCompile(`^claude-(4(?:\.\d+)?)-(sonnet|opus|haiku)`)

// antigravityModel turns a display name such as "Gemini 4 Neon (Medium)" into
// the API model ID "gemini-4-neon".
func antigravityModel(name string, id uint64) string {
	if name = strings.TrimSpace(name); name != "" {
		m := strings.ReplaceAll(strings.ToLower(displaySuffix.ReplaceAllString(name, "")), " ", "-")
		if strings.HasPrefix(m, "claude-") {
			m = strings.ReplaceAll(claudeOrder.ReplaceAllString(m, "claude-$2-$1"), ".", "-")
		}
		if ident.MatchString(m) {
			return m
		}
	}
	if m := antigravityModels[id]; m != "" {
		return m
	}
	if id > 0 {
		return "antigravity-model-" + strconv.FormatUint(id, 10)
	}
	return ""
}

type protoFields map[uint64][]any

var errProto = errors.New("invalid usage metadata")

// decodeProto reads one message level. Length-delimited values stay as bytes and
// are only decoded further when a usage path needs them.
func decodeProto(b []byte) (protoFields, error) {
	out := protoFields{}
	for i := 0; i < len(b); {
		tag, n := uvarint(b[i:])
		if n <= 0 || tag>>3 == 0 {
			return nil, errProto
		}
		i += n
		var v any
		switch tag & 7 {
		case 0:
			x, n := uvarint(b[i:])
			if n <= 0 {
				return nil, errProto
			}
			v, i = x, i+n
		case 1, 5:
			size := 8
			if tag&7 == 5 {
				size = 4
			}
			if len(b)-i < size {
				return nil, errProto
			}
			i += size
			continue
		case 2:
			size, n := uvarint(b[i:])
			if n <= 0 || size > uint64(len(b)-i-n) {
				return nil, errProto
			}
			i += n
			v, i = b[i:i+int(size)], i+int(size)
		default:
			return nil, errProto
		}
		out[tag>>3] = append(out[tag>>3], v)
	}
	return out, nil
}
func uvarint(b []byte) (uint64, int) {
	var x uint64
	for i := 0; i < len(b) && i < 10; i++ {
		x |= uint64(b[i]&0x7f) << (7 * i)
		if b[i] < 0x80 {
			return x, i + 1
		}
	}
	return 0, -1
}
func (f protoFields) number(k uint64) uint64 {
	if len(f[k]) > 0 {
		if v, ok := f[k][0].(uint64); ok {
			return v
		}
	}
	return 0
}
func (f protoFields) bytes(k uint64) []byte {
	if len(f[k]) > 0 {
		if v, ok := f[k][0].([]byte); ok {
			return v
		}
	}
	return nil
}
func (f protoFields) nested(k uint64) protoFields {
	n, _ := decodeProto(f.bytes(k))
	return n
}
func (f protoFields) text(k uint64) string {
	b := f.bytes(k)
	if len(b) > 512 || !utf8.Valid(b) {
		return ""
	}
	return strings.TrimSpace(string(b))
}
func (f protoFields) time() (time.Time, bool) {
	if s := f.number(1); s > 0 && s < 1<<40 {
		return time.Unix(int64(s), int64(f.number(2)%1e9)).UTC(), true
	}
	return time.Time{}, false
}

type antigravityUsage struct {
	tokens      Tokens
	model, name string
	enum, idx   uint64
	step        bool
	at          time.Time
	hasTime     bool
	keys        []string
	id          string
}

// antigravityMetadata reads one generation (gen_metadata) or step (steps.metadata)
// blob: the model's display name and code, the time and each attempt's usage.
func antigravityMetadata(blob []byte, step bool) (name string, enum uint64, at time.Time, hasTime bool, usages []protoFields, err error) {
	root, err := decodeProto(blob)
	if err != nil {
		return
	}
	data, info, usage, retries := root, root.nested(24), uint64(9), uint64(28)
	if !step {
		if root.bytes(1) == nil {
			return "", 0, at, false, nil, errProto
		}
		data = root.nested(1)
		info, usage, retries = data, 4, 17
	}
	if step {
		name, enum = firstText(info.text(12), info.text(8)), info.number(1)
		if at, hasTime = data.nested(8).time(); !hasTime {
			at, hasTime = data.nested(1).time()
		}
	} else {
		name, enum = firstText(info.text(19), info.text(21)), info.number(3)
		at, hasTime = data.nested(9).nested(4).time()
	}
	if u := data.bytes(usage); u != nil {
		f, e := decodeProto(u)
		if e != nil {
			return "", 0, at, false, nil, e
		}
		usages = append(usages, f)
	}
	for _, r := range data[retries] {
		b, ok := r.([]byte)
		if !ok {
			return "", 0, at, false, nil, errProto
		}
		retry, e := decodeProto(b)
		if e != nil {
			return "", 0, at, false, nil, e
		}
		if u := retry.bytes(2); u != nil {
			f, e := decodeProto(u)
			if e != nil {
				return "", 0, at, false, nil, e
			}
			usages = append(usages, f)
		}
	}
	return
}
func firstText(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
func (antigravity) read(db *sql.DB, path string, _ *Cursor) ([]Event, error) {
	names, err := tables(db)
	if err != nil {
		return nil, err
	}
	session := strings.TrimSuffix(filepath.Base(path), ".db")
	fallback := time.Now().UTC()
	if info, err := os.Stat(path); err == nil {
		fallback = info.ModTime().UTC()
	}
	if names["trajectory_metadata_blob"] {
		var blob []byte
		if db.QueryRow("SELECT data FROM trajectory_metadata_blob LIMIT 1").Scan(&blob) == nil {
			if f, err := decodeProto(blob); err == nil {
				if t, ok := f.nested(2).time(); ok {
					fallback = t
				}
			}
		}
	}
	records := []antigravityUsage{}
	collect := func(query string, step bool) error {
		rows, err := db.Query(query)
		if err != nil {
			return err
		}
		defer rows.Close()
		index := 0
		for rows.Next() {
			var idx int64
			var blob []byte
			if err := rows.Scan(&idx, &blob); err != nil {
				return err
			}
			// A row this reader cannot decode is skipped; the conversation's other rows still count.
			name, enum, at, hasTime, usages, _ := antigravityMetadata(blob, step)
			for i, u := range usages {
				output := max(u.number(3), u.number(9)+u.number(10))
				t := Tokens{Input: int64(min(u.number(2), 1e12)), CacheRead: int64(min(u.number(5), 1e12)), CacheWrite: int64(min(u.number(4), 1e12)), Output: int64(min(output, 1e12)), Reasoning: int64(min(output, u.number(9), 1e12))}
				if t.Input+t.CacheRead+t.CacheWrite+t.Output == 0 {
					continue
				}
				r := antigravityUsage{tokens: t, name: name, enum: enum, idx: uint64(idx), step: step, at: at, hasTime: hasTime, model: antigravityModels[u.number(1)]}
				if r.model == "" && u.number(1) != 0 {
					r.enum = u.number(1)
				}
				for _, k := range []uint64{11, 12, 7} {
					if id := u.text(k); id != "" && len(id) <= 200 {
						r.keys = append(r.keys, fmt.Sprintf("%d:%s", k, id))
					}
				}
				source := "generation"
				if step {
					source = "step"
				}
				r.id = fmt.Sprintf("%s:%s:%d:%d", session, source, index, i)
				if len(r.keys) > 0 {
					r.id = r.keys[0]
				}
				records = append(records, r)
			}
			index++
		}
		return rows.Err()
	}
	// Generation metadata names the model a step's usage may omit, so read it first.
	if names["gen_metadata"] {
		if err := collect("SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx", false); err != nil {
			return nil, err
		}
	}
	if names["steps"] {
		if err := collect("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx", true); err != nil {
			return nil, err
		}
	}
	// Steps can omit the model name that the conversation's generations save with
	// the same model code, so a code learned anywhere in the store names them.
	learned, generations := map[uint64]string{}, map[uint64]string{}
	for _, r := range records {
		if m := antigravityModel(r.name, 0); m != "" {
			learned[r.enum] = m
			if !r.step {
				generations[r.idx] = m
			}
		}
	}
	for i := range records {
		r := &records[i]
		r.model = firstText(r.model, antigravityModel(r.name, 0), learned[r.enum])
		if r.model == "" && r.step {
			r.model = generations[r.idx]
		}
		r.model = firstText(r.model, antigravityModel("", r.enum), "antigravity-unknown")
	}
	// A response can be saved with both its generation and its step. Records that
	// share any response ID are one response; each count keeps its largest value.
	merged, owner := []*antigravityUsage{}, map[string]*antigravityUsage{}
	for i := range records {
		r := &records[i]
		var target *antigravityUsage
		for _, k := range r.keys {
			if owner[k] != nil {
				target = owner[k]
				break
			}
		}
		if target == nil {
			merged = append(merged, r)
			target = r
		} else {
			t, u := &target.tokens, r.tokens
			t.Input, t.CacheRead, t.CacheWrite, t.Output, t.Reasoning = max(t.Input, u.Input), max(t.CacheRead, u.CacheRead), max(t.CacheWrite, u.CacheWrite), max(t.Output, u.Output), max(t.Reasoning, u.Reasoning)
			if target.model == "antigravity-unknown" {
				target.model = r.model
			}
			if !target.hasTime && r.hasTime {
				target.at, target.hasTime = r.at, true
			}
			target.keys = append(target.keys, r.keys...)
		}
		for _, k := range target.keys {
			owner[k] = target
		}
	}
	events := []Event{}
	for _, r := range merged {
		at := r.at
		if !r.hasTime {
			at = fallback
		}
		e := Event{Tokens: r.tokens, Provider: "antigravity", ID: r.id, Session: session, Model: r.model, Time: at}
		if e.valid() {
			events = append(events, e)
		}
	}
	return events, nil
}
