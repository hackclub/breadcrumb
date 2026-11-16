package library

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// ImportSuggestions commits each complete inbox file atomically. Corrections always win.
func (l *Library) ImportSuggestions() error {
	files, err := os.ReadDir(filepath.Join(l.Dir, "inbox"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		path := filepath.Join(l.Dir, "inbox", file.Name())
		info, err := file.Info()
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 1<<20 {
			continue
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var labels []struct {
			ID       string   `json:"id"`
			Activity string   `json:"activity"`
			Flags    []string `json:"flags"`
			Reason   string   `json:"reason"`
		}
		if json.Unmarshal(b, &labels) != nil || len(labels) > 10000 {
			continue
		}
		next := clone(l.Index)
		for _, label := range labels {
			if !validActivity(label.Activity) || len(label.Reason) > 1000 || len(label.Flags) > 20 {
				continue
			}
			valid := true
			for _, flag := range label.Flags {
				if len(flag) > 100 {
					valid = false
				}
			}
			if !valid {
				continue
			}
			for _, row := range next.Observations {
				if strings.EqualFold(row.ID(), label.ID) {
					row["agentLabel"] = map[string]any{"activity": label.Activity, "flags": label.Flags, "reason": label.Reason}
					break
				}
			}
		}
		if err := l.commit(next); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return nil
}
func validActivity(activity string) bool {
	for _, allowed := range []string{"Coding", "Terminal work", "Reading", "Video page", "Meeting app", "Messaging interface", "AI assistant page", "Social page", "Calendar interface", "Developer page", "Browser settings", "Browsing", "Music app", "Email app", "Unclassified"} {
		if allowed == activity {
			return true
		}
	}
	return false
}
