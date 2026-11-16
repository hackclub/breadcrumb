package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type reviewItem struct {
	ID          string          `json:"id"`
	CaptureKey  string          `json:"captureKey"`
	Participant string          `json:"participant"`
	Record      json.RawMessage `json:"record"`
}
type reviewLease struct {
	Agent      string    `json:"agent"`
	SecretHash string    `json:"secretHash"`
	Expires    time.Time `json:"expires"`
	Generation int       `json:"generation"`
}
type evidenceLabel struct {
	Activity   string `json:"activity"`
	Role       string `json:"role"`
	Evidence   string `json:"evidence"`
	Confidence string `json:"confidence"`
}
type reviewResult struct {
	Job        string          `json:"job"`
	Lease      string          `json:"lease,omitempty"`
	Generation int             `json:"generation"`
	Model      string          `json:"model"`
	Version    string          `json:"version"`
	Summary    string          `json:"summary"`
	Session    string          `json:"session"`
	Labels     []evidenceLabel `json:"labels"`
	Flags      []string        `json:"flags"`
	Agent      string          `json:"agent,omitempty"`
	ReviewedAt time.Time       `json:"reviewedAt"`
}

func (s *service) enqueue(ctx context.Context, key string, entry stored) error {
	id := hash(key)
	b, _ := json.Marshal(reviewItem{id, key, entry.Participant, entry.Upload.Record})
	_, e := s.store.Create(ctx, "review/items/"+id+".json", b)
	return e
}
func (s *service) reviewAgent(r *http.Request) string {
	supplied := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		return ""
	}
	agent := ""
	for name, token := range s.agents {
		expected := sha256.Sum256([]byte(token))
		if subtle.ConstantTimeCompare(supplied[:], expected[:]) == 1 {
			agent = name
		}
	}
	return agent
}
func (s *service) reviewRoutes(mux *http.ServeMux) {
	guard := func(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			agent := s.reviewAgent(r)
			if agent == "" {
				http.Error(w, "review-agent token required", 401)
				return
			}
			next(w, r, agent)
		}
	}
	mux.HandleFunc("POST /v1/review/claim", guard(s.claimReview))
	mux.HandleFunc("POST /v1/review/submit", guard(s.submitReview))
	mux.HandleFunc("GET /v1/review/context/{job}", guard(s.reviewContext))
	mux.HandleFunc("POST /v1/review/index", guard(s.indexReviews))
}
func jsonReply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func (s *service) latestLease(ctx context.Context, id string) (reviewLease, error) {
	var lease reviewLease
	keys, cursor, e := s.store.List(ctx, "review/claims/"+id+"/", "", 100)
	for e == nil && cursor != "" {
		var next []string
		next, cursor, e = s.store.List(ctx, "review/claims/"+id+"/", cursor, 100)
		keys = append(keys, next...)
	}
	if e != nil {
		return lease, e
	}
	if len(keys) == 0 {
		return lease, nil
	}
	sort.Strings(keys)
	b, e := s.store.Get(ctx, keys[len(keys)-1])
	if e != nil {
		return lease, e
	}
	e = json.Unmarshal(b, &lease)
	return lease, e
}
func (s *service) claimReview(w http.ResponseWriter, r *http.Request, agent string) {
	cursor := r.URL.Query().Get("cursor")
	keys, next, e := s.store.List(r.Context(), "review/items/", cursor, 100)
	if e != nil {
		http.Error(w, "queue unavailable", 503)
		return
	}
	for _, key := range keys {
		id := strings.TrimSuffix(strings.TrimPrefix(key, "review/items/"), ".json")
		if _, e := s.store.Get(r.Context(), "review/results/"+id+".json"); e == nil {
			continue
		} else if !errors.Is(e, errMissing) {
			http.Error(w, "queue unavailable", 503)
			return
		}
		lease, e := s.latestLease(r.Context(), id)
		if e != nil {
			http.Error(w, "queue unavailable", 503)
			return
		}
		if time.Now().Before(lease.Expires) {
			continue
		}
		b, e := s.store.Get(r.Context(), key)
		var item reviewItem
		if e != nil || json.Unmarshal(b, &item) != nil {
			http.Error(w, "queue item unavailable", 503)
			return
		}
		capture, e := s.store.Get(r.Context(), item.CaptureKey)
		if errors.Is(e, errMissing) {
			continue
		}
		if e != nil {
			http.Error(w, "capture unavailable", 503)
			return
		}
		token := secret()
		lease = reviewLease{agent, hash(token), time.Now().UTC().Add(10 * time.Minute), lease.Generation + 1}
		b, _ = json.Marshal(lease)
		ok, e := s.store.Create(r.Context(), fmt.Sprintf("review/claims/%s/%010d.json", id, lease.Generation), b)
		if e != nil {
			http.Error(w, "claim unavailable", 503)
			return
		}
		if !ok {
			continue
		}
		jsonReply(w, map[string]any{"job": id, "lease": token, "generation": lease.Generation, "expires": lease.Expires, "capture": json.RawMessage(capture), "contextURL": "/v1/review/context/" + id})
		return
	}
	jsonReply(w, map[string]any{"job": nil, "nextCursor": next})
}
func validJob(id string) bool { b, e := hex.DecodeString(id); return e == nil && len(b) == 32 }
func (s *service) submitReview(w http.ResponseWriter, r *http.Request, agent string) {
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	var result reviewResult
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF || !validJob(result.Job) || result.Model == "" || result.Version == "" || result.Summary == "" || len(result.Summary) > 12000 || len(result.Model) > 200 || len(result.Version) > 100 || len(result.Session) > 200 || len(result.Labels) == 0 || len(result.Labels) > 20 || len(result.Flags) > 20 {
		http.Error(w, "invalid review result", 400)
		return
	}
	for _, label := range result.Labels {
		if len(label.Activity) == 0 || len(label.Activity) > 100 || len(label.Evidence) == 0 || len(label.Evidence) > 2000 || (label.Role != "focused" && label.Role != "alongside" && label.Role != "uncertain") || (label.Confidence != "low" && label.Confidence != "medium" && label.Confidence != "high") {
			http.Error(w, "labels need activity, role, evidence and confidence", 400)
			return
		}
	}
	for _, flag := range result.Flags {
		if len(flag) > 100 {
			http.Error(w, "flag too long", 400)
			return
		}
	}
	lease, e := s.latestLease(r.Context(), result.Job)
	if e != nil {
		http.Error(w, "claim unavailable", 503)
		return
	}
	expected := hash(result.Lease)
	if lease.Agent != agent || lease.Generation != result.Generation || !time.Now().Before(lease.Expires) || subtle.ConstantTimeCompare([]byte(expected), []byte(lease.SecretHash)) != 1 {
		http.Error(w, "claim expired or not owned by this agent", 409)
		return
	}
	result.Agent = agent
	result.ReviewedAt = time.Now().UTC()
	result.Lease = ""
	b, _ := json.Marshal(result)
	ok, e := s.store.Create(r.Context(), "review/results/"+result.Job+".json", b)
	if e != nil {
		http.Error(w, "result storage unavailable", 503)
		return
	}
	if !ok {
		http.Error(w, "review already submitted", 409)
		return
	}
	w.WriteHeader(201)
}

