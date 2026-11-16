package library

import (
	"sort"
	"strings"
)

func Activity(bundle, title string) string {
	b, t := strings.ToLower(bundle), strings.ToLower(title)
	if strings.Contains(b, "openai") || strings.Contains(b, "claude") {
		return "AI assistant page"
	}
	if strings.Contains(b, "code") || strings.Contains(b, "xcode") || strings.Contains(b, "zed") {
		return "Coding"
	}
	if strings.Contains(b, "terminal") || strings.Contains(b, "ghostty") || strings.Contains(b, "iterm") || strings.Contains(b, "windowsterminal") {
		return "Terminal work"
	}
	if strings.Contains(b, "slack") || strings.Contains(b, "signal") || strings.Contains(b, "telegram") || strings.Contains(b, "discord") {
		return "Messaging interface"
	}
	if strings.Contains(b, "spotify") || strings.Contains(b, "music") {
		return "Music app"
	}
	if strings.HasSuffix(t, " - youtube") || strings.HasSuffix(t, " | youtube") || strings.HasSuffix(t, " - vimeo") {
		return "Video page"
	}
	if strings.HasSuffix(t, " - chatgpt") || strings.HasSuffix(t, " - claude") {
		return "AI assistant page"
	}
	if strings.Contains(b, "chrome") || strings.Contains(b, "firefox") || strings.Contains(b, "safari") || strings.Contains(b, "helium") || strings.Contains(b, "edge") {
		return "Browsing"
	}
	return "Unclassified"
}
func Enrich(r Record) {
	if _, ok := r["classification"]; !ok {
		bundle, _ := r["bundleID"].(string)
		title, _ := r["windowTitle"].(string)
		r["classification"] = map[string]any{"activity": Activity(bundle, title), "confidence": "Possible", "reason": "Visible app/window context; attention and playback unverified.", "version": 4}
	}
}

type Session struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Start      float64  `json:"start"`
	End        float64  `json:"end"`
	IDs        []string `json:"ids"`
	Activities []string `json:"activities"`
	key        string
	activities map[string]bool
}

func ContextKey(r Record) (key, label string) {
	key, _ = r["bundleID"].(string)
	label, _ = r["app"].(string)
	if ctx, ok := r["context"].(map[string]any); ok {
		if p, ok := ctx["project"].(string); ok && p != "" {
			return "project:" + strings.ToLower(p), p
		}
		if d, ok := ctx["domain"].(string); ok && d != "" {
			return "domain:" + d, d
		}
	}
	return
}
func Sessions(records []Record) []Session {
	rows := append([]Record(nil), records...)
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Date() < rows[j].Date() })
	result := []Session{}
	for _, r := range rows {
		key, label := ContextKey(r)
		i := len(result) - 1
		if i >= 0 && r.Date()-result[i].End <= 180 && result[i].key == key {
		} else if i >= 1 && result[i-1].key == key && r.Date()-result[i-1].End <= 120 {
			interruption := result[i]
			result = result[:i]
			i--
			result[i].IDs = append(result[i].IDs, interruption.IDs...)
			for a := range interruption.activities {
				result[i].activities[a] = true
			}
		} else {
			result = append(result, Session{ID: r.ID(), Title: label, Start: r.Date(), key: key, activities: map[string]bool{}, IDs: []string{}})
			i = len(result) - 1
		}
		s := &result[i]
		s.End = r.Date()
		s.IDs = append(s.IDs, r.ID())
		s.activities[r.Activity()] = true
		if windows, ok := r["visibleWindows"].([]any); ok {
			for _, v := range windows {
				if w, ok := v.(map[string]any); ok {
					bundle, _ := w["bundleID"].(string)
					title, _ := w["title"].(string)
					s.activities[Activity(bundle, title)] = true
				}
			}
		}
	}
	for i := range result {
		result[i].Activities = []string{}
		for a := range result[i].activities {
			result[i].Activities = append(result[i].Activities, a)
		}
		sort.Strings(result[i].Activities)
	}
	return result
}
