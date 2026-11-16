package library

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func record(id string, at time.Time) Record {
	return Record{"id": id, "date": Timestamp(at), "app": "Editor", "bundleID": "example.editor", "windowTitle": "Synthetic", "classification": map[string]any{"activity": "Coding"}}
}

const id1 = "12345678-1234-4234-8234-123456789abc"
const id2 = "22345678-1234-4234-8234-123456789abc"

func TestPersistenceRetentionAndSavedReferences(t *testing.T) {
	dir := t.TempDir()
	l, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	old := record(id1, now.Add(-48*time.Hour))
	recent := record(id2, now.Add(-time.Minute))
	for _, r := range []Record{old, recent} {
		if e = l.Append(r, Payload{JPEG: []byte{1}, Tree: []Node{}}, now); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = l.Save("clip-1", "Keep old", old.Date(), old.Date()); e != nil {
		t.Fatal(e)
	}
	s := l.Settings
	s.RetentionHours = 24
	if e = l.SetSettings(s); e != nil {
		t.Fatal(e)
	}
	if e = l.Expire(now); e != nil {
		t.Fatal(e)
	}
	restored, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	if len(restored.Index.Observations) != 2 || len(restored.Index.Clips) != 1 {
		t.Fatal("saved capture lost")
	}
	if e = restored.DeleteSince(Timestamp(now.Add(-time.Hour))); e != nil {
		t.Fatal(e)
	}
	if len(restored.Index.Observations) != 1 || restored.Index.Clips[0].FrameIDs[0] != id1 {
		t.Fatal("deletion damaged old clip")
	}
	if _, e = os.Stat(filepath.Join(dir, id2+".json")); !os.IsNotExist(e) {
		t.Fatal("deleted payload retained")
	}
}
func TestContinuousLimitDoesNotEvict(t *testing.T) {
	l, _ := Open(t.TempDir())
	now := time.Now()
	r := record(id1, now)
	r["bytes"] = float64(2 * GiB)
	l.Index.Observations = []Record{r}
	l.Settings.StorageGiB = 1
	e := l.Append(record(id2, now), Payload{JPEG: []byte{1}}, now)
	if e == nil || len(l.Index.Observations) != 1 || l.Index.Observations[0].ID() != id1 {
		t.Fatal("continuous pressure evicted history")
	}
}
func TestCorruptManifestIsNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "library.json")
	os.WriteFile(path, []byte("broken"), 0600)
	if _, e := Open(dir); e == nil {
		t.Fatal("corrupt index opened")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "broken" {
		t.Fatal("corrupt index overwritten")
	}
}
func TestGroupsInterruptedTaskWithoutFillingGaps(t *testing.T) {
	now := time.Now()
	a := record(id1, now)
	a["context"] = map[string]any{"project": "Breadcrumb"}
	b := record(id2, now.Add(time.Minute))
	b["bundleID"] = "browser"
	c := record("32345678-1234-4234-8234-123456789abc", now.Add(2*time.Minute))
	c["context"] = map[string]any{"project": "Breadcrumb"}
	d := record("42345678-1234-4234-8234-123456789abc", now.Add(10*time.Minute))
	d["context"] = map[string]any{"project": "Breadcrumb"}
	sessions := Sessions([]Record{a, b, c, d})
	if len(sessions) != 2 || len(sessions[0].IDs) != 3 {
		t.Fatal("incorrect task grouping")
	}
}
func TestSwiftManifestRoundTripKeepsUnknownMetadata(t *testing.T) {
	dir := t.TempDir()
	r := record(id1, time.Now())
	r["visibleWindows"] = []any{map[string]any{"windowID": 1, "focused": false, "title": "Video - YouTube"}}
	r["context"] = map[string]any{"domain": "chatgpt.com"}
	index := Index{Version: 1, Observations: []Record{r}, Clips: []Clip{}, Markers: []json.RawMessage{}}
	b, _ := json.Marshal(index)
	os.WriteFile(filepath.Join(dir, "library.json"), b, 0600)
	l, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	if e = l.Correct(id1, "Reading"); e != nil {
		t.Fatal(e)
	}
	again, _ := Open(dir)
	if again.Index.Observations[0].Activity() != "Reading" || again.Index.Observations[0]["visibleWindows"] == nil {
		t.Fatal("metadata not preserved")
	}
}

func TestAgentInboxPreservesManualCorrection(t *testing.T) {
	l, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := l.Append(record(id1, now), Payload{JPEG: []byte{1}, Tree: []Node{}}, now); err != nil {
		t.Fatal(err)
	}
	if err := l.Correct(id1, "Reading"); err != nil {
		t.Fatal(err)
	}
	inbox := filepath.Join(l.Dir, "inbox")
	os.Mkdir(inbox, 0700)
	path := filepath.Join(inbox, "suggestions.json")
	b, _ := json.Marshal([]map[string]any{{"id": id1, "activity": "Coding", "reason": "Editor title", "flags": []string{"review"}}})
	os.WriteFile(path, b, 0600)
	if err := l.ImportSuggestions(); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(l.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Index.Observations[0].Activity() != "Reading" {
		t.Fatal("agent replaced manual correction")
	}
	if err := restored.Correct(id1, ""); err != nil {
		t.Fatal(err)
	}
	if restored.Index.Observations[0].Activity() != "Coding" {
		t.Fatal("agent suggestion not persisted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("processed inbox file retained")
	}
}
