package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/oauth2"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var authValue = regexp.MustCompile(`^[a-f0-9]{64}$`)

type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string { return fmt.Sprintf("Server returned %d: %s", e.Status, e.Message) }
func randomSecret() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func oauthHTTPContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }})
}
func postJSON(ctx context.Context, server, path string, value, result any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(server, "/")+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := oauthHTTPContext(ctx).Value(oauth2.HTTPClient).(*http.Client)
	response, err := client.Do(req)
	if err != nil {
		return errors.New("Could not reach the server. Check your connection and try again.")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &apiError{response.StatusCode, string(body)}
	}
	if result != nil && len(body) > 0 {
		return json.Unmarshal(body, result)
	}
	return nil
}
func oauthConfig(c credentials, redirect string) *oauth2.Config {
	return &oauth2.Config{ClientID: c.ClientID, RedirectURL: redirect, Scopes: []string{"email", "offline_access", "captures:sync"}, Endpoint: oauth2.Endpoint{AuthURL: c.Server + "/api/auth/oauth2/authorize", TokenURL: c.Server + "/api/auth/oauth2/token", AuthStyle: oauth2.AuthStyleInParams}}
}

type desktopAuth struct {
	cancel                                      context.CancelFunc
	server, state, verifier, redirect, clientID string
}

