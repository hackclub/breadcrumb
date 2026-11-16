package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLiveR2(t *testing.T) {
	if os.Getenv("BREADCRUMB_LIVE_R2") != "1" {
		t.Skip("set BREADCRUMB_LIVE_R2=1 to explicitly test a real bucket")
	}
	env := func(primary, fallback string) string {
		v := os.Getenv(primary)
		if v == "" {
			v = os.Getenv(fallback)
		}
		if v == "" {
			t.Fatalf("missing %s", primary)
		}
		return v
	}
	store := newR2Store(env("R2_ENDPOINT", "AWS_ENDPOINT_URL_S3"), env("R2_BUCKET", "R2_BUCKET"), env("R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"), env("R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	key := "smoke/" + secret() + ".json"
	defer func() {
		cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanCancel()
		if e := store.Delete(cleanCtx, key); e != nil {
			t.Errorf("synthetic cleanup failed for %s", key)
		}
	}()
	data := []byte(`{"synthetic":true,"tree":[{"role":"AXWindow","label":"Synthetic","depth":0}]}`)
	ok, e := store.Create(ctx, key, data)
	if e != nil || !ok {
		t.Fatalf("create failed: %v", e)
	}
	ok, e = store.Create(ctx, key, []byte(`{}`))
	if e != nil || ok {
		t.Fatalf("conditional duplicate failed: %v", e)
	}
	b, e := store.Get(ctx, key)
	if e != nil || string(b) != string(data) {
		t.Fatalf("read failed: %v", e)
	}
	if e := store.Delete(ctx, key); e != nil {
		t.Fatalf("delete failed: %v", e)
	}
}

// Every object in this fixture is isolated under one unique synthetic prefix.
type namespacedStore struct {
	inner  objectStore
	prefix string
}

func (s *namespacedStore) Get(ctx context.Context, key string) ([]byte, error) {
	return s.inner.Get(ctx, s.prefix+key)
}
func (s *namespacedStore) Create(ctx context.Context, key string, b []byte) (bool, error) {
	return s.inner.Create(ctx, s.prefix+key, b)
}
func (s *namespacedStore) Delete(ctx context.Context, key string) error {
	return s.inner.Delete(ctx, s.prefix+key)
}
func (s *namespacedStore) List(ctx context.Context, prefix, cursor string, limit int) ([]string, string, error) {
	keys, next, e := s.inner.List(ctx, s.prefix+prefix, cursor, limit)
	for i := range keys {
		keys[i] = strings.TrimPrefix(keys[i], s.prefix)
	}
	return keys, next, e
}
func TestLiveR2ReviewQueue(t *testing.T) {
	if os.Getenv("BREADCRUMB_LIVE_R2") != "1" {
		t.Skip("explicit live R2 opt-in required")
	}
	env := func(a, b string) string {
		v := os.Getenv(a)
		if v == "" {
			v = os.Getenv(b)
		}
		if v == "" {
			t.Fatalf("missing %s", a)
		}
		return v
	}
	raw := newR2Store(env("R2_ENDPOINT", "AWS_ENDPOINT_URL_S3"), env("R2_BUCKET", "R2_BUCKET"), env("R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"), env("R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"))
	store := &namespacedStore{raw, "smoke/" + secret() + "/"}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for {
			keys, _, e := store.List(ctx, "", "", 100)
			if e != nil {
				t.Errorf("synthetic cleanup listing failed: %v", e)
				return
			}
			if len(keys) == 0 {
				return
			}
			for _, key := range keys {
				if e := store.Delete(ctx, key); e != nil {
					t.Errorf("synthetic cleanup failed for %s%s", store.prefix, key)
					return
				}
			}
		}
	}()
	auth := &authService{store: store, baseURL: "https://synthetic.invalid", allowed: map[string]bool{"synthetic@example.com": true}}
	s := &service{store: store, auth: auth, agents: map[string]string{"test-agent": agentToken}}
	token, e := auth.issue(context.Background(), credential{hash("synthetic@example.com"), "synthetic@example.com", "upload", time.Now().Add(time.Hour)})
	if e != nil {
		t.Fatal(e)
	}
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, token, nil), 201)
	j := decodeJob(t, call(s, "POST", "/v1/review/claim", `{}`, agentToken, nil))
	if j["job"] == nil {
		t.Fatal("R2 job missing")
	}
	requireStatus(t, call(s, "POST", "/v1/review/submit", resultFor(j), agentToken, nil), 201)
	requireStatus(t, call(s, "POST", "/v1/ingest", capture, token, nil), 200)
	if decodeJob(t, call(s, "POST", "/v1/review/claim", `{}`, agentToken, nil))["job"] != nil {
		t.Fatal("reviewed capture requeued")
	}
}
