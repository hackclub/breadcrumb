package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

//go:embed index.html
var page string

func required(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Fatalf("%s is required", name)
	}
	return v
}
func requiredEither(primary, fallback string) string {
	if value := os.Getenv(primary); value != "" {
		return value
	}
	return required(fallback)
}

func main() {
	base := strings.TrimRight(required("PUBLIC_URL"), "/")
	parsed, e := url.Parse(base)
	if e != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1"))) {
		log.Fatal("PUBLIC_URL must be an HTTPS origin (HTTP localhost is allowed)")
	}
	var store objectStore
	if dir := os.Getenv("LOCAL_DATA_DIR"); dir != "" {
		if parsed.Scheme != "http" {
			log.Fatal("LOCAL_DATA_DIR is only for HTTP localhost development")
		}
		store = &localStore{dir}
		log.Print("using local development storage")
	} else {
		endpoint := requiredEither("R2_ENDPOINT", "AWS_ENDPOINT_URL_S3")
		u, e := url.Parse(endpoint)
		if e != nil || u.Scheme != "https" || u.Host == "" {
			log.Fatal("R2_ENDPOINT must be HTTPS")
		}
		store = newR2Store(endpoint, required("R2_BUCKET"), requiredEither("R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"), requiredEither("R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"))
	}
	allowed := map[string]bool{}
	for _, email := range strings.Split(required("ALLOWED_EMAILS"), ",") {
		email = strings.ToLower(strings.TrimSpace(email))
		if email != "" {
			allowed[email] = true
		}
	}
	auth := &authService{store: store, baseURL: base, allowed: allowed, send: loopsSender(required("LOOPS_API_KEY"), required("LOOPS_TRANSACTIONAL_ID")), cooldown: map[string]time.Time{}}
	agents := map[string]string{}
	if raw := os.Getenv("REVIEW_AGENT_TOKENS"); raw != "" {
		if json.Unmarshal([]byte(raw), &agents) != nil {
			log.Fatal("REVIEW_AGENT_TOKENS must map names to random secrets")
		}
		seen := map[string]bool{}
		for name, token := range agents {
			if name == "" || len(name) > 100 || len(token) < 32 || seen[token] {
				log.Fatal("agent names and unique secrets of at least 32 characters required")
			}
			seen[token] = true
		}
	}
	app := &service{store: store, auth: auth, agents: agents}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	server := &http.Server{Addr: addr, Handler: app.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 45 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	log.Printf("Breadcrumb corpus listening on %s", addr)
	if e := server.ListenAndServe(); e != nil && !errors.Is(e, http.ErrServerClosed) {
		log.Fatal(e)
	}
}