func (e *engine) beginSignIn(server string) (any, error) {
	if e.demo {
		return nil, errors.New("Sign-in is disabled in demo mode")
	}
	server = strings.TrimRight(strings.TrimSpace(server), "/")
	if err := validateServer(server); err != nil {
		return nil, err
	}
	if e.auth != nil {
		e.auth.cancel()
		e.auth = nil
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("Could not open the local sign-in callback")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	flow := &desktopAuth{cancel: cancel, server: server, state: randomSecret(), verifier: oauth2.GenerateVerifier(), redirect: "http://" + listener.Addr().String() + "/callback"}
	var client struct {
		ID string `json:"client_id"`
	}
	err = postJSON(ctx, server, "/api/auth/oauth2/register", map[string]any{"client_name": "Breadcrumb Desktop", "application_type": "native", "token_endpoint_auth_method": "none", "redirect_uris": []string{flow.redirect}, "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "scope": "email offline_access captures:sync", "resources": []string{server + "/v1"}}, &client)
	if err != nil || client.ID == "" || len(client.ID) > 300 {
		cancel()
		listener.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("Server returned an invalid OAuth client")
	}
	flow.clientID = client.ID
	e.auth = flow
	e.authError = ""
	config := oauthConfig(credentials{Server: server, ClientID: client.ID}, flow.redirect)
	callback := &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second}
	callback.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		expected, _ := url.Parse(flow.redirect)
		if r.Method != "GET" || r.URL.Path != "/callback" || r.Host != expected.Host || subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("state")), []byte(flow.state)) != 1 || r.URL.Query().Get("iss") != server+"/api/auth" {
			http.Error(w, "Invalid sign-in callback", 400)
			return
		}
		e.mu.Lock()
		active := e.auth == flow
		e.mu.Unlock()
		if !active {
			http.Error(w, "Sign-in no longer active", 410)
			return
		}
		message := "Sign-in cancelled. Return to Breadcrumb."
		var token *oauth2.Token
		var exchangeErr error
		if r.URL.Query().Get("error") != "" {
			exchangeErr = errors.New("Desktop sign-in was cancelled")
		} else if code := r.URL.Query().Get("code"); code == "" || len(code) > 4096 {
			http.Error(w, "Missing authorization code", 400)
			return
		} else {
			token, exchangeErr = config.Exchange(oauthHTTPContext(ctx), code, oauth2.VerifierOption(flow.verifier), oauth2.SetAuthURLParam("resource", server+"/v1"))
		}
		e.mu.Lock()
		if e.auth == flow {
			var email, participant string
			if exchangeErr == nil {
				email, _ = token.Extra("email").(string)
				participant, _ = token.Extra("participant").(string)
				if token.AccessToken == "" || token.RefreshToken == "" || email == "" || !authValue.MatchString(participant) || participant != digestString(strings.ToLower(strings.TrimSpace(email))) {
					exchangeErr = errors.New("Server returned an invalid desktop account")
				}
			}
			if exchangeErr == nil {
				c := credentials{Server: server, Token: token.AccessToken, RefreshToken: token.RefreshToken, ClientID: client.ID, Email: email, Participant: participant, Expires: token.Expiry.UTC().Format(time.RFC3339), AutoSync: true}
				exchangeErr = writePrivate(filepath.Join(e.lib.Dir, "connection.json"), c)
				if exchangeErr == nil {
					if e.syncCancel != nil {
						e.syncCancel()
					}
					e.credentials = c
					e.authCompleted = time.Now().UnixNano()
					e.syncError = ""
					message = "You’re signed in. Breadcrumb is syncing your captures. You can close this tab."
				}
			}
			if exchangeErr != nil {
				e.authError = exchangeErr.Error()
				message = "Sign-in did not complete. Return to Breadcrumb to try again."
			}
			e.auth = nil
		}
		e.mu.Unlock()
		fmt.Fprintf(w, `<!doctype html><meta name="viewport" content="width=device-width"><title>Breadcrumb</title><style>body{font:16px system-ui;background:#000;color:#eee;max-width:420px;margin:15vh auto;padding:24px;line-height:1.7}</style><h1>Breadcrumb</h1><p>%s</p><script>history.replaceState(null,'','/callback')</script>`, message)
		time.AfterFunc(time.Second, cancel)
	})
	go func() {
		<-ctx.Done()
		_ = callback.Close()
		e.mu.Lock()
		if e.auth == flow {
			e.auth = nil
			e.authError = "Sign-in expired. Please try again."
		}
		e.mu.Unlock()
	}()
	go func() { _ = callback.Serve(listener) }()
	authorize := config.AuthCodeURL(flow.state, oauth2.S256ChallengeOption(flow.verifier), oauth2.SetAuthURLParam("resource", server+"/v1"), oauth2.SetAuthURLParam("prompt", "consent"))
	return map[string]string{"url": authorize}, nil
}
func refreshOAuth(ctx context.Context, c credentials) (credentials, error) {
	token, err := oauthConfig(c, "").TokenSource(oauthHTTPContext(ctx), &oauth2.Token{AccessToken: c.Token, RefreshToken: c.RefreshToken, TokenType: "Bearer", Expiry: time.Unix(1, 0)}).Token()
	if err != nil {
		return c, err
	}
	c.Token = token.AccessToken
	c.RefreshToken = token.RefreshToken
	c.Expires = token.Expiry.UTC().Format(time.RFC3339)
	return c, nil
}
func revokeOAuth(c credentials) {
	if c.Token == "" || c.ClientID == "" {
		return
	}
	values := url.Values{"client_id": {c.ClientID}, "token": {c.RefreshToken}, "token_type_hint": {"refresh_token"}}
	req, err := http.NewRequest("POST", c.Server+"/api/auth/oauth2/revoke", strings.NewReader(values.Encode()))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := oauthHTTPContext(context.Background()).Value(oauth2.HTTPClient).(*http.Client)
	response, err := client.Do(req)
	if err == nil {
		response.Body.Close()
	}
}
func (e *engine) disconnect() error {
	if e.auth != nil {
		e.auth.cancel()
		e.auth = nil
	}
	if e.syncCancel != nil {
		e.syncCancel()
	}
	previous := e.credentials
	if err := writePrivate(filepath.Join(e.lib.Dir, "connection.json"), credentials{}); err != nil {
		return err
	}
	e.credentials = credentials{}
	e.authError = ""
	e.syncError = ""
	go revokeOAuth(previous)
	return nil
}
