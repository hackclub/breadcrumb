package agentusage

import (
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestExportUsageOnlyAndRevision(t *testing.T) {
	s, path := setup(t)
	s.Configure("claude", true)
	os.WriteFile(path, []byte(claude("one")), 0600)
	scan(t, s, 256)
	first, err := s.Export(time.Now())
	if err != nil || len(first) != 1 {
		t.Fatal(err)
	}
	if len(first[0].Rows) != 1 || first[0].Rows[0].Sessions != 1 {
		t.Fatal("missing sessions")
	}
	raw, _ := json.Marshal(first)
	for _, private := range []string{"SENTINEL", "sessionId", "cwd", "C:", "session\""} {
		if strings.Contains(string(raw), private) {
			t.Fatal("private data in upload")
		}
	}
	second, _ := s.Export(time.Now())
	if first[0].Revision != second[0].Revision || first[0].Source != second[0].Source {
		t.Fatal("unstable snapshot")
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString(claude("two"))
	f.Close()
	scan(t, s, 256)
	third, _ := s.Export(time.Now())
	if third[0].Revision <= first[0].Revision || third[0].Rows[0].Input != 20 {
		t.Fatal("snapshot not advanced")
	}
}
func TestProjectIdentityDoesNotUseHomeDirectory(t *testing.T) {
	dir := t.TempDir()
	if name := project(dir); name != "" {
		t.Fatal("unversioned directory should not reveal a username")
	}
	os.MkdirAll(dir+"/.git", 0700)
	if name := project(dir); name == "" {
		t.Fatal("git project missing")
	}
}

func TestLegacyProjectNameNeverUploads(t *testing.T) {
	s, _ := setup(t)
	err := s.db.Update(func(tx *bolt.Tx) error {
		return put(tx.Bucket([]byte("hours")), "legacy", Hour{Provider: "claude", Model: "model", Project: "person-home-name", Hour: time.Now().UTC().Truncate(time.Hour), Tokens: Tokens{Input: 1}})
	})
	if err != nil {
		t.Fatal(err)
	}
	exported, err := s.Export(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(exported) != 1 || exported[0].Rows[0].Project != "" {
		t.Fatal("unverified project name uploaded")
	}
}
