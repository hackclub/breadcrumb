package library

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const GiB int64 = 1073741824

var Epoch = time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)

func Timestamp(t time.Time) float64 { return t.Sub(Epoch).Seconds() }

type Settings struct {
	RetentionHours       int     `json:"retentionHours"`
	StorageGiB           int64   `json:"storageGiB"`
	SavedStorageGiB      int64   `json:"savedStorageGiB"`
	IntervalSeconds      int     `json:"intervalSeconds"`
	CaptureChanges       bool    `json:"captureChanges"`
	MinimumEventInterval int     `json:"minimumEventInterval"`
	RecognizeText        bool    `json:"recognizeText"`
	JPEGQuality          float64 `json:"jpegQuality"`
	MaximumWidth         int     `json:"maximumWidth"`
	// IdleMinutes pauses capture once the computer has had no keyboard, mouse, or
	// touch input for this long. Older settings files keep the default.
	IdleMinutes int `json:"idleMinutes"`
}

func Defaults() Settings { return Settings{0, 20, 4, 60, true, 10, true, .65, 1280, 5} }
func (s Settings) Validate() error {
	if s.RetentionHours < 0 || s.RetentionHours > 8760 || s.StorageGiB < 1 || s.StorageGiB > 1000 || s.SavedStorageGiB < 1 || s.SavedStorageGiB > 1000 || s.IntervalSeconds < 15 || s.IntervalSeconds > 3600 || s.MinimumEventInterval < 5 || s.MinimumEventInterval > 300 || s.JPEGQuality < .3 || s.JPEGQuality > .95 || s.MaximumWidth < 0 || (s.MaximumWidth > 0 && s.MaximumWidth < 1280) || s.MaximumWidth > 7680 || s.IdleMinutes < 1 || s.IdleMinutes > 60 {
		return errors.New("invalid logging settings")
	}
	return nil
}

type Node struct {
	Role  string  `json:"role"`
	Label *string `json:"label,omitempty"`
	Depth int     `json:"depth"`
}
type Payload struct {
	JPEG       []byte  `json:"jpeg"`
	JPEGRef    string  `json:"jpegRef,omitempty"`
	Tree       []Node  `json:"tree"`
	ScreenText *string `json:"screenText,omitempty"`
}
type Record map[string]any

func (r Record) ID() string    { s, _ := r["id"].(string); return s }
func (r Record) Date() float64 { f, _ := r["date"].(float64); return f }
func (r Record) Activity() string {
	if c, ok := r["correction"].(string); ok && c != "" {
		return c
	}
	if c, ok := r["agentLabel"].(map[string]any); ok {
		if a, ok := c["activity"].(string); ok {
			return a
		}
	}
	if c, ok := r["classification"].(map[string]any); ok {
		if a, ok := c["activity"].(string); ok {
			return a
		}
	}
	return "Unclassified"
}
func (r Record) Bytes() int64 { f, _ := r["bytes"].(float64); return int64(f) }

type Clip struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Created  float64  `json:"created"`
	FrameIDs []string `json:"frameIDs"`
}
type Index struct {
	Version      int               `json:"version"`
	Observations []Record          `json:"observations"`
	Clips        []Clip            `json:"clips"`
	Markers      []json.RawMessage `json:"markers"`
}
type Library struct {
	Dir      string
	Settings Settings
	Index    Index
}

