package agentusage

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"sort"
	"time"
)

// SyncRow and Snapshot are the entire upload boundary. No session IDs, cursor
// paths, working directories or arbitrary provider metadata can enter them.
type SyncRow struct {
	Tokens
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Project  string `json:"project"`
	Events   int    `json:"events"`
	Sessions int    `json:"sessions"`
}
type Snapshot struct {
	Source   string    `json:"source"`
	Hour     string    `json:"hour"`
	Revision int64     `json:"revision"`
	Rows     []SyncRow `json:"rows"`
}
type exportVersion struct {
	Hash     string
	Revision int64
}

func (s *Store) Export(now time.Time) ([]Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Snapshot{}
	err := s.db.Update(func(tx *bolt.Tx) error {
		options := tx.Bucket([]byte("options"))
		source := string(options.Get([]byte("sync-source")))
		if source == "" {
			var b [16]byte
			if _, err := rand.Read(b[:]); err != nil {
				return err
			}
			source = hex.EncodeToString(b[:])
			if err := options.Put([]byte("sync-source"), []byte(source)); err != nil {
				return err
			}
		}
		hours := map[string]map[string]SyncRow{}
		projectAliases := map[string]string{}
		cut := now.Add(-92 * 24 * time.Hour).UTC().Truncate(time.Hour)
		err := tx.Bucket([]byte("hours")).ForEach(func(_, v []byte) error {
			var h Hour
			if err := json.Unmarshal(v, &h); err != nil {
				return err
			}
			if h.Hour.Before(cut) {
				return nil
			}
			hour := h.Hour.UTC().Format(time.RFC3339)
			if hours[hour] == nil {
				hours[hour] = map[string]SyncRow{}
			}
			project := h.Project
			if !h.ProjectVerified || !validProject(project) {
				project = ""
			}
			projectAliases[h.Provider+"|"+h.Model+"|"+h.Project] = project
			key := h.Provider + "|" + h.Model + "|" + project
			row := hours[hour][key]
			row.Provider = h.Provider
			row.Model = h.Model
			row.Project = project
			row.Tokens = row.Tokens.add(h.Tokens)
			row.Events += h.Events
			hours[hour][key] = row
			return nil
		})
		if err != nil {
			return err
		}
		err = tx.Bucket([]byte("sessions")).ForEach(func(_, v []byte) error {
			var session Session
			if err := json.Unmarshal(v, &session); err != nil {
				return err
			}
			hour := session.Start.UTC().Truncate(time.Hour).Format(time.RFC3339)
			if hours[hour] == nil {
				return nil
			}
			project := projectAliases[session.Provider+"|"+session.Model+"|"+session.Project]
			if !validProject(project) {
				project = ""
			}
			key := session.Provider + "|" + session.Model + "|" + project
			if row, ok := hours[hour][key]; ok {
				row.Sessions++
				hours[hour][key] = row
			}
			return nil
		})
		if err != nil {
			return err
		}
		// Previously uploaded hours that disappeared must send an empty replacement.
		options.ForEach(func(k, v []byte) error {
			key := string(k)
			if len(key) > 7 && key[:7] == "export:" {
				hour := key[7:]
				if hour >= cut.Format(time.RFC3339) && hours[hour] == nil {
					hours[hour] = map[string]SyncRow{}
				}
			}
			return nil
		})
		for hour, rows := range hours {
			snapshot := Snapshot{Source: source, Hour: hour, Rows: []SyncRow{}}
			for _, row := range rows {
				snapshot.Rows = append(snapshot.Rows, row)
			}
			sort.Slice(snapshot.Rows, func(i, j int) bool {
				a, b := snapshot.Rows[i], snapshot.Rows[j]
				return a.Provider+a.Model+a.Project < b.Provider+b.Model+b.Project
			})
			data, _ := json.Marshal(snapshot.Rows)
			digest := hash(string(data))
			version := exportVersion{}
			get(options, "export:"+hour, &version)
			if digest != version.Hash {
				revision := now.UnixMilli()
				if revision <= version.Revision {
					revision = version.Revision + 1
				}
				version = exportVersion{digest, revision}
				if err := put(options, "export:"+hour, version); err != nil {
					return err
				}
			}
			snapshot.Revision = version.Revision
			out = append(out, snapshot)
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Hour < out[j].Hour })
	return out, err
}
