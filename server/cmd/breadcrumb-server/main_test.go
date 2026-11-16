package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (*service, *string) {
	t.Helper()
	store := &localStore{t.TempDir()}
	link := ""
	auth := &authService{store: store, baseURL: "http://localhost:8080", allowed: map[string]bool{"friend@example.com": true}, cooldown: map[string]time.Time{}, send: func(_ context.Context, email, u string) error { link = u; return nil }}
	return &service{store: store, auth: auth}, &link
}
func call(s *service, method, path, body, token string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", s.auth.baseURL)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	return w
}
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status %d wanted %d: %s", w.Code, want, w.Body.String())
	}
}
func login(t *testing.T, s *service, link *string) *http.Cookie {
	t.Helper()
	requireStatus(t, call(s, "POST", "/auth/login", `{"email":"friend@example.com"}`, "", nil), 202)
	u, _ := url.Parse(*link)
	token := strings.TrimPrefix(u.Fragment, "login=")
	w := call(s, "POST", "/auth/verify", `{"token":"`+token+`"}`, "", nil)
	requireStatus(t, w, 204)
	requireStatus(t, call(s, "POST", "/auth/verify", `{"token":"`+token+`"}`, "", nil), 401)
	return w.Result().Cookies()[0]
}
func uploadToken(t *testing.T, s *service, c *http.Cookie) string {
	t.Helper()
	w := call(s, "POST", "/auth/token", `{}`, "", c)
	requireStatus(t, w, 200)
	var body struct {
		Token string `json:"token"`
	}
	json.Unmarshal(w.Body.Bytes(), &body)
	return body.Token
}

const capture = `{"schemaVersion":1,"consent":true,"record":{"id":"12345678-1234-1234-1234-123456789abc","date":123.5,"app":"Editor","bundleID":"example.editor","windowTitle":"Example.swift","classification":{"activity":"Coding","reason":"editor"}},"payload":{"jpeg":"AQID","tree":[{"role":"AXWindow","label":"Example.swift","depth":0}]}}`

