package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/hackclub/breadcrumb/engine/internal/library"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func validateServer(server string) error {
	u, e := url.Parse(server)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
		return errors.New("server must be an HTTPS origin (HTTP localhost allowed)")
	}
	return nil
}
func uploadTo(ctx context.Context, c credentials, record library.Record, payload library.Payload) (any, error) {
	if err := validateServer(c.Server); err != nil {
		return nil, err
	}
	if c.Token == "" {
		return nil, errors.New("connect an upload token first")
	}
	client := &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	request := func(path string, b []byte, headers map[string]string) (map[string]any, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.Server, "/")+path, bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.Token)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		response, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if err != nil {
			return nil, err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, &apiError{response.StatusCode, string(data)}
		}
		if len(data) == 0 {
			return map[string]any{"ok": true}, nil
		}
		var out map[string]any
		err = json.Unmarshal(data, &out)
		return out, err
	}
	// Probe with the account-scoped image reference first. Unordered queues and new
	// servers can miss the image; retry with pixels only when the server needs them.
	if len(payload.JPEG) > 0 {
		hash := sha256.Sum256(payload.JPEG)
		payload.JPEGRef = hex.EncodeToString(hash[:])
		compact := payload
		compact.JPEG = nil
		b, err := json.Marshal(map[string]any{"schemaVersion": 1, "consent": true, "record": record, "payload": compact})
		if err != nil {
			return nil, err
		}
		result, err := request("/v1/ingest", b, nil)
		if err == nil {
			return result, nil
		}
		var remote *apiError
		if !errors.As(err, &remote) || (remote.Status != 400 && !(remote.Status == 409 && strings.Contains(remote.Message, "Screenshot reference unavailable"))) {
			return nil, err
		}
		if remote.Status == 400 {
			payload.JPEGRef = ""
		}
	}
	bundle := map[string]any{"schemaVersion": 1, "consent": true, "record": record, "payload": payload}
	b, err := json.Marshal(bundle)
	if err != nil {
		return nil, err
	}
	if len(b) < 4<<20 {
		return request("/v1/ingest", b, nil)
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	if len(data) > 12<<20 {
		return nil, errors.New("capture payload exceeds 12 MiB")
	}
	digest := sha256.Sum256(data)
	start, _ := json.Marshal(map[string]any{"schemaVersion": 1, "consent": true, "record": record, "size": len(data), "sha256": hex.EncodeToString(digest[:])})
	pending, err := request("/v1/uploads/start", start, nil)
	if err != nil {
		return nil, err
	}
	id, ok := pending["uploadId"].(string)
	if !ok {
		return nil, errors.New("server returned an invalid upload ID")
	}
	size, ok := pending["chunkSize"].(float64)
	if !ok || size < 1 || size > 3<<20 {
		return nil, errors.New("invalid server chunk size")
	}
	chunk := int(size)
	for offset, index := 0, 0; offset < len(data); offset, index = offset+chunk, index+1 {
		end := min(len(data), offset+chunk)
		if _, err = request(fmt.Sprintf("/v1/uploads/chunk?index=%d", index), data[offset:end], map[string]string{"X-Upload-ID": id, "Content-Type": "application/octet-stream"}); err != nil {
			return nil, err
		}
	}
	complete, _ := json.Marshal(map[string]string{"uploadId": id})
	return request("/v1/uploads/complete", complete, nil)
}
