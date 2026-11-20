package agentusage

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Opt-in dense corpus: AGENT_USAGE_BENCH_BYTES=12884901888 go test -run TestLargeSyntheticUsage -v ./internal/agentusage
func TestLargeSyntheticUsage(t *testing.T) {
	raw := os.Getenv("AGENT_USAGE_BENCH_BYTES")
	if raw == "" {
		t.Skip("set AGENT_USAGE_BENCH_BYTES to run the large synthetic corpus")
	}
	target, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || target <= 0 {
		t.Fatal("invalid corpus size")
	}
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", filepath.Join(dir, "codex"))
	root := filepath.Join(os.Getenv("CODEX_HOME"), "sessions")
	os.MkdirAll(root, 0700)
	padding := strings.Repeat("synthetic content discarded ", 2400)
	var bytes int64
	events := 0
	for file := 0; file < 128 && bytes < target; file++ {
		f, e := os.Create(filepath.Join(root, fmt.Sprintf("rollout-%03d.jsonl", file)))
		if e != nil {
			t.Fatal(e)
		}
		w := bufio.NewWriterSize(f, 1<<20)
		w.WriteString(codexRecord("session_meta", fmt.Sprintf(`{"id":"session-%d","cwd":"/synthetic/project"}`, file)))
		w.WriteString(codexRecord("turn_context", `{"model":"gpt-5.4"}`))
		limit := target / 128
		for local := int64(0); local < limit; {
			line := codexRecord("token_usage_record", fmt.Sprintf(`{"response_id":"response-%d","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10},"text":%q}`, events, padding))
			n, e := w.WriteString(line)
			if e != nil {
				t.Fatal(e)
			}
			local += int64(n)
			bytes += int64(n)
			events++
		}
		w.Flush()
		f.Close()
	}
	s, err := Open(filepath.Join(dir, "library"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.Configure("codex", true)
	runtime.GC()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	peak := mem.HeapAlloc
	started := time.Now()
	ticks := 0
	for {
		if err := s.Scan(Budget); err != nil {
			t.Fatal(err)
		}
		ticks++
		runtime.ReadMemStats(&mem)
		if mem.HeapAlloc > peak {
			peak = mem.HeapAlloc
		}
		if s.Status().Pending == 0 {
			break
		}
	}
	elapsed := time.Since(started)
	r, e := s.Query(7, "UTC", time.Now())
	if e != nil {
		t.Fatal(e)
	}
	if sum(r) != int64(events)*60 {
		t.Fatalf("lost usage: %d events, input=%d", events, sum(r))
	}
	exportStarted := time.Now()
	snapshots, err := s.Export(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("hourly snapshots=%d export wall=%s", len(snapshots), time.Since(exportStarted))
	t.Logf("synthetic bytes=%d files=128 events=%d wall=%s throughput=%.1f MiB/s peak Go heap=%.1f MiB ticks=%d", bytes, events, elapsed, float64(bytes)/(1<<20)/elapsed.Seconds(), float64(peak)/(1<<20), ticks)
}