func TestAccountAndCorpusFlow(t *testing.T) {
	s, link := fixture(t)
	c := login(t, s, link)
	token := uploadToken(t, s, c)
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, "", nil), 401)
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, token, nil), 201)
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, token, nil), 200)
	requireStatus(t, call(s, "POST", "/v1/ingest", strings.Replace(capture, "Example.swift", "Changed.swift", 1), token, nil), 409)
	data, e := s.store.Get(context.Background(), "captures/"+hash("friend@example.com")+"/12345678-1234-1234-1234-123456789abc.json")
	if e != nil {
		t.Fatal(e)
	}
	var entry stored
	if e = json.Unmarshal(data, &entry); e != nil {
		t.Fatal(e)
	}
	if len(entry.Upload.Payload.Tree) != 1 || *entry.Upload.Payload.Tree[0].Label != "Example.swift" || !bytes.Equal(entry.Upload.Payload.JPEG, []byte{1, 2, 3}) {
		t.Fatal("payload not preserved")
	}
	requireStatus(t, call(s, "POST", "/auth/revoke", `{}`, token, nil), 204)
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, token, nil), 401)
	requireStatus(t, call(s, "POST", "/auth/logout", `{}`, "", c), 204)
	requireStatus(t, call(s, "POST", "/auth/token", `{}`, "", c), 401)
}
func TestValidationAndExpiry(t *testing.T) {
	s, link := fixture(t)
	token := uploadToken(t, s, login(t, s, link))
	for _, body := range []string{strings.Replace(capture, `"consent":true`, `"consent":false`, 1), strings.Replace(capture, "12345678-1234-1234-1234-123456789abc", "../../evil", 1), strings.Replace(capture, `"depth":0`, `"depth":-1`, 1), capture + `{}`, `null`} {
		requireStatus(t, call(s, "POST", "/v1/ingest", body, token, nil), 400)
	}
	requireStatus(t, call(s, "POST", "/v1/ingest", `{"record":{"padding":"`+strings.Repeat("x", maxUpload)+`"}}`, token, nil), 413)
	old, _ := s.auth.issue(context.Background(), credential{hash("friend@example.com"), "friend@example.com", "upload", time.Now().Add(-time.Minute)})
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, old, nil), 401)
	r := httptest.NewRequest("POST", "/auth/login", strings.NewReader(`{"email":"friend@example.com"}`))
	r.Header.Set("Origin", "https://other.example")
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	requireStatus(t, w, 403)
}
func TestUninvitedAndCooldown(t *testing.T) {
	s, link := fixture(t)
	requireStatus(t, call(s, "POST", "/auth/login", `{"email":"stranger@example.com"}`, "", nil), 202)
	if *link != "" {
		t.Fatal("sent to uninvited email")
	}
	requireStatus(t, call(s, "POST", "/auth/login", `{"email":"friend@example.com"}`, "", nil), 202)
	first := *link
	requireStatus(t, call(s, "POST", "/auth/login", `{"email":"friend@example.com"}`, "", nil), 202)
	if first != *link {
		t.Fatal("cooldown failed")
	}
}
func TestR2ConditionalWrite(t *testing.T) {
	var data []byte
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Error("missing S3 signing")
		}
		if r.URL.Path != "/bucket/captures/test.json" {
			t.Errorf("wrong R2 path: %s", r.URL.Path)
		}
		if r.Method == "PUT" {
			if r.Header.Get("If-None-Match") != "*" {
				t.Error("missing conditional write")
			}
			if data != nil {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(412)
				io.WriteString(w, `<Error><Code>PreconditionFailed</Code></Error>`)
				return
			}
			data, _ = io.ReadAll(r.Body)
			return
		}
		if r.Method == "GET" {
			w.Write(data)
			return
		}
		if r.Method == "DELETE" {
			data = nil
			w.WriteHeader(204)
		}
	}))
	defer fake.Close()
	store := newR2Store(fake.URL, "bucket", "key", "secret")
	ok, e := store.Create(context.Background(), "captures/test.json", []byte(`{"tree":[]}`))
	if e != nil || !ok {
		t.Fatalf("create %v %v", ok, e)
	}
	ok, e = store.Create(context.Background(), "captures/test.json", []byte(`{}`))
	if e != nil || ok {
		t.Fatalf("duplicate %v %v", ok, e)
	}
	b, e := store.Get(context.Background(), "captures/test.json")
	if e != nil || string(b) != `{"tree":[]}` {
		t.Fatalf("get %s %v", b, e)
	}
	if e = store.Delete(context.Background(), "captures/test.json"); e != nil {
		t.Fatal(e)
	}
}

func TestLoopsContract(t *testing.T) {
	status := 200
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("bad Loops request")
		}
		var body struct {
			TransactionalID string            `json:"transactionalId"`
			Email           string            `json:"email"`
			Data            map[string]string `json:"dataVariables"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.TransactionalID != "template" || body.Email != "friend@example.com" || body.Data["loginUrl"] != "https://example.com/#login=secret" {
			t.Error("bad Loops payload")
		}
		w.WriteHeader(status)
		io.WriteString(w, `{"success":true}`)
	}))
	defer fake.Close()
	send := loopsSenderWithClient("test-key", "template", fake.URL, fake.Client())
	if e := send(context.Background(), "friend@example.com", "https://example.com/#login=secret"); e != nil {
		t.Fatal(e)
	}
	status = 429
	if e := send(context.Background(), "friend@example.com", "https://example.com/#login=secret"); e == nil {
		t.Fatal("Loops failure ignored")
	}
}

func TestTokensSurviveRestartAndAccountsAreIsolated(t *testing.T) {
	s, link := fixture(t)
	token := uploadToken(t, s, login(t, s, link))
	otherEmail := "other@example.com"
	s.auth.allowed[otherEmail] = true
	other, e := s.auth.issue(context.Background(), credential{hash(otherEmail), otherEmail, "upload", time.Now().Add(time.Hour)})
	if e != nil {
		t.Fatal(e)
	}
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, token, nil), 201)
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, other, nil), 201)
	restarted := &service{store: s.store, auth: &authService{store: s.store, baseURL: s.auth.baseURL, allowed: s.auth.allowed, cooldown: map[string]time.Time{}}}
	requireStatus(t, call(restarted, "POST", "/v1/ingest", capture, token, nil), 200)
	delete(restarted.auth.allowed, "friend@example.com")
	requireStatus(t, call(restarted, "POST", "/v1/ingest", capture, token, nil), 401)
	requireStatus(t, call(restarted, "POST", "/v1/ingest", capture, other, nil), 200)
}