func Open(dir string) (*Library, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	l := &Library{Dir: dir, Settings: Defaults(), Index: Index{1, []Record{}, []Clip{}, []json.RawMessage{}}}
	if b, e := os.ReadFile(filepath.Join(dir, "settings.json")); e == nil {
		if e = json.Unmarshal(b, &l.Settings); e != nil {
			return nil, e
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	if err := l.Settings.Validate(); err != nil {
		return nil, err
	}
	if b, e := os.ReadFile(filepath.Join(dir, "library.json")); e == nil {
		if len(b) > 128<<20 {
			return nil, errors.New("library metadata too large")
		}
		if e = json.Unmarshal(b, &l.Index); e != nil || l.Index.Version != 1 {
			return nil, errors.New("library manifest could not be read; nothing was overwritten")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	} else if _, e := os.Stat(filepath.Join(dir, "library.sealed")); e == nil {
		return nil, errors.New("open the previous native app once to migrate encrypted history")
	}
	return l, nil
}
func atomic(path string, b []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".breadcrumb-write-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
func (l *Library) commit(next Index) error {
	b, e := json.Marshal(next)
	if e != nil {
		return e
	}
	if len(b) > 128<<20 {
		return errors.New("library metadata limit reached")
	}
	if e = atomic(filepath.Join(l.Dir, "library.json"), b); e != nil {
		return e
	}
	l.Index = next
	return l.cleanup()
}
func clone(index Index) Index {
	b, _ := json.Marshal(index)
	var copy Index
	json.Unmarshal(b, &copy)
	return copy
}
func pinned(index Index) map[string]bool {
	p := map[string]bool{}
	for _, c := range index.Clips {
		for _, id := range c.FrameIDs {
			p[id] = true
		}
	}
	return p
}
func (l *Library) cleanup() error {
	keep := map[string]bool{}
	images := map[string]bool{}
	for _, r := range l.Index.Observations {
		keep[r.ID()+".json"] = true
		if ref, ok := r["screenshotRef"].(string); ok {
			images[ref+".jpg"] = true
		}
	}
	files, e := os.ReadDir(l.Dir)
	if e != nil {
		return e
	}
	for _, f := range files {
		if len(f.Name()) == 41 && filepath.Ext(f.Name()) == ".json" && !keep[f.Name()] {
			if e = os.Remove(filepath.Join(l.Dir, f.Name())); e != nil {
				return e
			}
		}
	}
	stored, err := os.ReadDir(filepath.Join(l.Dir, "images"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, f := range stored {
		if !f.IsDir() && len(f.Name()) == 68 && filepath.Ext(f.Name()) == ".jpg" && !images[f.Name()] {
			if err = os.Remove(filepath.Join(l.Dir, "images", f.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
func (l *Library) Expire(now time.Time) error {
	if l.Settings.RetentionHours == 0 {
		return nil
	}
	next := clone(l.Index)
	p := pinned(next)
	cut := Timestamp(now.Add(-time.Duration(l.Settings.RetentionHours) * time.Hour))
	rows := []Record{}
	for _, r := range next.Observations {
		if p[r.ID()] || r.Date() > cut {
			rows = append(rows, r)
		}
	}
	if len(rows) == len(next.Observations) {
		return nil
	}
	next.Observations = rows
	return l.commit(next)
}
func (l *Library) SetSettings(s Settings) error {
	if e := s.Validate(); e != nil {
		return e
	}
	b, _ := json.Marshal(s)
	if e := atomic(filepath.Join(l.Dir, "settings.json"), b); e != nil {
		return e
	}
	l.Settings = s
	return nil
}
func (l *Library) Usage() (history, saved int64) {
	return usage(l.Index)
}
func usage(index Index) (history, saved int64) {
	p := pinned(index)
	images := map[string]int64{}
	savedImages := map[string]bool{}
	for _, r := range index.Observations {
		if p[r.ID()] {
			saved += r.Bytes()
		} else {
			history += r.Bytes()
		}
		if ref, ok := r["screenshotRef"].(string); ok {
			if size, ok := r["screenshotBytes"].(float64); ok {
				images[ref] = int64(size)
			}
			if p[r.ID()] {
				savedImages[ref] = true
			}
		}
	}
	for ref, size := range images {
		if savedImages[ref] {
			saved += size
		} else {
			history += size
		}
	}
	return
}
func (l *Library) Append(r Record, payload Payload, now time.Time) error {
	id := r.ID()
	if len(id) != 36 || filepath.Base(id) != id {
		return errors.New("invalid capture ID")
	}
	for _, existing := range l.Index.Observations {
		if existing.ID() == id {
			return errors.New("duplicate capture ID")
		}
	}
	image := l.deduplicate(r, &payload)
	b, e := json.Marshal(payload)
	if e != nil {
		return e
	}
	if len(b)+len(image) > 12<<20 {
		return errors.New("capture too large")
	}
	if e = l.Expire(now); e != nil {
		return e
	}
	next := clone(l.Index)
	p := pinned(next)
	budget := l.Settings.StorageGiB*GiB - (256 << 20)
	r["bytes"] = float64(len(b))
	next.Observations = append(next.Observations, r)
	if l.Settings.RetentionHours != 0 {
		sort.SliceStable(next.Observations, func(i, j int) bool { return next.Observations[i].Date() < next.Observations[j].Date() })
		for i := 0; i < len(next.Observations); {
			history, _ := usage(next)
			if history <= budget {
				break
			}
			item := next.Observations[i]
			if item.ID() != id && !p[item.ID()] {
				next.Observations = append(next.Observations[:i], next.Observations[i+1:]...)
			} else {
				i++
			}
		}
	}
	if history, _ := usage(next); history > budget {
		return errors.New("history storage limit reached; old captures preserved")
	}
	if len(image) > 0 {
		if e = os.MkdirAll(filepath.Join(l.Dir, "images"), 0700); e != nil {
			return e
		}
		path, err := l.ImagePath(payload.JPEGRef)
		if err != nil {
			return err
		}
		if _, err = os.Stat(path); os.IsNotExist(err) {
			if e = atomic(path, image); e != nil {
				return e
			}
		} else if err != nil {
			return err
		}
	}
	path := filepath.Join(l.Dir, id+".json")
	if e = atomic(path, b); e != nil {
		_ = l.cleanup()
		return e
	}
	if e = l.commit(next); e != nil {
		found := false
		for _, item := range l.Index.Observations {
			if item.ID() == id {
				found = true
			}
		}
		if !found {
			os.Remove(path)
			_ = l.cleanup()
		}
		return e
	}
	return nil
}
func (l *Library) Payload(id string) (Payload, error) {
	for _, r := range l.Index.Observations {
		if r.ID() == id {
			var p Payload
			b, e := os.ReadFile(filepath.Join(l.Dir, id+".json"))
			if e == nil {
				e = json.Unmarshal(b, &p)
			}
			if e == nil && p.JPEGRef != "" {
				p.JPEG, e = l.Image(p.JPEGRef)
			}
			return p, e
		}
	}
	return Payload{}, errors.New("capture not found")
}
func (l *Library) Save(id, name string, start, end float64) (string, error) {
	if start > end || name == "" || len(name) > 200 {
		return "", errors.New("invalid clip range or name")
	}
	next := clone(l.Index)
	ids := []string{}
	p := pinned(next)
	for _, r := range next.Observations {
		if r.Date() >= start && r.Date() <= end {
			ids = append(ids, r.ID())
			p[r.ID()] = true
		}
	}
	if len(ids) == 0 {
		return "", errors.New("no captures in this range")
	}
	next.Clips = append(next.Clips, Clip{id, name, Timestamp(time.Now()), ids})
	_, total := usage(next)
	if total > l.Settings.SavedStorageGiB*GiB {
		return "", errors.New("saved clip storage limit reached")
	}
	return id, l.commit(next)
}
func (l *Library) DeleteClip(id string) error {
	next := clone(l.Index)
	clips := []Clip{}
	for _, c := range next.Clips {
		if c.ID != id {
			clips = append(clips, c)
		}
	}
	next.Clips = clips
	return l.commit(next)
}
func (l *Library) DeleteSince(since float64) error {
	next := clone(l.Index)
	removed := map[string]bool{}
	rows := []Record{}
	for _, r := range next.Observations {
		if r.Date() >= since {
			removed[r.ID()] = true
		} else {
			rows = append(rows, r)
		}
	}
	next.Observations = rows
	clips := []Clip{}
	for _, c := range next.Clips {
		ids := []string{}
		for _, id := range c.FrameIDs {
			if !removed[id] {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			c.FrameIDs = ids
			clips = append(clips, c)
		}
	}
	next.Clips = clips
	markers := []json.RawMessage{}
	for _, m := range next.Markers {
		var value struct {
			Date float64 `json:"date"`
		}
		if json.Unmarshal(m, &value) == nil && value.Date < since {
			markers = append(markers, m)
		}
	}
	next.Markers = markers
	return l.commit(next)
}
func (l *Library) Correct(id, activity string) error {
	next := clone(l.Index)
	for _, r := range next.Observations {
		if r.ID() == id {
			if activity == "" {
				delete(r, "correction")
			} else {
				r["correction"] = activity
			}
			return l.commit(next)
		}
	}
	return errors.New("capture not found")
}
func (l *Library) Export(clipID, path string) error {
	var clip *Clip
	for _, c := range l.Index.Clips {
		if c.ID == clipID {
			copy := c
			clip = &copy
		}
	}
	if clip == nil {
		return errors.New("clip not found")
	}
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	success := false
	defer func() {
		f.Close()
		if !success {
			os.Remove(path)
		}
	}()
	w := zip.NewWriter(f)
	for _, id := range clip.FrameIDs {
		p, e := l.Payload(id)
		if e != nil {
			return e
		}
		entry, e := w.Create(id + ".jpg")
		if e != nil {
			return e
		}
		if _, e = entry.Write(p.JPEG); e != nil {
			return e
		}
	}
	entry, e := w.Create("clip.json")
	if e != nil {
		return e
	}
	if e = json.NewEncoder(entry).Encode(clip); e != nil {
		return e
	}
	if e = w.Close(); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	success = true
	return nil
}
func ValidateExportPath(path string) error {
	if !filepath.IsAbs(path) || filepath.Ext(path) != ".zip" {
		return fmt.Errorf("choose an absolute .zip destination")
	}
	return nil
}
