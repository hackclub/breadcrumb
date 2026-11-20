package agentusage

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	bolt "go.etcd.io/bbolt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const Budget = 2 << 20

var buckets = []string{"cursors", "seen", "hours", "sessions", "options", "modern"}

type Store struct {
	mu            sync.Mutex
	db            *bolt.DB
	dir           string
	queue         []logFile
	nextDiscovery time.Time
	status        Status
}
type logFile struct {
	path string
	p    Provider
}
type Cursor struct {
	Identity   string
	PrefixSize int

	Offset      int64
	Search      int64
	Size        int64
	Modified    int64
	Fingerprint string
	Context     Context
}
type Hour struct {
	Tokens
	Provider string    `json:"provider"`
	Model    string    `json:"model"`
	Project  string    `json:"project"`
	Hour     time.Time `json:"hour"`
	Events   int       `json:"events"`
}
type Session struct {
	Provider string    `json:"provider"`
	ID       string    `json:"id"`
	Parent   string    `json:"parent,omitempty"`
	Start    time.Time `json:"start"`
	End      time.Time `json:"end"`
	Events   int       `json:"events"`
	Model    string    `json:"model"`
	Project  string    `json:"project"`
}
type ProviderStatus struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Detected bool   `json:"detected"`
	Enabled  bool   `json:"enabled"`
}
type Status struct {
	Providers []ProviderStatus `json:"providers"`
	LastScan  time.Time        `json:"lastScan"`
	Pending   int              `json:"pending"`
	Bytes     int64            `json:"bytes"`
	Error     string           `json:"error,omitempty"`
}
type Result struct {
	Status   Status    `json:"status"`
	Hours    []Hour    `json:"hours"`
	Sessions []Session `json:"sessions"`
	TimeZone string    `json:"timeZone"`
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(filepath.Join(dir, "agent-usage.db"), 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, b := range buckets {
			if _, e := tx.CreateBucketIfNotExists([]byte(b)); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db, dir: dir}, nil
}
func (s *Store) Close() error { return s.db.Close() }
func hash(v string) string    { b := sha256.Sum256([]byte(v)); return hex.EncodeToString(b[:]) }
func get(b *bolt.Bucket, k string, v any) {
	if data := b.Get([]byte(k)); data != nil {
		json.Unmarshal(data, v)
	}
}
func put(b *bolt.Bucket, k string, v any) error {
	data, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return b.Put([]byte(k), data)
}
func (s *Store) Configure(id string, enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	valid := false
	for _, p := range Providers() {
		valid = valid || id == p.ID()
	}
	if !valid {
		return errors.New("unknown usage provider")
	}
	err := s.db.Update(func(tx *bolt.Tx) error { return put(tx.Bucket([]byte("options")), id, enabled) })
	s.nextDiscovery = time.Time{}
	return err
}
func (s *Store) statusLocked() Status {
	status := s.status
	status.Providers = []ProviderStatus{}
	s.db.View(func(tx *bolt.Tx) error {
		for _, p := range Providers() {
			enabled := false
			get(tx.Bucket([]byte("options")), p.ID(), &enabled)
			info, e := os.Stat(p.Root(s.dir))
			status.Providers = append(status.Providers, ProviderStatus{p.ID(), p.Name(), e == nil && info.IsDir(), enabled})
		}
		return nil
	})
	status.Pending = len(s.queue)
	return status
}
func (s *Store) Status() Status { s.mu.Lock(); defer s.mu.Unlock(); return s.statusLocked() }
func (s *Store) Query(days int, zone string, now time.Time) (Result, error) {
	if days != 1 && days != 7 && days != 30 && days != 90 {
		return Result{}, errors.New("invalid usage range")
	}
	if _, err := time.LoadLocation(zone); err != nil {
		return Result{}, errors.New("invalid time zone")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r := Result{Status: s.statusLocked(), Hours: []Hour{}, Sessions: []Session{}, TimeZone: zone}
	cut := now.Add(-time.Duration(days) * 24 * time.Hour)
	err := s.db.View(func(tx *bolt.Tx) error {
		if err := tx.Bucket([]byte("hours")).ForEach(func(_, v []byte) error {
			var h Hour
			json.Unmarshal(v, &h)
			if !h.Hour.Before(cut.Truncate(time.Hour)) && !h.Hour.After(now) {
				r.Hours = append(r.Hours, h)
			}
			return nil
		}); err != nil {
			return err
		}
		return tx.Bucket([]byte("sessions")).ForEach(func(_, v []byte) error {
			var a Session
			json.Unmarshal(v, &a)
			if !a.End.Before(cut) && !a.Start.After(now) {
				r.Sessions = append(r.Sessions, a)
			}
			return nil
		})
	})
	sort.Slice(r.Hours, func(i, j int) bool { return r.Hours[i].Hour.Before(r.Hours[j].Hour) })
	return r, err
}

// Scan is independent of capture and sync. A byte budget bounds discovery work's
// subsequent reads. Unknown JSON content is discarded, never copied into storage.
func (s *Store) Scan(budget int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if budget <= 0 {
		return nil
	}
	if len(s.queue) == 0 && time.Now().After(s.nextDiscovery) {
		s.nextDiscovery = time.Now().Add(30 * time.Second)
		st := s.statusLocked()
		for _, p := range Providers() {
			enabled := false
			for _, a := range st.Providers {
				if a.ID == p.ID() {
					enabled = a.Enabled
				}
			}
			if !enabled {
				continue
			}
			root := p.Root(s.dir)
			err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				if d.Type()&os.ModeSymlink != 0 {
					return nil
				}
				if !d.IsDir() && filepath.Ext(path) == ".jsonl" {
					s.queue = append(s.queue, logFile{path, p})
				}
				return nil
			})
			if err != nil {
				return err
			}
		}
	}
	if len(s.queue) == 0 {
		return nil
	}
	for budget > 0 && len(s.queue) > 0 {
		f := s.queue[0]
		enabled := false
		s.db.View(func(tx *bolt.Tx) error { get(tx.Bucket([]byte("options")), f.p.ID(), &enabled); return nil })
		if !enabled {
			s.queue = s.queue[1:]
			continue
		}
		used, done, err := s.scanFile(f, budget)
		budget -= used
		s.status.Bytes += int64(used)
		if err != nil {
			s.status.Error = "A usage log could not be read"
			s.queue = s.queue[1:]
			return err
		}
		if done {
			s.queue = s.queue[1:]
		} else {
			break
		}
	}
	s.status.LastScan = time.Now().UTC()
	return nil
}
func (s *Store) scanFile(log logFile, budget int) (int, bool, error) {
	f, err := os.Open(log.path)
	if err != nil {
		return 0, true, nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return 0, true, err
	}
	used := 0
	done := false
	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("cursors"))
		key := log.path
		c := Cursor{}
		get(b, key, &c)
		// First 256 bytes identify replacement files without retaining their content.
		prefix := make([]byte, 256)
		n, _ := f.ReadAt(prefix, 0)
		prefixSize := n
		if c.PrefixSize > 0 && c.PrefixSize < n {
			prefixSize = c.PrefixSize
		}
		digest := sha256.Sum256(prefix[:prefixSize])
		fingerprint := hex.EncodeToString(digest[:])
		if c.Size > 0 && (info.Size() < c.Size || (c.Fingerprint != fingerprint) || c.Identity != identity(f)) {
			c = Cursor{}
		}
		digest = sha256.Sum256(prefix[:n])
		c.Fingerprint = hex.EncodeToString(digest[:])
		c.PrefixSize = n
		c.Identity = identity(f)
		c.Size = info.Size()
		c.Modified = info.ModTime().UnixNano()
		reader := bufio.NewReaderSize(io.NewSectionReader(f, c.Search, int64(budget)), 4096)
		for used < budget {
			ch, e := reader.ReadByte()
			if e == io.EOF {
				done = c.Search >= info.Size()
				break
			}
			if e != nil {
				return e
			}
			used++
			c.Search++
			if ch != '\n' {
				continue
			}
			length := c.Search - c.Offset
			// A pathological line is skipped with bounded work and no allocation.
			if length <= 16<<20 {
				ev, e := log.p.Parse(io.NewSectionReader(f, c.Offset, length), &c.Context)
				if e == nil && ev != nil {
					if err := s.record(tx, *ev, log.p.ID() == "codex" && c.Context.Modern); err != nil {
						return err
					}
				}
			}
			c.Offset = c.Search
		}
		if c.Search >= info.Size() {
			done = true
		}
		return put(b, key, c)
	})
	return used, done, err
}
func (s *Store) record(tx *bolt.Tx, e Event, modern bool) error {
	if e.Time.Before(time.Now().Add(-92*24*time.Hour)) || e.Time.After(time.Now().Add(5*time.Minute)) {
		return nil
	}
	seen := tx.Bucket([]byte("seen"))
	key := hash(e.Provider + ":" + e.ID)
	// Legacy contributions are isolated so modern per-response records can replace
	// them regardless of record order, including after a restart.
	kind := ""
	if e.Provider == "codex" {
		kind = "legacy"
		if modern {
			kind = "modern"
		}
		marker := tx.Bucket([]byte("modern"))
		sessionKey := e.Provider + ":" + e.Session
		if modern && marker.Get([]byte(sessionKey)) == nil {
			for _, name := range []string{"hours", "sessions"} {
				b := tx.Bucket([]byte(name))
				c := b.Cursor()
				prefix := []byte("legacy:" + sessionKey + ":")
				for k, _ := c.Seek(prefix); k != nil && len(k) >= len(prefix) && string(k[:len(prefix)]) == string(prefix); k, _ = c.Next() {
					if err := c.Delete(); err != nil {
						return err
					}
				}
			}
			if err := marker.Put([]byte(sessionKey), []byte{1}); err != nil {
				return err
			}
		}
		if !modern && marker.Get([]byte(sessionKey)) != nil {
			return nil
		}
	}
	if seen.Get([]byte(key)) != nil {
		return nil
	}
	if err := seen.Put([]byte(key), []byte(e.Time.Format(time.RFC3339))); err != nil {
		return err
	}
	hkey := fmt.Sprintf("%s:%s:%s:%s:%s:%s", kind, e.Provider, e.Session, e.Model, e.Project, e.Time.UTC().Truncate(time.Hour).Format(time.RFC3339))
	hours := tx.Bucket([]byte("hours"))
	h := Hour{Provider: e.Provider, Model: e.Model, Project: e.Project, Hour: e.Time.UTC().Truncate(time.Hour)}
	get(hours, hkey, &h)
	h.Tokens = h.Tokens.add(e.Tokens)
	h.Events++
	if err := put(hours, hkey, h); err != nil {
		return err
	}
	sessions := tx.Bucket([]byte("sessions"))
	skey := kind + ":" + e.Provider + ":" + e.Session + ":"
	a := Session{Provider: e.Provider, ID: e.Session, Parent: e.Parent, Model: e.Model, Project: e.Project, Start: e.Time, End: e.Time}
	get(sessions, skey, &a)
	if e.Time.Before(a.Start) {
		a.Start = e.Time
	}
	if e.Time.After(a.End) {
		a.End = e.Time
	}
	a.Events++
	return put(sessions, skey, a)
}
