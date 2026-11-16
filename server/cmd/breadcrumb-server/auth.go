package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"strings"
	"sync"
	"time"
)

type credential struct {
	ID      string    `json:"id"`
	Email   string    `json:"email"`
	Kind    string    `json:"kind"`
	Expires time.Time `json:"expires"`
}
type authService struct {
	store    objectStore
	baseURL  string
	allowed  map[string]bool
	send     func(context.Context, string, string) error
	mu       sync.Mutex
	cooldown map[string]time.Time
}

func secret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func hash(s string) string { b := sha256.Sum256([]byte(s)); return hex.EncodeToString(b[:]) }
func (a *authService) issue(ctx context.Context, c credential) (string, error) {
	token := secret()
	b, _ := json.Marshal(c)
	ok, e := a.store.Create(ctx, "auth/credentials/"+hash(token)+".json", b)
	if e == nil && !ok {
		e = errors.New("token collision")
	}
	return token, e
}
func (a *authService) read(ctx context.Context, token, kind string) (credential, error) {
	var c credential
	if len(token) != 64 {
		return c, errors.New("invalid token")
	}
	b, e := a.store.Get(ctx, "auth/credentials/"+hash(token)+".json")
	if e != nil {
		return c, e
	}
	if json.Unmarshal(b, &c) != nil || c.Kind != kind || !time.Now().Before(c.Expires) || !a.allowed[c.Email] {
		return c, errors.New("invalid or expired token")
	}
	return c, nil
}
func (a *authService) authenticate(r *http.Request, kind string) (credential, error) {
	token := ""
	if kind == "session" {
		c, e := r.Cookie("breadcrumb_session")
		if e == nil {
			token = c.Value
		}
	} else {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == r.Header.Get("Authorization") {
			return credential{}, errors.New("bearer required")
		}
	}
	return a.read(r.Context(), token, kind)
}
func (a *authService) sameOrigin(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Origin") != a.baseURL {
		http.Error(w, "same-origin request required", 403)
		return false
	}
	return true
}
func (a *authService) routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /auth/login", a.login)
	mux.HandleFunc("POST /auth/verify", a.verify)
	mux.HandleFunc("GET /auth/me", func(w http.ResponseWriter, r *http.Request) {
		c, e := a.authenticate(r, "session")
		if e != nil {
			http.Error(w, "sign in required", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"email": c.Email, "id": c.ID})
	})
	mux.HandleFunc("POST /auth/token", func(w http.ResponseWriter, r *http.Request) {
		if !a.sameOrigin(w, r) {
			return
		}
		c, e := a.authenticate(r, "session")
		if e != nil {
			http.Error(w, "sign in required", 401)
			return
		}
		c.Kind = "upload"
		c.Expires = time.Now().Add(30 * 24 * time.Hour)
		token, e := a.issue(r.Context(), c)
		if e != nil {
			http.Error(w, "could not create token", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"token": token, "expires": c.Expires})
	})
	mux.HandleFunc("POST /auth/revoke", func(w http.ResponseWriter, r *http.Request) {
		_, e := a.authenticate(r, "upload")
		if e != nil {
			http.Error(w, "invalid token", 401)
			return
		}
		e = a.store.Delete(r.Context(), "auth/credentials/"+hash(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))+".json")
		if e != nil {
			http.Error(w, "could not revoke token", 503)
			return
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /auth/logout", func(w http.ResponseWriter, r *http.Request) {
		if !a.sameOrigin(w, r) {
			return
		}
		c, e := r.Cookie("breadcrumb_session")
		if e == nil {
			if e = a.store.Delete(r.Context(), "auth/credentials/"+hash(c.Value)+".json"); e != nil {
				http.Error(w, "could not end session", 503)
				return
			}
		}
		http.SetCookie(w, &http.Cookie{Name: "breadcrumb_session", Value: "", Path: "/", HttpOnly: true, Secure: strings.HasPrefix(a.baseURL, "https://"), SameSite: http.SameSiteStrictMode, MaxAge: -1})
		w.WriteHeader(204)
	})
}
func (a *authService) login(w http.ResponseWriter, r *http.Request) {
	if !a.sameOrigin(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var input struct {
		Email string `json:"email"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		http.Error(w, "invalid email", 400)
		return
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))
	parsed, e := mail.ParseAddress(email)
	if e != nil || parsed.Address != email {
		http.Error(w, "invalid email", 400)
		return
	}
	// Same response for uninvited accounts; only invited friends receive mail.
	if !a.allowed[email] {
		w.WriteHeader(202)
		return
	}
	a.mu.Lock()
	if time.Since(a.cooldown[email]) < time.Minute {
		a.mu.Unlock()
		w.WriteHeader(202)
		return
	}
	a.cooldown[email] = time.Now()
	a.mu.Unlock()
	c := credential{ID: hash(email), Email: email, Kind: "login", Expires: time.Now().Add(15 * time.Minute)}
	token, e := a.issue(r.Context(), c)
	if e == nil {
		e = a.send(r.Context(), email, a.baseURL+"/#login="+token)
	}
	if e != nil {
		http.Error(w, "could not send sign-in email", 503)
		return
	}
	w.WriteHeader(202)
}
func (a *authService) verify(w http.ResponseWriter, r *http.Request) {
	if !a.sameOrigin(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var input struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		http.Error(w, "invalid link", 400)
		return
	}
	c, e := a.read(r.Context(), input.Token, "login")
	if e != nil {
		http.Error(w, "invalid or expired link", 401)
		return
	}
	// Conditional claim is shared across replicas and survives process restarts.
	ok, e := a.store.Create(r.Context(), "auth/used/"+hash(input.Token)+".json", []byte(`{}`))
	if e != nil {
		http.Error(w, "sign-in unavailable", 503)
		return
	}
	if !ok {
		http.Error(w, "link already used", 401)
		return
	}
	c.Kind = "session"
	c.Expires = time.Now().Add(7 * 24 * time.Hour)
	token, e := a.issue(r.Context(), c)
	if e != nil {
		http.Error(w, "sign-in unavailable; request a new link", 503)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "breadcrumb_session", Value: token, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(a.baseURL, "https://"), SameSite: http.SameSiteStrictMode, MaxAge: 7 * 24 * 3600})
	w.WriteHeader(204)
}
func loopsSender(apiKey, template string) func(context.Context, string, string) error {
	return loopsSenderWithClient(apiKey, template, "https://app.loops.so/api/v1/transactional", &http.Client{Timeout: 15 * time.Second})
}

func loopsSenderWithClient(apiKey, template, endpoint string, client *http.Client) func(context.Context, string, string) error {
	return func(ctx context.Context, email, link string) error {
		data, _ := json.Marshal(map[string]any{"transactionalId": template, "email": email, "dataVariables": map[string]string{"loginUrl": link}})
		req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(data))
		if e != nil {
			return e
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("Content-Type", "application/json")
		resp, e := client.Do(req)
		if e != nil {
			return e
		}
		defer resp.Body.Close()
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("Loops returned status %d", resp.StatusCode)
		}
		return nil
	}
}
