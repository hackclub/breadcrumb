package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const maxUpload = 12 << 20

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type node struct {
	Role  string  `json:"role"`
	Label *string `json:"label,omitempty"`
	Depth int     `json:"depth"`
}
type payload struct {
	ScreenText *string `json:"screenText,omitempty"`
	JPEG       []byte  `json:"jpeg"`
	Tree       []node  `json:"tree"`
}
type upload struct {
	SchemaVersion int             `json:"schemaVersion"`
	Consent       bool            `json:"consent"`
	Record        json.RawMessage `json:"record"`
	Payload       payload         `json:"payload"`
}
type stored struct {
	Participant string    `json:"participant"`
	ReceivedAt  time.Time `json:"receivedAt"`
	Digest      string    `json:"digest"`
	Upload      upload    `json:"upload"`
}
type service struct {
	store  objectStore
	auth   *authService
	agents map[string]string
}

func (s *service) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, page)
	})
	mux.HandleFunc("POST /v1/ingest", s.ingest)
	s.auth.routes(mux)
	s.reviewRoutes(mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		mux.ServeHTTP(w, r)
	})
}
func (s *service) ingest(w http.ResponseWriter, r *http.Request) {
	account, err := s.auth.authenticate(r, "upload")
	if err != nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "invalid upload token", 401)
		return
	}
	participant := account.ID
	mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		http.Error(w, "use application/json", 415)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var u upload
	if err := decoder.Decode(&u); err != nil {
		var sizeErr *http.MaxBytesError
		if errors.As(err, &sizeErr) {
			http.Error(w, "upload too large", 413)
		} else {
			http.Error(w, "invalid upload JSON", 400)
		}
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "expected one JSON object", 400)
		return
	}
	var record struct {
		ID          string   `json:"id"`
		Date        *float64 `json:"date"`
		App         string   `json:"app"`
		BundleID    string   `json:"bundleID"`
		WindowTitle *string  `json:"windowTitle"`
	}
	if json.Unmarshal(u.Record, &record) != nil || !uuidPattern.MatchString(record.ID) || record.Date == nil || record.App == "" || record.BundleID == "" || record.WindowTitle == nil || u.SchemaVersion != 1 || !u.Consent {
		http.Error(w, "schemaVersion 1, consent true, and valid Breadcrumb capture metadata required", 400)
		return
	}
	if len(u.Payload.JPEG) > 8<<20 || len(u.Payload.Tree) > 1000 || (u.Payload.ScreenText != nil && len(*u.Payload.ScreenText) > 48000) {
		http.Error(w, "capture exceeds payload limits", 413)
		return
	}
	if len(u.Payload.JPEG) == 0 && len(u.Payload.Tree) == 0 {
		http.Error(w, "screenshot or tree required", 400)
		return
	}
	for _, n := range u.Payload.Tree {
		if n.Role == "" || len(n.Role) > 256 || n.Depth < 0 || n.Depth > 64 || (n.Label != nil && len(*n.Label) > 8192) {
			http.Error(w, "invalid tree node", 400)
			return
		}
	}
	// Canonicalize record keys/whitespace for stable retries.
	var metadata map[string]any
	json.Unmarshal(u.Record, &metadata)
	metadata["id"] = stringLower(record.ID)
	u.Record, _ = json.Marshal(metadata)
	canonical, _ := json.Marshal(u)
	digest := sha256.Sum256(canonical)
	entry := stored{participant, time.Now().UTC(), hex.EncodeToString(digest[:]), u}
	data, err := json.Marshal(entry)
	if err != nil {
		http.Error(w, "encoding failed", 500)
		return
	}
	key := "captures/" + participant + "/" + stringLower(record.ID) + ".json"
	created, err := s.store.Create(r.Context(), key, data)
	if err != nil {
		http.Error(w, "could not save capture", 503)
		return
	}
	if !created {
		existing, err := s.store.Get(r.Context(), key)
		var previous stored
		if err != nil || json.Unmarshal(existing, &previous) != nil {
			http.Error(w, "stored capture unreadable", 503)
			return
		}
		if previous.Digest != entry.Digest {
			http.Error(w, "capture ID already contains different data", 409)
			return
		}
		if err := s.enqueue(r.Context(), key, previous); err != nil {
			http.Error(w, "review queue unavailable; retry upload", 503)
			return
		}
		respond(w, 200, record.ID, true)
		return
	}

	if err := s.enqueue(r.Context(), key, entry); err != nil {
		http.Error(w, "review queue unavailable; retry upload", 503)
		return
	}
	respond(w, 201, record.ID, false)
}
func stringLower(s string) string { return strings.ToLower(s) }
func respond(w http.ResponseWriter, status int, id string, duplicate bool) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"id": stringLower(id), "duplicate": duplicate})
}