// Context is bounded and scoped to the same contributor. No email/auth data is exposed.
func (s *service) reviewContext(w http.ResponseWriter, r *http.Request, agent string) {
	id := r.PathValue("job")
	if !validJob(id) {
		http.Error(w, "invalid job", 400)
		return
	}
	b, e := s.store.Get(r.Context(), "review/items/"+id+".json")
	var item reviewItem
	if e != nil || json.Unmarshal(b, &item) != nil {
		http.NotFound(w, r)
		return
	}
	keys, next, e := s.store.List(r.Context(), "captures/"+item.Participant+"/", r.URL.Query().Get("cursor"), 20)
	if e != nil {
		http.Error(w, "context unavailable", 503)
		return
	}
	rows := []json.RawMessage{}
	for _, key := range keys {
		data, e := s.store.Get(r.Context(), key)
		var capture stored
		if e != nil || json.Unmarshal(data, &capture) != nil {
			http.Error(w, "context unavailable", 503)
			return
		}
		rows = append(rows, capture.Upload.Record)
	}
	jsonReply(w, map[string]any{"records": rows, "nextCursor": next})
}
func (s *service) indexReviews(w http.ResponseWriter, r *http.Request, agent string) {
	keys, next, e := s.store.List(r.Context(), "captures/", r.URL.Query().Get("cursor"), 20)
	if e != nil {
		http.Error(w, "index unavailable", 503)
		return
	}
	count := 0
	for _, key := range keys {
		data, e := s.store.Get(r.Context(), key)
		var entry stored
		if e != nil || json.Unmarshal(data, &entry) != nil {
			http.Error(w, "capture unavailable", 503)
			return
		}
		if e = s.enqueue(r.Context(), key, entry); e != nil {
			http.Error(w, "index unavailable", 503)
			return
		}
		count++
	}
	jsonReply(w, map[string]any{"indexed": count, "nextCursor": next})
}
